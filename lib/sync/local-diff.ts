/**
 * 本地变更识别（纯函数，既有约定 决策一）。
 *
 * 原生书签树 vs 基线文档 → 本机这一轮的写入。刻意**不**从书签事件生成变更：
 * 事件会丢（后台被杀）、会重复（浏览器自己的账号同步）、也会把我们刚写进去的
 * 远端变更当成"用户又改了一次"。每次同步整树重读、与基线对账——与 既有约定
 * 同一条思路：整树对账不会漏，也不会产生回环。
 *
 * 三条判定规则（从旧 diff.ts 原样移植，既有约定 的坑都还热着）：
 * - 有映射 → 用映射里的 syncId；丢了映射但能对上"父节点+类型+标题+网址"→ 认领回
 *   原 syncId，**绝不新建**，否则一次映射丢失就会把整棵树复制一遍；
 * - 排序键只在"这一层的顺序真的变了"时才重算，避免每次同步都产生一堆无意义的移动；
 * - 删除只针对**本地曾经有过**的节点（有映射记录）。远端来的新节点没映射，
 *   属于待创建，不是待删除。
 *
 * 与旧模型的区别：产出不是"操作意图"而是**盖好本机时钟的节点状态**——
 * 传输单位是整份状态文档，没有操作可生成。
 */

import { positionBetween, positionsFor } from './position';
import type { NativeMapping } from '../../types/sync-state';
import type {
  LogicalRootId,
  NodeType,
  StateDocument,
  SyncNodeState,
  SyncStateField,
  Version,
} from '../../types/sync-state';

export interface NativeNodeView {
  nativeId: string;
  parentNativeId: string | null;
  logicalRootId: LogicalRootId;
  type: NodeType;
  title: string;
  url?: string;
  index: number;
}

export interface LocalDiffInput {
  nodes: readonly NativeNodeView[];
  mappings: readonly NativeMapping[];
  /** 基线文档：上一轮同步结束时的全量目标。调用方保证它存在（全新安装走"先采纳远端"路径）。 */
  baseline: StateDocument;
  enabledRoots: readonly string[];
  /** 墙上时钟（毫秒）。删除时刻 `deletedAt` 用它——年龄判据按执行删除那台设备的时钟算。 */
  now: number;
  /** 新节点的 syncId 生成器。可注入以便单测确定性；默认全局唯一 UUID。 */
  newSyncId?: () => string;
}

export interface LocalDiffResult {
  /** 本机的完整节点集 = 基线原样携带 + 本机写入（墓碑/purged 标记不重写，原样带）。 */
  nodes: Record<string, SyncNodeState>;
  /** 新的 nativeId → syncId 映射，调用方落盘。 */
  mappings: NativeMapping[];
  /** 失效映射的原生 id：映射里有、浏览器里已经没了。上层必须清掉。 */
  staleNativeIds: string[];
  /** 新分配 syncId 的节点，供应用阶段回写映射。 */
  assigned: Array<{ syncId: string; nativeId: string }>;
  /** 本轮真正被本机改动的 syncId（诊断/日志用）。 */
  changed: string[];
}

/** 本次本地写入的统一版本：基线时钟 + 1，写入方是本机。 */
function writeVersion(baseline: StateDocument): Version {
  return { clock: baseline.clock + 1, writerId: baseline.writerId };
}

function matchKey(
  logicalRootId: string,
  parentSyncId: string | null,
  node: { type: NodeType; title: string; url?: string },
): string {
  return `${logicalRootId}|${parentSyncId ?? ''}|${node.type}|${node.title}|${node.url ?? ''}`;
}

/**
 * 新节点的 syncId 生成器。
 *
 * **绝不能拿浏览器原生 id 当 syncId**：原生 id 只在一个浏览器配置文件内有意义，
 * 两台设备各自生出的"第 5 条书签"会是两个完全不同的 syncId —— 一合并就是一整树重复
 * （这正是旧系统在线上出过的那个症状）。所以这里必须造全局唯一的新 id，
 * 占位前缀只在函数内部用一瞬间，**绝不落盘**。
 *
 * 可注入是为了让单测能钉住"认领 vs 新建"的分流，而不必断言随机串。
 */
function defaultNewSyncId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function computeLocalDiff(input: LocalDiffInput): LocalDiffResult {
  const newSyncId = input.newSyncId ?? defaultNewSyncId;
  const enabled = new Set(input.enabledRoots);
  const baseBySync = new Map<string, SyncNodeState>();
  for (const [syncId, node] of Object.entries(input.baseline.nodes)) {
    if (node.deleted) continue;
    if (node.purged) continue;
    if (!enabled.has(node.logicalRootId)) continue;
    baseBySync.set(syncId, node);
  }

  const mappingByNative = new Map<string, NativeMapping>();
  for (const entry of input.mappings) mappingByNative.set(entry.nativeId, entry);

  const nodes = input.nodes.filter((node) => enabled.has(node.logicalRootId));
  const write = writeVersion(input.baseline);

  // ---- 第一遍：给每个原生节点定 syncId（父先于子） ----
  const syncIdOfNative = new Map<string, string>();
  const claimed = new Set<string>();
  const assigned: Array<{ syncId: string; nativeId: string }> = [];
  const newSyncIds = new Set<string>();
  const unclaimedByKey = new Map<string, SyncNodeState[]>();

  for (const node of baseBySync.values()) {
    const key = matchKey(node.logicalRootId, node.parentSyncId, {
      type: node.kind,
      title: node.title,
      url: node.url ?? undefined,
    });
    const list = unclaimedByKey.get(key);
    if (list) list.push(node);
    else unclaimedByKey.set(key, [node]);
  }

  for (const node of nodes) {
    const mapped = mappingByNative.get(node.nativeId);
    if (mapped && baseBySync.has(mapped.syncId) && !claimed.has(mapped.syncId)) {
      syncIdOfNative.set(node.nativeId, mapped.syncId);
      claimed.add(mapped.syncId);
      continue;
    }
    // 走到这里可能是：压根没映射、映射指向的节点已不存在（被删了或移出了同步范围）、
    // 或者那个 syncId 已经被别的原生节点认领走了。一律按"父+类型+标题+网址"重新认领，
    // 认领不到才当新节点——绝不因为一条映射失效就把整棵树复制一遍。

    const parentSyncId = node.parentNativeId
      ? (syncIdOfNative.get(node.parentNativeId) ?? null)
      : null;
    const key = matchKey(node.logicalRootId, parentSyncId, node);
    const candidates = unclaimedByKey.get(key) ?? [];
    const free = candidates.find((candidate) => !claimed.has(candidate.syncId));
    if (free) {
      syncIdOfNative.set(node.nativeId, free.syncId);
      claimed.add(free.syncId);
      continue;
    }
    // 确实是个新节点——**立刻**生成一个全局唯一的 syncId 并落盘。
    // 绝不能拿原生 id 当 syncId：原生 id 只在一个浏览器配置文件内有意义，两台设备
    // 各自生出的"新节点"会形成两个不同的身份（或撞成同一个），合并即整树重复——
    // 这正是旧系统在线上出过的那个症状。
    const fresh = newSyncId();
    syncIdOfNative.set(node.nativeId, fresh);
    newSyncIds.add(fresh);
    assigned.push({ syncId: fresh, nativeId: node.nativeId });
  }

  // ---- 第二遍：逐层算排序键 ----
  const siblings = new Map<string, NativeNodeView[]>();
  for (const node of nodes) {
    const key = `${node.logicalRootId}|${node.parentNativeId ?? ''}`;
    const list = siblings.get(key);
    if (list) list.push(node);
    else siblings.set(key, [node]);
  }

  const positionOfNative = new Map<string, string>();
  for (const list of siblings.values()) {
    // siblings 是按原生顺序收集的（readSyncTree 保证父先于子、同级按 index）。
    const ordered = [...list].sort((a, b) => a.index - b.index);
    const currentSyncIds = ordered.map((node) => syncIdOfNative.get(node.nativeId));
    const baselineNodes = currentSyncIds
      .map((syncId) => (syncId ? baseBySync.get(syncId) : undefined))
      .filter((node): node is SyncNodeState => Boolean(node));

    // 只有这一层**每个**成员在基线里都有排序键时，才谈得上"顺序没变"。
    // 混进新节点（pending）就整层重排——局部复用会让新旧键交错出无法比较的区间。
    const allKnown = baselineNodes.length === ordered.length;
    const orderUnchanged =
      allKnown &&
      [...baselineNodes]
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .every((node, index) => currentSyncIds[index] === node.syncId);

    const positions = orderUnchanged
      ? baselineNodes.map((node) => node.position)
      : positionsFor(ordered.length);

    ordered.forEach((node, index) => {
      const key = positions[index] ?? positionsFor(1)[0] ?? positionBetween(null, null);
      positionOfNative.set(node.nativeId, key);
    });
  }

  // ---- 第三遍：生成节点状态 ----
  const out: Record<string, SyncNodeState> = {};
  // 基线原样携带：墓碑、purged 标记、禁用根的节点都不重写。
  for (const [syncId, node] of Object.entries(input.baseline.nodes)) {
    out[syncId] = node;
  }

  const nextMappings: NativeMapping[] = [];
  const changed: string[] = [];
  const now = input.now;

  for (const node of nodes) {
    const syncId = syncIdOfNative.get(node.nativeId);
    if (!syncId) continue;
    const parentSyncId = node.parentNativeId
      ? (syncIdOfNative.get(node.parentNativeId) ?? null)
      : null;
    const position = positionOfNative.get(node.nativeId) ?? '';
    const isNew = newSyncIds.has(syncId);
    const base = isNew ? undefined : baseBySync.get(syncId);

    nextMappings.push({
      nativeId: node.nativeId,
      syncId,
      logicalRootId: node.logicalRootId,
      title: node.title,
      ...(node.url === undefined ? {} : { url: node.url }),
      parentNativeId: node.parentNativeId,
      index: node.index,
      updatedAt: now,
    });

    if (!base) {
      // 新节点：所有字段都盖上本机时钟，base 为 null（创建）。
      const ver = {} as Record<SyncStateField, Version>;
      for (const field of [
        'title',
        'url',
        'parentSyncId',
        'logicalRootId',
        'position',
        'deleted',
        'purged',
      ] as SyncStateField[]) {
        ver[field] = write;
      }
      out[syncId] = {
        syncId,
        kind: node.type,
        logicalRootId: node.logicalRootId,
        title: node.title,
        url: node.url ?? null,
        parentSyncId,
        position,
        deleted: false,
        deletedAt: null,
        purged: false,
        purgedAt: null,
        ver,
        nv: write,
        base: null,
      };
      changed.push(syncId);
      continue;
    }

    const titleChanged = base.title !== node.title;
    const urlChanged = (base.url ?? '') !== (node.url ?? '');
    const parentChanged = base.parentSyncId !== parentSyncId;
    const rootChanged = base.logicalRootId !== node.logicalRootId;
    const positionChanged = base.position !== position;
    if (!titleChanged && !urlChanged && !parentChanged && !rootChanged && !positionChanged) {
      continue; // 这一层顺序没变、字段没变——基线原样携带，不产生写入
    }

    const ver = { ...base.ver };
    if (titleChanged) ver.title = write;
    if (urlChanged) ver.url = write;
    if (parentChanged) ver.parentSyncId = write;
    if (rootChanged) ver.logicalRootId = write;
    if (positionChanged) ver.position = write;

    out[syncId] = {
      ...base,
      title: node.title,
      url: node.url ?? null,
      parentSyncId,
      logicalRootId: node.logicalRootId,
      position,
      ver,
      nv: write,
      base: base.nv,
    };
    changed.push(syncId);
  }

  // ---- 删除：只对"本地曾经有过、现在没了"的节点 ----
  // 子树天然级联：原生树里整棵子树一起消失，每个节点各自对账成一条删除写入，
  // 不需要旧模型那种 observedDescendants 载荷。
  const presentNativeIds = new Set(nodes.map((node) => node.nativeId));
  for (const entry of input.mappings) {
    if (!enabled.has(entry.logicalRootId)) continue;
    if (presentNativeIds.has(entry.nativeId)) continue;
    const base = baseBySync.get(entry.syncId);
    if (!base) continue; // 基线里本来就没有（或已是墓碑/purged）——没什么可删的

    out[entry.syncId] = {
      ...base,
      deleted: true,
      deletedAt: now,
      ver: { ...base.ver, deleted: write },
      nv: write,
      base: base.nv,
    };
    changed.push(entry.syncId);
  }

  // 失效映射：浏览器里已经没了的原生 id（用户在浏览器书签管理器里手工删的）。
  const staleNativeIds: string[] = [];
  for (const entry of input.mappings) {
    if (!presentNativeIds.has(entry.nativeId)) staleNativeIds.push(entry.nativeId);
  }

  return { nodes: out, mappings: nextMappings, staleNativeIds, assigned, changed };
}
