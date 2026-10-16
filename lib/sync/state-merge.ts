/**
 * 合并引擎（纯函数，既有约定 决策二/三/四）。
 *
 * 把所有已知状态文档按**逐字段 LWW** 求解成一份全量目标：
 * - 每个可变字段各带版本，赢家是 `ver` 最大的那个（`ver = (clock, 写入方)`）。
 *   两台设备一台改标题、一台改位置，两个改动互不覆盖（沿用 既有约定 的字段级合并）。
 * - 删除闸门：互未见过的"删除 vs 编辑"不自动择一，进人工闸门（修订 既有约定）。
 * - 覆盖日志：被盖掉的字段值必留痕、可一键撤销（修订 既有约定 的落地形态）。
 * - 30 天自动过期是**计算出来**的（deletedAt + 宽限期，跨设备确定），不需要传播；
 *   用户点的彻底清除才是写进文档的粘性字段（purged）。
 */

import { compareVersion, versionSees } from './version';
import {
  SYNC_STATE_FIELDS,
  type StateDocument,
  type SyncNodeState,
  type SyncStateField,
  type Version,
} from '../../types/sync-state';

/** 墓碑宽限期：写死的常量，不可配（不可逆的判定依据必须所有安装一致）。 */
export const TOMB_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** purged 标记的剪枝期：标记本身躺满 90 天从文档里去掉，防无限堆积。 */
export const PURGED_MARKER_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 自动过期打入的版本。
 *
 * 刻意用 `(deletedAt + 宽限期, 'expiry')` 而不是本机时钟：每台设备对同一条墓碑
 * 必须算出**同一个版本**，否则两台设备可能一个判过期一个没判，purged 字段出现
 * 同值不同版的平票，各活各的。墙钟值只在本节点的 purged 字段内部比较，
 * 不参与别的节点的排序。它永远大于真实清除写入的 Lamport 钟——两者值相同
 * （都是 true），没有裁决冲突。
 */
function expiryVersion(node: SyncNodeState): Version {
  return { clock: (node.deletedAt ?? 0) + TOMB_GRACE_MS, writerId: 'expiry' };
}

export interface DeleteGateEntry {
  syncId: string;
  title: string;
  /** 删除候选（互没看过编辑的那个删除写入）。 */
  deleteVersion: Version;
  /** 与删除互未见过的编辑候选（字段 → 值）。 */
  edits: Array<{ field: SyncStateField; value: string | boolean | null; ver: Version }>;
}

export interface OverrideEntry {
  syncId: string;
  field: SyncStateField;
  /** 我文档里的值（被盖掉的那个）。 */
  myValue: string | boolean | null;
  /** 合并后生效的值。 */
  winnerValue: string | boolean | null;
  /** 生效值的写入方（截断显示）。 */
  winnerWriterId: string;
}

export interface MergeInput {
  /** 本机文档（local-diff 的产物，已盖本机时钟）。 */
  mine: StateDocument;
  /** 其他写入方的文档（远端拉取，已 parse 校验）。 */
  remotes: readonly StateDocument[];
  /** 墙上时钟（毫秒），过期判定用。 */
  now: number;
}

export interface MergeResult {
  /** 合并出的全量目标节点集。 */
  nodes: Record<string, SyncNodeState>;
  /** 推进后的时钟 = 全场最大 clock。 */
  clock: number;
  gates: DeleteGateEntry[];
  overrides: OverrideEntry[];
}

function fieldValue(node: SyncNodeState, field: SyncStateField): string | boolean | null {
  switch (field) {
    case 'title':
      return node.title;
    case 'url':
      return node.url;
    case 'parentSyncId':
      return node.parentSyncId;
    case 'logicalRootId':
      return node.logicalRootId;
    case 'position':
      return node.position;
    case 'deleted':
      return node.deleted;
    case 'purged':
      return node.purged;
  }
}

function applyFieldValue(node: SyncNodeState, field: SyncStateField, value: string | boolean | null): void {
  switch (field) {
    case 'title':
      node.title = String(value);
      break;
    case 'url':
      node.url = value as string | null;
      break;
    case 'parentSyncId':
      node.parentSyncId = value as string | null;
      break;
    case 'logicalRootId':
      node.logicalRootId = value as SyncNodeState['logicalRootId'];
      break;
    case 'position':
      node.position = String(value);
      break;
    case 'deleted':
      node.deleted = Boolean(value);
      break;
    case 'purged':
      node.purged = Boolean(value);
      break;
  }
}

export function mergeStateDocs(input: MergeInput): MergeResult {
  const docs: StateDocument[] = [input.mine, ...input.remotes];
  const mine = input.mine;

  const syncIds = new Set<string>();
  for (const doc of docs) {
    for (const syncId of Object.keys(doc.nodes)) syncIds.add(syncId);
  }

  const out: Record<string, SyncNodeState> = {};
  const gates: DeleteGateEntry[] = [];
  const overrides: OverrideEntry[] = [];

  // 时钟推进在节点循环**之外**：空节点集的两份文档也要把 clock 对齐到全场最大，
  // 否则两台都没节点的设备永远追不上对方的计数器。
  let clock = mine.clock;
  for (const doc of docs) {
    if (doc.clock > clock) clock = doc.clock;
  }

  for (const syncId of syncIds) {
    const candidates: SyncNodeState[] = [];
    for (const doc of docs) {
      const node = doc.nodes[syncId];
      if (node) candidates.push(node);
    }
    if (candidates.length === 0) continue;

    // ---- 逐字段 LWW：每个字段独立取赢家（值与版本同一次算出） ----
    const ver = {} as Record<SyncStateField, Version>;
    const merged = { syncId } as SyncNodeState;
    for (const field of SYNC_STATE_FIELDS) {
      let best = candidates[0]!;
      for (const candidate of candidates) {
        if (compareVersion(candidate.ver[field], best.ver[field]) >= 0) best = candidate;
      }
      ver[field] = best.ver[field];
      applyFieldValue(merged, field, fieldValue(best, field));
      if (best.ver[field].clock > clock) clock = best.ver[field].clock;
    }

    // kind 创建时定死，不参与合并；取节点级赢家的（任何候选都一样）。
    let nodeWinner = candidates[0]!;
    for (const candidate of candidates) {
      if (compareVersion(candidate.nv, nodeWinner.nv) >= 0) nodeWinner = candidate;
      if (candidate.nv.clock > clock) clock = candidate.nv.clock;
    }
    merged.kind = nodeWinner.kind;

    // 载荷跟着各自字段的赢家走：删除时刻跟删除字段，purged 时刻跟 purged 字段。
    const deletedWinner = winnerOf(candidates, 'deleted');
    const purgedWinner = winnerOf(candidates, 'purged');
    merged.deletedAt = merged.deleted ? deletedWinner.deletedAt : null;
    merged.purgedAt = merged.purged ? purgedWinner.purgedAt : null;
    merged.ver = ver;
    merged.nv = nodeWinner.nv;
    merged.base = nodeWinner.base;

    // ---- 自动过期（计算出来，确定性） ----
    if (
      merged.deleted &&
      !merged.purged &&
      merged.deletedAt !== null &&
      input.now - merged.deletedAt > TOMB_GRACE_MS
    ) {
      merged.purged = true;
      merged.purgedAt = merged.deletedAt + TOMB_GRACE_MS;
      merged.ver = { ...merged.ver, purged: expiryVersion(merged) };
    }

    // ---- purged 标记剪枝（计算式，既有约定 决策六） ----
    // 标记躺满 90 天就不再进任何文档 ⇒ 这条记录从全空间的视野里消失，标记不会
    // 随每次彻底删除无限堆积。放在**这里**（自动过期之后、覆盖日志与闸门之前）
    // 有三个理由：
    // ① 自动过期刚打上的 purged 也要参与判定 —— deletedAt 很老的墓碑应当在第一次
    //    合并时就当场剪掉，而不是先拍一份标记再加 90 天；
    // ② 剪掉的节点不该再往闸门/覆盖日志里塞条目，它已经没有可裁决的对象了；
    // ③ 应用层早就按这个语义写好了：`planApply` 删除的第二类正是"目标里根本没有、
    //    但映射还在的（**90 天剪枝后从所有文档里消失的节点**）"——浏览器里若还留着
    //    它会这一轮删掉，映射随后按失效映射清掉。
    // 判定只依赖 `purgedAt` 与 `now`，跨设备一致（毫秒级偏差无害：一台先剪、
    // 一台后剪，两边都收敛到"没有"）。
    // 已知代价（既有约定「已知取舍」）：落后 90 天以上才回来的设备手里那条还是活的，
    // 会在它回来那一轮把节点复活一次 —— 这是"防无限堆积"必然的价格。
    if (merged.purged && merged.purgedAt !== null && input.now - merged.purgedAt > PURGED_MARKER_MS) {
      continue;
    }

    // ---- 覆盖日志：赢家不是本机、且值与我文档里的不同 ----
    const myNode = mine.nodes[syncId];
    for (const field of SYNC_STATE_FIELDS) {
      if (ver[field].writerId === mine.writerId) continue; // 本机写的（含本轮本地改动）
      const winnerValue = fieldValue(merged, field);
      const myValue = myNode === undefined ? null : fieldValue(myNode, field);
      if (winnerValue === myValue) continue; // 值没变——只是同一份写入又被看到一次
      overrides.push({ syncId, field, myValue, winnerValue, winnerWriterId: ver[field].writerId });
    }

    // ---- 删除闸门 ----
    const gate = computeGate(syncId, merged, candidates);
    if (gate) gates.push(gate);

    out[syncId] = merged;
  }

  return { nodes: out, clock, gates, overrides };
}

function winnerOf(candidates: readonly SyncNodeState[], field: SyncStateField): SyncNodeState {
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (compareVersion(candidate.ver[field], best.ver[field]) >= 0) best = candidate;
  }
  return best;
}

/**
 * 删除闸门判定。
 *
 * 删除候选 D 与编辑候选 E 互未见过时才拦下来：
 * - E 见过 D ⟺ `versionSees(E.base, D.nv)`；D 见过 E ⟺ `versionSees(D.base, E.nv)`；
 * - 复活写入的 base 恰好是被删节点的 nv（同钟同写入方）——精确判定，不误报；
 * - 落后设备手里的旧状态：D.base 的 clock 严格大——判"见过"，不误报。
 *
 * 同一台设备的两条写入有时序（它的 clock 单调增），不存在"互没看见"，直接跳过。
 */
function computeGate(
  syncId: string,
  merged: SyncNodeState,
  candidates: readonly SyncNodeState[],
): DeleteGateEntry | null {
  const deletes = candidates.filter((candidate) => candidate.deleted);
  if (deletes.length === 0) return null;
  const edits = candidates.filter((candidate) => !candidate.deleted);
  if (edits.length === 0) return null;

  // 删除字段的赢家作为闸门里的删除候选；赢家是"不删"时，删除候选是被盖掉的
  // 删除——同样要让人知道。
  const primaryDelete = winnerOf(deletes, 'deleted');

  const concurrentEdits: DeleteGateEntry['edits'] = [];
  for (const edit of edits) {
    if (edit.nv.writerId === primaryDelete.nv.writerId) continue;
    const editSawDelete = versionSees(edit.base, primaryDelete.nv);
    const deleteSawEdit = versionSees(primaryDelete.base, edit.nv);
    if (editSawDelete || deleteSawEdit) continue; // 有一方见过——因果有序，不是并发
    // 只把"赢家正是这个编辑"的字段摆出来（版本相同 ⟺ 同一条写入）。
    for (const field of SYNC_STATE_FIELDS) {
      if (field === 'deleted' || field === 'purged') continue;
      if (compareVersion(edit.ver[field], merged.ver[field]) === 0) {
        concurrentEdits.push({ field, value: fieldValue(merged, field), ver: edit.ver[field] });
      }
    }
  }

  if (concurrentEdits.length === 0) return null;
  return {
    syncId,
    title: merged.title,
    deleteVersion: primaryDelete.ver.deleted,
    edits: concurrentEdits,
  };
}
