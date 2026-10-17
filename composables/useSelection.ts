import { computed, ref } from 'vue';

/**
 * 多选状态。
 *
 * 模块级单例，和 `useDragArrange` / `useSettings` 同一个理由：全页只能有**一份**
 * "现在选中了哪些"，卡片、文件夹块、操作条都要读同一份。
 *
 * 存 `Set` 但**每次改动都换一个新 Set**：`ref(new Set())` 里原地 `add` 不会触发更新，
 * 这是 Vue 的响应式边界（`ref` 对 Set 的内部变更不追踪，除非用 `reactive`）。
 * 换成新实例最省心，代价是每次多一次分配 —— 选中是低频操作，不在乎。
 */

const selected = ref<ReadonlySet<string>>(new Set());

/** 选中数量。操作条的显隐与文案都读它。 */
const count = computed(() => selected.value.size);

/** 有没有选中任何东西。 */
const active = computed(() => selected.value.size > 0);

function commit(next: Set<string>): void {
  selected.value = next;
}

export function useSelection() {
  function has(id: string): boolean {
    return selected.value.has(id);
  }

  function toggle(id: string): void {
    const next = new Set(selected.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit(next);
  }

  function add(id: string): void {
    if (selected.value.has(id)) return;
    const next = new Set(selected.value);
    next.add(id);
    commit(next);
  }

  function clear(): void {
    if (selected.value.size === 0) return;
    commit(new Set());
  }

  /** 整组替换（Shift 范围选择用）。 */
  function replace(ids: Iterable<string>): void {
    commit(new Set(ids));
  }

  /**
   * 掉掉已经不存在的 id。
   *
   * 必须做：删除、同步拉取、切目录都会让树变化，选中集合里留着已消失的 id 的话，
   * 操作条会显示"已选 3 项"而屏幕上只有 2 张卡 —— 然后点删除只删得掉 2 个，
   * 用户看到的数字和实际动作对不上。
   */
  function retainExisting(existingIds: ReadonlySet<string>): void {
    if (selected.value.size === 0) return;
    const next = new Set<string>();
    for (const id of selected.value) if (existingIds.has(id)) next.add(id);
    if (next.size !== selected.value.size) commit(next);
  }

  return { selected, count, active, has, toggle, add, clear, replace, retainExisting };
}
