/**
 * 「从一组选项里挑一个」的菜单键盘状态机。
 *
 * 为什么单独放这里：这是**组件里唯一值得测的部分** —— 上下键边界、Home/End、
 * 回车选中、Esc/Tab 收起这些分支，靠真机点一遍很难穷尽（本仓组件不挂单测，
 * 见 vitest.config.ts 的注释）。渲染与焦点是另一回事，那部分留给真机探针。
 *
 * 用的是 WAI-ARIA 的 **menu button** 模式（`aria-haspopup="menu"` +
 * `role="menu"` + `role="menuitemradio"`），不是 listbox：这里的语义就是
 * "从一组单选里挑一个"，`menuitemradio` 的 `aria-checked` 正好说这件事。
 *
 * 两条刻意的规则：
 * - **不绕回**（ArrowDown 到底就停住）。菜单不是轮播：绕回去会让"按了几下"
 *   和"到哪一项了"失去对应关系。
 * - **空列表一律 none**，包括收起态的开合键 —— 没有可选项的菜单不该开。
 */

export type ChoiceMenuAction =
  | { kind: 'open'; index: number }
  | { kind: 'move'; index: number }
  | { kind: 'select'; index: number }
  | { kind: 'close' }
  | { kind: 'none' };

/** 把下标夹进 `[0, count)`；空列表返回 -1（调用方据此判"没得选"）。 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  // NaN 当 0（"没有高亮"落到第一项，别把菜单点哑）；±Infinity 照常夹到两端
  // —— 只判 `!Number.isFinite` 会把 Infinity 也吞成 0，那是另一个语义。
  if (Number.isNaN(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

/**
 * 按下的键该怎么处理。
 *
 * `index` 传的是"当前高亮项"（收起时 = 已选中项）：收起态按方向键或回车，
 * 菜单从**它**开起来，而不是从第一项 —— 三选一的菜单里让用户再看一遍
 * 从头上数下来毫无意义。
 */
export function resolveChoiceKey(input: {
  key: string;
  open: boolean;
  index: number;
  count: number;
}): ChoiceMenuAction {
  const { key, open, count } = input;
  if (count <= 0) return { kind: 'none' };

  const index = clampIndex(input.index, count);

  if (!open) {
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ' || key === 'Spacebar') {
      return { kind: 'open', index };
    }
    return { kind: 'none' };
  }

  switch (key) {
    case 'ArrowDown':
      return index >= count - 1 ? { kind: 'none' } : { kind: 'move', index: index + 1 };
    case 'ArrowUp':
      return index <= 0 ? { kind: 'none' } : { kind: 'move', index: index - 1 };
    case 'Home':
      return index === 0 ? { kind: 'none' } : { kind: 'move', index: 0 };
    case 'End':
      return index === count - 1 ? { kind: 'none' } : { kind: 'move', index: count - 1 };
    case 'Enter':
    case ' ':
    case 'Spacebar':
      return { kind: 'select', index };
    case 'Escape':
    case 'Tab':
      return { kind: 'close' };
    default:
      return { kind: 'none' };
  }
}
