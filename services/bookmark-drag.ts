/**
 * 主页拖放的写通道。
 *
 * 这是继「删除」与「回收站就地重建」之后**第三条**从主页写原生书签的通道，
 * 规矩与前两条完全一致：
 * - **不自创语义**：就是 `chrome.bookmarks.move`，与在书签管理器里拖动完全等价；
 * - **不碰同步侧的映射与基线**：下一轮 diff 自己会发现位置变了、产出 `node.move`、
 *   照常传播（改顺序的 position 冲突自动择一，改归属的 parentSyncId 冲突才要人裁）；
 * - **失败一律抛出**，不静默吞掉。
 *
 * 「上一次改动」的记录与撤销**统一放在 `services/bookmark-edit.ts`**（既有约定 把
 * 既有约定 的 lastMove 泛化成了 lastEdit）—— 撤销条只有一条，不该存在两套。
 */

import {
  clampDropIndex,
  nativeIndexFor,
  type DropResolution,
} from '../lib/drag/drop-plan';
import {
  describeNativeError,
  EditError,
  readNativeChildIds,
  readNativeNode,
  readNativeTitle,
  writeLastEdit,
  type MoveRecord,
} from './bookmark-edit';

export interface MoveResult {
  kind: DropResolution['kind'];
  /**
   * true = 浏览器没接受算出来的位置（跨目录直接追加到末尾被拒），退了一位。
   * 这不是静默降级 —— 界面必须把它说出来。
   */
  adjusted: boolean;
  /** 撤销记录写成功了没有。写不进去时界面要说明"撤销不可用"，不能装作有。 */
  undoSaved: boolean;
  record: MoveRecord | null;
}

function api(): typeof chrome.bookmarks | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.bookmarks;
}

/**
 * 执行一次拖放。
 *
 * 顺序很讲究：**先读来处、再动手、最后记撤销**。
 * 反过来（先移动再回头问原来在哪）问到的就已经是新位置了。
 */
export async function moveBookmarkNode(resolution: DropResolution): Promise<MoveResult> {
  const bookmarks = api();
  if (!bookmarks) {
    throw new EditError('api-unavailable', '当前环境不支持写入浏览器书签。');
  }

  const node = await readNativeNode(resolution.nodeId);
  const fromParentId = typeof node.parentId === 'string' ? node.parentId : '';
  const fromIndex = Number.isFinite(node.index) ? Number(node.index) : 0;
  const nodeTitle = node.title ?? '';

  const childIds = await readNativeChildIds(resolution.parentId);
  // ★ 直接把锚点的**当前下标**交给浏览器：`chrome.bookmarks.move` 的 index 就是
  //   "插到当前列表第 N 个元素之前"，`== 长度` 表示追加（2026-10-17 真机实测，既有约定）。
  //   曾经这里还减一（"摘除后左移一位"的假设），那是错的：前移整体少一位、
  //   移到末尾会落在倒数第二格。
  const index = clampDropIndex(nativeIndexFor(childIds, resolution.containerIds, resolution.insertAt), childIds.length);

  // 原来的位置已经读到了，接下来无论成功失败都不影响撤销记录的内容。
  const recordBase = {
    nodeId: resolution.nodeId,
    nodeTitle,
    fromParentId,
    fromParentTitle: fromParentId === '' ? '' : await readNativeTitle(fromParentId),
    fromIndex,
    toParentId: resolution.parentId,
    toParentTitle: await readNativeTitle(resolution.parentId),
    at: Date.now(),
  };

  try {
    await bookmarks.move(resolution.nodeId, { parentId: resolution.parentId, index });
  } catch (error) {
    // 既有约定 记下的边界：跨目录移动时"追加到末尾"可能被浏览器按摘除前的计数拒绝。
    // 退一位再试一次；还不行就把原始错误原样抛出去，绝不假装成功。
    const fallback = clampDropIndex(index - 1, childIds.length);
    if (fallback === index) throw new EditError('write-failed', describeNativeError(error));
    try {
      await bookmarks.move(resolution.nodeId, { parentId: resolution.parentId, index: fallback });
      const record: MoveRecord = { ...recordBase, kind: 'move' };
      const undoSaved = await writeLastEdit(record);
      return { kind: resolution.kind, adjusted: true, undoSaved, record };
    } catch {
      throw new EditError('write-failed', describeNativeError(error));
    }
  }

  const record: MoveRecord = { ...recordBase, kind: 'move' };
  const undoSaved = await writeLastEdit(record);
  return { kind: resolution.kind, adjusted: false, undoSaved, record };
}
