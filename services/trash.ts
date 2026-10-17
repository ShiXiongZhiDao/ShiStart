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
import { positionsFor } from '../lib/sync/position';
import { TOMB_GRACE_MS } from '../lib/sync/state-merge';
import type { NativeSubtreeNode } from '../lib/folder/delete-preview';
import {
  SYNC_STATE_FIELDS,
  SYNC_STATE_FORMAT,
  SYNC_STATE_VERSION,
  type LogicalRootId,
  type NativeMapping,
  type NodeType,
  type StateDocument,
  type SyncNodeState,
  type SyncStateField,
  type Version,
} from '../types/sync-state';
import {
  createNativeBookmark,
  createNativeFolder,
  moveNativeNode,
  readNativeChildrenCount,
  readSyncTree,
} from './bookmark-sync-adapter';
import { isConfigured, loadSyncConfig, effectiveEnabledRoots } from './sync-config';
import {
  acquireLease,
  putMappings,
  readBaselineDoc,
  readMappings,
  readMeta,
  releaseLease,
  removeMappings,
  writeBaselineDoc,
  writeMeta,
} from './sync-store';
import { commitLocalState, newWriterId } from './sync-write';
import type { NativeAncestor } from './bookmark-edit';

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

/**
 * 修一类已落库的错档（2026-10-17 的 bug）：书签被记成了 `folder`。
 *
 * 当初判 kind 用了 `Array.isArray(node.children)`，而单点子树带着 `children: []` ——
 * 删书签全记成文件夹，回收站里是文件夹图标、恢复出来是空文件夹。**墓碑里的 url 还在**，
 * `kind === 'folder' && url !== null` 这个组合在正确数据里不可能出现，据此识别、改回 bookmark。
 *
 * `kind` 不是参与合并的字段（创建时定死），本机改它不产生版本冲突。
 * 返回修了几条。
 */
export async function repairLocalTombKinds(): Promise<number> {
  const baseline = await readBaselineDoc();
  if (!baseline) return 0;

  const broken: string[] = [];
  for (const [syncId, node] of Object.entries(baseline.nodes)) {
    if (node.kind === 'folder' && node.url !== null) broken.push(syncId);
  }
  if (broken.length === 0) return 0;

  const nodes = { ...baseline.nodes };
  for (const syncId of broken) {
    nodes[syncId] = { ...nodes[syncId]!, kind: 'bookmark' };
  }
  await commitLocalState(nodes);
  return broken.length;
}

/**
 * 修一类已落库的错链（2026-10-17 的 bug）：子项的 `parentSyncId` 是空的。
 *
 * 当初记录器给子孙排队时把父链丢了（父的 syncId 还没定就入队，出队时没回填），
 * 于是"删文件夹 + 内容"记下的是几条**互不相干**的墓碑：恢复文件夹收不到它们，
 * 它们的"原位置"也显示成书签栏。**映射里还留着当时的原生父 id**，据此能确定地
 * 挂回去（子项映射的原生父 = 某个墓碑/祖先映射的原生 id；一级目录不写映射，查不到就留着）。
 *
 * ⚠️ **只碰本机基线的 `parentSyncId` 一个字段**：恢复点（设置页的「历史版本」快照）
 * 一个字节都不动 —— 那是用户的历史存档，不该被一次数据修复重写。
 *
 * `parentSyncId` 不必盖新版本：下一轮本地对账会按真实书签树重算它，对账才是权威。
 * 返回修了几条。
 */
export async function repairTrashParentChains(): Promise<number> {
  const baseline = await readBaselineDoc();
  if (!baseline) return 0;

  const mappings = await readMappings();
  const syncIdByNative = new Map(mappings.map((entry) => [entry.nativeId, entry.syncId]));
  const mappingBySync = new Map(mappings.map((entry) => [entry.syncId, entry]));

  const repaired: Array<{ syncId: string; parentSyncId: string }> = [];
  for (const [syncId, node] of Object.entries(baseline.nodes)) {
    if (node.parentSyncId !== null) continue;
    const entry = mappingBySync.get(syncId);
    if (!entry || !entry.parentNativeId) continue;
    const parentSyncId = syncIdByNative.get(entry.parentNativeId);
    if (!parentSyncId || parentSyncId === syncId) continue;
    // 父必须是基线里认识的节点（墓碑，或补出来的祖先）。一级目录没有映射，查不到，正好留着 null。
    if (!baseline.nodes[parentSyncId]) continue;
    repaired.push({ syncId, parentSyncId });
  }
  if (repaired.length === 0) return 0;

  const nodes = { ...baseline.nodes };
  for (const item of repaired) {
    nodes[item.syncId] = { ...nodes[item.syncId]!, parentSyncId: item.parentSyncId };
  }
  await commitLocalState(nodes);
  return repaired.length;
}

/**
 * 回收站视图：墓碑档 + 待同步档，全部从基线文档与原生树派生。
 *
 * **不在读视图时发网络请求**（"待同步"那一档也是本地对账算出来的）—— 唯一的写是
 * 顺手做的三件维修（`repairLocalTombKinds` / `repairTrashParentChains` /
 * `expireLocalTombs`）：分别修错档、修断掉的父链、补 30 天到期；失败都只当没做，
 * 不让它们把视图弄成错误态。三件都是**修本机基线**，不碰恢复点。
 *
 * 失败不能只吞掉：读不到时如果显示成"一条都没有"，用户会以为东西真没了——
 * 那是把"读不到"伪装成"不存在"。
 */
export async function readTrashView(): Promise<TrashView> {
  try {
    await repairLocalTombKinds();
    await repairTrashParentChains();
    await expireLocalTombs();
  } catch {
    // 维修动作失败不影响看回收站：错档的卡片还是点得动，下次读再修。
  }

  const baseline = await readBaselineDoc();
  if (!baseline) return { tombs: [], pending: [] };

  const now = Date.now();
  const tombs: TrashItem[] = [];
  for (const [syncId, node] of Object.entries(baseline.nodes)) {
    if (!node.deleted || node.purged) continue;
    // 躺满宽限期的墓碑等价于已彻底清除（合并时算的就是这一条，既有约定）——
    // 视图与角标都不该再显示它。配了同步的用户由下一轮合并落库，两边同一公式。
    if (node.deletedAt !== null && now - node.deletedAt > TOMB_GRACE_MS) continue;
    tombs.push(toItem(syncId, node));
  }

  // 待同步档：基线里活着、映射指向的原生书签已经不在真实书签树里的。
  // 同步一跑完，节点成了墓碑，它自动消失。
  const config = await loadSyncConfig();
  const enabled = effectiveEnabledRoots(config);
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

/**
 * 本机过期（既有约定 补，2026-10-17）：躺满 30 天的墓碑打上 `purged` 标记。
 *
 * 为什么需要：宽限期原本是**同步合并时算出来**的（既有约定 / `mergeStateDocs`）——
 * 没配同步的用户没有合并，墓碑会无限期躺在回收站里。用户报过这个疑虑。
 *
 * 与合并路径**同一公式**（`deletedAt + 30 天`、写入方 `'expiry'`，跨设备确定）：
 * 本机打过标，重连后合并看到的正是远端也会算出的同一个版本 —— 平票同值，
 * 不冲突、不误拦（`state-merge` 的过期注释原样适用）。配了同步的用户不在这里
 * 过期（合并负责），避免读一次回收站就上传一份状态。
 *
 * 返回过期条数。零网络（`commitLocalState` 未配置时只落本机）。
 */
export async function expireLocalTombs(now: number = Date.now()): Promise<number> {
  const config = await loadSyncConfig();
  if (isConfigured(config)) return 0; // 同步路径的合并负责过期（同公式，结果一致）

  const baseline = await readBaselineDoc();
  if (!baseline) return 0;

  const expired: string[] = [];
  for (const [syncId, node] of Object.entries(baseline.nodes)) {
    if (!node.deleted || node.purged) continue;
    if (node.deletedAt === null) continue;
    if (now - node.deletedAt <= TOMB_GRACE_MS) continue;
    expired.push(syncId);
  }
  if (expired.length === 0) return 0;

  const nodes = { ...baseline.nodes };
  for (const syncId of expired) {
    const node = nodes[syncId]!;
    const at = (node.deletedAt ?? 0) + TOMB_GRACE_MS;
    nodes[syncId] = {
      ...node,
      purged: true,
      purgedAt: at,
      // 只动 purged 一个字段（与 mergeStateDocs 的过期同一形状）：nv / base 不碰，
      // 免得在版本向量里造出一次合并看不明白的写入。
      ver: { ...node.ver, purged: { clock: at, writerId: 'expiry' } },
    };
  }
  await commitLocalState(nodes);
  return expired.length;
}

// ---------------------------------------------------------------- 本机墓碑

/** 一次删除要记进本机墓碑的内容：子树 + 它原来的位置。 */
export interface LocalTombstoneInput {
  /** 子树根在被删前的原生父节点；null = 直接挂在逻辑根下。 */
  parentNativeId: string | null;
  logicalRootId: LogicalRootId;
  /** 子树根在原生死序中的下标。 */
  index: number;
  /** 子树（书签 = 没有 children 的单点；文件夹 = readNativeSubtree 的产物）。 */
  subtree: NativeSubtreeNode;
  /** 从子树根的父到逻辑根的祖先链（readNativeLocation 的产物），从近到远。 */
  ancestors: readonly NativeAncestor[];
}

/**
 * 没配同步时，把一次删除记进**本机基线**的墓碑档。
 *
 * 为什么需要：删除写通道历来只调浏览器 API，墓碑靠"下一轮同步对账"产生
 * 。没配同步的用户没有下一轮 —— 删掉即永久消失，回收站永远是空的。
 * 而墓碑的真相本来就可以只在本机：恢复是"重建原生书签 + 换绑映射"，
 * 零网络、不需要服务器。
 *
 * 三条边界：
 * - **配了同步就不写**（返回 0）—— 对账流会产出墓碑，不抢着写；
 * - **有同步身份（有映射）的节点不写** —— 它的删除归待同步档与将来的对账，
 *   断开配置的用户照常走那条路；没有身份的（从没同步过 / 断开后新建）才由这条路径记；
 * - **祖先链补成活节点**（只补没有身份的）—— 否则嵌套删除的墓碑认不回原来的
 *   父文件夹，恢复出来会挂到逻辑根下，回收站里的"原位置"也会说错。这些节点
 *   浏览器里还在，恢复时按"原生还在"跳过，不会重复创建。
 *
 * 返回记进去的墓碑条数。
 */
export async function recordLocalTombstones(input: LocalTombstoneInput): Promise<number> {
  const config = await loadSyncConfig();
  if (isConfigured(config)) return 0;

  const existingMappings = await readMappings();
  const mappedSyncByNative = new Map(existingMappings.map((entry) => [entry.nativeId, entry.syncId]));

  const baseline = await readBaselineDoc();
  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
  // 固定本机写入身份：「谁删的」按它认，将来说不定还要进删除闸门。没同步过的用户这里是第一次写。
  if (meta.writerId === '') await writeMeta({ writerId });

  const now = Date.now();
  const write: Version = { clock: (baseline?.clock ?? 0) + 1, writerId };
  const nodes: Record<string, SyncNodeState> = { ...(baseline?.nodes ?? {}) };
  const freshMappings: NativeMapping[] = [];
  /** nativeId → syncId：本批次认领的或新造的，子项的 parentSyncId 靠它接。 */
  const resolvedSyncId = new Map<string, string>();

  const putAlive = (args: {
    nativeId: string;
    parentSyncId: string | null;
    parentNativeId: string | null;
    index: number;
    title: string;
    url: string | null;
    kind: NodeType;
    logicalRootId: LogicalRootId;
  }): string => {
    const syncId = newWriterId();
    resolvedSyncId.set(args.nativeId, syncId);
    const ver = {} as Record<SyncStateField, Version>;
    for (const field of SYNC_STATE_FIELDS) ver[field] = write;
    nodes[syncId] = {
      syncId,
      kind: args.kind,
      logicalRootId: args.logicalRootId,
      title: args.title,
      url: args.url,
      parentSyncId: args.parentSyncId,
      position: positionsFor(args.index + 1)[args.index] ?? positionsFor(1)[0]!,
      deleted: false,
      deletedAt: null,
      purged: false,
      purgedAt: null,
      ver,
      nv: write,
      base: null,
    };
    freshMappings.push({
      nativeId: args.nativeId,
      syncId,
      logicalRootId: args.logicalRootId,
      title: args.title,
      ...(args.url === null ? {} : { url: args.url }),
      parentNativeId: args.parentNativeId,
      index: args.index,
      updatedAt: now,
    });
    return syncId;
  };

  const putTombstone = (args: {
    nativeId: string;
    parentSyncId: string | null;
    parentNativeId: string | null;
    index: number;
    title: string;
    url: string | null;
    kind: NodeType;
    logicalRootId: LogicalRootId;
  }): string => {
    const syncId = newWriterId();
    resolvedSyncId.set(args.nativeId, syncId);
    const ver = {} as Record<SyncStateField, Version>;
    for (const field of SYNC_STATE_FIELDS) ver[field] = write;
    nodes[syncId] = {
      syncId,
      kind: args.kind,
      logicalRootId: args.logicalRootId,
      title: args.title,
      url: args.url,
      parentSyncId: args.parentSyncId,
      position: positionsFor(args.index + 1)[args.index] ?? positionsFor(1)[0]!,
      deleted: true,
      deletedAt: now,
      purged: false,
      purgedAt: null,
      ver,
      nv: write,
      base: null,
    };
    freshMappings.push({
      nativeId: args.nativeId,
      syncId,
      logicalRootId: args.logicalRootId,
      title: args.title,
      ...(args.url === null ? {} : { url: args.url }),
      parentNativeId: args.parentNativeId,
      index: args.index,
      updatedAt: now,
    });
    return syncId;
  };

  // ---- 祖先链：补成活节点（只补没有同步身份的），让墓碑认回原来的父文件夹 ----
  let parentSyncId: string | null = null;
  let parentNativeId: string | null = input.parentNativeId;
  for (const ancestor of input.ancestors) {
    const mapped = mappedSyncByNative.get(ancestor.nativeId);
    if (mapped !== undefined) {
      // 有身份：不补节点，但把身份接下去（父链不断）。
      parentSyncId = mapped;
      parentNativeId = ancestor.nativeId;
      continue;
    }
    parentSyncId = putAlive({
      nativeId: ancestor.nativeId,
      parentSyncId,
      parentNativeId,
      index: ancestor.index,
      title: ancestor.title,
      url: null,
      kind: 'folder',
      logicalRootId: input.logicalRootId,
    });
    parentNativeId = ancestor.nativeId;
  }

  // ---- 子树：广度优先（父先于子），没身份的记墓碑，有身份的借身份 ----
  let recorded = 0;
  const queue: Array<{ node: NativeSubtreeNode; parentSyncId: string | null; parentNativeId: string | null; index: number }> = [
    { node: input.subtree, parentSyncId, parentNativeId, index: input.index },
  ];
  while (queue.length > 0) {
    const frame = queue.shift();
    if (!frame) break;
    const { node } = frame;
    // 父的 syncId 在父出队时才定，所以子项入队时只带原生父 id，在这里回填。
    // 回填不到（父是逻辑根 / 借来的映射身份）就用在队首带来的那个。
    const parentSyncId =
      (frame.parentNativeId !== null ? resolvedSyncId.get(frame.parentNativeId) : undefined) ?? frame.parentSyncId;
    // **判 kind 只看 url**：书签一定有网址，文件夹一定没有；`children` 不可靠 ——
    // 空文件夹是 `children: []`，而单点子树（书签）也可能带着空数组。
    // 早先用 `Array.isArray(node.children)` 判，删书签全被记成了文件夹（2026-10-17）。
    const url = typeof node.url === 'string' ? node.url : null;
    const isFolder = url === null;
    const title = node.title ?? '';

    // 子项按数组顺序入队：下标就是原生死序里的位置，恢复时顺序照旧。
    (node.children ?? []).forEach((child, at) => {
      queue.push({ node: child, parentSyncId: null, parentNativeId: node.id, index: at });
    });

    const mapped = mappedSyncByNative.get(node.id);
    if (mapped !== undefined) {
      // 有同步身份：不记墓碑（归待同步档与对账），身份借给子项。
      resolvedSyncId.set(node.id, mapped);
      continue;
    }

    putTombstone({
      nativeId: node.id,
      parentSyncId,
      parentNativeId: frame.parentNativeId,
      index: frame.index,
      title,
      url,
      kind: isFolder ? 'folder' : 'bookmark',
      logicalRootId: input.logicalRootId,
    });
    recorded += 1;
  }

  if (recorded === 0 && freshMappings.length === 0) return 0;

  const doc: StateDocument = {
    format: SYNC_STATE_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId: baseline?.spaceId ?? writerId,
    writerId,
    clock: write.clock,
    writtenAt: now,
    nodes,
  };
  await writeBaselineDoc(doc);
  if (freshMappings.length > 0) await putMappings(freshMappings);
  return recorded;
}

/**
 * 收集恢复目标：自己 + 祖先链上的墓碑祖先 + **整棵子树里还能找回的后代**。
 *
 * 2026-10-17 用户确认的语义：**恢复文件夹 = 恢复它下面所有还能找回的内容**。
 * 早先这里只收"墓碑后代"，于是待同步档（节点还活着、原生没了）恢复文件夹时只回个空壳。
 * 现在两条恢复路径共用这一份集合：
 * - 已经彻底清除的（purged）跳过，**连它的子树一起跳过** —— 那是用户明确说"不要了"的；
 * - 已经单独恢复过的后代仍在集合里，重建阶段按"原生还在"跳过，不会重复创建，
 *   计数阶段也不把它算成"这次带回来的"（见 previewRestore）；
 * - 早先单独删掉的也在集合里 —— 回收站按结构分组，"恢复这一组"就是恢复全组。
 */
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
    // 后代：除了彻底清除过的，全部收进来（位置与内容才完整）。
    for (const child of childrenOf.get(syncId) ?? []) {
      const childNode = nodes[child];
      if (childNode && !childNode.purged) stack.push(child);
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

  // 数**真的会被动到的**那些：墓碑会在基线里清标记并重建；活着的只在原生确实没了时
  // 才会被重建 —— 已经单独恢复过的（原生还在）不算"这次带回来的"，否则会说谎（Q4）。
  const config = await loadSyncConfig();
  const tree = await readSyncTree(effectiveEnabledRoots(config));
  const presentNativeIds = new Set(tree.nodes.map((node) => node.nativeId));
  const mappingBySync = new Map((await readMappings()).map((entry) => [entry.syncId, entry]));
  const effective = targets.filter((syncId) => {
    const node = baseline.nodes[syncId];
    if (!node) return false;
    if (node.deleted) return true;
    const entry = mappingBySync.get(syncId);
    return !entry || !presentNativeIds.has(entry.nativeId);
  });

  return {
    targetCount: effective.length,
    extraCount: Math.max(0, effective.length - syncIds.length),
  };
}

/**
 * 墓碑恢复：清掉 `deleted` 标记，盖上本机新时钟，整份上传。
 *
 * 不推历史操作、不走网络重放——就是一次普通的本地写入，随下一轮合并传播。
 *
 * **没配同步时（2026-10-17 修，既有约定 修订）**：commitLocalState 只落本机基线，
 * 并且要紧接着就地重建原生书签 —— 没有"下一轮同步的应用层"来把它建回来，
 * 只清标记的话用户看到的是"恢复成功但书签没回来"。重建走 既有约定 那条零网络的路。
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
    // 只清**真的在墓碑档**的标记。集合里还有"活着但原生没了"的后代（待同步档那种，
    // 混在一棵被删的子树里），它们没有标记要清，不该被顺手盖一次新版本。
    if (!node || !node.deleted) continue;
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

  const config = await loadSyncConfig();
  if (!isConfigured(config)) {
    await recreateNativeNodes(nodes, targets);
  }
}

/**
 * 待同步就地恢复：删除还没离开这台机器，把原生书签重建出来、
 * 再把映射换绑到新的原生 id，就等于撤销 —— **零网络**。
 *
 * 2026-10-17 修：**文件夹要连内容一起回来**。早先这里只把传进来的那一个 id 交给重建，
 * 于是恢复一个文件夹只回个空壳（用户报）。展开规则与墓碑档共用
 * `collectRestoreTargets` —— 两条恢复路径从此是同一个语义。
 */
export async function restorePendingFromTrash(syncIds: readonly string[]): Promise<void> {
  const baseline = await readBaselineDoc();
  if (!baseline) return;
  const targets = collectRestoreTargets(baseline.nodes, syncIds);
  await recreateNativeNodes(baseline.nodes, targets);
}

/**
 * 把一批**活着**但浏览器里已经没有的节点重建出来，映射换绑到新原生 id。
 *
 * 两条调用路径共用它：
 * - 待同步档的就地恢复 —— 删除还没出手，基线里节点本来就没删；
 * - 断开配置后的墓碑恢复（既有约定 修订，2026-10-17）—— 墓碑刚被清掉，而没有
 *   "下一轮同步的应用层"来重建它，只能在这里就地建。两条路都零网络。
 *
 * 先创建后换映射：拿租约后再校验一次"原生树里确实没有、基线里确实活着"。
 */
async function recreateNativeNodes(
  nodes: Record<string, SyncNodeState>,
  syncIds: readonly string[],
): Promise<void> {
  const config = await loadSyncConfig();
  const tree = await readSyncTree(effectiveEnabledRoots(config));
  const presentNativeIds = new Set(tree.nodes.map((node) => node.nativeId));
  const mappings = await readMappings();
  const mappingBySync = new Map(mappings.map((entry) => [entry.syncId, entry]));

  const owner = `recreate-${newWriterId().slice(0, 8)}`;
  if (!(await acquireLease(owner))) throw new Error('已有一次同步在进行中，请稍后再试。');
  try {
    const depths = computeDepths(Object.values(nodes));
    // 父先于子：按深度升序处理，父建好了子才有地方挂。**同父内按目标排序键排** ——
    // 创建顺序就是最终顺序（新建节点排不进后面的 move），collectRestoreTargets 给的
    // 顺序是栈弹出序（同层是反的），不能直接用。
    const targets = syncIds
      .filter((syncId) => {
        const node = nodes[syncId];
        if (!node || node.deleted || node.purged) return false;
        const entry = mappingBySync.get(syncId);
        return !entry || !presentNativeIds.has(entry.nativeId);
      })
      .sort((a, b) => {
        const depthA = depths.get(a) ?? 0;
        const depthB = depths.get(b) ?? 0;
        if (depthA !== depthB) return depthA - depthB;
        const nodeA = nodes[a]!;
        const nodeB = nodes[b]!;
        if (nodeA.parentSyncId !== nodeB.parentSyncId) {
          return (nodeA.parentSyncId ?? '') < (nodeB.parentSyncId ?? '') ? -1 : 1;
        }
        return nodeA.position < nodeB.position ? -1 : nodeA.position > nodeB.position ? 1 : 0;
      });

    const createdBySync = new Map<string, string>();
    const nextMappings: NativeMapping[] = [];
    // 换绑之前先收掉**失效映射**：映射库按 nativeId 存，重建后旧绑定还在，
    // 留着这一条会继续算进"待同步"档 —— 书签都回到树上了，面板里却还挂着它，
    // 侧边栏角标也不清零（2026-10-17 修；同步引擎每轮也会收一次，这里是就地重建的
    // 即时版本，既有约定 的待同步恢复同样受益）。
    const targetSet = new Set(targets);
    const staleNativeIds = mappings
      .filter((entry) => targetSet.has(entry.syncId) && !presentNativeIds.has(entry.nativeId))
      .map((entry) => entry.nativeId);
    // 父的原生 id：本轮刚建出来的 > 映射里且原生树里还在的。
    const resolveParentNative = (parentSyncId: string): string | undefined => {
      const created = createdBySync.get(parentSyncId);
      if (created) return created;
      const entry = mappingBySync.get(parentSyncId);
      if (entry && presentNativeIds.has(entry.nativeId)) return entry.nativeId;
      return undefined;
    };
    for (const syncId of targets) {
      const node = nodes[syncId]!;
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
      const siblings = Object.values(nodes).filter(
        (item) =>
          !item.deleted &&
          item.parentSyncId === node.parentSyncId &&
          item.logicalRootId === node.logicalRootId,
      );
      siblings.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      let index = siblings.findIndex((item) => item.syncId === syncId);
      // 父节点的活孩子，基线里都认识吗？同步用户的基线是整棵树的投影，位置键可以比；
      // 没配同步的用户的基线只有墓碑与补出来的祖先，而原生树里还有一堆基线不认识的
      // 孩子（从没删过的）—— 位置键只覆盖得了一半，比出来的下标是错的。这种稀疏基线
      // 用映射里记下的**原下标**：同一次删除记下的下标互相一致，也对着当年的完整子列
      // 。
      const nativeToSync = new Map(mappings.map((entry) => [entry.nativeId, entry.syncId]));
      const parentNativeChildren = tree.nodes.filter(
        (child) =>
          child.parentNativeId === parentNativeId ||
          (child.parentNativeId === null && parentNativeId === tree.rootIds[child.logicalRootId]),
      );
      const knowsAllSiblings = parentNativeChildren.every((child) => {
        const siblingSyncId = nativeToSync.get(child.nativeId);
        const sibling = siblingSyncId === undefined ? undefined : nodes[siblingSyncId];
        return sibling !== undefined && !sibling.deleted;
      });
      if (!knowsAllSiblings) index = mappingBySync.get(syncId)?.index ?? 0;
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
    if (staleNativeIds.length > 0) await removeMappings(staleNativeIds);
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
 *
 * **没配同步时（2026-10-17 修，既有约定 修订）**：commitLocalState 只落本机基线，
 * 标记等重新连接之后才传播。墓碑的原生实体在删除时就已经没了，本机没有可删的东西。
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
