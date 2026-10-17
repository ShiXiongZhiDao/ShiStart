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
 * 删除书签的写通道在 `bookmark-delete.ts`（删 + 按需要记本机墓碑，既有约定）；
 * 删文件夹的在 `bookmark-folder-delete.ts`。这个文件只留读取与变更订阅。
 */

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
