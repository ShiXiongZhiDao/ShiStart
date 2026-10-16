/**
 * WebDavPort 的 HTTP 实现（既有约定 精简版）。
 *
 * 这一层只做三件事：发**对**的请求、把状态码翻译成端口定义的那几种语义、
 * 把"没拿到响应"和"服务器回答不"分开。业务规则一律不在这里。
 *
 * 三条只在 MV3 里成立的实现前提：
 * 1. MV3 的 fetch **不支持** Request 的 username/password 字段，所以 Basic 认证只能自己拼
 *    `Authorization` 头。少了这一句的表现是"每次 401"，而且报出来的 kind 是 credentials。
 * 2. 自定义方法（PROPFIND/MKCOL/MOVE）在 fetch 里合法：规范只禁 CONNECT/TRACE/TRACK。
 * 3. 不做重定向剥离（redirect: 'follow'）。代价转给调用方：**baseUrl 必须指向用户自己的服务器**。
 *
 * 相对旧版的删除：请求预算计数（配额不再是约束——快照模型每轮请求数
 * 与书签数脱钩）与"已确认集合"备忘录（连同它当晚需要的回归补丁）整层退休。
 */

import {
  WebDavError,
  webDavErrorKind,
  type RemoteResourceMeta,
  type WebDavAdminPort,
  type WebDavCredential,
  type WebDavMethod,
  type WebDavPort,
  type WebDavRequestOptions,
} from '../lib/sync/webdav-port';
import { childrenByLocal, descendantsByLocal, parseXmlRoot, textOf, type XmlNode } from '../lib/sync/webdav-xml';

export interface HttpWebDavOptions {
  /** 注入点：让整套状态码表能被直接喂给真实适配器，不必架一台服务器。 */
  fetchImpl?: typeof fetch;
  /** 注入点：把每个请求的墙上时间改成这个值，用例才不用真的等 15 秒。 */
  timeoutMs?: number;
}

/** 小请求（PROPFIND/MKCOL/MOVE/DELETE/HEAD/测试连接）：载荷是固定的几百字节。 */
export const SMALL_REQUEST_TIMEOUT_MS = 15_000;
/** GET 单独一档：它读的可能是完整状态文档。 */
export const GET_REQUEST_TIMEOUT_MS = 60_000;
export const PUT_TIMEOUT_FLOOR_MS = 15_000;
export const PUT_TIMEOUT_CEILING_MS = 120_000;
const PUT_MIN_BYTES_PER_SECOND = 16 * 1024;

/**
 * PUT 不给死数是因为两个变量都不在手里：载荷多大、上行多快。
 * 夹在上下限之间，让"慢网络上的合法上传"和"挂死的连接"还能分开。
 * 字节按 UTF-8 数而不是 string.length —— 标题与 URL 大量多字节字符。
 */
export function requestTimeoutMs(method: WebDavMethod, body?: string): number {
  if (method === 'PUT') {
    const bytes = body === undefined ? 0 : new TextEncoder().encode(body).length;
    const scaled = Math.ceil((bytes / PUT_MIN_BYTES_PER_SECOND) * 1000);
    return Math.min(PUT_TIMEOUT_CEILING_MS, Math.max(PUT_TIMEOUT_FLOOR_MS, scaled));
  }
  return method === 'GET' ? GET_REQUEST_TIMEOUT_MS : SMALL_REQUEST_TIMEOUT_MS;
}

class RequestTimeout extends Error {
  constructor(method: WebDavMethod, url: string, readonly timeoutMs: number) {
    super(`${method} ${url} 超过 ${timeoutMs}ms 没有完成，已中止`);
    this.name = '请求超时';
  }
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:">' +
  '<d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop>' +
  '</d:propfind>';

/** UTF-8 安全的 base64。用户名/密码里有中文是常见配置，不先过 TextEncoder 会抛。 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

function authorizationHeader(credential: WebDavCredential): string {
  return `Basic ${base64Utf8(`${credential.username}:${credential.password}`)}`;
}

function reasonText(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

/**
 * 没有响应 = network + status 0。
 *
 * 这是整个文件最重要的一行：TypeError（DNS/TLS/离线）和 AbortError **都不是**服务器的判断。
 * 把它们按 HTTP 状态码分类会得到 forbidden 或 bad-response，而上层对 403 的分支是
 * "提示用户改权限"，"网络故障只报告、不改动本地数据"这条就从这里开始失效。
 */
function networkError(method: WebDavMethod, url: string, cause: unknown): WebDavError {
  const error = new WebDavError(
    'network',
    method,
    url,
    0,
    `WebDAV ${method} ${url} 没有拿到响应：${reasonText(cause)}`,
  );
  error.cause = cause;
  return error;
}

function statusError(method: WebDavMethod, url: string, status: number): WebDavError {
  return new WebDavError(webDavErrorKind(status), method, url, status);
}

/** NaN 一律变"缺失"：lastModified 为 0 会被上层读成"1970 年改过"。 */
function parseHttpDate(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

function parseLength(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

/** `<d:status>` 里是 `HTTP/1.1 404 Not Found`，要的是那三位数。 */
function perResourceStatus(response: XmlNode): number | undefined {
  const value = textOf(response, 'status');
  if (!value) return undefined;
  const matched = /(\d{3})/.exec(value);
  const code = matched?.[1] === undefined ? undefined : Number(matched[1]);
  return code === undefined || Number.isNaN(code) ? undefined : code;
}

/**
 * `<d:href>` → 绝对 URL。服务器可能回完整 URL、以 / 开头的绝对路径（最常见）或相对路径。
 * 绝对路径必须用请求 URL 的 origin 还原：上层拿它当键比对，串不一致就判"远端没有这个文件"。
 */
function resolveHref(href: string, baseUrl: string): string | undefined {
  let candidate = href;
  try {
    candidate = decodeURIComponent(href);
  } catch {
    candidate = href;
  }
  try {
    return new URL(candidate, baseUrl).href;
  } catch {
    return undefined;
  }
}

function metaFromResponse(response: XmlNode, url: string): RemoteResourceMeta {
  const isCollection = descendantsByLocal(response, 'resourcetype').some(
    (type) => childrenByLocal(type, 'collection').length > 0,
  );
  const meta: RemoteResourceMeta = {
    url,
    exists: true,
    // resourcetype 没给时退到通行约定：尾斜杠 = 集合。
    isDirectory: isCollection || url.endsWith('/'),
  };
  const etag = textOf(response, 'getetag');
  if (etag) meta.etag = etag;
  const lastModified = parseHttpDate(textOf(response, 'getlastmodified'));
  if (lastModified !== undefined) meta.lastModified = lastModified;
  const length = parseLength(textOf(response, 'getcontentlength'));
  if (length !== undefined) meta.contentLength = length;
  return meta;
}

/**
 * 207 正文 → 条目列表。
 * 返回 undefined = "正文根本不是 multistatus"；返回空数组 = "解开了但一条都没有"。两者含义不同。
 */
export function parseMultistatus(xml: string, baseUrl: string): RemoteResourceMeta[] | undefined {
  const root = parseXmlRoot(xml);
  if (!root || root.local === 'parsererror') return undefined;
  if (root.local !== 'multistatus') return undefined;

  const entries: RemoteResourceMeta[] = [];
  for (const response of childrenByLocal(root, 'response')) {
    const href = textOf(response, 'href');
    if (!href) continue;
    const url = resolveHref(href, baseUrl);
    if (!url) continue;

    const code = perResourceStatus(response);
    // 逐资源 404 是**信息**不是错误：探测"这个路径有没有东西"要的正是它。
    if (code === 404) {
      entries.push({ url, exists: false, isDirectory: false });
      continue;
    }
    if (code !== undefined && code >= 400) continue;

    entries.push(metaFromResponse(response, url));
  }
  return entries;
}

/** 只 encodeURI，不整体 encodeURIComponent：后者会把 scheme 的 `:` 和路径 `/` 一起编码掉。 */
function destinationHeader(url: string): string {
  return encodeURI(url);
}

/**
 * 逐级 MKCOL 要打的集合路径，从最外层开始。
 *
 * **不重新编码路径段**：进来的 URL 可能已经编码过（`%20`），再编码一次得到 `%2520`，
 * 结果是新建一个"存在但永远空"的目录，写入静默落在别处。
 */
export function collectionPathOf(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const out: string[] = [];
  let path = '/';
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    path += `${segment}/`;
    out.push(`${parsed.origin}${path}`);
  }
  return out;
}

/** 文件 URL 的父集合（带尾斜杠）。`put` 收到 409 时用它"就地确认父目录"。 */
function parentCollectionOf(url: string): string {
  if (url.endsWith('/')) return url;
  const at = url.lastIndexOf('/');
  return at === -1 ? url : url.slice(0, at + 1);
}

export function createWebDavPort(options?: HttpWebDavOptions): WebDavPort & WebDavAdminPort {
  // 用箭头包一层而不是把 globalThis.fetch 存进变量：Chrome 里脱离 global 引用的 fetch
  // 会抛 Illegal invocation，而这个炸法在 try 之外，会变成裸 TypeError。
  const fetchImpl: typeof fetch =
    options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  interface CallInit {
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutCoversBody?: boolean;
  }

  async function request(
    method: WebDavMethod,
    url: string,
    credential: WebDavCredential,
    init?: CallInit,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: authorizationHeader(credential),
      ...init?.headers,
    };

    const limit = options?.timeoutMs ?? requestTimeoutMs(method, init?.body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new RequestTimeout(method, url, limit)), limit);
    const caller = init?.signal;
    const forward = (): void => controller.abort(caller?.reason);
    if (caller) {
      if (caller.aborted) forward();
      else caller.addEventListener('abort', forward, { once: true });
    }
    const release = (): void => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', forward);
    };

    const requestInit: RequestInit = {
      method,
      headers,
      redirect: 'follow',
      signal: controller.signal,
      ...(init?.body === undefined ? {} : { body: init.body }),
    };

    try {
      const response = await fetchImpl(url, requestInit);
      // fetch 在**响应头**到达就 resolve，而 GET/PROPFIND 的正文可能一直流不完。
      // 这一条由方法自己决定，不给调用方留一个"忘了传"的机会。
      const coversBody = init?.timeoutCoversBody ?? (method === 'GET' || method === 'PROPFIND');
      if (!coversBody) {
        release();
        return response;
      }
      return bodyTimeoutView(response, release, method, url);
    } catch (cause) {
      release();
      throw networkError(method, url, cause);
    }
  }

  /** 只暴露适配器真正读的四项，并把撤计时器推迟到正文读完。 */
  function bodyTimeoutView(
    response: Response,
    release: () => void,
    method: WebDavMethod,
    url: string,
  ): Response {
    let settled = false;
    const once = (): void => {
      if (settled) return;
      settled = true;
      release();
    };
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: async () => {
        try {
          return await response.text();
        } catch (cause) {
          throw networkError(method, url, cause);
        } finally {
          once();
        }
      },
    } as unknown as Response;
  }

  /**
   * 这一级是不是**已经存在的集合**。用 PROPFIND Depth:0 问，不写任何东西。
   *
   * 返回 false 的含义是"问不出它已就绪"，包括"确实没有"和"这台服务器不让我问"，
   * 调用方都按原来的逐级 MKCOL 处理 ⇒ 这个快路径只会少打请求，不会改变结果。
   */
  async function probeIsCollection(url: string, credential: WebDavCredential): Promise<boolean> {
    let response: Response;
    try {
      response = await request('PROPFIND', url, credential, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
    } catch {
      return false;
    }
    if (response.status !== 207 && response.status !== 200) return false;
    let body: string;
    try {
      body = await response.text();
    } catch {
      return false;
    }
    const entries = parseMultistatus(body, url);
    if (!entries) return false;
    // 坚果云对 `.../ops/` 的 PROPFIND 回的 href **不带尾斜杠**，留着斜杠一比就永远不等。
    const wanted = url.replace(/\/+$/, '');
    return entries.some((entry) => entry.isDirectory && entry.url.replace(/\/+$/, '') === wanted);
  }

  /**
   * 确保这一级集合存在。**不写任何东西**（除了必要时建目录）。
   *
   * 先探活；不在就**从最深的一级往上**建，而不是从根往叶盲建整条链：
   * - MKCOL 成功 / 405（已存在，RFC 4918 §9.3.1）⇒ 这一层就绪，且它的父也在
   *   （服务器不会对缺父的 MKCOL 回 201），于是往下补下一层；
   * - 409 ⇒ 父集合还缺，退一层；
   * - 其它状态（坚果云对用户填的根 `/dav/` 回 403）⇒ 先 PROPFIND **证一下它在不在**，
   *   证不出来才真的抛 —— 把"确保有"当"必须新建"会让第二次同步必然失败。
   *
   * 老写法对链上每一层都发 MKCOL：建 `states/`、`history/` 时会把已经存在的
   * 三级祖先各 MKCOL 一遍。实测一次一键连接为此白花约 9 个请求，而请求配额
   * 是硬约束（见 既有约定 / 既有约定 的请求数表）。
   */
  async function ensureCollection(url: string, credential: WebDavCredential): Promise<void> {
    if (await probeIsCollection(url, credential)) return;

    const chain = collectionPathOf(url);
    const leaf = chain.length - 1;
    // 非规范实现会把"父在、自身也在"回成 409 ⇒ 逐级上下有可能来回打转。
    // 给一个宽松的上限兜底，正常永远不会撞上（最多 chain.length 次）。
    const limit = chain.length * 2 + 4;
    let at = leaf;
    let attempts = 0;
    let lastCollection = url;
    let lastStatus = 0;

    while (at >= 0 && attempts < limit) {
      attempts += 1;
      const collection = chain[at]!;
      lastCollection = collection;
      const response = await request('MKCOL', collection, credential);
      lastStatus = response.status;

      if (response.ok || response.status === 405) {
        if (at === leaf) return;
        at += 1;
        continue;
      }
      if (response.status === 409) {
        at -= 1;
        continue;
      }

      // MKCOL 被拒不等于没权限 —— 先证它在不在，证不出来才真的抛。
      const probe = await request('PROPFIND', collection, credential, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      if (probe.status !== 207 && probe.status !== 200) {
        throw statusError('MKCOL', collection, response.status);
      }
      if (at === leaf) return;
      at += 1;
    }

    // 一路退到根都没有一层建得出来 —— 不是"已存在"，是真的建不出。
    throw statusError('MKCOL', lastCollection, lastStatus);
  }

  return {
    /** 用 PROPFIND 而不是 GET：只问属性、不下载载荷，且**不写任何东西**。 */
    async testConnection(url, credential) {
      const response = await request('PROPFIND', url, credential, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      // 207 落在 fetch 的 ok 区间里，不必为它单开一支。
      if (!response.ok) throw statusError('PROPFIND', url, response.status);
    },

    ensureCollection,

    async put(url, body, credential, options) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // 条件头**只在显式给了的时候**才发：`If-Match: undefined` 序列化会变成空值，
      // 服务器按"带了条件头但值不匹配"处理成 412 —— 那就是"什么都没做但一直失败"。
      if (options?.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
      if (options?.ifNoneMatch !== undefined) headers['If-None-Match'] = options.ifNoneMatch;

      const send = (): Promise<Response> =>
        request('PUT', url, credential, { headers, body, signal: options?.signal });

      let response = await send();

      // 409 = 父集合不存在。服务器不会替我们造父目录，而"哪个祖先缺了"没有别的办法知道，
      // 只能补一遍整条链再重试。这道兜底是**幂等**的：父目录都在时 MKCOL 只是空跑。
      if (response.status === 409) {
        await ensureCollection(parentCollectionOf(url), credential);
        response = await send();
      }

      if (!response.ok) throw statusError('PUT', url, response.status);

      const etag = response.headers.get('ETag');
      // 没有 ETag 就不塞这个键：etag: undefined 与缺失在 JSON round-trip 下不是一回事。
      return etag ? { etag } : {};
    },

    async get(url, credential) {
      const response = await request('GET', url, credential);
      if (!response.ok) throw statusError('GET', url, response.status);
      return await response.text();
    },

    async head(url, credential) {
      const response = await request('HEAD', url, credential);
      // 404 在 HEAD 上是**答案**不是故障。但绝不能让 503/401 也走这条。
      if (response.status === 404) return { url, exists: false, isDirectory: false };
      if (!response.ok) throw statusError('HEAD', url, response.status);

      const meta: RemoteResourceMeta = {
        url,
        exists: true,
        isDirectory:
          response.headers.get('Content-Type') === 'httpd/unix-directory' || url.endsWith('/'),
      };
      const etag = response.headers.get('ETag');
      if (etag) meta.etag = etag;
      const lastModified = parseHttpDate(response.headers.get('Last-Modified'));
      if (lastModified !== undefined) meta.lastModified = lastModified;
      const length = parseLength(response.headers.get('Content-Length'));
      if (length !== undefined) meta.contentLength = length;
      return meta;
    },

    async propfind(url, credential, depth) {
      const response = await request('PROPFIND', url, credential, {
        headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      const { status } = response;
      // 424 Failed Dependency：目录里有一个子资源属性读不出来（mod_dav/Nginx 常见）。
      // 一次列目录失败不该把整次同步判死，照样解析、只丢掉坏条目。
      if (status !== 207 && status !== 200 && status !== 424) {
        throw statusError('PROPFIND', url, status);
      }

      const parsed = parseMultistatus(await response.text(), url);
      if (parsed === undefined) {
        if (status === 424) return [];
        throw new WebDavError(
          'bad-response',
          'PROPFIND',
          url,
          status,
          `WebDAV PROPFIND ${url} 的响应体不是 multistatus，无法解析（HTTP ${status}）`,
        );
      }
      return parsed;
    },

    async move(from, to, overwrite, credential) {
      const response = await request('MOVE', from, credential, {
        headers: { Destination: destinationHeader(to), Overwrite: overwrite ? 'T' : 'F' },
      });
      if (!response.ok) throw statusError('MOVE', from, response.status);
    },

    async remove(url, credential) {
      const response = await request('DELETE', url, credential, {});
      // 404 按幂等成功：目标是"这里没有这个文件"，已经没有了就是达到了。
      if (response.status === 404) return;
      if (!response.ok) throw statusError('DELETE', url, response.status);
    },
  };
}
