/**
 * 同步配置与凭据的读写。
 *
 * 存在 `chrome.storage.local`（本机、不跨设备），与界面偏好分开两个键 ——
 * 清偏好不该把同步配置也清掉。
 *
 * **凭据绝不进 IndexedDB 的操作日志、绝不进任何上传文件、绝不进诊断日志。**
 * 扩展的本地存储不等价于操作系统密钥库，UI 里如实说明这一点，不夸大。
 */

import type { WebDavCredential } from '../lib/sync/webdav-port';
import {
  LOGICAL_ROOT_BAR,
  LOGICAL_ROOT_OTHER,
  type SyncConfig,
} from '../types/sync-state';

export const SYNC_CONFIG_KEY = 'shistart.sync.config.v1';
export const SYNC_CREDENTIAL_KEY = 'shistart.sync.credential.v1';

/**
 * 远程子目录的默认值。
 *
 * 用户要求默认落在 `/ShiXiongZhiDao/ShiStart` —— 它同时意味着**「服务器根下」
 * 这个选项没有了**：留空在 `normalizeRemotePath` 里被折到这里，全场只有一个落点。
 * 位置是数据形状的一部分：换它等于换一个空间的位置，旧位置的数据不会被自动搬走
 * （开发阶段、无人使用，所以不写兼容探测 —— 既有约定 决策四记下了这个取舍）。
 */
export const DEFAULT_REMOTE_PATH = '/ShiXiongZhiDao/ShiStart';

/**
 * 远端子目录归一：留空（含从没填过）一律用默认子目录。
 *
 * 前后空白与首尾斜杠留给 `createRemoteLayout` 去规范化 —— 这里只回答"空不空"，
 * 不改用户写的形态（设置页的输入框显示的就是存储里的原文）。
 */
export function normalizeRemotePath(raw: unknown): string {
  const path = typeof raw === 'string' ? raw.trim() : '';
  return path === '' ? DEFAULT_REMOTE_PATH : path;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  baseUrl: '',
  username: '',
  remotePath: DEFAULT_REMOTE_PATH,
  spaceId: '',
  enabledRoots: [LOGICAL_ROOT_BAR, LOGICAL_ROOT_OTHER],
  // 默认开启：这个开关同时管「书签变更后自动同步」与「定时同步」两件事，
  // 关掉就等于配好之后什么都不会自动发生 —— 用户会以为坏了。
  autoSync: true,
  intervalMinutes: 30,
  initialized: false,
};

function storage(): chrome.storage.LocalStorageArea | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.storage?.local;
}

function normalizeRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SYNC_CONFIG.enabledRoots];
  const out = raw.filter((id): id is string => typeof id === 'string' && id !== '');
  return out.length > 0 ? out : [...DEFAULT_SYNC_CONFIG.enabledRoots];
}

/** 把任意存储值收敛成合法配置。缺字段一律回退默认，不让半个配置流入引擎。 */
export function normalizeSyncConfig(raw: unknown): SyncConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SYNC_CONFIG };
  const value = raw as Partial<Record<keyof SyncConfig, unknown>>;

  const intervalMinutes =
    typeof value.intervalMinutes === 'number' && Number.isFinite(value.intervalMinutes)
      ? Math.min(720, Math.max(5, Math.round(value.intervalMinutes)))
      : DEFAULT_SYNC_CONFIG.intervalMinutes;

  return {
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    username: typeof value.username === 'string' ? value.username : '',
    remotePath: normalizeRemotePath(value.remotePath),
    spaceId: typeof value.spaceId === 'string' ? value.spaceId : '',
    enabledRoots: normalizeRoots(value.enabledRoots),
    // 缺字段时按默认值 true，而不是 false —— 配置里没写过这个开关的新用户
    // 应当直接获得自动同步。
    autoSync: value.autoSync === undefined ? DEFAULT_SYNC_CONFIG.autoSync : value.autoSync === true,
    intervalMinutes,
    initialized: value.initialized === true,
  };
}

export async function loadSyncConfig(): Promise<SyncConfig> {
  const area = storage();
  if (!area) return { ...DEFAULT_SYNC_CONFIG };
  try {
    const stored = await area.get(SYNC_CONFIG_KEY);
    return normalizeSyncConfig(stored?.[SYNC_CONFIG_KEY]);
  } catch {
    return { ...DEFAULT_SYNC_CONFIG };
  }
}

export async function saveSyncConfig(config: SyncConfig): Promise<void> {
  const area = storage();
  if (!area) return;
  await area.set({ [SYNC_CONFIG_KEY]: config });
}

export async function loadCredential(): Promise<WebDavCredential | null> {
  const area = storage();
  if (!area) return null;
  try {
    const stored = await area.get(SYNC_CREDENTIAL_KEY);
    const raw = stored?.[SYNC_CREDENTIAL_KEY] as Partial<WebDavCredential> | undefined;
    if (!raw || typeof raw.username !== 'string' || typeof raw.password !== 'string') return null;
    return { username: raw.username, password: raw.password };
  } catch {
    return null;
  }
}

export async function saveCredential(credential: WebDavCredential): Promise<void> {
  const area = storage();
  if (!area) return;
  await area.set({ [SYNC_CREDENTIAL_KEY]: credential });
}

/** 断开同步：清掉配置与凭据，但**保留**本地 IDB 里的映射与日志，方便重新连上时接续。 */
export async function clearSyncConfig(): Promise<void> {
  const area = storage();
  if (!area) return;
  await area.remove([SYNC_CONFIG_KEY, SYNC_CREDENTIAL_KEY]);
}

export function isConfigured(config: SyncConfig): boolean {
  return config.baseUrl.trim() !== '' && config.username.trim() !== '' && config.spaceId !== '';
}
