/**
 * 侧边栏「浮出」状态机（既有约定；2026-10-15 按用户反馈修订）。
 * 2026-10-16 起**两侧各一个实例**：左缘 = 侧边栏，右缘 = 最近访问
 * 面板。两边共用同一套时序与豁免规则，只有三处按 `side` 分叉：
 * 热区判左缘还是右缘、面板元素（焦点管理）、`onOpen` 钩子（互斥关停）。
 *
 * 背景：默认收起（主区全宽）之后，"展开侧边栏"从一次点击变成一个高频动作，
 * 顶栏那颗孤钮 therefore 被撤掉，改成**左缘热区悬停浮出**：鼠标贴住主区左缘，
 * 侧边栏以浮层压在内容之上（**贴顶通高**、带投影、不推布局、不加遮罩）。
 * 鼠标进入面板即钉住，离开（几秒宽容）/ Esc / 点主区都会关。它**不写偏好** ——
 * 不是第三种持久态。
 *
 * 为什么抽成 composable：这段逻辑的价值全在时序（两个延迟、两段式关闭、焦点
 * 进出、吞点击），而 App.vue 不挂组件测试（vitest 是 node 环境）。留在组件里
 * 就只有真机能验，抽出来之后假一个 `window.matchMedia` + `document` 就能在
 * node 里把状态机锁住（与 useSyncPresence、useSidebarTree 同一个理由）。
 *
 * ⚠️ **关闭是两段式**（`closing`，2026-10-15 用户报修"关闭时主内容整体左右
 * 移动"）：直接摘掉浮层，aside 会从 `position: fixed` 变回流内，而内联 width
 * 还是 216（正在向 0 过渡）—— aside 瞬间重新占流，**主区猛窄 216px 再慢慢
 * 撑回**，面板还会闪回一下。所以先进入 `closing`：CSS `[data-peek='out']`
 * 保持 fixed 滑出，同时 width/flex-basis/padding 在这一态里向 0 过渡
 * （App.vue 的 `layoutCollapsed` 在 closing 期间为 true，width 从第一帧就
 * 归零）；滑完（PEEK_SLIDE_MS）再摘 data-peek，那时各项已归零 —— 摘除那一下
 * 零回流、零闪板，主区全程纹丝不动。开的那一遍不跳（fixed 前后都是 0 流
 * 空间），不需要两段。
 *
 * 常数与 style.css 的约定：`PEEK_SLIDE_MS` = `--dur-base`（160ms，滑出一段的
 * 时长）。离开宽容取 2s（用户原话"过个几秒后再关闭"）：够鼠标去主区办点事再
 * 回来，又不至于面板长期赖屏。
 */

import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';

/** 关闭时滑出一段的时长（ms）。必须与 style.css 的 `--dur-base` 一致。 */
export const PEEK_SLIDE_MS = 160;
/**
 * 进入热区后多久算"要浮出"（ms）。
 * 2026-10-16 从 120 放宽到 80（既有约定 修订二）：装机首日用户报修"很不灵敏、
 * 有时弹不出"，轨迹探针量出缘外 12px 停下 / 驻留不足两类静默失败。80ms 仍压得住
 * "指针路过"，但贴缘停一下的意图兑现更快。**不归零** —— 归零会让路过左缘
 * （去点第一列卡片、往主区左下角移动）都蹦面板 + 吞点击。
 */
export const OPEN_DELAY_MS = 80;
/**
 * 热区宽度（px）：指针横向坐标进缘界多少算武装。面板贴顶通高，纵向不设防。
 * 2026-10-16 从 8 放宽到 **24**（既有约定 修订二）：8px 是"几乎蹭到屏幕边"的
 * 精度，用户停在缘外 12px（感觉上已经贴边）时静默无反馈 —— 实测最主要的失效模式。
 * 24px = 触屏那颗把手的宽度，两缘共用一套常量、鼠标与手指同一个覆盖范围。
 */
export const HOT_ZONE_PX = 24;
/** 鼠标离开面板后多久关（ms）。用户要"过个几秒"，取 2s。 */
export const CLOSE_DELAY_MS = 2000;

/** 浮出在哪一缘。左缘 = 侧边栏；右缘 = 最近访问面板。 */
export type PeekSide = 'left' | 'right';

/**
 * 文档级吞击的豁免名单：点这些不算"点主区"。
 *
 * 三个选择器覆盖**两个实例**：左缘实例开着时不该吞右缘面板/把手上的点击
 * （互斥只保证"至多一个开着"，但右缘把手的点击要先放行、再由它把左缘关掉），
 * 反之亦然；`.sidebar` 也要豁免 —— 右缘开着时点持久展开的左导航是合法操作。
 */
const PEEK_SAFE_SELECTORS = ['.sidebar', '.recent-panel', '.peek-handle'];

export interface SidebarPeekOptions {
  /** 哪一缘。默认 'left'（既有约定 的老用法）。 */
  side?: PeekSide;
  /**
   * 「浮出有可能成立」的总闸。左缘实例 = 持久收起态（`settings.sidebarCollapsed`）；
   * 右缘实例 = 功能开着（`settings.recentPanel`）—— 右面板没有持久展开态，
   * 它永远是纯浮出，所以闸门不是"收起"而是"开不开"。
   */
  collapsed: Ref<boolean>;
  /** 面板本体（焦点管理用：键盘打开时把焦点移进去）。 */
  panelEl?: Ref<HTMLElement | null>;
  /** 钉住：把当前浮出转成持久展开（写偏好）。右缘面板没有这一出，不传。 */
  onPin?: () => void | Promise<void>;
  /**
   * 浮出真正成立时调用一次。右缘实例用它把左缘浮出关掉、左缘实例反之 ——
   * **互斥**：两侧同时浮出会把主区挤成一条缝。在 `open()` 里同步调，
   * 所以两面板从不同时处于 peeking。
   */
  onOpen?: () => void;
}

export interface SidebarPeek {
  /** 浮出可见中。它不写偏好，只驱动 `data-peek` 与浮层样式。 */
  peeking: Ref<boolean>;
  /**
   * 关闭的第二段：面板保持 fixed 滑出中（CSS `[data-peek='out']`）。
   * 这段时间里 `data-collapsed` 仍为 false（面板还是 216px 宽），滑完才脱离。
   */
  closing: Ref<boolean>;
  /** ≤900px 窄屏：侧边栏是顶部横条，没有"全宽"诉求，浮出整套不参与。 */
  narrow: Ref<boolean>;
  /** 有效收起态：窄屏恒显（false），否则听偏好。 */
  effectiveCollapsed: ComputedRef<boolean>;
  /**
   * 热区武装点。**由本 composable 自己挂在 document 上**（start/stop）——
   * 别再到某个元素上绑 @pointermove：滚动条区域的事件 target 是根元素，
   * 不经过任何内容容器（见 onPointerMove 的注释）。导出只为测试可直接调。
   */
  onPointerMove(event: PointerEvent): void;
  /** 挂 `<aside>` 的 mouseenter：进面板 = 钉住，取消离开计时。 */
  onSidebarEnter(): void;
  /** 挂 `<aside>` 的 mouseleave：键盘会话不关（焦点还在里面），其余进宽容期。 */
  onSidebarLeave(): void;
  /** 触屏/键盘把手按钮的 click：切换浮出。键盘激活（detail === 0）才移焦点。 */
  onHandleClick(event: MouseEvent): void;
  /** Esc：关浮出，键盘打开的连焦点一起还给触发点。 */
  closeOnEscape(): void;
  /** 把焦点移进面板第一个可聚焦项（`]` / `[` 展开后由 App.vue 调）。 */
  focusSidebar(): void;
  /** 立刻关浮出（两段式）。互斥钩子与面板头部 ✕ 钮都用它。 */
  close(): void;
  /** 开始监听（matchMedia + document 捕获点击）。页面 onMounted 里调。 */
  start(): void;
  /** 停止监听。页面 onUnmounted 里调。 */
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

export function useSidebarPeek(options: SidebarPeekOptions): SidebarPeek {
  const side = options.side ?? 'left';
  const peeking = ref(false);
  const closing = ref(false);
  const narrow = ref(false);
  const effectiveCollapsed = computed(() => (narrow.value ? false : options.collapsed.value));

  let openTimer: Timer | null = null;
  let closeTimer: Timer | null = null;
  let closeAnimTimer: Timer | null = null;
  /** 键盘打开时记住触发点，关闭时还回去；null = 这次是鼠标/触屏开的，不还。 */
  let returnFocusTo: HTMLElement | null = null;
  /** 这次浮出是不是键盘打开的：是则 mouseleave 不关（用户还在面板里用键盘）。 */
  let openedByKeyboard = false;

  function clearOpenTimer(): void {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function clearCloseTimer(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function clearCloseAnimTimer(): void {
    if (closeAnimTimer !== null) {
      clearTimeout(closeAnimTimer);
      closeAnimTimer = null;
    }
  }

  function clearTimers(): void {
    clearOpenTimer();
    clearCloseTimer();
    clearCloseAnimTimer();
  }

  /** 面板里的第一个可聚焦项：左缘是品牌行的钉住/收起钮，右缘是头部的 ✕（DOM 里都第一个）。 */
  function focusSidebar(): void {
    const el = options.panelEl?.value;
    if (!el || typeof el.querySelector !== 'function') return;
    const first = el.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus?.();
  }

  /**
   * 视口宽：右缘热区用。⚠️ 必须用**内容区宽度**（`clientWidth`），不是
   * `innerWidth` —— `innerWidth` 含竖直滚动条，而指针压在滚动条上时页面
   * **收不到 pointermove**（滚动条是浏览器 UI）：主页书签一多、窗口出滚动条，
   * 按 innerWidth 算的 8px 热区就整个压在滚动条上，鼠标贴内容右缘永远武装不了
   * （真机报修"有时不弹、有时能弹"的根因 —— 书签少时没有滚动条所以时好时坏；
   *  headless 滚动条只有 6px，还会剩一条 2px 细缝偶尔触发，更难捉）。
   * 左缘不受影响：左边没有滚动条，判据照旧。
   * 文档不可见（clientWidth 为 0）时回落 innerWidth。
   */
  function viewportWidth(): number {
    if (typeof document !== 'undefined' && document.documentElement) {
      const width = document.documentElement.clientWidth;
      if (typeof width === 'number' && width > 0) return width;
    }
    if (typeof window === 'undefined') return 0;
    const fallback = window.innerWidth;
    return typeof fallback === 'number' ? fallback : 0;
  }

  function open(moveFocus: boolean): void {
    if (!effectiveCollapsed.value) return;
    clearTimers();
    closing.value = false;
    // 先让面板可见，再移焦点（见下面 nextTick 的说明）。
    peeking.value = true;
    if (moveFocus) {
      // 结构判断而非 instanceof HTMLElement：node 测试环境里没有那个全局类，
      // 而这里只需要"能 focus"。
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      returnFocusTo =
        active && typeof (active as HTMLElement).focus === 'function'
          ? (active as HTMLElement)
          : null;
      openedByKeyboard = true;
      // ⚠️ 焦点必须等 `data-peek='on'` 真正落上、visibility 解除之后再移：
      // 右缘面板收起态是 `visibility: hidden`（链接要退出 Tab 顺序），
      // **隐藏容器里的 .focus() 是静默无效的**（真机探针逮到：
      // `]` 开了面板但焦点没进去）。左栏只淡出（opacity: 0）不隐 visibility，
      // 所以这个坑只在右缘显形 —— 但两缘走同一条路，就在这里一起修。
      void nextTick(focusSidebar);
    }
    // 互斥：这一缘浮出成立，另一缘若有浮出立刻关。
    options.onOpen?.();
  }

  /**
   * 关浮出，**两段式**（见文件头）：先把 `closing` 置上让 CSS 保持 fixed 滑出，
   * 滑完（PEEK_SLIDE_MS）再脱离。中途再开会取消滑出、直接回到开着。
   */
  function close(): void {
    clearTimers();
    if (peeking.value) {
      peeking.value = false;
      closing.value = true;
      closeAnimTimer = setTimeout(() => {
        closeAnimTimer = null;
        closing.value = false;
      }, PEEK_SLIDE_MS);
      if (returnFocusTo) {
        returnFocusTo.focus?.();
        returnFocusTo = null;
      }
    } else {
      closing.value = false;
    }
    openedByKeyboard = false;
  }

  /**
   * 浮出失去存在理由、但**不是用户主动关**的那几条：钉住 / `[` 展开 / 窄屏。
   * 这些情况下面板要立刻以"展开态"在场（或直接消失），不能播滑出 ——
   * 钉住时面板滑出去再弹回来会很难看。
   */
  function cancelClose(): void {
    clearTimers();
    peeking.value = false;
    closing.value = false;
    returnFocusTo = null;
    openedByKeyboard = false;
  }

  /**
   * 挂 document 的 pointermove：热区武装点。
   *
   * ⚠️ 为什么不挂在 `.shell` 元素上（既有约定 修订，真机逮到）：指针压在
   * **竖直滚动条**上时，事件的 target 是根元素（`<html>`），**不经过 .shell**
   * （实测 target=HTML、closest('.shell')=null）—— 挂在 shell 上的监听对
   * "屏幕右缘"这一整条带永久失灵。左缘没有滚动条所以从未显形，右缘书签一多
   * 就中招，表现为"右侧很不灵敏、左侧还好"。
   * 挂 document 还有语义上的正确性：热区是**视口边缘的属性**，不是某个元素的。
   * capture 阶段收：中途没人 stopPropagation，但收了更稳（与吞击的 click 同相位）。
   */
  function onPointerMove(event: PointerEvent): void {
    // 触屏没有 hover：它的通道是两缘的把手（onHandleClick），不占热区。
    if (event.pointerType === 'touch') return;
    if (!effectiveCollapsed.value || peeking.value) {
      clearOpenTimer();
      return;
    }
    // 面板贴顶通高（2026-10-15 修订）：纵向不再设防，任一缘任何高度都武装。
    const inHotZone =
      side === 'left'
        ? event.clientX <= HOT_ZONE_PX
        : event.clientX >= viewportWidth() - HOT_ZONE_PX;
    if (inHotZone) {
      if (openTimer === null) {
        openTimer = setTimeout(() => open(false), OPEN_DELAY_MS);
      }
    } else {
      clearOpenTimer();
    }
  }

  function onSidebarEnter(): void {
    clearCloseTimer();
    // 鼠标回到面板里 = 用户在用鼠标，键盘会话语义到此为止。
    openedByKeyboard = false;
  }

  function onSidebarLeave(): void {
    if (!peeking.value) return;
    if (openedByKeyboard) return;
    closeTimer = setTimeout(() => close(), CLOSE_DELAY_MS);
  }

  function onHandleClick(event: MouseEvent): void {
    if (peeking.value) {
      close();
      return;
    }
    // detail === 0 = 键盘（Enter/Space）激活的 click，这时焦点该进面板；
    // 鼠标/触屏点的不进 —— 焦点环会跟着冒出来挡视线。
    open(event.detail === 0);
  }

  function closeOnEscape(): void {
    close();
  }

  // 偏好被改成展开（钉住 / `[` / 设置页勾选）或窗口变窄 → 浮出失去存在理由。
  // 走 cancelClose 而非 close：这些情况面板要立刻以展开态在场，不播滑出。
  watch(effectiveCollapsed, (collapsed) => {
    if (!collapsed) cancelClose();
  });

  // ---------- document 捕获点击：点主区 = 关 + 吞掉那一击 ----------
  //
  // 为什么吞：不吞的话，第一下既关了面板、又点开了底下的卡片/链接 ——
  // 用户看到的是"面板关了，同时莫名其妙跳转/选中了一个东西"。
  // 捕获阶段拦在 document 上，面板内与把手上的点击放行。

  function onDocumentClick(event: MouseEvent): void {
    if (!peeking.value) return;
    const target = event.target as HTMLElement | null;
    if (target && typeof target.closest === 'function') {
      // 两个面板 + 两个把手都豁免（见 PEEK_SAFE_SELECTORS：右缘把手的点击
      // 要能放行过去、由它把左缘关掉；反之亦然）。
      if (PEEK_SAFE_SELECTORS.some((selector) => target.closest(selector))) return;
    }
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  // ---------- matchMedia：窄屏整套退出 ----------

  let mediaQuery: MediaQueryList | null = null;

  function onMediaChange(event: MediaQueryList | MediaQueryListEvent): void {
    narrow.value = event.matches;
    if (event.matches) cancelClose();
  }

  function start(): void {
    if (typeof window !== 'undefined' && window.matchMedia) {
      mediaQuery = window.matchMedia('(max-width: 900px)');
      narrow.value = mediaQuery.matches;
      mediaQuery.addEventListener('change', onMediaChange);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('click', onDocumentClick, true);
      // 热区武装挂在 document 上，不挂 .shell —— 滚动条区域的事件不过 shell
      // （target 是根元素）。见 onPointerMove 的注释。
      document.addEventListener('pointermove', onPointerMove, true);
    }
  }

  function stop(): void {
    clearTimers();
    mediaQuery?.removeEventListener('change', onMediaChange);
    mediaQuery = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('pointermove', onPointerMove, true);
    }
  }

  return {
    peeking,
    closing,
    narrow,
    effectiveCollapsed,
    onPointerMove,
    onSidebarEnter,
    onSidebarLeave,
    onHandleClick,
    closeOnEscape,
    focusSidebar,
    close,
    start,
    stop,
  };
}
