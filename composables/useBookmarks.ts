import { onMounted, onUnmounted, ref } from 'vue';
import {
  listenToBookmarkChanges,
  readBookmarkSnapshot,
} from '../services/bookmarks-service';
import type { BookmarkFolderNode, BookmarkViewItem } from '../types/bookmarks';

export type LoadStatus = 'loading' | 'ready' | 'error';

/**
 * 持有书签读取状态与原始数据。
 * 刷新使用 latest-wins token：书签管理器里连续拖动几十次时，
 * 旧的 getTree() 结果不允许覆盖新结果。
 */
export function useBookmarks() {
  const status = ref<LoadStatus>('loading');
  const errorMessage = ref('');
  const roots = ref<BookmarkFolderNode[]>([]);
  const items = ref<BookmarkViewItem[]>([]);

  let disposeListeners: (() => void) | null = null;
  let requestToken = 0;
  let disposed = false;

  async function refresh(): Promise<void> {
    const token = (requestToken += 1);
    try {
      const snapshot = await readBookmarkSnapshot();
      if (token !== requestToken || disposed) return;
      roots.value = snapshot.roots;
      items.value = snapshot.items;
      errorMessage.value = '';
      status.value = 'ready';
    } catch (error) {
      if (token !== requestToken || disposed) return;
      roots.value = [];
      items.value = [];
      errorMessage.value = error instanceof Error ? error.message : String(error);
      status.value = 'error';
    }
  }

  onMounted(() => {
    void refresh();
    disposeListeners = listenToBookmarkChanges(() => void refresh());
  });

  onUnmounted(() => {
    disposed = true;
    requestToken += 1;
    disposeListeners?.();
    disposeListeners = null;
  });

  return { status, errorMessage, roots, items, refresh };
}
