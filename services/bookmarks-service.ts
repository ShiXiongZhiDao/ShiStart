/**
 * 唯一与 chrome.bookmarks 打交道的适配层。
 * 组件不允许直接调用浏览器书签 API。
 */

import { mapBookmarkTree } from '../lib/bookmark-mapper';
import { createFaviconUrl } from '../lib/favicon';
import type { BookmarkTreeSnapshot, NativeBookmarkNode } from '../types/bookmarks';

export const BOOKMARKS_UNAVAILABLE_MESSAGE =
  '无法读取当前浏览器书签。请确认扩展已启用并拥有书签权限，然后刷新页面。';

/** 书签 API 缺失或权限不匹配时抛出，页面据此进入错误状态（绝不回退为演示数据）。 */
export class BookmarksUnavailableError extends Error {
  constructor(message: string = BOOKMARKS_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'BookmarksUnavailableError';
  }
}

export function isBookmarksApiAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.bookmarks?.getTree === 'function';
}

export async function readBookmarkSnapshot(): Promise<BookmarkTreeSnapshot> {
  if (!isBookmarksApiAvailable()) {
    throw new BookmarksUnavailableError();
  }

  const tree = (await chrome.bookmarks.getTree()) as unknown as NativeBookmarkNode[];
  return mapBookmarkTree(tree, { buildFaviconUrl: (url) => createFaviconUrl(url) });
}

/**
 * 删除一个书签节点。
 *
 * 刻意**不发明一套自己的删除语义**：这就是调用浏览器 API 把节点删掉，
 * 和用户在书签管理器里按删除键**完全等价**。同步侧照常在下一轮对账时发现"本地少了这个节点"，
 * 照常生成删除操作、照常传播、照常留下墓碑进回收站（见 既有约定）。
 *
 * 反过来做的代价我们已经付过一次：只改本机状态而不写进操作日志，下一轮同步重放日志
 * 就把它变回来 —— 那是静默失败（既有约定 的来由）。
 */
export async function removeBookmarkNode(nativeId: string): Promise<void> {
  if (!isBookmarksApiAvailable()) {
    throw new BookmarksUnavailableError();
  }
  await chrome.bookmarks.remove(nativeId);
}

const BOOKMARK_CHANGE_EVENTS = [
  'onCreated',
  'onChanged',
  'onMoved',
  'onRemoved',
  'onChildrenReordered',
  'onImportEnded',
] as const;

interface NoArgEvent {
  addListener(callback: () => void): void;
  removeListener(callback: () => void): void;
}

/**
 * 注册一次，返回取消函数。
 *
 * 连续事件用 debounce 合并后整树重读 —— V1 刻意选择"简单可靠"而非局部增量更新，
 * 因为移动/导入/重排的局部更新极易出现状态不一致。
 */
export function listenToBookmarkChanges(onChanged: () => void, debounceMs = 120): () => void {
  if (typeof chrome === 'undefined' || !chrome.bookmarks) return () => {};
  const api = chrome.bookmarks;

  const namespace = api as unknown as Record<string, NoArgEvent | undefined>;
  const events = BOOKMARK_CHANGE_EVENTS.map((name) => namespace[name]).filter(
    (event): event is NoArgEvent => typeof event?.addListener === 'function',
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChanged, debounceMs);
  };

  events.forEach((event) => event.addListener(listener));

  return () => {
    if (timer) clearTimeout(timer);
    events.forEach((event) => event.removeListener(listener));
  };
}
