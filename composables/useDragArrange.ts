import { ref } from 'vue';
import { zoneFromVertical } from '../lib/drag/drop-zone';
import type { DropZone } from '../lib/drag/drop-plan';

/**
 * 拖拽整理的状态机。
 *
 * 用**模块级单例**而不是每个组件一份：侧边栏目录树是递归组件，
 * 而"现在拖着谁"和"落点在哪"全页只能有一份（与 `useSettings` 同一个理由）。
 *
 * 只放状态和落点判定，**不碰书签数据** —— 真正的移动由注册进来的 handler 做，
 * 它住在 App.vue 里，因为只有那里握着整棵树。
 */

export interface DragSource {
  id: string;
  kind: 'bookmark' | 'folder';
  title: string;
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
   * 一律按**纵向**位置算：卡片网格是横向铺开的，但"插到它前面/后面"用上下半来判断
   * 在纵横两种布局里都说得通，且与侧边栏（纵向列表）保持同一套手感。
   *
   * @param mode 'edge' = 只分前后（书签卡片，没有"里面"可进）；
   *             'folder' = 三段（前后 + 放进去）。
   * @param allowEdge false 时只认"放进去" —— 一级目录用它，因为改一级目录的次序
   *                  等于改浏览器根节点下的顺序，不开放。
   */
  function zoneFor(event: DragEvent, mode: 'edge' | 'folder', allowEdge: boolean): DropZone {
    const element = event.currentTarget as HTMLElement | null;
    const rect = element?.getBoundingClientRect();
    if (!rect || rect.height === 0) return mode === 'folder' ? 'inside' : 'before';
    return zoneFromVertical({
      height: rect.height,
      offsetY: event.clientY - rect.top,
      mode,
      allowEdge,
    });
  }

  function over(event: DragEvent, targetId: string, mode: 'edge' | 'folder', allowEdge = true): void {
    const source = dragging.value;
    // 拖到自己身上没有意义（放进自己 = 造环，插到自己旁边 = 原地）。
    // 这里**不** preventDefault，浏览器因此不会给 drop —— 连视觉反馈都不给。
    if (!source || source.id === targetId) return;
    // 不 preventDefault 浏览器就不给 drop —— 这一行是必需的。
    event.preventDefault();
    // 分组是嵌着卡片与文件夹块的：里层先接管，外层（整节）才轮得到。
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    hint.value = { targetId, zone: zoneFor(event, mode, allowEdge) };
  }

  function drop(event: DragEvent, targetId: string, mode: 'edge' | 'folder', allowEdge = true): void {
    const source = dragging.value;
    if (!source || source.id === targetId) return;
    event.preventDefault();
    event.stopPropagation();
    const zone = zoneFor(event, mode, allowEdge);
    cancel();
    dropHandler?.({ draggedId: source.id, targetId, zone });
  }

  /** 由 App.vue 注册：只有它握着整棵树，能算出落点到底是什么意思。 */
  function registerDropHandler(handler: ((request: DropRequest) => void) | null): void {
    dropHandler = handler;
  }

  return { dragging, hint, begin, cancel, hintZone, over, drop, registerDropHandler };
}
