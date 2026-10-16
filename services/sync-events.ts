/**
 * 本机同步运行记录。
 *
 * 回答的是"它到底同步过没有、同步了什么"—— **不是审计**，所以是环形缓冲、
 * 可以滚动丢弃（上限 `SYNC_EVENT_LIMIT`）。
 *
 * 纯本机、与同步配置分开一个键：不进备份、不进远端、不进基线。
 * 清配置不该把记录也清掉 —— 配置是配置，日志是日志。
 *
 * **写入失败一律静默吞掉。** 这是旁路观测数据，写不进去不该让一次真实的
 * 书签同步失败。注意这与"书签读取失败必须走错误态"不冲突：书签是唯一数据源，
 * 读不到是灾难；记录只是旁路（见 既有约定）。
 */

import {
  SYNC_EVENT_LIMIT,
  type SyncEventKind,
  type SyncEventRecord,
  type SyncTriggerReason,
} from '../types/sync-state';

export const SYNC_EVENTS_KEY = 'shistart.sync.events.v1';

export interface SyncEventInput {
  kind: SyncEventKind;
  trigger: SyncTriggerReason;
  success: boolean;
  pushed?: number;
  pulled?: number;
  applied?: number;
  conflictCount?: number;
  /** 地址过长、没进同步空间的条数。 */
  skipped?: number;
  /** 远端要来、但本机浏览器拒收的条数。 */
  failed?: number;
  detail?: string;
}

function storage(): chrome.storage.LocalStorageArea | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.storage?.local;
}

function newEventId(): string {
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把任意存储值收敛成合法记录数组。坏数据一律丢掉，不让半个记录流入 UI。 */
function normalizeRecords(raw: unknown): SyncEventRecord[] {
  if (!Array.isArray(raw)) return [];
  const kinds: SyncEventKind[] = ['push', 'pull', 'skip', 'error'];
  const triggers: SyncTriggerReason[] = ['manual', 'interval', 'debounced', 'setup', 'trash-expiry'];
  const out: SyncEventRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Partial<Record<keyof SyncEventRecord, unknown>>;
    if (typeof value.id !== 'string') continue;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) continue;
    if (!kinds.includes(value.kind as SyncEventKind)) continue;
    if (!triggers.includes(value.trigger as SyncTriggerReason)) continue;
    out.push({
      id: value.id,
      at: value.at,
      kind: value.kind as SyncEventKind,
      trigger: value.trigger as SyncTriggerReason,
      success: value.success === true,
      pushed: typeof value.pushed === 'number' ? value.pushed : 0,
      pulled: typeof value.pulled === 'number' ? value.pulled : 0,
      applied: typeof value.applied === 'number' ? value.applied : 0,
      conflictCount: typeof value.conflictCount === 'number' ? value.conflictCount : 0,
      skipped: typeof value.skipped === 'number' ? value.skipped : 0,
      failed: typeof value.failed === 'number' ? value.failed : 0,
      detail: typeof value.detail === 'string' ? value.detail : '',
    });
  }
  return out;
}

/**
 * 读全部记录，**最新的在前**（UI 直接渲染即可）。
 *
 * 读取失败返回空数组 —— 记录读不到不是错误态，只是"还没有记录"。
 */
export async function listSyncEvents(): Promise<SyncEventRecord[]> {
  const area = storage();
  if (!area) return [];
  try {
    const stored = await area.get(SYNC_EVENTS_KEY);
    const records = normalizeRecords(stored?.[SYNC_EVENTS_KEY]);
    return records.slice().reverse();
  } catch {
    return [];
  }
}

/**
 * 追加一条记录并做环形裁剪。
 *
 * **永不抛。** 记录失败返回一条内存中的记录即可，调用方不该为此改变任何行为。
 */
export async function appendSyncEvent(
  input: SyncEventInput,
  at: number = Date.now(),
): Promise<SyncEventRecord> {
  const record: SyncEventRecord = {
    id: newEventId(),
    at,
    kind: input.kind,
    trigger: input.trigger,
    success: input.success,
    pushed: input.pushed ?? 0,
    pulled: input.pulled ?? 0,
    applied: input.applied ?? 0,
    conflictCount: input.conflictCount ?? 0,
    skipped: input.skipped ?? 0,
    failed: input.failed ?? 0,
    detail: input.detail ?? '',
  };

  const area = storage();
  if (!area) return record;

  try {
    const stored = await area.get(SYNC_EVENTS_KEY);
    const records = normalizeRecords(stored?.[SYNC_EVENTS_KEY]);
    // 环形裁剪：只留最近 SYNC_EVENT_LIMIT 条。上限定高了就是新的泄漏源。
    const next = [...records, record].slice(-SYNC_EVENT_LIMIT);
    await area.set({ [SYNC_EVENTS_KEY]: next });
  } catch {
    // 故意吞掉：记录失败不影响同步主流程。
  }
  return record;
}

/** 清空全部记录。用于"重置同步"（让这台设备从头开始）。 */
export async function clearSyncEvents(): Promise<void> {
  const area = storage();
  if (!area) return;
  try {
    await area.remove(SYNC_EVENTS_KEY);
  } catch {
    // 同上：清不掉不影响调用方。
  }
}
