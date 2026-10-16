/**
 * 右缘「最近访问」面板的数据层。
 *
 * 三条策略都是产品决策，不是实现细节：
 * ① **懒加载** —— 只在面板浮出时才读历史（悬停才劳动，与左栏"瞄一眼"同哲学）；
 *     不悬停就一次 `history` 调用都不发。
 * ② **开着时才追新** —— `chrome.history.onVisited` 订阅在页面存活期间一直挂着，
 *     但只有面板开着才重读：用户 Ctrl+点卡片开新标签，回到主画面板就是新的。
 *     关着时任何标签页的导航都不该惊动这个面板。
 * ③ **失败必须说出来** —— 读失败进错误态（一行说明 + 重试），不静默留空列表，
 *     那会被读成"最近什么都没访问"。
 *
 * 为什么住在 composable：这些是页面行为（watch / 订阅 / 三态），而 App.vue 不挂
 * 组件测试（vitest 是 node 环境）—— 与 useSidebarPeek、useSyncPresence 同一个理由。
 */

import { ref, watch, type Ref } from 'vue';

import { fetchRecentVisits, onHistoryVisited, type RecentVisit } from '../services/recent-history';

export interface RecentVisits {
  /** 当前列表（最新的在前）。 */
  visits: Ref<RecentVisit[]>;
  /** 正在读（加载态：轻骨架）。 */
  loading: Ref<boolean>;
  /** 上一次读失败（错误态：说明 + 重试）。 */
  error: Ref<boolean>;
  /** 重试：错误态那颗按钮与每次浮出都走它。 */
  reload: () => Promise<void>;
  /** 挂 onVisited 订阅。页面 onMounted 里调。 */
  start: () => void;
  /** 退订。页面 onUnmounted 里调。 */
  stop: () => void;
}

export function useRecentVisits(active: Ref<boolean>): RecentVisits {
  const visits = ref<RecentVisit[]>([]);
  const loading = ref(false);
  const error = ref(false);

  /**
   * 读一次。请求号防竞态：连续两次 reload（浮出 → onVisited → 又浮出）时，
   * 先发的那个后回来不许覆盖新的结果。
   */
  let requestId = 0;

  async function reload(): Promise<void> {
    const id = (requestId += 1);
    loading.value = true;
    try {
      const next = await fetchRecentVisits();
      if (id !== requestId) return;
      visits.value = next;
      error.value = false;
    } catch {
      if (id !== requestId) return;
      visits.value = [];
      error.value = true;
    } finally {
      if (id === requestId) loading.value = false;
    }
  }

  // 浮出成立 ⇒ 读一次（每次浮出都重读：别处的访问要靠这个兜底）。
  watch(active, (open) => {
    if (open) void reload();
  });

  let unsubscribe: (() => void) | null = null;

  function start(): void {
    if (unsubscribe) return;
    unsubscribe = onHistoryVisited(() => {
      // 面板开着才追新（策略②）。内容不看 —— 重读一次比增量合并简单且不会错。
      if (active.value) void reload();
    });
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  return { visits, loading, error, reload, start, stop };
}
