/**
 * 原生书签的读写适配器（写入侧）。
 *
 * 与 `services/bookmarks-service.ts` 的分工：那边只读、供主页展示；这边负责同步需要的
 * **结构化读取 + 写入**。组件层仍然不许直接碰 chrome.bookmarks。
 *
 * 三条不可妥协的规矩：
 * 1. 根节点（书签栏 / 其他书签 / 移动设备书签）**永不被删除、永不被移动**。
 *    它们是浏览器提供的容器，删掉等于给用户制造一个无法恢复的洞。
 * 2. **网址节点一律同步，不看协议**—— 唯一的护栏是长度（见
 *    `isSyncableUrl`）。用户的原话是"只要是用户的书签，不管合不合法，都要能显示，能同步"。
 *    被长度挡下的条数会随同步结果上报，不再静默。
 * 3. 写入失败一律抛出，不静默吞掉。同步引擎靠异常决定要不要停在这一步。
 */

/**
 * 这条地址参不参与同步。
 *
 * ⚠️ **不再按协议过滤**。以前 `javascript:` / `data:` / `file:` / 浏览器内部页一律跳过 ——
 * 用户的原话是"只要是用户的书签，不管合不合法，都要能显示，能同步"。那条白名单让
 * 一整类书签在同步空间里**根本不存在**，而且被跳过的条数从来没显示过（静默少同步）。
 *
 * 现在唯一的护栏是**长度**：整棵树的同步状态文档每轮**全量上传**，一条 100KB 的
 * `data:` 会让每台设备**每一次**同步都多传 100KB。这是带宽护栏，不是合法性判断 ——
 * 被它挡下的条数会随同步结果上报（`skipped`）并显示在界面上。
 */
const MAX_URL_LENGTH = 2048;

export function isSyncableUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw === '') return false;
  return raw.length <= MAX_URL_LENGTH;
}

import {
  LOGICAL_ROOT_BAR,
  LOGICAL_ROOT_IDS,
  LOGICAL_ROOT_MOBILE,
  LOGICAL_ROOT_OTHER,
  type LogicalRootId,
  type NodeType,
} from '../types/sync-state';

/** 浏览器 Bookmarks API 返回的节点（只声明用到的字段）。 */
interface NativeNode {
  id: string;
  title?: string;
  url?: string;
  parentId?: string;
  index?: number;
  children?: NativeNode[];
  unmodifiable?: string;
}

export class BookmarkWriteUnavailableError extends Error {
  constructor(message = '当前浏览器不支持书签写入，同步已停止。') {
    super(message);
    this.name = 'BookmarkWriteUnavailableError';
  }
}

function api(): typeof chrome.bookmarks | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.bookmarks;
}

export function isBookmarkWriteAvailable(): boolean {
  // 只判断 API 在不在，不逐个方法判空：类型上这些方法是必有成员，
  // 真缺了也是调用时才炸 —— 那里有 BookmarkWriteUnavailableError 兜着。
  return api() !== undefined;
}

function request<T>(work: (bookmarks: typeof chrome.bookmarks) => Promise<T>): Promise<T> {
  const bookmarks = api();
  if (!bookmarks) return Promise.reject(new BookmarkWriteUnavailableError());
  return work(bookmarks);
}

// ------------------------------------------------------------------ 读取

export interface NativeSyncNode {
  nativeId: string;
  /** null 表示直接挂在该逻辑根下。 */
  parentNativeId: string | null;
  logicalRootId: LogicalRootId;
  type: NodeType;
  title: string;
  url?: string;
  index: number;
}

export interface NativeSyncTree {
  /** 逻辑根 → 原生根 id。不同浏览器 id 不同，所以每次读取都重新识别。 */
  rootIds: Record<string, string>;
  /** 深度优先顺序，父节点一定在自己子节点之前。 */
  nodes: NativeSyncNode[];
  /** 被跳过的节点数（地址过长），**会随同步结果上报并显示**。 */
  skipped: number;
}

/** 按位置识别逻辑根：第一个文件夹 = 书签栏，第二个 = 其他书签，第三个 = 移动设备。 */
const LOGICAL_ROOT_BY_POSITION = [LOGICAL_ROOT_BAR, LOGICAL_ROOT_OTHER, LOGICAL_ROOT_MOBILE];

/**
 * 识别当前浏览器的逻辑根。
 *
 * 不写死原生 id —— Chrome 常见的是 "1"/"2"，但那是实现细节，不是契约。
 * 也不按标题猜：多语言、用户改名、导入产生的重复根都会让猜测出错。
 */
export async function detectLogicalRoots(): Promise<Record<string, string>> {
  const tree = await request((bookmarks) => bookmarks.getTree());
  const root = tree[0] as NativeNode | undefined;
  const folders = (root?.children ?? []).filter(
    (child): child is NativeNode => Boolean(child) && typeof child.url !== 'string',
  );

  const out: Record<string, string> = {};
  folders.forEach((folder, index) => {
    const logical = LOGICAL_ROOT_BY_POSITION[index];
    if (logical && folder.id) out[logical] = folder.id;
  });
  return out;
}

/**
 * 读取参与同步的原生子树。
 *
 * 遍历用显式栈：书签层级可能非常深，递归会爆栈。
 * 输出的顺序保证"父在子前"，应用计划可以直接按顺序创建。
 */
export async function readSyncTree(enabledRoots: readonly string[]): Promise<NativeSyncTree> {
  const rootIds = await detectLogicalRoots();
  const tree = await request((bookmarks) => bookmarks.getTree());
  const root = tree[0] as NativeNode | undefined;

  const nodes: NativeSyncNode[] = [];
  let skipped = 0;

  // 按固定顺序遍历，而不是按 enabledRoots 的字面顺序 —— 顺带把 id 收窄成
  // LogicalRootId（调用方传的是 string[]，直接拿去当逻辑根用会漏过类型检查）。
  for (const logicalRootId of LOGICAL_ROOT_IDS) {
    if (!enabledRoots.includes(logicalRootId)) continue;
    const nativeRootId = rootIds[logicalRootId];
    if (!nativeRootId) continue;

    const rootNode = findById(root, nativeRootId);
    if (!rootNode) continue;

    const stack: Array<{ native: NativeNode; parentNativeId: string | null; index: number }> = [];
    (rootNode.children ?? []).forEach((child, index) => {
      stack.push({ native: child, parentNativeId: null, index });
    });
    // forEach 是顺序压栈，这里倒过来弹才能保证按原生顺序输出。
    stack.reverse();

    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      const { native, parentNativeId, index } = frame;
      if (!native?.id) continue;

      if (typeof native.url === 'string') {
        if (!isSyncableUrl(native.url)) {
          skipped += 1;
          continue;
        }
        nodes.push({
          nativeId: native.id,
          parentNativeId,
          logicalRootId,
          type: 'bookmark',
          title: native.title ?? '',
          url: native.url,
          index,
        });
        continue;
      }

      nodes.push({
        nativeId: native.id,
        parentNativeId,
        logicalRootId,
        type: 'folder',
        title: native.title ?? '',
        index,
      });

      const children = native.children ?? [];
      for (let at = children.length - 1; at >= 0; at -= 1) {
        const child = children[at];
        if (child) stack.push({ native: child, parentNativeId: native.id, index: at });
      }
    }
  }

  return { rootIds, nodes, skipped };
}

/** 按 id 找节点。显式栈，不用递归。 */
function findById(root: NativeNode | undefined, id: string): NativeNode | undefined {
  if (!root) return undefined;
  const stack: NativeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === id) return node;
    for (const child of node.children ?? []) stack.push(child);
  }
  return undefined;
}

// ------------------------------------------------------------------ 写入

export async function createNativeFolder(
  parentNativeId: string,
  title: string,
  index?: number,
): Promise<string> {
  const node = await request((bookmarks) =>
    bookmarks.create({ parentId: parentNativeId, title, ...(index === undefined ? {} : { index }) }),
  );
  return node.id;
}

export async function createNativeBookmark(
  parentNativeId: string,
  title: string,
  url: string,
  index?: number,
): Promise<string> {
  const node = await request((bookmarks) =>
    bookmarks.create({
      parentId: parentNativeId,
      title,
      url,
      ...(index === undefined ? {} : { index }),
    }),
  );
  return node.id;
}

/** 只传实际要改的字段。整节点覆盖会把"另一台设备的并发修改"一起盖掉。 */
export async function updateNativeNode(
  nativeId: string,
  patch: { title?: string; url?: string },
): Promise<void> {
  await request((bookmarks) => bookmarks.update(nativeId, patch));
}

export async function moveNativeNode(
  nativeId: string,
  parentNativeId: string,
  index: number,
): Promise<void> {
  await request((bookmarks) => bookmarks.move(nativeId, { parentId: parentNativeId, index }));
}

/** 删单个节点。文件夹非空时浏览器会拒绝，因此调用方必须先处理子节点。 */
export async function removeNativeNode(nativeId: string): Promise<void> {
  await request((bookmarks) => bookmarks.remove(nativeId));
}

export async function removeNativeTree(nativeId: string): Promise<void> {
  await request((bookmarks) => bookmarks.removeTree(nativeId));
}

export async function readNativeChildrenCount(nativeId: string): Promise<number> {
  const nodes = await request((bookmarks) => bookmarks.getChildren(nativeId));
  return nodes.length;
}

/** 浏览器子树节点的最小形状（`getSubTree` 的返回，删除预览要用）。 */
export interface NativeSubtreeNode {
  id: string;
  title?: string;
  url?: string;
  children?: NativeSubtreeNode[];
}

/**
 * 读一个文件夹的**整棵子树**（删除预览用，既有约定）。
 *
 * 一次 `getSubTree` 拿全，比逐层 `getChildren` 少绕弯。返回以该文件夹为根的树。
 * 找不到时浏览器**直接 reject**（`Can't find bookmark for id.`），由调用方翻成机器码。
 */
export async function readNativeSubtree(nativeId: string): Promise<NativeSubtreeNode> {
  const nodes = await request((bookmarks) => bookmarks.getSubTree(nativeId));
  const root = nodes[0];
  if (!root) throw new Error(`找不到 id 为 ${nativeId} 的文件夹。`);
  return root;
}
