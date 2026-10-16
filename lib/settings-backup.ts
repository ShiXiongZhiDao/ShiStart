/**
 * 设置备份 —— 导出/导入**界面偏好**，不碰书签、不碰同步凭据。
 *
 * 为什么刻意不校验更多东西：备份里只有主题、语言、搜索引擎、侧边栏这四项，
 * 每一项都已经在 `normalizeSettings()` 里有独立的兜底，多余的"深度体检"只会让
 * 用户上一次修改被拒之门外而说不清为什么。
 *
 * 反过来，**外壳必须认**：`kind` 或 `version` 对不上就明确失败，绝不"尽力导入"。
 * 一个不认识的文件被当成设置读进去，最可能的后果是偏好静默变成默认值 ——
 * 那和"悄悄丢了"没有区别（见 既有约定）。
 */

import { normalizeSettings } from '../services/settings-service';
import type { ShiStartSettings } from '../types/settings';

/**
 * 注意这是 `lib/` 里唯一反向依赖 `services/` 的模块，理由是刻意的：
 * 归一化规则只在 `settings-service` 里存在一份副本，备份读进来必须走同一套规则，
 * 否则就会出现"存进去再读回来形状不一样"。`normalizeSettings` 本身是纯函数，
 * 不碰 `chrome.*`，所以这条边不会把浏览器 API 拖进 `lib/`。
 */

export const SETTINGS_BACKUP_KIND = 'shistart.settings';
export const SETTINGS_BACKUP_VERSION = 1;

export interface SettingsBackupEnvelope {
  kind: typeof SETTINGS_BACKUP_KIND;
  version: typeof SETTINGS_BACKUP_VERSION;
  /** 写出这份备份的扩展版本，只用于人对 debugging，不参与校验。 */
  app: string;
  exportedAt: number;
  settings: ShiStartSettings;
}

/**
 * 导入失败的原因。
 *
 * 给的是**机器可读的码**而不是一段中文：设置页有两种语言，
 * 把文案写死在这里会让英文界面里冒出一句中文。
 */
export type SettingsBackupError =
  | 'not-json'
  | 'not-object'
  | 'kind-mismatch'
  | 'version-mismatch';

export type ParseSettingsBackupResult =
  | { ok: true; settings: ShiStartSettings }
  | { ok: false; reason: SettingsBackupError };

export function serializeSettingsBackup(
  settings: ShiStartSettings,
  appVersion: string,
  exportedAt: number = Date.now(),
): string {
  const envelope: SettingsBackupEnvelope = {
    kind: SETTINGS_BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    app: appVersion,
    exportedAt,
    // 先归一化再写：存进去的东西保证是"读回来还认得"的形状。
    settings: normalizeSettings(settings),
  };
  return JSON.stringify(envelope, null, 2);
}

export function parseSettingsBackup(text: string): ParseSettingsBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-object' };
  }

  const value = raw as Partial<Record<keyof SettingsBackupEnvelope, unknown>>;
  if (value.kind !== SETTINGS_BACKUP_KIND) return { ok: false, reason: 'kind-mismatch' };
  if (value.version !== SETTINGS_BACKUP_VERSION) {
    return { ok: false, reason: 'version-mismatch' };
  }

  return { ok: true, settings: normalizeSettings(value.settings) };
}
