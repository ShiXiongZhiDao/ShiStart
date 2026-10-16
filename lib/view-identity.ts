/**
 * 视图身份：决定内容区"在看什么"的最小状态组合 ——
 * 视图（浏览 / 回收站）+ 目录 id + 是否处于搜索态。
 *
 * 它的产物只做一件事：当内容区 <Transition> 的 key。语义有两面，两面都别动：
 * - **变化 ⇒ 播切换动效**（快出慢进，见 style.css 的 .view-switch-*）；
 * - **不变 ⇒ 不播**。所以同目录内的数据增删改（删除 / 拖拽 / 同步刷新 / 撤销）
 *   与搜索词的逐字变化都**不进**这个键 —— 否则每操作一下就整页闪一次。
 *
 * 注意它**不要**从"解析后的当前目录"（selectedFolderId）算出来：那是个 computed，
 * 启动加载阶段会随设置与书签树陆续读入而漂移，拿它成键会让每次打开新标签页
 * 都白播一次切换。调用方只在**用户动作**（点目录 / 进回收站 / 改搜索框）里
 * 更新持有这个键的那个 ref。
 */
export function viewIdentityKey(
  view: 'browse' | 'trash',
  folderId: string | null,
  searching: boolean,
): string {
  if (view === 'trash') return 'trash';
  return `browse:${folderId ?? ''}:${searching ? 'search' : 'list'}`;
}
