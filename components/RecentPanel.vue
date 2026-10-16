<script setup lang="ts">
/**
 * 右缘「最近访问」浮出面版的内容。
 *
 * 外层 `<aside class="recent-panel">`、`data-peek` 三态、mouseenter/leave 都由
 * App.vue 持有 —— 与左侧边栏同一条规矩：状态机住 composable（useSidebarPeek
 * 双实例），DOM 事实在页面组件。这个文件只负责"面板里画什么"。
 *
 * 版式（2026-10-16 重设计，四稿里选的「分组时间线」）：按**日历天**分
 * 今天 / 昨天 / 更早 三档，档头带条数；行是 34px 单行 —— 图标 + 标题（省略号）
 * + 右对齐时间。为什么选它：
 * ① 50 条平铺是一面墙，分档给出层次，而"难看"的根源多半是没层次；
 * ② 保住密度（一屏 ~14 条）—— 面板的职责是快速访问，精致到一屏 7 条是本末倒置；
 * ③ 浏览器历史页就是这个模型，零学习成本；④ 不需要解释的装饰（对比被否的
 * 时间轴圆点/竖线：装饰不参与扫读）。被否的三稿见 既有约定 决策三。
 *
 * 时间列随档位换口径：今天说相对（"3 分钟前"）、昨天说钟点（"21:14"——组头已经
 * 说了哪天，行里再报日期是重复）、更早说日期。三态纪律与主页一致：加载 = 轻骨架；
 * 读失败 = 明说 + 重试（不静默留空，那会被读成"最近什么都没访问"）；空 = 一句话。
 */

import { computed } from 'vue';

import { useI18n } from '../composables/useI18n';
import { createFaviconUrl } from '../lib/favicon';
import { formatClock, formatDate, formatRelativeTime, type DayBucket } from '../lib/format-time';
import type { MessageKey } from '../lib/i18n';
import { groupRecentVisits, type RecentVisit } from '../services/recent-history';
import SiteIcon from './SiteIcon.vue';

const { t, resolvedLocale } = useI18n();

const props = defineProps<{
  visits: RecentVisit[];
  loading: boolean;
  error: boolean;
}>();

const emit = defineEmits<{
  /** 头部 ✕（键盘 / 触屏用户的显式关闭入口；鼠标用户靠移开）。 */
  (event: 'close'): void;
  /** 错误态那颗重试。 */
  (event: 'retry'): void;
  /** 底部「查看全部历史」。 */
  (event: 'open-all'): void;
}>();

/** 档位 → 组头文案。 */
const GROUP_LABEL_KEY: Record<DayBucket, MessageKey> = {
  today: 'home.recent.today',
  yesterday: 'home.recent.yesterday',
  earlier: 'home.recent.earlier',
};

/**
 * 分档。`Date.now()` 不是响应式依赖 ⇒ computed 的值在本轮数据里**定住**、
 * 数据一换（重读 / onVisited 追新）自然重算 —— 正是要的：同一屏里不会因为
 * 跨了零点把同一行换组。
 */
const groups = computed(() => groupRecentVisits(props.visits, Date.now()));

/**
 * 历史条目都是 http(s)，favicon 直接构造。
 * `_favicon` 对没缓存图标的站点回占位图而非报错 —— SiteIcon 那边有签名比对，
 * 认得出就转字母牌，这里不用操心。
 */
function faviconOf(visit: RecentVisit): string {
  return createFaviconUrl(visit.url);
}

/** 时间列随档位换口径（见文件头）。相对时间拿不到（时钟跳了）时兜到钟点。 */
function timeOf(visit: RecentVisit, bucket: DayBucket): string {
  const locale = resolvedLocale.value;
  if (bucket === 'today') {
    return (
      formatRelativeTime(visit.lastVisitTime, Date.now(), locale) ??
      formatClock(visit.lastVisitTime, locale)
    );
  }
  if (bucket === 'yesterday') return formatClock(visit.lastVisitTime, locale);
  return formatDate(visit.lastVisitTime, locale);
}
</script>

<template>
  <header class="recent-head">
    <h2 class="recent-title">{{ t('home.recent.title') }}</h2>
    <button
      type="button"
      class="rail-btn"
      :title="t('home.recent.close')"
      :aria-label="t('home.recent.close')"
      @click="emit('close')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </header>

  <div class="recent-body">
    <!-- 加载态：轻骨架，行高与真行一致（34px），不跳版 -->
    <div v-if="loading" class="recent-skeleton" aria-hidden="true">
      <div v-for="row in 5" :key="row" class="recent-skeleton-row"></div>
    </div>

    <!-- 错误态：明说 + 重试 -->
    <div v-else-if="error" class="recent-state">
      <p class="recent-state-text">{{ t('home.recent.error') }}</p>
      <button type="button" class="ghost-btn" @click="emit('retry')">
        {{ t('home.recent.retry') }}
      </button>
    </div>

    <!-- 空态：一句话，不解释 -->
    <div v-else-if="visits.length === 0" class="recent-state">
      <p class="recent-state-text">{{ t('home.recent.empty') }}</p>
    </div>

    <template v-else>
      <section v-for="group in groups" :key="group.bucket" class="recent-group">
        <h3 class="recent-group-label">
          <span>{{ t(GROUP_LABEL_KEY[group.bucket]) }}</span>
          <span class="recent-group-count">{{ group.visits.length }}</span>
        </h3>
        <ul class="recent-list">
          <li v-for="visit in group.visits" :key="visit.url">
            <!-- 网页协议才用 `<a target="_blank">`（history 条目基本只可能是 http(s)，
                 与书签卡同一条规矩；点开不关面板 —— 左栏"点目录保持浮出"同款语义）。
                 链文本就是标题，不再挂 aria-label（重复标注反而让读屏念两遍）。 -->
            <a class="recent-link" :href="visit.url" target="_blank" rel="noopener noreferrer">
              <SiteIcon
                class="recent-icon"
                :favicon-url="faviconOf(visit)"
                :url="visit.url"
                :fallback-label="visit.fallbackLabel"
                :domain="visit.domain"
              />
              <span class="recent-name">{{ visit.title }}</span>
              <span class="recent-time">{{ timeOf(visit, group.bucket) }}</span>
            </a>
          </li>
        </ul>
      </section>
    </template>
  </div>

  <footer class="recent-foot">
    <button type="button" class="recent-all" @click="emit('open-all')">
      {{ t('home.recent.viewAll') }}
    </button>
  </footer>
</template>
