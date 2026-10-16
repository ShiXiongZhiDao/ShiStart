import { ALL_FOLDERS, type BookmarkViewItem } from '../types/bookmarks';

/**
 * 搜索命中范围：标题、URL、域名、文件夹路径，以及一级目录名。
 * （一级目录名额外纳入，是为了让"未归类"这类合成分类也能被搜到。）
 */
export function searchHaystack(item: BookmarkViewItem): string {
  return [item.title, item.url, item.domain, item.folderPath.join('/'), item.rootFolderTitle ?? '']
    .join(' ')
    .toLocaleLowerCase();
}

/**
 * 先按分类限定范围，再做关键词匹配。
 * 不去重、不排序 —— 保留浏览器书签管理器里的原始排列。
 */
export function filterBookmarks(
  items: BookmarkViewItem[],
  selectedFolderId: string,
  searchText: string,
): BookmarkViewItem[] {
  const keyword = searchText.trim().toLocaleLowerCase();
  const folderId = selectedFolderId === ALL_FOLDERS ? null : selectedFolderId;

  if (keyword === '' && folderId === null) return items.slice();

  return items.filter((item) => {
    if (folderId !== null && item.rootFolderId !== folderId) return false;
    if (keyword === '') return true;
    return searchHaystack(item).includes(keyword);
  });
}
