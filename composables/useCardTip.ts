/**
 * 书签卡片的**自绘**提示。
 *
 * 为什么不用原生 `title`：原生提示由浏览器绘制，深色下是一块发蓝的黑底白字，
 * 与两套配色、与暖陶的青柠气质完全对不上 —— 用户原话"太丑了"。CSS 又碰不到它，
 * 所以只能自绘。
 *
 * 形状（都是刻意的）：
 * - **全页共用一个气泡**。卡片只带 `data-tip`（文本），谁都不自带 DOM ——
 *   一个网格几十张卡，各带一份就是几十份隐藏节点 + 几十个定位实现。
 *   位置/翻面/边界夹紧只有一份，在 `lib/tooltip-place.ts`（有单测）。
 * - **悬停意图**：停满 400ms 才出现，穿过网格时不会一路闪；
 *   已经在显示时换到另一张卡**立刻换**，不再等（等会显得迟钝）。
 * - **消失从宽**：鼠标离开、点击、滚动、窗口缩放、失焦、Esc —— 一律立刻收，
 *   没有"再等几秒"（提示是低优先级信息，晚收比早收更烦）。
 * - **键盘焦点也显示**，但只在 `:focus-visible`（Tab 来的）—— 鼠标点一下卡片
 *   也给它焦点，那时弹提示纯属噪音。
 * - 气泡 `pointer-events: none`：不会把"鼠标移到气泡上"算成离开卡片。
 *
 * 生命周期 `start()` / `stop()`：与 `useSidebarPeek` / `useSyncPresence` 同一条规矩 ——
 * 那对钩子需要组件实例，测试里没有。这里的监听是文档/窗口级的（scroll、pointerdown…），
 * 页面在 `onMounted` / `onUnmounted` 里接上。
 *
 * 测试怎么注入：测量与视口默认读真实 DOM，测试里用 `measure` / `viewport` 换掉，
 * 于是这个状态机可以在 node 环境里跑（`nextTick` 与假定时器就够）。
 */

import { nextTick, ref, type Ref } from 'vue';
import {
  placeTip,
  type SizeLike,
  type TipPlacement,
} from '../lib/tooltip-place';

/** 鼠标要停多久才算"想看提示"（400ms：比"手滑过网格"长，比"故意悬停"短）。 */
export const TIP_HOVER_DELAY_MS = 400;

export interface CardTipState {
  text: string;
  /** 视口坐标（气泡是 position: fixed）。 */
  left: number;
  top: number;
  placement: TipPlacement;
  /** 箭头中心相对气泡左缘的 x（px），模板写成 `--tip-arrow` 给 CSS 用。 */
  arrowLeft: number;
}

export interface CardTipDeps {
  /** 量气泡自己的尺寸。默认读 `tipEl`；给不出（还没挂载）就返回 null。 */
  measure?: () => SizeLike | null;
  /** 视口尺寸。默认读 `window.innerWidth/Height`。 */
  viewport?: () => SizeLike;
  /** 悬停延迟（测试里调小/调成 0）。 */
  delayMs?: number;
}

export interface CardTip {
  /** 当前气泡；null = 不渲染。 */
  tip: Ref<CardTipState | null>;
  /** 模板绑到气泡元素上的 ref（量尺寸用）。 */
  tipEl: Ref<HTMLElement | null>;
  onTipPointerOver(event: PointerEvent): void;
  onTipPointerOut(event: PointerEvent): void;
  onTipFocusIn(event: FocusEvent): void;
  onTipFocusOut(event: FocusEvent): void;
  hide(): void;
  start(): void;
  stop(): void;
}

/** 从事件目标找到带提示的锚点（卡片）；没有或文本为空就返回 null。 */
function anchorFor(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  const anchor = el.closest('[data-tip]') as HTMLElement | null;
  if (!anchor) return null;
  return (anchor.dataset.tip ?? '') === '' ? null : anchor;
}

export function useCardTip(deps: CardTipDeps = {}): CardTip {
  const tip = ref<CardTipState | null>(null);
  const tipEl = ref<HTMLElement | null>(null);
  const delayMs = deps.delayMs ?? TIP_HOVER_DELAY_MS;

  /** 正在显示的锚点（null = 没显示）。 */
  let shownAnchor: HTMLElement | null = null;
  /** 已经武装、等着到点的那一个。 */
  let pendingAnchor: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  function measure(): SizeLike | null {
    if (deps.measure) return deps.measure();
    const el = tipEl.value;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function viewport(): SizeLike {
    if (deps.viewport) return deps.viewport();
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function clearTimer(): void {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function hide(): void {
    clearTimer();
    pendingAnchor = null;
    shownAnchor = null;
    tip.value = null;
  }

  /**
   * 显示某个锚点的提示。两步：先挂进 DOM（位置待定），量完尺寸再定坐标 ——
   * 两步在同一个微任务里完成，浏览器还没画过，所以看不到"从左上角滑过来"。
   */
  async function show(anchor: HTMLElement): Promise<void> {
    const text = anchor.dataset.tip ?? '';
    if (text === '') return;
    clearTimer();
    pendingAnchor = null;
    shownAnchor = anchor;
    tip.value = { text, left: 0, top: 0, arrowLeft: 0, placement: 'top' };
    await nextTick();
    // 等的这一帧里可能已经被收掉了（鼠标已经离开、或者换了锚点）
    if (shownAnchor !== anchor || tip.value === null) return;
    const size = measure();
    if (!size) return;
    tip.value = { text, ...placeTip(anchor.getBoundingClientRect(), size, viewport()) };
  }

  /** 到点了就显示（武装）。 */
  function arm(anchor: HTMLElement): void {
    clearTimer();
    pendingAnchor = anchor;
    showTimer = setTimeout(() => {
      showTimer = null;
      void show(anchor);
    }, delayMs);
  }

  function onTipPointerOver(event: PointerEvent): void {
    const anchor = anchorFor(event.target);
    if (!anchor) return;
    if (anchor === shownAnchor || anchor === pendingAnchor) return; // 同一张卡内部移动
    // 已经有一个在显示：立刻换，不再让用户等第二遍延迟
    if (tip.value !== null) {
      void show(anchor);
      return;
    }
    arm(anchor);
  }

  function onTipPointerOut(event: PointerEvent): void {
    const anchor = anchorFor(event.target);
    if (!anchor) return;
    // 卡内子元素之间移动也会冒泡 pointerout：只有真的离开这张卡才算
    const to = (event as PointerEvent).relatedTarget as HTMLElement | null;
    if (to && anchor.contains(to)) return;
    if (anchor === pendingAnchor) {
      clearTimer();
      pendingAnchor = null;
    }
    if (anchor === shownAnchor) hide();
  }

  function onTipFocusIn(event: FocusEvent): void {
    const anchor = anchorFor(event.target);
    if (!anchor) return;
    // 只有键盘来的焦点才显示：鼠标点卡片也给它焦点，那时弹提示是噪音
    // （而且卡片一点就开新标签页，提示连出现的机会都没有）。
    if (typeof anchor.matches === 'function' && !anchor.matches(':focus-visible')) return;
    void show(anchor);
  }

  function onTipFocusOut(event: FocusEvent): void {
    const anchor = anchorFor(event.target);
    if (!anchor) return;
    const to = (event as FocusEvent).relatedTarget as HTMLElement | null;
    if (to && anchor.contains(to)) return;
    if (anchor === shownAnchor) hide();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') hide();
  }

  function start(): void {
    // scroll 走捕获：滚动容器里的滚动事件不冒泡，只有捕获阶段能在 window 收到。
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    // 点哪儿都先收：含拖拽的起手（拖起来之后锚点位置已经没意义了）。
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', onKeydown);
  }

  function stop(): void {
    window.removeEventListener('scroll', hide, true);
    window.removeEventListener('resize', hide);
    window.removeEventListener('blur', hide);
    document.removeEventListener('pointerdown', hide, true);
    document.removeEventListener('keydown', onKeydown);
    clearTimer();
  }

  return {
    tip,
    tipEl,
    onTipPointerOver,
    onTipPointerOut,
    onTipFocusIn,
    onTipFocusOut,
    hide,
    start,
    stop,
  };
}
