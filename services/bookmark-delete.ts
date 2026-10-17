/**
 * 主页「删除书签」的写通道，以及**没配同步时的本机墓碑**。
 *
 * 与文件夹删除（bookmark-folder-delete.ts）是同一条规矩：
 * - **不自创语义**：原生侧就是一次 `chrome.bookmarks.remove`，与在书签管理器里
 *   按删除键完全等价；
 * - **删除之前先把位置读走**（标题、网址、父链、下标）—— 删掉之后就问不到了，
 *   回收站里的"原位置"与恢复时的落点都靠它；
 * - **失败一律抛出**，不静默吞掉。唯一例外是墓碑没记上：删除本身已经成功，
 *   那种情况下如实返回 `recoverable: false`，由界面说"这一条可能找不回来了"，
 *   而不是把一次成功的删除报成失败。
 *
 * ## 没配同步时为什么也要记墓碑
 *
 * 删除历来只调浏览器 API，墓碑靠"下一轮同步对账"产生。没配同步的用户没有下一轮
 * —— 删掉即永久消失，回收站入口永远不出现（用户报过）。墓碑的真相本来就可以只在
 * 本机：恢复是"重建原生书签 + 换绑映射"，零网络、不需要服务器。
 * 记录规则（哪些记、哪些不记）在 `recordLocalTombstones` 的注释里。
 */

import type { NativeSubtreeNode } from '../lib/folder/delete-preview';
import { readNativeLocation, readNativeNode } from './bookmark-edit';
import { removeNativeNode } from './bookmark-sync-adapter';
import { recordLocalTombstones } from './trash';

export interface DeleteBookmarkResult {
  /**
   * 删掉的东西有没有一条找回的路。false 只意味着**本机墓碑没写进去**
   * （IndexedDB 出问题）—— 那时删除已经生效，界面必须说实话。
   */
  recoverable: boolean;
}

/** 删掉一条书签，并按需要记一笔本机墓碑。 */
export async function deleteBookmark(nodeId: string): Promise<DeleteBookmarkResult> {
  // 删除之前读：标题 / 网址 / 父与下标，以及沿父链到逻辑根的位置。
  const node = await readNativeNode(nodeId);
  const location = await readNativeLocation(node);

  await removeNativeNode(nodeId);

  // 单点子树要照 Chrome 的形状来：书签**没有 children 键**、只有 url（文件夹反过来）。
  // 早先在这里补了 `children: []`，记录器按"有 children 就是文件夹"判 kind ⇒ 书签全被记成
  // 文件夹，回收站里显示文件夹图标、恢复出来是个空文件夹（2026-10-17 用户报的）。
  const subtree: NativeSubtreeNode = {
    id: node.id,
    title: node.title ?? '',
    ...(typeof node.url === 'string' ? { url: node.url } : {}),
  };
  try {
    await recordLocalTombstones({
      parentNativeId: node.parentId ?? null,
      logicalRootId: location.logicalRootId,
      index: node.index ?? 0,
      subtree,
      ancestors: location.ancestors,
    });
    return { recoverable: true };
  } catch {
    // 记不上就不吹牛说它能找回 —— 但删除已经成功了，不把成功报成失败。
    return { recoverable: false };
  }
}
