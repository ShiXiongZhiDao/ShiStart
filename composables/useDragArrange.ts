import { ref } from 'vue';
import { zoneFromHorizontal, zoneFromVertical } from '../lib/drag/drop-zone';
import { resolveReorderZone, type DropZone } from '../lib/drag/drop-plan';

/**
 * 拖拽整理的状态机。
 *
 * 用**模块级单例**而不是每个组件一份：侧边栏目录树是递归组件，
 * 而"现在拖着谁"和"落点在哪"全页只能有一份（与 `useSettings` 同一个理由）。
 *
 * 只放状态和落点判定，**不碰书签数据** —— 真正的移动由注册进来的 handler 做，
 * 它住在 App.vue 里，因为只有那里握着整棵树。
 */

/** 落点按哪个轴判：横向网格（卡片、文件夹块）用 x，纵向列表（侧边栏、分组）用 y。 */
export type DragAxis = 'x' | 'y';

export interface DragSource {
  id: string;
  kind: 'bookmark' | 'folder';
  title: string;
  /**
   * 同一容器里兄弟的 id（界面顺序）。
   *
   * 有了它，同父排序的"前/后"由**目标与拖动的相对位置**决定（`resolveReorderZone`）——
   * 指针落在目标的哪一半不参与。没有它只能按几何判，而"抓卡片右半边往左拖"
   * 在几何上永远落成"插到前一张之后" = 原位（2026-10-17 修的就是这个）。
   * 跨目录拖放时它会被原样忽略：那种场景下落点在哪一半才是有意义的信号。
   */
  siblingIds?: string[];
}

export interface DropHint {
  targetId: string;
  zone: DropZone;
}

export interface DropRequest {
  draggedId: string;
  targetId: string;
  zone: DropZone;
}

// 落点几何（边带宽度、三段判定）在 `lib/drag/drop-zone.ts`，是纯函数且有单测 ——
// 别把这类"差几像素就整个功能失效"的规则留在组件里。

const dragging = ref<DragSource | null>(null);
const hint = ref<DropHint | null>(null);

let dropHandler: ((request: DropRequest) => void) | null = null;

export function useDragArrange() {
  function begin(source: DragSource, event: DragEvent): void {
    dragging.value = source;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // dragover 阶段浏览器不给读 data，写上只是为了让这次拖拽在别处（比如拖出页面）
      // 仍然带着稳定的语义，而不是默认的"拖一个链接"。
      event.dataTransfer.setData('text/plain', source.id);
    }
  }

  function cancel(): void {
    dragging.value = null;
    hint.value = null;
  }

  /** 当前落点落在 `targetId` 上的哪一段；不在它上面时返回 null。 */
  function hintZone(targetId: string): DropZone | null {
    const current = hint.value;
    if (!current || current.targetId !== targetId) return null;
    return current.zone;
  }

  /**
   * 落点判定。
   *
   * 轴由布局决定：横向网格（卡片、文件夹块）走 `zoneFromHorizontal`，
   * 纵向列表（侧边栏、分组）走 `zoneFromVertical`。
   *
   * ★ 判定顺序很要紧：**先按几何算出落在哪一段，再让"同父排序"的方向规则盖掉前/后**。
   *   反过来（先方向、再几何）会把文件夹的"放进去"整段吃掉。
   *
   * @param mode 'edge' = 只分前后（书签卡片，没有"里面"可进）；
   *             'folder' = 三段（前后 + 放进去）。
   * @param allowEdge false 时只认"放进去" —— 一级目录用它，因为改一级目录的次序
   *                  等于改浏览器根节点下的顺序，不开放。
   * @param axis 'x' = 横向网格；'y' = 纵向列表（默认）。
   */
  function zoneFor(
    event: DragEvent,
    targetId: string,
    mode: 'edge' | 'folder',
    allowEdge: boolean,
    axis: DragAxis,
  ): DropZone {
    const element = event.currentTarget as HTMLElement | null;
    const rect = element?.getBoundingClientRect();
    if (!rect || rect.height === 0 || rect.width === 0) return mode === 'folder' ? 'inside' : 'before';
    const geometric =
      axis === 'x'
        ? zoneFromHorizontal({
            width: rect.width,
            offsetX: event.clientX - rect.left,
            mode,
            allowEdge,
          })
        : zoneFromVertical({
            height: rect.height,
            offsetY: event.clientY - rect.top,
            mode,
            allowEdge,
          });
    const source = dragging.value;
    if (!source?.siblingIds || source.id === targetId) return geometric;
    return resolveReorderZone(source.siblingIds, source.id, targetId, geometric);
  }

  function over(
    event: DragEvent,
    targetId: string,
    mode: 'edge' | 'folder',
    allowEdge = true,
    axis: DragAxis = 'y',
  ): void {
    const source = dragging.value;
    // 拖到自己身上没有意义（放进自己 = 造环，插到自己旁边 = 原地）。
    // 这里**不** preventDefault，浏览器因此不会给 drop —— 连视觉反馈都不给。
    if (!source || source.id === targetId) return;
    // 不 preventDefault 浏览器就不给 drop —— 这一行是必需的。
    event.preventDefault();
    // 分组是嵌着卡片与文件夹块的：里层先接管，外层（整节）才轮得到。
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    hint.value = { targetId, zone: zoneFor(event, targetId, mode, allowEdge, axis) };
  }

  function drop(
    event: DragEvent,
    targetId: string,
    mode: 'edge' | 'folder',
    allowEdge = true,
    axis: DragAxis = 'y',
  ): void {
    const source = dragging.value;
    if (!source || source.id === targetId) return;
    event.preventDefault();
    event.stopPropagation();
    const zone = zoneFor(event, targetId, mode, allowEdge, axis);
    cancel();
    dropHandler?.({ draggedId: source.id, targetId, zone });
  }

  /** 由 App.vue 注册：只有它握着整棵树，能算出落点到底是什么意思。 */
  function registerDropHandler(handler: ((request: DropRequest) => void) | null): void {
    dropHandler = handler;
  }

  return { dragging, hint, begin, cancel, hintZone, over, drop, registerDropHandler };
}
