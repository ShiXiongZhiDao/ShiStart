/**
 * 拖放的纯计算层。
 *
 * 把"拖到某个元素的哪一段"翻译成 `chrome.bookmarks.move` 需要的参数。
 * 这里刻意不碰任何 `chrome.*`：落点能不能算出来、算出来的下标对不对，
 * 都必须能在没有浏览器的环境里被单测钉住（`lib/` 的规矩）。
 *
 * 两个容易搞混、必须在这一层说清的事实：
 *
 * 1. **界面把同一父目录下的文件夹与网址拆成两块渲染**（分组铺开，见 App.vue）。
 *    所以"容器里的第 3 位"**不等于**原生 children 列表里的第 3 位 —— 原生列表是
 *    文件夹与网址混排的。必须拿 `getChildren` 的真实列表来定位（`nativeIndexFor`）。
 *
 * 2. **同父移动时浏览器会先把节点摘下来**，它后面的下标整体左移一位。
 *    不减这一位，"插到第 3 位"会变成"插到第 4 位" —— 差一位，肉眼看得见。
 */

import { findFolderNode } from '../bookmark-mapper';
import {
  UNFILED_FOLDER,
  type BookmarkFolderNode,
  type BookmarkViewItem,
} from '../../types/bookmarks';

/** 落点落在目标元素的哪一段。 */
export type DropZone = 'before' | 'after' | 'inside';

export interface DropRequest {
  /** 被拖动的原生节点 id。 */
  draggedId: string;
  /** 落点元素的原生节点 id。 */
  targetId: string;
  zone: DropZone;
}

/**
 * 拒绝的理由。**机器码**，不是文案 —— 文案由界面查表
 * （与 `services/tab-actions.ts` 同一条规矩：服务不写中文，否则英文界面会漏中文）。
 */
export type DropRejectCode =
  /** 拖动的那条已经不在当前书签树里了（同步或书签管理器里被删了）。 */
  | 'unknown-dragged'
  /** 落点已经不在当前书签树里了。 */
  | 'unknown-target'
  /** 把文件夹拖进它自己或它的子目录 —— 会造出一个环。 */
  | 'into-self'
  /** 落点是「未归类」这个合成视图，不是能放东西进去的原生目录。 */
  | 'virtual-target'
  /** 落点的父是浏览器根节点：一级目录的排序、以及"未归类"里散落书签的排序。 */
  | 'root-parent'
  /** 原地松手，一次 move 都不该发。 */
  | 'same-position';

export interface DropResolution {
  nodeId: string;
  /** 目标父文件夹的原生 id。 */
  parentId: string;
  /**
   * 落点容器里的**同类**兄弟 id，按界面顺序。
   * 只用来把 UI 的位置换算成原生下标（投进目录时为空数组 = 追加到末尾）。
   */
  containerIds: string[];
  /** 插到容器里第几个之前；等于 `containerIds.length` 表示末尾。 */
  insertAt: number;
  /**
   * **排序** = 没换父目录，改的是 `position`；
   * **归属** = 换了父目录，改的是 `parentSyncId`。
   * 对原生 API 它们是同一个 `move`，但对同步层是两种命运（见 GLOSSARY）。
   */
  kind: 'reorder' | 'reparent';
}

export type DropOutcome =
  | { ok: true; resolution: DropResolution }
  | { ok: false; code: DropRejectCode };

/** 一个目录节点在树里的父目录；它挂在浏览器根节点下时返回 null。 */
export function parentFolderOf(
  roots: BookmarkFolderNode[],
  folderId: string,
): BookmarkFolderNode | null {
  const stack: BookmarkFolderNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.children.some((child) => child.id === folderId)) return node;
    for (const child of node.children) stack.push(child);
  }
  return null;
}

/** 一个目录子树里全部**目录** id（含它自己），用于循环检测。显式栈，不递归。 */
export function collectFolderIds(node: BookmarkFolderNode): string[] {
  const ids: string[] = [];
  const stack: BookmarkFolderNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    ids.push(current.id);
    for (const child of current.children) stack.push(child);
  }
  return ids;
}

export function resolveDrop(input: {
  roots: BookmarkFolderNode[];
  items: readonly BookmarkViewItem[];
  request: DropRequest;
}): DropOutcome {
  const { roots, items, request } = input;
  const { draggedId, targetId, zone } = request;

  const draggedFolder = findFolderNode(roots, draggedId);
  const draggedItem = draggedFolder ? null : (items.find((item) => item.id === draggedId) ?? null);
  if (!draggedFolder && !draggedItem) return { ok: false, code: 'unknown-dragged' };

  const fromParentId = draggedFolder
    ? (parentFolderOf(roots, draggedId)?.id ?? '')
    : (draggedItem?.parentId ?? '');
  // 一级目录（书签栏 / 其他书签 / 移动设备书签）是浏览器给的容器，不参与拖放。
  if (draggedFolder && fromParentId === '') return { ok: false, code: 'root-parent' };

  // 拖的是文件夹时，落点的父不能是它自己或它的任何后代。
  const forbidden = draggedFolder ? new Set(collectFolderIds(draggedFolder)) : null;

  // ---------- 投进一个目录：追加到它的末尾 ----------
  if (zone === 'inside') {
    const target = findFolderNode(roots, targetId);
    if (!target) return { ok: false, code: 'unknown-target' };
    if (target.id === UNFILED_FOLDER) return { ok: false, code: 'virtual-target' };
    if (forbidden?.has(target.id)) return { ok: false, code: 'into-self' };
    return {
      ok: true,
      resolution: {
        nodeId: draggedId,
        parentId: target.id,
        containerIds: [],
        insertAt: 0,
        kind: target.id === fromParentId ? 'reorder' : 'reparent',
      },
    };
  }

  // ---------- 插到某个兄弟的前面 / 后面 ----------
  const targetFolder = findFolderNode(roots, targetId);
  const targetItem = targetFolder ? null : (items.find((item) => item.id === targetId) ?? null);
  if (!targetFolder && !targetItem) return { ok: false, code: 'unknown-target' };

  const parentId = targetFolder
    ? (parentFolderOf(roots, targetId)?.id ?? null)
    : (targetItem?.parentId ?? null);
  // 父不在目录树里 = 落点直接挂在浏览器根节点下（一级目录，或"未归类"里的散落书签）。
  // 改根节点下的顺序既没必要也风险高，一律不做。
  if (parentId === null || parentId === '' || findFolderNode(roots, parentId) === null) {
    return { ok: false, code: 'root-parent' };
  }
  if (forbidden?.has(parentId)) return { ok: false, code: 'into-self' };

  const parent = findFolderNode(roots, parentId);
  if (!parent) return { ok: false, code: 'root-parent' };

  const containerIds = targetFolder
    ? parent.children.map((child) => child.id)
    : parent.bookmarks.map((item) => item.id);
  const at = containerIds.indexOf(targetId);
  if (at === -1) return { ok: false, code: 'unknown-target' };
  const insertAt = zone === 'after' ? at + 1 : at;

  const kind: DropResolution['kind'] = parentId === fromParentId ? 'reorder' : 'reparent';
  if (kind === 'reorder') {
    const current = containerIds.indexOf(draggedId);
    // 放在自己前面或自己后面 = 原地松手。
    if (current !== -1 && (insertAt === current || insertAt === current + 1)) {
      return { ok: false, code: 'same-position' };
    }
  }

  return { ok: true, resolution: { nodeId: draggedId, parentId, containerIds, insertAt, kind } };
}

/**
 * 把"插到容器里第 insertAt 个之前"换算成原生 children 列表里的下标。
 *
 * 容器里的兄弟只是原生列表的一个**子集**，所以只能拿它们当锚点去原生列表里定位，
 * 不能直接把 `insertAt` 当原生下标用 —— 那会把书签排到错误的位置上。
 */
export function nativeIndexFor(
  nativeChildIds: readonly string[],
  containerIds: readonly string[],
  insertAt: number,
): number {
  if (insertAt < containerIds.length) {
    const anchor = containerIds[insertAt];
    const at = anchor === undefined ? -1 : nativeChildIds.indexOf(anchor);
    return at === -1 ? nativeChildIds.length : at;
  }
  const last = containerIds[containerIds.length - 1];
  if (last === undefined) return nativeChildIds.length;
  const at = nativeChildIds.indexOf(last);
  return at === -1 ? nativeChildIds.length : at + 1;
}

/**
 * 同父移动时浏览器先把节点摘下来：它**原位之后**的下标整体左移一位。
 * 不减这一位，插到后面的操作会整体偏一格。
 */
export function shiftForRemoval(
  index: number,
  nativeChildIds: readonly string[],
  nodeId: string,
): number {
  const at = nativeChildIds.indexOf(nodeId);
  if (at === -1 || at > index) return index;
  return Math.max(0, index - 1);
}

/**
 * 落点的安全上界。
 *
 * 与同步引擎用的 `clampMoveIndex`（`lib/sync/diff.ts`）**故意不同**：那边无人值守，
 * 宁可偏一位也不肯让整次同步失败；而这里是用户当场看着放的，必须落到他放的那个位置，
 * 所以上界按"摘除之后"的真实长度算。跨目录追加到末尾仍可能被浏览器拒绝 ——
 * 那种情况由 service 捕获后退一位并明确回报（既有约定 记的是同一条边界）。
 */
export function clampDropIndex(index: number, siblingCount: number, sameParent: boolean): number {
  const count = Number.isFinite(siblingCount) ? Math.max(0, Math.trunc(siblingCount)) : 0;
  const upper = sameParent ? Math.max(0, count - 1) : count;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), upper);
}
