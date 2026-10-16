/**
 * 自绘提示气泡的定位。
 *
 * 为什么要有这个纯函数：气泡只有**一个**（App.vue 里那个共用的 `.card-tip`），
 * 但定位要回答三件事 —— 翻面（上/下）、左右夹紧（贴边的卡片不能超出视口）、
 * 空间都不够时选哪边。这三件事全是几何，把它们抽成纯函数就能被单测钉住
 * （仓库没有组件测试基座，`lib/**` 是唯一能跑 node 测试的地方）。
 *
 * 坐标系：**视口坐标**（气泡是 `position: fixed`，跟锚点的 `getBoundingClientRect()`
 * 同一个坐标系，不用管页面滚没滚）。
 */

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export type TipPlacement = 'top' | 'bottom';

export interface TipPosition {
  left: number;
  top: number;
  placement: TipPlacement;
  /**
   * 箭头中心相对气泡左边缘的 x（px）—— 气泡被夹紧时它**不**在气泡中央，
   * 而是始终指着卡片。CSS 用 `left: var(--tip-arrow)` 消费它。
   */
  arrowLeft: number;
}

export interface TipPlaceOptions {
  /** 气泡与锚点之间的缝。 */
  gap?: number;
  /** 气泡与视口四边至少留的距离。 */
  margin?: number;
}

/** 气泡与锚点之间的缝（8px）。 */
export const TIP_GAP_PX = 8;
/** 气泡与视口四边至少留的距离（8px）。 */
export const TIP_MARGIN_PX = 8;
/**
 * 箭头中心离气泡左右边缘至少这么远。箭头是 6px 方块转 45°（半对角线 4.24px），
 * 12px 的 inset 保证它整个落在气泡的直边段里，不会探进圆角外面——
 * 圆角是 --radius-md（10px，青柠 12px），inset 取大一档。
 */
export const TIP_ARROW_INSET_PX = 12;

/**
 * 算出气泡的 `left` / `top`（视口坐标）与落面。
 *
 * 三条规则，按顺序：
 * 1. **默认落上方**，水平居中于锚点 —— 提示在卡片上沿，视线不用往下跑。
 * 2. 上方不够（第一排卡片贴着顶栏、锚点本身很矮）就**翻到下方**；
 *    两边都不够时选**空间更大**的一边，允许溢出视口（比"干脆不显示"强）。
 * 3. 水平方向夹紧在 `[margin, 视口宽 - margin - 气泡宽]` 里 —— 卡片贴着左/右缘时
 *    气泡不能被视口切掉。气泡比可用空间还宽时贴左（右溢出），这一档由 CSS 的
 *    `max-width: min(320px, calc(100vw - 16px))` 兜住，正常不会发生。
 *
 * 另外单独算 `arrowLeft`：**夹紧之后气泡不再居中于卡片**，箭头若还放在气泡正中
 * 就歪了。所以箭头中心跟着锚点中心走，再用 inset 夹在气泡直边段内。
 */
export function placeTip(
  anchor: RectLike,
  tip: SizeLike,
  viewport: SizeLike,
  options: TipPlaceOptions = {},
): TipPosition {
  const gap = options.gap ?? TIP_GAP_PX;
  const margin = options.margin ?? TIP_MARGIN_PX;

  const above = anchor.top;
  const below = viewport.height - anchor.bottom;
  const fitsAbove = above >= tip.height + gap;
  const fitsBelow = below >= tip.height + gap;

  // 上方放得下就上；否则下方放得下就下；两边都放不下选空间大的那边。
  const placement: TipPlacement =
    fitsAbove || (!fitsBelow && above >= below) ? 'top' : 'bottom';

  const top = placement === 'top' ? anchor.top - gap - tip.height : anchor.bottom + gap;

  const centred = (anchor.left + anchor.right) / 2 - tip.width / 2;
  const maxLeft = viewport.width - margin - tip.width;
  const left = maxLeft <= margin ? margin : Math.max(margin, Math.min(centred, maxLeft));

  // 箭头中心：锚点中心在气泡里的位置，夹在 [inset, 宽 - inset] 里。
  const anchorCentre = (anchor.left + anchor.right) / 2 - left;
  const arrowLeft = Math.max(
    TIP_ARROW_INSET_PX,
    Math.min(anchorCentre, tip.width - TIP_ARROW_INSET_PX),
  );

  return { left, top, placement, arrowLeft };
}
