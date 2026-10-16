/**
 * 回收站的用例层（既有约定：墓碑 = 状态文档里的字段，回收站 = 派生视图）。
 *
 * 三条产品规矩原样保留：
 * 1. **恢复不碰历史、只加写入**。恢复一个墓碑就是把 `deleted` 清掉、盖上新时钟，
 *    走正常同步路径推上去 —— 与其它安装看到的"一次普通同步"没有区别。
 *    这也意味着恢复**可以被并发编辑挡下**（删除闸门），那不是 bug。
 * 2. 恢复范围 = 自己 + 祖先链上的墓碑祖先 + 子树里的墓碑后代 —— 这样它才回到
 *    **原来的位置**，否则恢复出来的就是孤儿。
 * 3. 彻底清除 = 打上 `purged` 粘性标记（用户点的与 30 天到期过期共用同一个字段），
 *    范围 = 自己 + 子树里的墓碑后代；**不带祖先**、**不带活着的后代**
 *    （活后代按孤儿规则挂回逻辑根，既有约定）。
 *
 * 相对旧版：没有本机回收站索引了——`deletedAt` 与写入方都在状态文档里
 * （墓碑是数据层事实，回收站是界面层视图，既有约定），索引整个是派生的。
 */

import { clampMoveIndex, computeDepths } from '../lib/sync/state-apply';
import type { StateDocument, SyncNodeState } from '../types/sync-state';
import {
  LOGICAL_ROOT_BAR,
  LOGICAL_ROOT_MOBILE,
  LOGICAL_ROOT_OTHER,
  type NativeMapping,
} from '../types/sync-state';
import {
  createNativeBookmark,
  createNativeFolder,
  moveNativeNode,
  readNativeChildrenCount,
  readSyncTree,
} from './bookmark-sync-adapter';
import { isConfigured, loadSyncConfig } from './sync-config';
import {
  acquireLease,
  putMappings,
  readBaselineDoc,
  readMappings,
  readMeta,
  releaseLease,
} from './sync-store';
import { commitLocalState, newWriterId } from './sync-write';

export interface TrashItem {
  syncId: string;
  kind: 'folder' | 'bookmark';
  title: string;
  url: string | null;
  parentSyncId: string | null;
  logicalRootId: string;
  /** 删除时刻（执行删除那台设备的墙上时钟）。 */
  deletedAt: number | null;
  /** 谁删的（截断显示）。 */
  writerId: string | null;
}

export interface TrashView {
  /** 墓碑档：同步已经接手、躺在回收站里的。 */
  tombs: TrashItem[];
  /** 待同步档：本机删了、同步还没接手的（派生，零存储，既有约定）。 */
  pending: TrashItem[];
}

function toItem(syncId: string, node: SyncNodeState): TrashItem {
  return {
    syncId,
    kind: node.kind,
    title: node.title,
    url: node.url,
    parentSyncId: node.parentSyncId,
    logicalRootId: node.logicalRootId,
    deletedAt: node.deletedAt,
    writerId: node.ver.deleted.writerId === 'expiry' ? null : node.ver.deleted.writerId.slice(0, 8),
  };
}

/** 回收站视图：墓碑档 + 待同步档，全部从基线文档与原生树派生。 */
export async function readTrashView(): Promise<TrashView> {
  const baseline = await readBaselineDoc();
  if (!baseline) return { tombs: [], pending: [] };

  const tombs: TrashItem[] = [];
  for (const [syncId, node] of Object.entries(baseline.nodes)) {
    if (!node.deleted || node.purged) continue;
    tombs.push(toItem(syncId, node));
  }

  // 待同步档：基线里活着、映射指向的原生书签已经不在真实书签树里的。
  // 同步一跑完，节点成了墓碑，它自动消失。
  const config = await loadSyncConfig();
  const enabled = isConfigured(config) ? config.enabledRoots : [LOGICAL_ROOT_BAR, LOGICAL_ROOT_OTHER];
  const tree = await readSyncTree(enabled);
  const presentNativeIds = new Set(tree.nodes.map((node) => node.nativeId));
  const mappings = await readMappings();
  const pending: TrashItem[] = [];
  for (const entry of mappings) {
    if (!enabled.includes(entry.logicalRootId)) continue;
    if (presentNativeIds.has(entry.nativeId)) continue;
    const node = baseline.nodes[entry.syncId];
    if (!node || node.deleted || node.purged) continue;
    pending.push(toItem(entry.syncId, node));
  }

  return { tombs, pending };
}

/** 收集恢复目标：自己 + 祖先链上的墓碑祖先 + 子树里的墓碑后代。 */
export function collectRestoreTargets(
  nodes: Record<string, SyncNodeState>,
  roots: readonly string[],
): string[] {
  const out = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (const [syncId, node] of Object.entries(nodes)) {
    if (node.parentSyncId === null) continue;
    const list = childrenOf.get(node.parentSyncId);
    if (list) list.push(syncId);
    else childrenOf.set(node.parentSyncId, [syncId]);
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const syncId = stack.pop();
    if (syncId === undefined || out.has(syncId)) continue;
    out.add(syncId);
    const node = nodes[syncId];
    if (!node) continue;
    // 墓碑祖先：恢复它要连祖先一起，否则恢复出来是孤儿。
    let parent = node.parentSyncId;
    while (parent !== null) {
      const parentNode = nodes[parent];
      if (!parentNode || !parentNode.deleted) break;
      if (!out.has(parent)) {
        out.add(parent);
        stack.push(parent);
      }
      parent = parentNode.parentSyncId;
    }
    // 墓碑后代：子树里的墓碑一起恢复，位置才完整。
    for (const child of childrenOf.get(syncId) ?? []) {
      const childNode = nodes[child];
      if (childNode?.deleted) stack.push(child);
    }
  }
  return [...out];
}

export interface RestorePreview {
  /** 会一起恢复的节点数（含祖先与后代）。 */
  targetCount: number;
  /** 其中"额外"带出来的（祖先 + 后代）。 */
  extraCount: number;
}

export async function previewRestore(syncIds: readonly string[]): Promise<RestorePreview> {
  const baseline = await readBaselineDoc();
  if (!baseline) return { targetCount: 0, extraCount: 0 };
  const targets = collectRestoreTargets(baseline.nodes, syncIds);
  return { targetCount: targets.length, extraCount: Math.max(0, targets.length - syncIds.length) };
}

/**
 * 墓碑恢复：清掉 `deleted` 标记，盖上本机新时钟，整份上传。
 *
 * 不推历史操作、不走网络重放——就是一次普通的本地写入，随下一轮合并传播。
 */
export async function restoreFromTrash(syncIds: readonly string[]): Promise<void> {
  const baseline = await readBaselineDoc();
  if (!baseline) return;
  const targets = collectRestoreTargets(baseline.nodes, syncIds);
  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
  const write = { clock: baseline.clock + 1, writerId };

  const nodes = { ...baseline.nodes };
  for (const syncId of targets) {
    const node = nodes[syncId];
    if (!node) continue;
    nodes[syncId] = {
      ...node,
      deleted: false,
      deletedAt: null,
      ver: { ...node.ver, deleted: write },
      nv: write,
      base: node.nv,
    };
  }
  await commitLocalState(nodes);
}

/**
 * 待同步就地恢复：删除还没离开这台机器，把原生书签重建出来、
 * 再把映射换绑到新的原生 id，就等于撤销 —— **零网络**。
 *
 * 先创建后换映射：拿租约后再校验一次"原生树里确实没有、基线里确实活着"。
 */
export async function restorePendingFromTrash(syncIds: readonly string[]): Promise<void> {
  const baseline = await readBaselineDoc();
  if (!baseline) return;
  const config = await loadSyncConfig();
  const tree = await readSyncTree(config.enabledRoots);
  const presentNativeIds = new Set(tree.nodes.map((node) => node.nativeId));
  const mappings = await readMappings();
  const mappingBySync = new Map(mappings.map((entry) => [entry.syncId, entry]));

  const owner = `recreate-${newWriterId().slice(0, 8)}`;
  if (!(await acquireLease(owner))) throw new Error('已有一次同步在进行中，请稍后再试。');
  try {
    const depths = computeDepths(Object.values(baseline.nodes));
    // 父先于子：按深度升序处理，父建好了子才有地方挂。
    const targets = syncIds
      .filter((syncId) => {
        const node = baseline.nodes[syncId];
        if (!node || node.deleted || node.purged) return false;
        const entry = mappingBySync.get(syncId);
        return !entry || !presentNativeIds.has(entry.nativeId);
      })
      .sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));

    const createdBySync = new Map<string, string>();
    const nextMappings: NativeMapping[] = [];
    // 父的原生 id：本轮刚建出来的 > 映射里且原生树里还在的。
    const resolveParentNative = (parentSyncId: string): string | undefined => {
      const created = createdBySync.get(parentSyncId);
      if (created) return created;
      const entry = mappingBySync.get(parentSyncId);
      if (entry && presentNativeIds.has(entry.nativeId)) return entry.nativeId;
      return undefined;
    };
    for (const syncId of targets) {
      const node = baseline.nodes[syncId]!;
      const parentNativeId =
        node.parentSyncId === null
          ? tree.rootIds[node.logicalRootId]
          : resolveParentNative(node.parentSyncId);
      if (!parentNativeId) continue;

      const nativeId =
        node.kind === 'folder'
          ? await createNativeFolder(parentNativeId, node.title)
          : await createNativeBookmark(parentNativeId, node.title, node.url ?? '');
      createdBySync.set(syncId, nativeId);

      // 位置尽力还原：同父下按目标排序键算下标（收敛防越界）。
      const siblings = Object.values(baseline.nodes).filter(
        (item) =>
          !item.deleted &&
          item.parentSyncId === node.parentSyncId &&
          item.logicalRootId === node.logicalRootId,
      );
      siblings.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      const index = siblings.findIndex((item) => item.syncId === syncId);
      if (index > 0) {
        const count = await readNativeChildrenCount(parentNativeId);
        await moveNativeNode(nativeId, parentNativeId, clampMoveIndex(index, count));
      }

      nextMappings.push({
        nativeId,
        syncId,
        logicalRootId: node.logicalRootId,
        title: node.title,
        ...(node.url === null ? {} : { url: node.url }),
        parentNativeId,
        index: Math.max(0, index),
        updatedAt: Date.now(),
      });
    }
    if (nextMappings.length > 0) await putMappings(nextMappings);
    // 基线不动：本地实况已经和基线一致（没有删除、没有墓碑）。
  } finally {
    await releaseLease(owner);
  }
}

export interface PurgePreview {
  /** 会一起清除的节点数（子树里的墓碑后代）。 */
  targetCount: number;
  /** 会被挂回逻辑根的活后代数（界面要把这个数说出来，既有约定）。 */
  livingDescendants: number;
}

export async function previewPurge(syncIds: readonly string[]): Promise<PurgePreview> {
  const baseline = await readBaselineDoc();
  if (!baseline) return { targetCount: 0, livingDescendants: 0 };
  const { targets, living } = collectPurgeTargets(baseline.nodes, syncIds);
  return { targetCount: targets.length, livingDescendants: living };
}

/**
 * 收集彻底清除目标：自己 + 子树里的墓碑后代。
 * **不带祖先**（牵连无辜）、**不带活着的后代**（它们按孤儿规则挂回逻辑根）。
 */
export function collectPurgeTargets(
  nodes: Record<string, SyncNodeState>,
  roots: readonly string[],
): { targets: string[]; living: number } {
  const childrenOf = new Map<string, string[]>();
  for (const [syncId, node] of Object.entries(nodes)) {
    if (node.parentSyncId === null) continue;
    const list = childrenOf.get(node.parentSyncId);
    if (list) list.push(syncId);
    else childrenOf.set(node.parentSyncId, [syncId]);
  }

  const targets = new Set<string>();
  let living = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const syncId = stack.pop();
    if (syncId === undefined || targets.has(syncId)) continue;
    const node = nodes[syncId];
    if (!node) continue;
    targets.add(syncId);
    for (const child of childrenOf.get(syncId) ?? []) {
      const childNode = nodes[child];
      if (!childNode) continue;
      if (childNode.deleted) {
        if (!childNode.purged) stack.push(child);
      } else {
        living += 1;
      }
    }
  }
  return { targets: [...targets], living };
}

/**
 * 彻底清除：打上 `purged` 粘性标记并上传。
 *
 * 粘性是因为**单纯从状态里移除无法传播**——别人的文档里还有它，下一轮合并
 * 又会把它拉回来。标记由下一轮同步的应用层从浏览器里删掉。
 */
export async function purgeFromTrash(syncIds: readonly string[]): Promise<void> {
  const baseline = await readBaselineDoc();
  if (!baseline) return;
  const { targets } = collectPurgeTargets(baseline.nodes, syncIds);
  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
  const write = { clock: baseline.clock + 1, writerId };
  const now = Date.now();

  const nodes = { ...baseline.nodes };
  for (const syncId of targets) {
    const node = nodes[syncId];
    if (!node) continue;
    nodes[syncId] = {
      ...node,
      purged: true,
      purgedAt: now,
      ver: { ...node.ver, purged: write },
      nv: write,
      base: node.nv,
    };
  }
  await commitLocalState(nodes);
}

/** 清空整个回收站（墓碑档全部彻底清除）。 */
export async function purgeAllFromTrash(): Promise<{ purged: number }> {
  const baseline = await readBaselineDoc();
  if (!baseline) return { purged: 0 };
  const all = Object.entries(baseline.nodes)
    .filter(([, node]) => node.deleted && !node.purged)
    .map(([syncId]) => syncId);
  if (all.length === 0) return { purged: 0 };
  await purgeFromTrash(all);
  return { purged: all.length };
}

/** 到期自动彻底清除：由合并时的计算式过期负责（见 state-merge.ts），这里只留给后台入口。 */
export async function purgeExpiredTrash(): Promise<void> {
  // 过期在合并时按 deletedAt + 30 天确定性计算，跑一轮同步即生效并传播。
  const { runSync } = await import('./sync-engine');
  await runSync('trash-expiry');
}
