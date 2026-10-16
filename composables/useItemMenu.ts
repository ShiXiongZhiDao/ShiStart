import { ref } from 'vue';

/**
 * 右键菜单的目标与位置。
 *
 * 用**模块级单例**而不是逐层 emit：侧边栏目录树是递归组件，把"右键了谁"一路
 * emit 上来要在每一层都转发一遍，而这份状态全页只能有一份（与 `useDragArrange`
 * 同一个理由）。
 *
 * 只放"点右键点了谁"，**不碰书签数据** —— 真正的动作由注册进来的 handler 做，
 * 它住在 App.vue 里，因为只有那里握着整棵树与写通道。
 */

/** 菜单能对谁开：一条书签，或一个文件夹。 */
export type MenuTarget =
  | { kind: 'bookmark'; id: string; title: string; url: string }
  | {
      kind: 'folder';
      id: string;
      title: string;
      /**
       * 直接子节点数（书签 + 子文件夹）。0 = 空文件夹 —— 它免删除预览，
       * 菜单内两下点击就够。非空的一律走模态。
       */
      descendants: number;
      /**
       * 是不是一级目录（书签栏 / 其他书签 / 移动设备书签）。
       * 它们是浏览器给的容器，**不给删**——
       * 服务层另有一道断言，但菜单先不给才是对的。
       */
      isTopLevel: boolean;
    };

export interface MenuRequest {
  target: MenuTarget;
  x: number;
  y: number;
}

const request = ref<MenuRequest | null>(null);
let actionHandler: ((action: string) => void) | null = null;

export function useItemMenu() {
  function open(target: MenuTarget, event: MouseEvent): void {
    request.value = { target, x: event.clientX, y: event.clientY };
  }

  function close(): void {
    request.value = null;
  }

  /** 由 App.vue 注册：只有它握着整棵树与写通道。 */
  function registerActionHandler(handler: ((action: string) => void) | null): void {
    actionHandler = handler;
  }

  function fire(action: string): void {
    actionHandler?.(action);
  }

  return { request, open, close, fire, registerActionHandler };
}
