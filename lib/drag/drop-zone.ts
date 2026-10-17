/**
 * 落点判定的几何。
 *
 * 纯函数、不碰 DOM：`composables/useDragArrange.ts` 只负责把指针位置喂进来。
 * 抽出来的理由是这条规则**必须能被单测钉住** —— 它一旦退化，
 * 表现是"功能还在，但人做不到"，最难被发现。
 */

import type { DropZone } from './drop-plan';

/** 上下缘各占四分之一是"插到它旁边"，中间一半是"放进去"。 */
export const EDGE_RATIO = 0.25;
/** 边带的绝对下限：按比例切在矮元素上会切出几像素，人点不中。 */
export const MIN_EDGE_PX = 8;
/** "放进去"那一段至少占多少比例，别被两个边带挤没了。 */
export const MIN_INSIDE_RATIO = 0.4;

/**
 * 边带宽度（px）。
 *
 * 分组标题只有 22px 高，纯按 25% 切 ⇒ 5.6px。那不是"难点中"，是"做不到" ——
 * 2026-10-12 实测：瞄在标题正中间的人，落进中间的 50% ⇒ 文件夹被**塞进另一个文件夹**
 * 而不是排序。所以给边带一个 8px 的下限，同时保证中间至少留四成。
 */
export function dropEdgePx(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  const proportional = height * EDGE_RATIO;
  return Math.min(Math.max(proportional, MIN_EDGE_PX), (height * (1 - MIN_INSIDE_RATIO)) / 2);
}

/**
 * 按**纵向**位置判定落点。纵向列表（侧边栏目录树、分组块）用它。
 *
 * @param mode 'edge' = 只分前后（书签卡片，没有"里面"可进）；'folder' = 三段。
 * @param allowEdge false 时只认"放进去" —— 一级目录用它，改一级目录的次序等于
 *                  改浏览器根节点下的顺序，不开放。
 */
export function zoneFromVertical(input: {
  /** 落点元素的高度（px）。 */
  height: number;
  /** 指针在元素内的纵向偏移（px）。 */
  offsetY: number;
  mode: 'edge' | 'folder';
  allowEdge?: boolean;
}): DropZone {
  const { height, offsetY, mode, allowEdge = true } = input;
  if (mode === 'edge') return offsetY < height / 2 ? 'before' : 'after';
  if (!allowEdge) return 'inside';
  const edge = dropEdgePx(height);
  if (offsetY < edge) return 'before';
  if (height - offsetY < edge) return 'after';
  return 'inside';
}

/**
 * 按**横向**位置判定落点。横向铺开的网格（书签卡片、文件夹块）用它。
 *
 * ★ 2026-10-17 之前这里没有这一份：卡片区是 `auto-fill, minmax(240px)` 的**横排**网格，
 *   落点却按上下半判，而插入线早就画的是左右竖条（style.css 里 .bookmark-card.drop-before
 *   是 inset 3px 0）—— 样式和几何从一开始就说的两件事。
 *   症状：横向拖拽时指针通常在卡片竖直中线以下 ⇒ 永远判成"插到它后面" ⇒
 *   向**后**拖一格正好落回原位（被 same-position 静默拒掉），向**前**拖一格却正常。
 */
export function zoneFromHorizontal(input: {
  /** 落点元素的宽度（px）。 */
  width: number;
  /** 指针在元素内的横向偏移（px）。 */
  offsetX: number;
  mode: 'edge' | 'folder';
  allowEdge?: boolean;
}): DropZone {
  const { width, offsetX, mode, allowEdge = true } = input;
  if (mode === 'edge') return offsetX < width / 2 ? 'before' : 'after';
  if (!allowEdge) return 'inside';
  const edge = dropEdgePx(width);
  if (offsetX < edge) return 'before';
  if (width - offsetX < edge) return 'after';
  return 'inside';
}
