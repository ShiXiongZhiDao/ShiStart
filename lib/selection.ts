/**
 * 多选集合的分类。
 *
 * 选中集合是**全局**的（可以跨分组），所以按 id 分类时必须拿**整棵树**去查，
 * 不能只在当前视图里查 —— 否则"选了别的分组里的两张卡"会被判成查不到，
 * 操作条显示 2 项、实际能删 0 项。这段抽成纯函数就是为了把这条边界钉住。
 */

export interface SelectionSplit {
  /** 能直接打开/删除的书签 id，顺序与输入一致。 */
  bookmarkIds: string[];
  /** 文件夹 id，顺序与输入一致。 */
  folderIds: string[];
  /**
   * 既不是书签也不是文件夹的 id。
   *
   * 正常情况下应该永远是空的 —— 树一变，`retainExisting` 就会把它们掉掉。
   * 留着这个出口是为了"删除进行到一半时树刷新了"这种竞态：那时宁可少报数，
   * 也不要让"已选 3 项"配上一个只删得掉 2 个的动作。
   */
  missingIds: string[];
}

export function splitSelectedIds(
  ids: Iterable<string>,
  bookmarkIds: readonly string[],
  folderIds: readonly string[],
): SelectionSplit {
  const bookmarks = new Set(bookmarkIds);
  const folders = new Set(folderIds);

  const result: SelectionSplit = { bookmarkIds: [], folderIds: [], missingIds: [] };
  for (const id of ids) {
    if (bookmarks.has(id)) result.bookmarkIds.push(id);
    else if (folders.has(id)) result.folderIds.push(id);
    else result.missingIds.push(id);
  }
  return result;
}

/** 把 id 集合收敛到"树里还存在"的那些。用于树刷新后的清理。 */
export function retainExistingIds(
  ids: Iterable<string>,
  bookmarkIds: readonly string[],
  folderIds: readonly string[],
): Set<string> {
  const alive = new Set<string>([...bookmarkIds, ...folderIds]);
  const next = new Set<string>();
  for (const id of ids) if (alive.has(id)) next.add(id);
  return next;
}
