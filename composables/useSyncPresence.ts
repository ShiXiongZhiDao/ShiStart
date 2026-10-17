/**
 * 主页上"跟着同步走"的那几个事实，以及收到「同步跑完了」之后的整体刷新。
 *
 * 为什么单独抽出来：这些事实（配没配同步、自动同步开没开、同步状态点、回收站角标、
 * 右键菜单的能力探测）**都由本页之外的上下文改变** —— 后台 alarm、设置页的
 * 「立即同步」/「一键连接」/「一键回退」都会动它们。所以它们是这一页里最容易变陈旧的
 * 东西，也正是用户报过的两个 bug 的住处：
 * ① 连接之后回收站入口不出现（它 `v-if="syncConfigured"`，而那个值只在挂载时读过一次）；
 * ② 手动同步之后回收站角标不更新（广播那半边漏在设置页的调用点，已在引擎里修）。
 *
 * 抽成 composable 的直接收益是**可测**：`entrypoints/newtab/App.vue` 是个 ~1550 行的
 * 组件，而仓库没有组件测试基座（`vitest.config.ts` 是 node 环境、只收 `lib/**` +
 * `services/**`）。这里只需要假一个 `chrome` 就能在 node 里跑，行为因此锁得住。
 *
 * 生命周期刻意做成 `start()` / `stop()` 而不是 `onMounted` / `onUnmounted`：
 * 那两个钩子需要组件实例，测试里没有；页面自己把它们接到钩子上。
 */

import { ref, type Ref } from 'vue';
import { readSyncStatus } from '../services/sync-engine';
import { readTrashView } from '../services/trash';
import { isConfigured, loadSyncConfig } from '../services/sync-config';
import { readRestorePointError } from '../services/restore-points';
import { isIncognitoAccessAllowed, supportsSplitView } from '../services/tab-actions';
import { SYNC_DONE_MESSAGE } from '../lib/messages';
import type { SyncStatus } from '../types/sync-state';

export interface SyncPresenceDeps {
  /**
   * 同步跑完后，除了本 composable 自己管的那几个事实，页面还要刷的东西
   * （回收站面板重读、删除文件夹的期望核对）。
   *
   * 注入进来是为了让"收到广播该做什么"只有一份定义，而且这一份可测。
   * **新增一个"跟着同步走"的事实，就加在这里或上面的 ref 里，别再在页面里挂一个
   * 各写各的监听器** —— 那正是漏刷的来源。
   */
  onAfterSync?: () => void;
}

export interface SyncPresence {
  /** 同步状态点（顶栏）。 */
  syncStatus: Ref<SyncStatus | null>;
  /**
   * 本机记的"上次写恢复点失败"（零网络，读 IndexedDB 的 meta）。
   * 既有约定 起顶栏红点为它挂点、落点分流到「快照」分区 —— 保险断了
   * 不能只有设置页一处看得见。同步成功时引擎会清掉它，所以它天然是"当前事实"。
   */
  restorePointError: Ref<string | null>;
  /** 配过同步没有。删除确认那行文案与侧边栏回收站入口都看它（入口是 `syncConfigured || trashCount > 0`）。 */
  syncConfigured: Ref<boolean>;
  /** 「自动同步」开着没有。与 `syncConfigured` 是两个事实，都影响"删了能不能找回"的措辞。 */
  autoSyncOn: Ref<boolean>;
  /** 右键菜单里那两项的前置条件。能力不足时如实说，不静默降级。 */
  incognitoReady: Ref<boolean>;
  splitReady: Ref<boolean>;
  /** 侧边栏角标：待同步 + 回收站里的。 */
  trashCount: Ref<number>;
  refreshSyncStatus(): Promise<void>;
  refreshMenuCapabilities(): Promise<void>;
  refreshTrashCount(): Promise<void>;
  /** 收到「同步跑完了」时走的那一次全量补齐。 */
  refreshAfterSync(): Promise<void>;
  /** 开始监听广播（页面在 `onMounted` 里调）。 */
  start(): void;
  /** 停止监听（页面在 `onUnmounted` 里调）。 */
  stop(): void;
}

export function useSyncPresence(deps: SyncPresenceDeps = {}): SyncPresence {
  const syncStatus = ref<SyncStatus | null>(null);
  const restorePointError = ref<string | null>(null);
  const syncConfigured = ref(false);
  const autoSyncOn = ref(false);
  const incognitoReady = ref(false);
  const splitReady = ref(false);
  const trashCount = ref(0);

  async function refreshSyncStatus(): Promise<void> {
    try {
      syncStatus.value = await readSyncStatus();
    } catch {
      // 同步状态读不出来不影响主页展示书签。
    }
    // 保险状态与状态读数同源同路：都是"跟着同步走"的事实，读失败都不该炸主页。
    try {
      restorePointError.value = await readRestorePointError();
    } catch {
      restorePointError.value = null;
    }
  }

  /**
   * 重新读一遍"配没配同步"和菜单要用的能力事实。
   *
   * **打开菜单时也要读一次**，不能只在页面加载时读：新标签页会长时间挂在后台，
   * 用户完全可能在这个页面开着的时候去设置页配好同步，再切回来右键 ——
   * 那时页面里的旧值会让确认那行写成"找不回来"，而其实回收站就在那儿。
   * 说错话比不说更糟。
   */
  async function refreshMenuCapabilities(): Promise<void> {
    try {
      const config = await loadSyncConfig();
      syncConfigured.value = isConfigured(config);
      autoSyncOn.value = isConfigured(config) && config.autoSync;
    } catch {
      // 读不出来就按"没有回收站"措辞 —— 宁可把话说得保守些。
      syncConfigured.value = false;
      autoSyncOn.value = false;
    }
    try {
      incognitoReady.value = await isIncognitoAccessAllowed();
    } catch {
      incognitoReady.value = false;
    }
    splitReady.value = supportsSplitView();
  }

  /**
   * 刷新侧边栏那个角标。**纯本机，零网络**（"待同步"那一档也是本地对账算出来的）。
   *
   * 读失败就当 0：它是个角标，不该因为它把整页弄出错误态。真正的"读不到"由面板自己报。
   *
   * **不再因为"没配置同步"就提前归零**（2026-10-17 修）：墓碑存在**本机基线**里，
   * 断开配置不会删它；而恢复是"重建原生书签 + 换绑映射"（既有约定，零网络），
   * 也不依赖同步配置。曾经同步过又断开配置的用户，本地墓碑仍在、也仍能就地恢复 ——
   * 提前归零再配上入口的 `v-if`，会把它们彻底挡在看不见的地方。
   */
  async function refreshTrashCount(): Promise<void> {
    try {
      const view = await readTrashView();
      trashCount.value = view.tombs.length + view.pending.length;
    } catch {
      trashCount.value = 0;
    }
  }

  /**
   * 把这一页上所有"跟着同步走"的东西补齐。
   *
   * 一次全读，而不是只刷回收站计数 —— 同步是在**别处**跑完的，所以这一页关于同步的
   * **每个**事实都陈旧了：
   * - `syncStatus` → 顶栏那颗状态点（**只在失败/冲突时挂出来**，既有约定 修订）；
   * - `syncConfigured` / `autoSyncOn` → 侧边栏的回收站入口是
   *   `v-if="syncConfigured || trashCount > 0"`，而它只在挂载时读过一次。不重读的话，
   *   「一键连接」之后那个入口根本不出现，得手动刷新页面才行
   *   （用户报过：连接后书签都显示了，回收站却没有）；
   * - 回收站角标与面板 —— 它们是墓碑的视图，同步跑完才有内容。
   */
  async function refreshAfterSync(): Promise<void> {
    await refreshSyncStatus();
    // 先重读配置、再算角标：刚连接完那一次要两个值在同一拍里一起到位
    // （入口的显隐与角标上的数）。2026-10-17 之前这里还多一层"早退"依赖——
    // 角标曾因 !syncConfigured 直接归零，顺序错了连接后也算不出 1；那个早退已删，
    // 顺序现在只是让两个值一起到达，不再承载正确性。
    await refreshMenuCapabilities();
    await refreshTrashCount();
    deps.onAfterSync?.();
  }

  function onRuntimeMessage(message: unknown): void {
    if ((message as { type?: string } | undefined)?.type !== SYNC_DONE_MESSAGE) return;
    void refreshAfterSync();
  }

  function start(): void {
    chrome.runtime?.onMessage?.addListener(onRuntimeMessage);
  }

  function stop(): void {
    chrome.runtime?.onMessage?.removeListener(onRuntimeMessage);
  }

  return {
    syncStatus,
    restorePointError,
    syncConfigured,
    autoSyncOn,
    incognitoReady,
    splitReady,
    trashCount,
    refreshSyncStatus,
    refreshMenuCapabilities,
    refreshTrashCount,
    refreshAfterSync,
    start,
    stop,
  };
}
