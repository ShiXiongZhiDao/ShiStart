/**
 * 远端目录布局（纯函数，既有约定 的 v3 布局）。
 *
 * 所有路径拼接集中在这一处 —— 斜杠有没有、哪一段该编码，是同步层最容易出静默 404 的地方。
 *
 * 布局：
 *   <base>/shistart-sync/v3/
 *     space.json                 空间身份（spaceId 归远端所有，既有约定）
 *     settings.json              界面偏好，**空间级一份**
 *     states/{writerId}.json     每处安装一份全量状态（原子 PUT）
 *     history/{状态指纹}.json     恢复点（内容寻址，空间级共享）
 *
 * 与 v2 的区别：没有 ops/（没有操作日志）、没有 devices/（没有设备名册）、
 * 没有 head.json（没有序号可追）。v2 与 v3 数据不互通 —— 换布局 = 换空间。
 */

/** 远端根目录下的目录名。换它等于换一个不兼容的空间，所以写死而不是可配置。 */
const SYNC_ROOT_DIR = 'shistart-sync';

/**
 * 远端目录布局版本。
 *
 * `v3` 与 `v2` 的区别：没有 ops/（没有操作日志）、没有 devices/（没有设备名册）、
 * 没有 head.json（没有序号可追）。换它是换一个不兼容的空间，所以两边的数据不互通
 * —— 升级后就是全新的空空间（v2 的由来见 既有约定，v3 见 既有约定）。
 */
const SYNC_LAYOUT_DIR = 'v3';

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

/** 每一段单独编码，斜杠保留。中文、空格、`#`、`%` 的文件名全靠这一步。 */
export function encodeSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment === '' ? '' : encodeURIComponent(segment)))
    .join('/');
}

/**
 * 规范化用户填的 base URL：去碎片、去查询串、补尾斜杠。
 *
 * 只接受 http/https —— 其余协议（尤其 file:）不该带着 Basic 凭据发出去。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new LayoutError('WebDAV 地址不能为空');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LayoutError('WebDAV 地址不是合法的 URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LayoutError('只支持 http/https 的 WebDAV 地址');
  }
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

export function joinUrl(base: string, ...segments: string[]): string {
  const head = base.endsWith('/') ? base : `${base}/`;
  const tail = segments
    .map((segment) => encodeSegments(segment.replace(/^\/+|\/+$/g, '')))
    .filter((segment) => segment !== '')
    .join('/');
  return tail === '' ? head : `${head}${tail}`;
}

export interface RemoteLayout {
  /** 用户配置的根（已规范化，带尾斜杠）。 */
  baseUrl: string;
  /** 同步空间根：.../shistart-sync/v3/ */
  spaceUrl: string;
  spaceFileUrl: string;
  /**
   * 偏好文档：**空间级一份**，所有写入方共用。
   * 不放在 `states/` 下 —— 那是"每处安装一份"的语义。
   */
  settingsFileUrl: string;
  /** 全部写入方的状态文档目录。 */
  statesUrl: string;
  /** 某一处安装的状态文档。 */
  stateUrl(writerId: string): string;
  /** 恢复点目录（空间级共享，内容寻址）。 */
  historyUrl: string;
  restorePointUrl(fingerprint: string): string;
  /** 连接测试临时文件，用完即删。 */
  probeUrl(nonce: string): string;
}

export function createRemoteLayout(baseUrl: string, remotePath = ''): RemoteLayout {
  const root = normalizeBaseUrl(baseUrl);
  const prefix = remotePath.trim().replace(/^\/+|\/+$/g, '');
  const spaceUrl = `${joinUrl(root, ...(prefix ? [prefix] : []), SYNC_ROOT_DIR, SYNC_LAYOUT_DIR)}/`;

  return {
    baseUrl: root,
    spaceUrl,
    spaceFileUrl: joinUrl(spaceUrl, 'space.json'),
    settingsFileUrl: joinUrl(spaceUrl, 'settings.json'),
    statesUrl: joinUrl(spaceUrl, 'states'),
    stateUrl: (writerId) => joinUrl(spaceUrl, 'states', `${writerId}.json`),
    historyUrl: joinUrl(spaceUrl, 'history'),
    restorePointUrl: (fingerprint) => joinUrl(spaceUrl, 'history', `${fingerprint}.json`),
    probeUrl: (nonce) => joinUrl(spaceUrl, `.probe-${nonce}.tmp`),
  };
}

/** 从 PROPFIND 的 href 里取最后一段文件名。坚果云回的 href 不带尾斜杠，这里统一处理。 */
export function fileNameFromHref(href: string): string {
  const withoutQuery = href.split('?')[0] ?? href;
  const segments = withoutQuery.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] ?? '';
}

/** 状态文档文件名 → 写入令牌。认不出一律忽略（可能是别的客户端留下的垃圾）。 */
export function writerIdFromFileName(fileName: string): string | null {
  const matched = /^([0-9a-f-]{8,64})\.json$/i.exec(fileName);
  return matched?.[1] ? matched[1].toLowerCase() : null;
}

/** 恢复点文件名 → 状态指纹（SHA-256 前 32 位，同内容同名 ⇒ 天然去重，既有约定）。 */
export function fingerprintFromFileName(fileName: string): string | null {
  const matched = /^([0-9a-f]{32})\.json$/i.exec(fileName);
  return matched?.[1] ? matched[1].toLowerCase() : null;
}
