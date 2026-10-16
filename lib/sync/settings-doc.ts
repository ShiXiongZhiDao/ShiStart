/**
 * 偏好文档：空间级一份 `settings.json`，**逐字段 LWW**。
 *
 * 形状刻意与 `state-doc.ts` 同构（每个可变字段各带一个 `ver = (clock, writerId)`），
 * 裁决次序也复用 `lib/sync/version.ts` 那一条全序 —— 两处同一个"谁大谁赢"的规矩，
 * 不重新发明一次。
 *
 * 与书签文档不同的三处，都是因为偏好不是树：
 * 1. **不进删除闸门**。偏好没有"删除 vs 编辑"这种不对称：一个字段要么被设成新值，
 *    要么没人设过。改个主题弹一次冲突闸门是荒谬的（既有约定 当初的反对理由之一）。
 * 2. **只推本机改过的字段**。整份覆盖会让"老设备读不懂的新字段"被悄悄删掉
 *    （见 `diffSettingsAgainstBaseline`）。
 * 3. **没有基线就不算本机改动**。新装的机器第一次连上空间时手里的全是出厂默认值，
 *    把它们当成"最新改动"推上去会**静默**覆盖全空间 —— 是本仓最不接受的那类失败。
 */

import { normalizeSettings } from '../../services/settings-service';
import {
  DEFAULT_SETTINGS,
  SYNCED_SETTING_KEYS,
  type ShiStartSettings,
  type SyncedSettingKey,
} from '../../types/settings';
import type { Version } from '../../types/sync-state';
import { advanceClock, compareVersion, maxVersion } from './version';

export const SETTINGS_DOC_FORMAT = 'shistart-settings';
export const SETTINGS_DOC_VERSION = 1;

/** 一个字段的当前值与它的版本。 */
export interface SettingsFieldEntry {
  value: unknown;
  ver: Version;
}

/**
 * 偏好文档：整个同步空间**只有一份**，所有写入令牌共用。
 *
 * `fields` 是部分的：只有"有人真的设过"的字段在里头。缺一个字段不是"它是默认值"，
 * 而是"这个空间里没人设过它" —— 两种说法在合并时行为不同（见 `diffSettingsAgainstBaseline`）。
 */
export interface SettingsDocument {
  format: typeof SETTINGS_DOC_FORMAT;
  version: typeof SETTINGS_DOC_VERSION;
  spaceId: string;
  /** 最后写这份文档的写入令牌。只用于界面上"最后由谁更新"那一行。 */
  writerId: string;
  clock: number;
  writtenAt: number;
  fields: Partial<Record<SyncedSettingKey, SettingsFieldEntry>>;
}

export function emptySettingsDoc(
  spaceId: string,
  writerId: string,
  now: number = Date.now(),
): SettingsDocument {
  return {
    format: SETTINGS_DOC_FORMAT,
    version: SETTINGS_DOC_VERSION,
    spaceId,
    writerId,
    clock: 0,
    writtenAt: now,
    fields: {},
  };
}

export function serializeSettingsDoc(doc: SettingsDocument): string {
  return JSON.stringify(doc);
}

/**
 * 解析远端偏好文档。
 *
 * **format / version 对不上就整份拒绝**（未来的形状读不懂，硬读会产生半个真值）；
 * 但**单个字段坏了只跳过那一个** —— 偏好不是树，一个值坏掉不该连累其余十个。
 */
export function parseSettingsDoc(raw: string): SettingsDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const doc = value as Partial<Record<keyof SettingsDocument, unknown>>;
  if (doc.format !== SETTINGS_DOC_FORMAT) return null;
  if (doc.version !== SETTINGS_DOC_VERSION) return null;
  if (typeof doc.spaceId !== 'string') return null;
  if (typeof doc.writerId !== 'string') return null;

  const fields: Partial<Record<SyncedSettingKey, SettingsFieldEntry>> = {};
  if (doc.fields && typeof doc.fields === 'object' && !Array.isArray(doc.fields)) {
    for (const key of SYNCED_SETTING_KEYS) {
      const entry = (doc.fields as Record<string, unknown>)[key];
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { value?: unknown; ver?: unknown };
      const ver = record.ver as Partial<Version> | undefined;
      if (!ver || typeof ver.clock !== 'number' || typeof ver.writerId !== 'string') continue;
      fields[key] = { value: record.value, ver: { clock: ver.clock, writerId: ver.writerId } };
    }
  }

  return {
    format: SETTINGS_DOC_FORMAT,
    version: SETTINGS_DOC_VERSION,
    spaceId: doc.spaceId,
    writerId: doc.writerId,
    clock: typeof doc.clock === 'number' ? doc.clock : 0,
    writtenAt: typeof doc.writtenAt === 'number' ? doc.writtenAt : 0,
    fields,
  };
}

/**
 * 把文档里的值读成一份偏好补丁。
 *
 * **远端是不可信输入**：值一律过 `normalizeSettings`（与 `settings-backup.ts` 同一个规矩），
 * 坏值回落默认值而不是直接进界面。
 *
 * ⚠️ 取出来的 `selectedFolderId` 是**云端形态**（syncId，或 `all` / `__root__` 这类常量），
 * 换成本机原生 id 是 `services/settings-sync.ts` 的事 —— 它才拿得到映射表，
 * 这个文件是纯函数，不碰 IndexedDB。
 */
export function settingsDocToPatch(doc: SettingsDocument): Partial<ShiStartSettings> {
  const present: SyncedSettingKey[] = [];
  const raw: Record<string, unknown> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const entry = doc.fields[key];
    if (entry === undefined) continue;
    present.push(key);
    raw[key] = entry.value;
  }
  if (present.length === 0) return {};
  // 归一化一次拿到全套合法值，再按"文档里真的有的字段"挑回去 ——
  // 直接喂进 normalize 会拿到一整份（含默认值），那会把"没人设过"变成"设成了默认"。
  const normalized = normalizeSettings(raw);
  const patch: Record<string, unknown> = {};
  for (const key of present) patch[key] = normalized[key];
  return patch as Partial<ShiStartSettings>;
}

/**
 * 本机哪些字段**真的被改过**。
 *
 * 判据是与**偏好基线**逐字段比，而不是"当前值 ≠ 默认值"：
 * - 没有基线 ⇒ **一个都不算改动**。新装的机器手里全是出厂默认值，把它们当改动推上去
 *   会把整个空间的偏好冲掉（既有约定 决策六）；
 * - 基线里有这个字段 ⇒ 值不同才算改动；
 * - 基线里没有 ⇒ 算改动（这个空间里还没人设过它，本机来立这个值）。
 *
 * 返回的文档**只含改过的字段**，上传时按逐字段并进空间文档 —— 整份覆盖会让
 * "本机读不懂、但别人设过的新字段"被悄悄删掉。
 */
export function diffSettingsAgainstBaseline(input: {
  current: ShiStartSettings;
  baseline: SettingsDocument | null;
  spaceId: string;
  writerId: string;
  /** 本机已见到的偏好时钟。 */
  clock: number;
  now?: number;
}): { doc: SettingsDocument; changed: SyncedSettingKey[] } {
  const now = input.now ?? Date.now();
  const changed: SyncedSettingKey[] = [];
  if (input.baseline === null) {
    return { doc: emptySettingsDoc(input.spaceId, input.writerId, now), changed };
  }

  const baseline = input.baseline;
  for (const key of SYNCED_SETTING_KEYS) {
    const before = baseline.fields[key];
    const value = input.current[key];
    if (before !== undefined) {
      if (before.value === value) continue;
    } else if (value === DEFAULT_SETTINGS[key]) {
      // 这个空间里还没人设过它，而本机手里是**出厂默认值** —— 那不是"用户设过"，
      // 是"用户还没碰过"。把它当改动推上去，新装的机器就会用一整套默认值
      // 把整个空间的偏好冲掉（既有约定 决策六要防的正是这件事）。
      //
      // 代价认下：用户把某项**恰好设成默认值**时，这次显式选择不会往上传。
      // 但它传过去也只会让对方保持同一个默认值，结果一致 —— 没有信息损失。
      continue;
    }
    changed.push(key);
  }
  if (changed.length === 0) {
    return { doc: emptySettingsDoc(input.spaceId, input.writerId, now), changed };
  }

  const observed = Object.values(baseline.fields)
    .map((entry) => entry?.ver)
    .filter((ver): ver is Version => ver !== undefined);
  // 基线文档的 clock 也是"这个空间已经爬到过的地方"，必须一并算进起点 ——
  // 只看字段上的 ver 会撞上别人已经用过的值（平票虽由 writerId 裁决，但不该主动制造）。
  const nextClock = advanceClock(Math.max(input.clock, baseline.clock), observed) + 1;
  const ver: Version = { clock: nextClock, writerId: input.writerId };

  const fields: Partial<Record<SyncedSettingKey, SettingsFieldEntry>> = {};
  for (const key of changed) fields[key] = { value: input.current[key], ver };

  return {
    doc: {
      format: SETTINGS_DOC_FORMAT,
      version: SETTINGS_DOC_VERSION,
      spaceId: input.spaceId,
      writerId: input.writerId,
      clock: nextClock,
      writtenAt: now,
      fields,
    },
    changed,
  };
}

/**
 * 逐字段 LWW：每个字段各取 `ver` 最大的那个，互不相干。
 *
 * 两台机器一台改配色、一台改搜索引擎，两个改动**都留着** —— 这正是没有选
 * "整份 LWW" 的原因（整份会让先写的那次凭空消失）。
 *
 * `writerId` 是结果文档的作者：合并只是本地求解，真正写上去的是调用方。
 */
export function mergeSettingsDocs(
  docs: readonly SettingsDocument[],
  writerId: string,
  now: number = Date.now(),
): SettingsDocument {
  const fields: Partial<Record<SyncedSettingKey, SettingsFieldEntry>> = {};
  let clock = 0;
  let spaceId = '';

  for (const doc of docs) {
    if (doc.clock > clock) clock = doc.clock;
    if (spaceId === '' && doc.spaceId !== '') spaceId = doc.spaceId;
    for (const key of SYNCED_SETTING_KEYS) {
      const incoming = doc.fields[key];
      if (incoming === undefined) continue;
      if (incoming.ver.clock > clock) clock = incoming.ver.clock;
      const held = fields[key];
      if (held === undefined || compareVersion(incoming.ver, held.ver) > 0) {
        fields[key] = incoming;
      }
    }
  }

  return {
    format: SETTINGS_DOC_FORMAT,
    version: SETTINGS_DOC_VERSION,
    spaceId,
    writerId,
    clock,
    writtenAt: now,
    fields,
  };
}

/**
 * 这份文档里"最后由谁在什么时候改过"。
 *
 * 给界面上"最后由 X 更新"那一行用：偏好被覆盖是**静默**的（不进冲突闸门），
 * 所以至少要能查出来是誰改的 —— 可追溯是静默择一的前提，不是可选项。
 */
export function lastWriterOf(doc: SettingsDocument): { writerId: string; at: number } | null {
  let winner: Version | null = null;
  for (const entry of Object.values(doc.fields)) {
    if (entry === undefined) continue;
    winner = maxVersion(winner, entry.ver);
  }
  if (winner === null) return null;
  return { writerId: winner.writerId, at: doc.writtenAt };
}
