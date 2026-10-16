/**
 * 删除文件夹的**纯计算**。
 *
 * 这里只放"不碰浏览器、不碰存储"的函数：子树计数、样本标题、输入名闸门、
 * 回收站分组键、树里找一个节点的父。写通道在 `services/bookmark-folder-delete.ts`，
 * 界面在 `components/DeleteFolderDialog.vue` 与 `components/TrashPanel.vue`。
 *
 * 两条项目规矩在这里照样成立：
 * - **深层树一律显式栈迭代，不递归**（书签树深度不可控）；
 * - 纯函数才能无浏览器单测 —— 删除是唯一不可逆的一类操作，它的计数错一位
 *   就是"说了删 312 项、实际删了 313 项"。
 */

import type { BookmarkFolderNode } from '../../types/bookmarks';

/** 浏览器子树节点的最小形状（`chrome.bookmarks.getSubTree` 的返回）。 */
export interface NativeSubtreeNode {
  id: string;
  title?: string;
  url?: string;
  children?: NativeSubtreeNode[];
}

/** 超过这个数的书签，删除前要求手动输入文件夹名。 */
export const TYPED_NAME_BOOKMARK_THRESHOLD = 100;

/** 直属样本默认取几条（既有约定：样本只为"确认没删错行"，不为浏览内容）。 */
export const SAMPLE_TITLE_LIMIT = 5;

export interface SubtreeSummary {
  bookmarkCount: number;
  folderCount: number;
}

/**
 * 数一整整棵子树里有多少书签、多少子文件夹（都不含被删的文件夹自己）。
 *
 * 判据是**有没有 url**：浏览器里带网址的是书签，不带的是文件夹。
 */
export function summarizeNativeSubtree(root: NativeSubtreeNode): SubtreeSummary {
  let bookmarkCount = 0;
  let folderCount = 0;
  const stack: NativeSubtreeNode[] = [...(root.children ?? [])];
  const seen = new Set<NativeSubtreeNode>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.url === 'string') bookmarkCount += 1;
    else folderCount += 1;
    for (const child of node.children ?? []) stack.push(child);
  }
  return { bookmarkCount, folderCount };
}

/** 直属书签的标题样本，保持浏览器原始顺序（打乱顺序会让"确认没删错行"变难）。 */
export function sampleDirectBookmarkTitles(
  root: NativeSubtreeNode,
  limit: number = SAMPLE_TITLE_LIMIT,
): string[] {
  const out: string[] = [];
  for (const child of root.children ?? []) {
    if (typeof child.url !== 'string') continue;
    out.push(child.title ?? '');
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 这次删除要不要手动输入文件夹名。
 *
 * 标题为空时**豁免**：未命名文件夹在界面上本来就只能靠位置与数量指认，
 * 让用户打一串产品编出来的占位名，防误删的效果存疑。
 */
export function requiresTypedName(bookmarkCount: number, title: string): boolean {
  return bookmarkCount > TYPED_NAME_BOOKMARK_THRESHOLD && title.trim() !== '';
}

/** 子树里的全部原生 id（含根自己）—— 期望记录要用它去映射表里换 syncId。 */
export function collectSubtreeNativeIds(root: NativeSubtreeNode): Set<string> {
  const out = new Set<string>();
  const stack: NativeSubtreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || out.has(node.id)) continue;
    out.add(node.id);
    for (const child of node.children ?? []) stack.push(child);
  }
  return out;
}

// ---------------------------------------------------------------- 回收站分组

export interface TrashGroupMember<T> {
  item: T;
  /** 相对组根的深度，从 1 起（只用于缩进）。 */
  depth: number;
}

export interface TrashGroup<T> {
  /** 顶层墓碑：它的父不是墓碑、或父不在这一屏里。 */
  root: T;
  /** 跟着它一起来的那些（子树里的其余墓碑），父一定排在子前面。 */
  members: TrashGroupMember<T>[];
}

/**
 * 把一屏墓碑按"一次删除"分组成森林。
 *
 * 分组键**现算**，不碰存储：op / 墓碑里没有任何按用户动作分组的字段
 * （`occurredAt` 是按**轮**共享的，同一次合并窗口里删两个文件夹会撞同一时间戳，
 * 拿它当分组键会把两次删除并成一组）。判据只有一条结构事实：
 * **墓碑的父也是墓碑 ⇒ 它是随那个一起来的**，逐层上溯到最顶层的墓碑祖先就是组根。
 *
 * 输入顺序即组根的显示顺序（调用方已经按删除时间排好）；成员按**深度优先前序**展开，
 * 保证父出现在子之前、同一层保持输入顺序。
 */
export function groupTrashItems<T extends { syncId: string; parentSyncId: string | null }>(
  items: readonly T[],
): TrashGroup<T>[] {
  const bySync = new Map(items.map((item) => [item.syncId, item]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const item of items) {
    const parentId = item.parentSyncId;
    // 父在自己这屏里、且不是自己（防脏数据成环）⇒ 成员；否则 ⇒ 组根。
    if (parentId !== null && parentId !== item.syncId && bySync.has(parentId)) {
      const list = children.get(parentId);
      if (list) list.push(item);
      else children.set(parentId, [item]);
    } else {
      roots.push(item);
    }
  }

  const visited = new Set<string>();

  const buildGroup = (root: T): TrashGroup<T> => {
    const members: TrashGroupMember<T>[] = [];
    visited.add(root.syncId);
    const stack: TrashGroupMember<T>[] = (children.get(root.syncId) ?? [])
      .map((item) => ({ item, depth: 1 }))
      .reverse();
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next || visited.has(next.item.syncId)) continue;
      visited.add(next.item.syncId);
      members.push(next);
      const kids = children.get(next.item.syncId) ?? [];
      for (let at = kids.length - 1; at >= 0; at -= 1) {
        const kid = kids[at];
        if (!kid) continue;
        stack.push({ item: kid, depth: next.depth + 1 });
      }
    }
    return { root, members };
  };

  const groups = roots.map(buildGroup);

  // 脏数据成环时（a 的父是 b、b 的父也是 a），上面这一轮谁都不够不着它们 ——
  // 两条都会从界面上凭空消失。宁可各自成组排在后头，也不能丢条目。
  for (const item of items) {
    if (visited.has(item.syncId)) continue;
    groups.push(buildGroup(item));
  }
  return groups;
}

// ---------------------------------------------------------------- 主页用的两棵小树查询

/** 找一个文件夹的父 id；找不到（或它本来就在根级）返回 null。显式栈，不递归。 */
export function findFolderParentId(
  roots: readonly BookmarkFolderNode[],
  targetId: string,
): string | null {
  const stack: Array<{ node: BookmarkFolderNode; parentId: string | null }> = roots.map((node) => ({
    node,
    parentId: null,
  }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;
    if (next.node.id === targetId) return next.parentId;
    for (const child of next.node.children) stack.push({ node: child, parentId: next.node.id });
  }
  return null;
}

/**
 * 这个原生 id 在不在当前书签树里（书签 + 文件夹都算）。
 *
 * 删除之后有两处界面要素要问这句话：撤销条的目标、
 * 以及正开着的内联编辑器的目标 —— 它们都不该等用户去点一个注定失败的操作。
 */
export function nodeExistsInTree(
  roots: readonly BookmarkFolderNode[],
  items: readonly { id: string }[],
  id: string,
): boolean {
  if (id === '') return false;
  if (items.some((item) => item.id === id)) return true;
  const stack: BookmarkFolderNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === id) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}
