<script setup lang="ts">
/**
 * 设置页外壳：左侧一栏（品牌 + 分区导航）+ 右侧内容。
 *
 * 这个文件以前是 1566 行的单块 `OptionsApp.vue`（见 既有约定）。
 * 现在它只负责导航、品牌、以及把"当前选中哪个分区"这件事管住。
 *
 * ## 左栏为什么是现在这样（2026-10-15，用户给了参照设计）
 *
 * 用户原话："设置界面的导航样式被弄丢了，还原回来"，随后贴了一张兄弟项目的设置页。
 * 查证结果是**样式一行没丢**（本文件的样式块与 既有约定 拆文件那次逐字节一致），
 * 真正的问题是它**从来就没有"栏"的样子**：几行裸文字直接浮在页面底上，而浅色主题下
 * 它两个状态色与底色的对比低到看不出来（实测激活底 1.06:1、悬停底 1.05:1，
 * WCAG 对 UI 状态要求 3:1）—— 看上去就像没上样式。
 *
 * 所以按参照设计补上它缺的结构：
 * - **品牌块进左栏**（原先在页顶横跨整宽，和左栏是两截）：标记用主页侧边栏那颗
 *   同一个 `--brand-gradient`，名字与品牌语也是那两句（同一个品牌，两处必须一样）；
 * - **导航项带图标**：图标数据在下面 `ICONS`，全部只用 `<path>`，24 栅格 1.8 描边，
 *   与全站图标同一口径；
 * - 品牌与导航之间一条分隔线。
 *
 * 2026-10-16：**底部那行「版本 · 本机说明」脚注撤掉了**（用户要求）—— 版本号在
 * 「关于」分区有显眼的一枚胶囊，同一句话在那一页的隐私卡里也写得更完整，
 * 左栏再重复一遍只是噪音。
 *
 * 分区用 `v-if` 切换而不是 keep-alive：同步分区挂载时会连着读一轮本地状态，
 * 数据分区挂载时会读整棵书签树 —— 用户没看的时候不该付这笔开销。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import GeneralSection from './sections/GeneralSection.vue';
import AppearanceSection from './sections/AppearanceSection.vue';
import SyncSection from './sections/SyncSection.vue';
import SnapshotSection from './sections/SnapshotSection.vue';
import DataSection from './sections/DataSection.vue';
import AboutSection from './sections/AboutSection.vue';
import { useI18n } from '../../composables/useI18n';
import { useSettings } from '../../composables/useSettings';
import type { MessageKey } from '../../lib/i18n/zh-CN';

type SectionId = 'general' | 'appearance' | 'sync' | 'snapshot' | 'data' | 'about';

const { t } = useI18n();
// 外壳顶着 SETTINGS 单例；`data-theme` 由 useSettings 的 watchEffect 统一写在 <html> 上。
useSettings();

const NAV_KEY: Record<SectionId, MessageKey> = {
  general: 'nav.general',
  appearance: 'nav.appearance',
  sync: 'nav.sync',
  snapshot: 'nav.snapshot',
  data: 'nav.data',
  about: 'nav.about',
};

/**
 * 导航图标：一枚 = 一组 `<path>` 的 d。
 *
 * 全部只用 `<path>`（圆也是用两段弧画的），这样模板里一个 `v-for` 就画完 ——
 * 换成 `<circle>`/`<ellipse>` 就得为一个图标开一种元素，六个图标六种写法。
 */
const ICONS: Record<SectionId, string[]> = {
  // 两条滑轨各带一个滑块：通用里是搜索引擎、侧边栏、快捷键这些开关。
  general: ['M4 8h8', 'M16 8h4', 'M4 16h4', 'M12 16h8', 'M14 6v4', 'M10 14v4'],
  // 太阳：主题与语言。
  appearance: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    'M12 2.5v2',
    'M12 19.5v2',
    'M2.5 12h2',
    'M19.5 12h2',
    'M5.4 5.4l1.4 1.4',
    'M17.2 17.2l1.4 1.4',
    'M18.6 5.4l-1.4 1.4',
    'M6.8 17.2l-1.4 1.4',
  ],
  // 云：云端同步。
  sync: ['M7.5 18.5h8.75a3.75 3.75 0 0 0 .3-7.49A5.5 5.5 0 0 0 6.6 10.3 3.9 3.9 0 0 0 7.5 18.5Z'],
  // 层叠：与快照分区空态那颗同一个比喻（一份份叠着的历史）。
  snapshot: ['M12 3 3 7.5l9 4.5 9-4.5L12 3Z', 'm3 12.5 9 4.5 9-4.5', 'm3 17 9 4.5 9-4.5'],
  // 数据筒：导出与备份。
  data: [
    'M12 3.5c3.87 0 7 1.34 7 3s-3.13 3-7 3-7-1.34-7-3 3.13-3 7-3Z',
    'M5 6.5v11c0 1.66 3.13 3 7 3s7-1.34 7-3v-11',
    'M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3',
  ],
  // 信息圈：关于。
  about: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5.5', 'M12 7.8h.01'],
};

const SECTION_IDS: SectionId[] = ['general', 'appearance', 'sync', 'snapshot', 'data', 'about'];

/**
 * 落在哪一页不持久化：设置页不是常态界面，用户每次打开都从"通用"开始更可预测。
 * 例外是主页带 hash 直接落进来 —— 同步状态点是 `#sync`，"保险断"时是 `#snapshot`
 * （既有约定 决策四：落点按问题类型分流）。
 */
const initialSection = location.hash.replace('#', '') as SectionId;
const active = ref<SectionId>(SECTION_IDS.includes(initialSection) ? initialSection : 'general');

function select(id: SectionId): void {
  active.value = id;
  // 把位置写进 hash：刷新时不至于跳回第一页，也方便从主页直接链进来。
  location.hash = id;
}

/**
 * hash 变了也跟着切：分区内部的跳转（同步区那一行 → 快照、
 * 快照空态 → 同步）就是改 hash，不监听的话那些跳转全是死的。
 * 顺带的收益：浏览器的前进/后退在分区之间也能用了。
 */
function onHashChange(): void {
  const id = location.hash.replace('#', '') as SectionId;
  if (SECTION_IDS.includes(id)) active.value = id;
}

onMounted(() => window.addEventListener('hashchange', onHashChange));
onUnmounted(() => window.removeEventListener('hashchange', onHashChange));

const navItems = computed(() =>
  SECTION_IDS.map((id) => ({ id, label: t(NAV_KEY[id]), icon: ICONS[id] })),
);
</script>

<template>
  <div class="page">
    <div class="body">
      <!-- 左栏 = 一张卡：品牌 / 导航 / 脚注 三段，两道分隔线。 -->
      <nav class="side-nav" :aria-label="t('app.title')">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <!-- 定稿标识「旗星合一」：与主页侧边栏顶部、工具栏图标
                 同一个符号、同一种画法。颜色走 --brand-mark-color，不写死。
                 viewBox 裁到内容 bbox（同主页侧边栏）：256 母版画布里内容中心
                 偏上 4/256，直接放进居中 tile 会显偏上。 -->
            <svg viewBox="40 36 176 176" aria-hidden="true">
              <path
                fill="currentColor"
                fill-rule="evenodd"
                d="M48 36 H208 V212 L128 160 L48 212 Z M128 56 L139.8 85.8 L171.8 87.8 L147 108.2 L155 139.2 L128 122 L101 139.2 L109 108.2 L84.2 87.8 L117.2 85.8 Z"
              />
            </svg>
          </div>
          <div class="brand-text">
            <div class="brand-name">{{ t('app.name') }}</div>
            <!-- 品牌语与主页侧边栏是同一句（home.brandNote）：同一个品牌，两处必须一样。 -->
            <p class="brand-note">{{ t('home.brandNote') }}</p>
          </div>
        </div>

        <div class="rule" role="presentation"></div>

        <ul class="nav-list">
          <li v-for="item in navItems" :key="item.id">
            <button
              type="button"
              class="nav-btn"
              :data-active="active === item.id"
              :aria-current="active === item.id ? 'page' : undefined"
              @click="select(item.id)"
            >
              <svg
                class="nav-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path v-for="d in item.icon" :key="d" :d="d" />
              </svg>
              <span>{{ item.label }}</span>
            </button>
          </li>
        </ul>
      </nav>

      <main class="content">
        <GeneralSection v-if="active === 'general'" />
        <AppearanceSection v-else-if="active === 'appearance'" />
        <SyncSection v-else-if="active === 'sync'" />
        <SnapshotSection v-else-if="active === 'snapshot'" />
        <DataSection v-else-if="active === 'data'" />
        <AboutSection v-else-if="active === 'about'" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.page {
  max-width: 1000px;
  margin: 0 auto;
  padding: var(--sp-8) var(--sp-7) var(--sp-10);
}

.body {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-7);
}

/* 左栏是一张卡：品牌 / 导航 / 脚注住同一张壳里（2026-10-15 按参照设计）。
   它同时是导航区，所以滚动时钉住 —— 内容再长也不用滚回去找。 */
.side-nav {
  flex: none;
  width: 200px;
  position: sticky;
  top: var(--sp-8);
  padding: var(--sp-5);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-1);
}

/* ---------- 品牌块 ---------- */

.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  min-width: 0;
}

/* 标记的渐变与三色全走令牌，与主页侧边栏那颗逐字同款 ——
   同一个品牌在两处必须是同一个标识，别在这里写死色值。 */
.brand-mark {
  width: var(--sp-10);
  height: var(--sp-10);
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-lg);
  background: var(--brand-gradient);
  color: var(--brand-mark-color);
  box-shadow: var(--shadow-1);
}

/* 与主页侧边栏同一个尺寸（20px）。viewBox 已裁到内容 bbox（同主页侧边栏），
   符号撑满 svg 高度，32px tile 里上下各留 6px —— 预览 _probe/brand-mark-centering
   定的，别凭感觉调。 */
.brand-mark svg {
  width: 20px;
  height: 20px;
}

.brand-text {
  min-width: 0;
}

.brand-name {
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.2px;
}

.brand-note {
  margin: var(--sp-1) 0 0;
  color: var(--text-3);
  font-size: var(--fs-2xs);
  line-height: 1.5;
}

/* ---------- 分隔线 ---------- */

.rule {
  height: 1px;
  background: var(--line);
  margin: var(--sp-5) 0;
}

/* ---------- 导航 ---------- */

.nav-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.nav-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  text-align: left;
  padding: var(--sp-4) var(--sp-5);
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-md);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.nav-icon {
  width: var(--sp-7);
  height: var(--sp-7);
  flex: none;
}

.nav-btn:hover:not([data-active='true']) {
  background: var(--surface-2);
  color: var(--text);
}

/* 激活态：底色 + 文字色 + 字重三件一起变。底色本身对比很弱（浅色主题下
   对卡面约 1.1:1），所以**不能只靠它** —— 文字色与字重是主要的读法。 */
.nav-btn[data-active='true'] {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: var(--fw-medium);
}

/* ---------- 内容 ---------- */

.content {
  flex: 1;
  min-width: 0;
}

/* 窄屏：左栏横过来放顶上。竖排导航在 860px 以下会把内容挤成一条。 */
@media (max-width: 860px) {
  .body {
    flex-direction: column;
    gap: var(--sp-6);
  }

  .side-nav {
    position: static;
    width: 100%;
  }

  /* 横排时品牌块让位给导航本身：一屏里先要能点到分区。 */
  .brand,
  .rule {
    display: none;
  }

  .nav-list {
    flex-direction: row;
    overflow-x: auto;
    gap: var(--sp-2);
  }

  .nav-btn {
    white-space: nowrap;
  }
}
</style>
