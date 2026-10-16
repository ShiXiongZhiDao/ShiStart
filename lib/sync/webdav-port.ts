/**
 * WebDAV 边界接口与错误语义（纯声明 + 一张状态码分类表）。
 *
 * 分层规矩和项目里"组件不许直接调 chrome.bookmarks"是同一条线：
 * **同步引擎不许直接调 fetch**。网络层必须能被一个内存假服务器替换，
 * 否则"上传到一半断掉""412 条件失败"这类场景只能靠真服务器复现。
 *
 * 状态码刻意翻译成语义而不是透传数字：引擎要按"该怎么办"分支
 * （要不要重试 / 要不要让用户重填密码 / 要不要重拉），
 * 按数字分支会把服务器的实现细节变成引擎的合同。
 */

export interface RemoteResourceMeta {
  /** 绝对 URL，与调用时传进去的一致。 */
  url: string;
  exists: boolean;
  isDirectory: boolean;
  /** 服务器给的实体标签，条件写用它。 */
  etag?: string;
  /** epoch 毫秒。解析不出就是缺失，绝不给 0 —— 0 会被读成"1970 年改过"。 */
  lastModified?: number;
  contentLength?: number;
}

export type WebDavMethod =
  | 'GET'
  | 'HEAD'
  | 'PUT'
  | 'PROPFIND'
  | 'MKCOL'
  | 'MOVE'
  | 'DELETE';

export type WebDavErrorKind =
  /** 401/407：用户名或密码不对。只能让用户改凭据，重试没有意义。 */
  | 'credentials'
  /** 403：认证过了但没权限（只读目录、配额、服务器策略）。 */
  | 'forbidden'
  /** 404：路径不存在。 */
  | 'not-found'
  /** 409：父目录不存在或状态冲突。 */
  | 'parent-conflict'
  /** 412：条件请求失败 —— 有别的设备先写了。 */
  | 'precondition-failed'
  /** 405/501：这台服务器不支持这个方法（不少 WebDAV 主机不实现 MOVE）。 */
  | 'unsupported-method'
  /** 429/5xx：可退避重试。 */
  | 'throttled'
  /** 5xx：服务器异常。 */
  | 'server'
  /** 请求没拿到响应：DNS、TLS、超时、离线。**与"服务器说 no"是两件事**。 */
  | 'network'
  /** 拿到了响应但内容不对。 */
  | 'bad-response';

export class WebDavError extends Error {
  constructor(
    readonly kind: WebDavErrorKind,
    readonly method: WebDavMethod,
    readonly url: string,
    /** 原始状态码。`network` 时是 0 —— 0 本身有信息量，不是缺省。 */
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `WebDAV ${method} ${url} 失败：${kind}（HTTP ${status}）`);
    this.name = 'WebDavError';
  }
}

/**
 * 状态码 → 语义。
 *
 * 只收状态码：同一台服务器上同一个 403 在 GET 和 PUT 上是同一个含义，
 * 调用点已经拿着 method 在构造错误了。
 */
export function webDavErrorKind(status: number): WebDavErrorKind {
  if (status === 0) return 'network';
  if (status === 401 || status === 407) return 'credentials';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'parent-conflict';
  if (status === 412) return 'precondition-failed';
  if (status === 405 || status === 501) return 'unsupported-method';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server';
  // 其余 4xx（400 / 413 / 423…）统一按 bad-response：意思是"我们的假设和这台服务器对不上"，
  // 不是"权限不够"。翻译成 forbidden 会让上层去提示用户改密码，那是把实现细节当结论。
  if (status >= 400) return 'bad-response';
  return 'bad-response';
}

/** 这类错误重试才有意义。401 重试一百次也是 401。 */
export function isRetryable(kind: WebDavErrorKind): boolean {
  return kind === 'network' || kind === 'server' || kind === 'throttled' || kind === 'parent-conflict';
}

export interface WebDavCredential {
  username: string;
  password: string;
}

export interface WebDavRequestOptions {
  /** 条件写：只有远端当前 ETag 等于这个值才允许覆盖。 */
  ifMatch?: string;
  ifNoneMatch?: '*' | string;
  signal?: AbortSignal;
}

export interface WebDavPort {
  /** 只问"能不能连上、能不能看到这个目录"，**不写任何东西**。 */
  testConnection(url: string, credential: WebDavCredential): Promise<void>;
  /** 逐级 MKCOL。已存在算成功：语义是"确保有"，不是"必须新建"。 */
  ensureCollection(url: string, credential: WebDavCredential): Promise<void>;
  put(
    url: string,
    body: string,
    credential: WebDavCredential,
    options?: WebDavRequestOptions,
  ): Promise<{ etag?: string }>;
  get(url: string, credential: WebDavCredential): Promise<string>;
  head(url: string, credential: WebDavCredential): Promise<RemoteResourceMeta>;
  propfind(
    url: string,
    credential: WebDavCredential,
    depth: 0 | 1,
  ): Promise<RemoteResourceMeta[]>;
  move(from: string, to: string, overwrite: boolean, credential: WebDavCredential): Promise<void>;
}

/**
 * 删除能力**单独一个接口**，不放进 `WebDavPort`。
 *
 * 目的是让"普通同步永不删除远端历史"变成签名层面的约束，而不是注释里的一句约定：
 * 同步引擎的依赖声明成 `WebDavPort`，它**拿不到**删除方法，
 * 只有显式接受 `WebDavAdminPort` 的用例（连接测试清理临时文件、用户主动清理）才有。
 */
export interface WebDavAdminPort {
  /** 404 按幂等成功：目标是"这里没有东西"，已经没有了就是达到了。 */
  remove(url: string, credential: WebDavCredential): Promise<void>;
}

/**
 * 指数退避 + jitter。抖动是必须的：两台设备同时被 429 打回，
 * 不抖动就会在完全相同的时刻一起重试，然后再一起被打回。
 */
export function backoffDelayMs(attempt: number): number {
  const steps = [2000, 5000, 15000, 60000, 300000];
  const base = steps[Math.min(attempt, steps.length - 1)] ?? 300000;
  const jitter = Math.round(base * 0.2 * Math.random());
  return base + jitter;
}
