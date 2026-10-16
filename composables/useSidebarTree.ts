import { ref, watch, type Ref } from 'vue';
import { folderPathOf } from '../lib/bookmark-mapper';
import type { BookmarkFolderNode } from '../types/bookmarks';

/**
 * 侧边栏目录树的展开态。
 *
 * 三条规则，一律"用户点出来的"优先于"程序算出来的"：
 *
 * 1. **首次拿到书签树时铺开一级目录**（书签栏 / 其他书签 / 移动设备书签 / 未归类）。
 *    以前只铺三行根容器，侧边栏几乎全空 —— 打开新标签页第一眼看不到自己的分类在哪。
 *    ⚠️ 只铺一次：`seeded` 一旦置上就不再回填。刷新书签树是常态（同步、删除、撤销
 *    都走 `refresh()`），每次回填会把用户手动折叠过的一级目录重新撑开。
 * 2. **选中项变化时展开它的祖先**：从搜索结果跳进深层目录时，侧边栏要能显示当前位置。
 *    ⚠️ 只加不减（用 `Set.add`），别顺手折叠兄弟节点 —— 用户在侧边栏一层层点开的
 *    那几层，不该因为换了个目录就被收掉。
 * 3. **切换（toggle）只对"有子目录"的节点有意义**，判断在调用方：无子目录的行根本
 *    没有展开箭头，点了不该有反应。
 *
 * 展开态是**内存态**，刷新页面不保留 —— 与"书签树每次打开重新读取"同一套口径。
 * 持久化要面对"存的目录 id 这次已经没了"（用户可能在浏览器书签管理器里删了它），
 * 收益却只是省一次点击（既有约定 决策三）。
 *
 * 之所以从 App.vue 搬到这里：**这段是可以单测的**。App.vue 不挂组件测试，留在里面
 * 就只有真机能验（与 `useSyncPresence` 同一个理由）。
 */
export function useSidebarTree(roots: Ref<BookmarkFolderNode[]>, selectedId: Ref<string>) {
  const expandedIds = ref<Set<string>>(new Set());

  /** 一级目录的默认展开只做一次；之后一律听用户的（规则 1）。 */
  let seeded = false;

  watch(
    roots,
    (list) => {
      if (seeded || list.length === 0) return;
      seeded = true;
      const next = new Set(expandedIds.value);
      list.forEach((node) => next.add(node.id));
      expandedIds.value = next;
    },
    { immediate: true },
  );

  watch(
    selectedId,
    (id) => {
      const path = folderPathOf(roots.value, id);
      if (path.length <= 1) return;
      const next = new Set(expandedIds.value);
      path.slice(0, -1).forEach((node) => next.add(node.id));
      expandedIds.value = next;
    },
    { immediate: true },
  );

  function isExpanded(id: string): boolean {
    return expandedIds.value.has(id);
  }

  /** 有子目录的行点一下开、再点一下合（既有约定 决策二）。 */
  function toggleExpand(id: string): void {
    const next = new Set(expandedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedIds.value = next;
  }

  return { expandedIds, isExpanded, toggleExpand };
}
