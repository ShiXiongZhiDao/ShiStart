/**
 * 应用计划（纯函数，既有约定 决策一的"应用"步）。
 *
 * 把合并出的全量目标翻译成对浏览器的有序写入步骤。从旧 diff.ts 的 planApply
 * 移植，两条命都保留原样：
 * - 顺序：先建文件夹（父在子前）→ 再建书签 → 改标题/网址 → 移动排序 → **最后**删
 *   （删除放最后，中途失败也不会留下一个被删空一半的树）；
 * - `clampMoveIndex`：执行时按真实子节点数收敛，防 `Index out of bounds.`
 *   让整次同步失败。
 *
 * 与旧模型的区别：目标是确定的全量文档、diff 幂等——**不设应用日志**，
 * worker 中途被杀后下一轮重算自然续上（既有约定 决策一）。
 */

import type { NativeMapping } from '../../types/sync-state';
import type { LogicalRootId, NodeType, SyncNodeState } from '../../types/sync-state';

export interface NativeNodeView {
  nativeId: string;
  parentNativeId: string | null;
  logicalRootId: LogicalRootId;
  type: NodeType;
  title: string;
  url?: string;
  index: number;
}

export type ApplyAction = 'create-folder' | 'create-bookmark' | 'update' | 'move' | 'delete';

export interface ApplyStep {
  stepId: string;
  action: ApplyAction;
  syncId: string;
  /** 已有原生节点才有；新建时由执行阶段回填。 */
  nativeId?: string;
  title?: string;
  url?: string;
  /** 逻辑根用该根在浏览器里的原生 id；本次新建的父用占位符（见下）。 */
  parentNativeId?: string;
  index?: number;
  done: boolean;
}

export interface ApplyPlan {
  steps: ApplyStep[];
  /**
   * **失效映射**的原生 id：映射里有、但浏览器里已经没有这个节点了
   * （典型是用户在浏览器书签管理器里手工删掉的）。上层必须清掉——
   * 留着会让下一轮以为"本地已经有了"，该建的永远建不出来。
   */
  staleNativeIds: string[];
}

export interface PlanInput {
  /** 合并后的全量目标。 */
  target: Record<string, SyncNodeState>;
  /** 当前原生树（readSyncTree 的产物）。 */
  nodes: readonly NativeNodeView[];
  mappings: readonly NativeMapping[];
  /** 逻辑根 → 原生根 id。 */
  rootIds: Readonly<Record<string, string>>;
  enabledRoots: readonly string[];
}

/** 计划阶段还不知道新父节点的原生 id，先写占位符。冒号结尾：原生 id 是全数字，撞不上。 */
const PENDING_NATIVE_PREFIX = 'pending-sync:';

/**
 * 一个 syncId 在本机浏览器里**真的还在**的原生 id；不在就是 undefined。
 *
 * 不能只看映射：映射是上一次同步落盘的，用户随时可能在浏览器里手工删掉某个书签。
 * 拿失效映射当"本地已经有了"，该删的会去删一个不存在的 id（浏览器直接抛错，
 * 整次同步失败），该建的会因为"以为已经有了"而永远建不出来。
 */
function liveNativeOf(
  syncId: string,
  nativeBySync: Map<string, string>,
  nativeById: Map<string, NativeNodeView>,
): string | undefined {
  const nativeId = nativeBySync.get(syncId);
  if (nativeId === undefined) return undefined;
  return nativeById.has(nativeId) ? nativeId : undefined;
}

export function planApply(input: PlanInput): ApplyPlan {
  const enabled = new Set(input.enabledRoots);
  const nativeBySync = new Map<string, string>();
  for (const entry of input.mappings) nativeBySync.set(entry.syncId, entry.nativeId);

  const nativeById = new Map<string, NativeNodeView>();
  for (const node of input.nodes) nativeById.set(node.nativeId, node);

  // 存活 = 没删、没被彻底清除、且在参与同步的根里。
  const alive: SyncNodeState[] = [];
  for (const node of Object.values(input.target)) {
    if (node.deleted || node.purged) continue;
    if (!enabled.has(node.logicalRootId)) continue;
    alive.push(node);
  }

  // 深度对**全部**目标节点算，不只活节点：purged 的子树也要按"深的先删"排
  // （父节点非空时浏览器拒绝删除）。只对 alive 算会让墓碑的深度全是 0。
  const depthOf = computeDepths(Object.values(input.target));

  // 每一层里期望的顺序（按排序键排）。
  const orderByParent = new Map<string, SyncNodeState[]>();
  for (const node of alive) {
    const key = `${node.logicalRootId}|${node.parentSyncId ?? ''}`;
    const list = orderByParent.get(key);
    if (list) list.push(node);
    else orderByParent.set(key, [node]);
  }
  for (const list of orderByParent.values()) {
    list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  }

  const steps: ApplyStep[] = [];
  const stepId = (prefix: string, syncId: string): string => `${prefix}:${syncId}`;

  // 映射失效的节点也按"还没有"处理——它会在这轮被重新创建出来。
  const pending = alive.filter((node) => liveNativeOf(node.syncId, nativeBySync, nativeById) === undefined);
  const creatable = new Set<string>();

  // 父 nativeId 的解析：父是逻辑根时用该根在浏览器里的原生 id；
  // 父是本次要新建的节点时先给占位符，执行阶段再换成刚建出来的真实 id。
  const nativeParentOf = (node: SyncNodeState): string | undefined => {
    if (node.parentSyncId === null) return input.rootIds[node.logicalRootId];
    const known = liveNativeOf(node.parentSyncId, nativeBySync, nativeById);
    if (known) return known;
    if (creatable.has(node.parentSyncId)) return `${PENDING_NATIVE_PREFIX}${node.parentSyncId}`;
    // 父自己都建不出来（它的父链断了），整条链一起放弃。
    return undefined;
  };

  // 新建节点的**落点必须按目标顺序**：创建顺序 = 深度升序 → 同父内按 position 升序，
  // 并且每一条都带上它在目标顺序里的下标，执行时**插到那个位置**（追加到末尾是不够的）。
  //
  // 为什么非这样不可：move 只能修**已经存在**的节点（`nativeById` 取自应用前的树，
  // 新建的节点不在里面 ⇒ 永远排不到 move）。所以新建兄弟的最终顺序 = 创建顺序。
  // 老写法"先建全部文件夹、再建全部书签"，等于把任何"文件夹夹着书签"的层拆成两段 ——
  // 一台全新设备加入时顺序就复现不出来（用户报过：两台机器书签与文件夹顺序都不一样）。
  //
  // 深度升序同时保证"父先于子"（父的深度必然更小），所以文件夹与书签可以合在一个循环里。
  const targetIndexOf = (node: SyncNodeState): number => {
    const siblings = orderByParent.get(`${node.logicalRootId}|${node.parentSyncId ?? ''}`) ?? [];
    return siblings.findIndex((item) => item.syncId === node.syncId);
  };
  const pendingOrdered = pending
    .map((node) => ({ node, depth: depthOf.get(node.syncId) ?? 0, index: targetIndexOf(node) }))
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      // 同深度但不同父：按父的 syncId 排，只要**确定**就行（两边算出的顺序一致）。
      const parentA = a.node.parentSyncId ?? '';
      const parentB = b.node.parentSyncId ?? '';
      if (parentA !== parentB) return parentA < parentB ? -1 : 1;
      return a.index - b.index;
    });

  for (const entry of pendingOrdered) {
    const node = entry.node;
    const parentNativeId = nativeParentOf(node);
    if (!parentNativeId) continue; // 父链断了：整条链一起放弃（连同它的子树）
    creatable.add(node.syncId);
    const isFolder = node.kind === 'folder';
    steps.push({
      stepId: stepId(isFolder ? 'create-folder' : 'create-bookmark', node.syncId),
      action: isFolder ? 'create-folder' : 'create-bookmark',
      syncId: node.syncId,
      title: node.title,
      ...(isFolder ? {} : { url: node.url ?? '' }),
      parentNativeId,
      index: Math.max(0, entry.index),
      done: false,
    });
  }

  for (const node of alive) {
    const nativeId = nativeBySync.get(node.syncId);
    if (!nativeId) continue;
    const current = nativeById.get(nativeId);
    if (!current) continue;
    const titleChanged = current.title !== node.title;
    const urlChanged = node.kind === 'bookmark' && (current.url ?? '') !== (node.url ?? '');
    if (titleChanged || urlChanged) {
      steps.push({
        stepId: stepId('update', node.syncId),
        action: 'update',
        syncId: node.syncId,
        nativeId,
        ...(titleChanged ? { title: node.title } : {}),
        ...(urlChanged ? { url: node.url ?? '' } : {}),
        done: false,
      });
    }
  }

  for (const node of alive) {
    const nativeId = nativeBySync.get(node.syncId);
    if (!nativeId) continue;
    const current = nativeById.get(nativeId);
    const parentNativeId = nativeParentOf(node);
    if (!parentNativeId || !current) continue;

    // 直接挂在逻辑根下的节点，`readSyncTree` 填的 `parentNativeId` 就是 `null`
    // （哨兵值，见该函数）。这里必须用同一种表示来比：拿根的原生 id（'1'）去比
    // 会让**每一条顶层书签每一轮都被判成"父变了"**，各排一个多余的 move ——
    // 稳态一轮凭空产生 N 个写入（同步永远收敛不了，还刷请求）。
    const expectedParentNative =
      node.parentSyncId === null
        ? null
        : (nativeBySync.get(node.parentSyncId) ?? null);
    const siblings = orderByParent.get(`${node.logicalRootId}|${node.parentSyncId ?? ''}`) ?? [];
    const expectedIndex = siblings.findIndex((item) => item.syncId === node.syncId);

    if (current.parentNativeId !== expectedParentNative || current.index !== expectedIndex) {
      steps.push({
        stepId: stepId('move', node.syncId),
        action: 'move',
        syncId: node.syncId,
        nativeId,
        parentNativeId,
        index: Math.max(0, expectedIndex),
        done: false,
      });
    }
  }

  // ---- 删除（放最后） ----
  // 两类：①目标里标记 purged 的（用户彻底清除 / 30 天到期过期）；
  // ②目标里根本没有、但映射还在的（90 天剪枝后从所有文档里消失的节点）。
  // 第②类安全的前提：每份文档都是全量状态，"目标里没有"只可能是所有设备都
  // 剪枝了它——它确实没了。旧模型"target 会明显小于本地实况"的顾虑
  // 在快照模型里结构性不存在。
  //
  // 失效映射统一在这里收：映射里有的原生 id，浏览器里已经没有了。留着会让
  // 下一轮以为"本地已经有了"——该建的永远建不出来（既有约定 同源的坑）。
  const staleNativeIds: string[] = [];
  for (const entry of input.mappings) {
    if (!nativeById.has(entry.nativeId)) staleNativeIds.push(entry.nativeId);
  }

  const toDelete: Array<{ syncId: string; nativeId: string; depth: number }> = [];

  for (const node of Object.values(input.target)) {
    if (!node.purged) continue;
    if (!enabled.has(node.logicalRootId)) continue;
    const nativeId = nativeBySync.get(node.syncId);
    if (nativeId === undefined) continue;
    if (nativeById.has(nativeId)) {
      toDelete.push({ syncId: node.syncId, nativeId, depth: depthOf.get(node.syncId) ?? 0 });
    }
  }

  for (const entry of input.mappings) {
    if (!enabled.has(entry.logicalRootId)) continue;
    if (input.target[entry.syncId]) continue; // 目标里还有（含墓碑）——不是剪枝消失
    if (!nativeById.has(entry.nativeId)) continue; // 浏览器里本来就没有——失效映射已收
    if (steps.some((step) => step.action === 'delete' && step.syncId === entry.syncId)) continue;
    toDelete.push({ syncId: entry.syncId, nativeId: entry.nativeId, depth: 0 });
  }

  // 深的先删：父节点非空时浏览器会拒绝删除。
  toDelete.sort((a, b) => b.depth - a.depth);
  for (const entry of toDelete) {
    steps.push({
      stepId: stepId('delete', entry.syncId),
      action: 'delete',
      syncId: entry.syncId,
      nativeId: entry.nativeId,
      done: false,
    });
  }

  return { steps, staleNativeIds };
}

/**
 * 把 `move` 的目标位置钳进浏览器接受的区间。
 *
 * `planApply` 算出的 `index` 是"在**目标**顺序里的第几位"，执行时的父节点下当前
 * 实际有几个子节点完全可能与之不同。实测边界（Chrome 154，既有约定）：
 * - `index === 子节点数` 合法（追加到末尾）；
 * - `index > 子节点数` 抛 `Index out of bounds.`；
 * - 跨父移动时浏览器按"摘除前"的计数校验，所以即便算式上正好是追加位也可能越界。
 *
 * 因此上界统一取更保守的 `子节点数 - 1`；`index` 偏小只会让顺序靠前，
 * 下一轮同步会用准确位置再纠正一次——宁可多一次 move，不要让整次同步失败。
 */
export function clampMoveIndex(index: number, siblingCount: number): number {
  const safeCount = Number.isFinite(siblingCount) ? Math.max(0, Math.trunc(siblingCount)) : 0;
  const upper = safeCount === 0 ? 0 : safeCount - 1;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), upper);
}

/** 每个节点到逻辑根的距离。显式栈，不用递归。 */
export function computeDepths(nodes: readonly SyncNodeState[]): Map<string, number> {
  const bySync = new Map(nodes.map((node) => [node.syncId, node]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  for (const node of nodes) {
    if (depths.has(node.syncId)) continue;
    const chain: string[] = [];
    let cursor: string | null = node.syncId;
    while (cursor !== null && !depths.has(cursor) && !visiting.has(cursor)) {
      visiting.add(cursor);
      chain.push(cursor);
      cursor = bySync.get(cursor)?.parentSyncId ?? null;
    }
    let depth = cursor === null ? 0 : (depths.get(cursor) ?? 0);
    for (let at = chain.length - 1; at >= 0; at -= 1) {
      depth += 1;
      const id = chain[at];
      if (id) depths.set(id, depth);
    }
    visiting.clear();
  }
  return depths;
}
