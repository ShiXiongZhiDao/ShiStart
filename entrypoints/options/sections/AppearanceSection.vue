<script setup lang="ts">
/**
 * 外观分区：配色、明暗与语言。
 *
 * 配色与明暗是**两颗独立的分段控件**—— 它们曾经合成一颗四选一
 * （浅色/深色/青春活力/跟随系统），那个模型把两个维度混在了一起，用户必然
 * 问"选了青春活力还能选深色吗"。现在每颗控件的选项同类，问题不需要回答。
 *
 * 最后一张卡是「每行卡片数」—— 它是**滑块**而不是分段控件：
 * 取值是 4–12 的整数，九个档位排成分段控件太长了；而且这个值要能一边拖一边看。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSettings } from '../../../composables/useSettings';
import { useI18n } from '../../../composables/useI18n';
import {
  CARDS_PER_ROW_DEFAULT,
  CARDS_PER_ROW_MAX,
  CARDS_PER_ROW_MIN,
} from '../../../types/settings';
import type { BgPattern, LocaleMode, ThemeMode, ThemePalette } from '../../../types/settings';

const { t } = useI18n();
const { settings, setPalette, setMode, setPattern, setLocale, setCardsPerRow } = useSettings();

function selectCardsPerRow(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  // 越界不写：normalize 也会夹住，但让 UI 先自己挡一道，别把奇怪的数送进存储。
  if (!Number.isInteger(raw) || raw < CARDS_PER_ROW_MIN || raw > CARDS_PER_ROW_MAX) return;
  void setCardsPerRow(raw);
}

/**
 * 量尺：一把**真的**网格（`.grid-probe`，与主页共用 `card-grid.css` 里那条列公式），
 * 铺到"主页内容区"那么宽，让浏览器自己算出**当前窗口实际能排几列**。
 *
 * 为什么不在 JS 里把公式再写一遍：写两遍就是两处真值，迟早对不上 —— 而这正是
 * "设 11 却只给 8"的根因（公式住在 CSS、被列宽下限挡住，却没人告诉用户）。
 * 现在改成**量**，量尺和主页用的是同一条规则，所以显示出来的数就是主页会排的数。
 */
const probeEl = ref<HTMLElement | null>(null);
const achieved = ref(CARDS_PER_ROW_DEFAULT);

/** 侧边栏占掉的宽度（含它那条 1px 右边框）；收起时是 0。量尺要把它减掉。 */
const sidebarTaken = computed(() =>
  settings.value.sidebarCollapsed ? '0px' : `${settings.value.sidebarWidth + 1}px`,
);

function measureAchieved(): void {
  const el = probeEl.value;
  if (!el) return;
  const tracks = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean);
  achieved.value = Math.max(1, tracks.length);
}

onMounted(() => {
  measureAchieved();
  window.addEventListener('resize', measureAchieved);
});
onUnmounted(() => window.removeEventListener('resize', measureAchieved));
// 拖滑块 / 改侧边栏之后要重量：等 Vue 把 DOM 与 --cards-per-row 都刷完。
watch(
  () => [settings.value.cardsPerRow, settings.value.sidebarCollapsed, settings.value.sidebarWidth],
  () => void nextTick(measureAchieved),
);

// computed 而不是常量：切到英文时这些标签要跟着变。
// 界面顺序**由这里定**：`THEME_PALETTES` 只回答"哪些值合法"，不驱动界面。
// 青柠夏夜排在前面（2026-10-16 用户要求对调）—— 它同时也是新装的默认配色。
const paletteOptions = computed<Array<{ id: ThemePalette; label: string }>>(() => [
  { id: 'youth', label: t('appearance.palette.youth') },
  { id: 'warm', label: t('appearance.palette.warm') },
]);

const modeOptions = computed<Array<{ id: ThemeMode; label: string }>>(() => [
  { id: 'light', label: t('appearance.mode.light') },
  { id: 'dark', label: t('appearance.mode.dark') },
  { id: 'system', label: t('appearance.mode.system') },
]);

const patternOptions = computed<Array<{ id: BgPattern; label: string }>>(() => [
  { id: 'none', label: t('appearance.pattern.none') },
  { id: 'dots', label: t('appearance.pattern.dots') },
  { id: 'checker', label: t('appearance.pattern.checker') },
  { id: 'grid', label: t('appearance.pattern.grid') },
]);

const localeOptions = computed<Array<{ id: LocaleMode; label: string }>>(() => [
  { id: 'zh-CN', label: t('appearance.language.zh') },
  { id: 'en', label: t('appearance.language.en') },
  { id: 'system', label: t('appearance.language.system') },
]);
</script>

<template>
  <div class="stack">
    <div class="section-head">
      <h2>{{ t('appearance.title') }}</h2>
    </div>

    <section class="card">
      <h3>{{ t('appearance.palette') }}</h3>
      <p class="hint">{{ t('appearance.palette.hint') }}</p>
      <div class="segmented" role="radiogroup" :aria-label="t('appearance.palette')">
        <button
          v-for="option in paletteOptions"
          :key="option.id"
          type="button"
          role="radio"
          class="segment"
          :aria-checked="settings.themePalette === option.id"
          :data-active="settings.themePalette === option.id"
          @click="setPalette(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>{{ t('appearance.mode') }}</h3>
      <p class="hint">{{ t('appearance.mode.hint') }}</p>
      <div class="segmented" role="radiogroup" :aria-label="t('appearance.mode')">
        <button
          v-for="option in modeOptions"
          :key="option.id"
          type="button"
          role="radio"
          class="segment"
          :aria-checked="settings.themeMode === option.id"
          :data-active="settings.themeMode === option.id"
          @click="setMode(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>{{ t('appearance.pattern') }}</h3>
      <p class="hint">{{ t('appearance.pattern.hint') }}</p>
      <div class="segmented" role="radiogroup" :aria-label="t('appearance.pattern')">
        <button
          v-for="option in patternOptions"
          :key="option.id"
          type="button"
          role="radio"
          class="segment"
          :aria-checked="settings.bgPattern === option.id"
          :data-active="settings.bgPattern === option.id"
          @click="setPattern(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>{{ t('appearance.language') }}</h3>
      <p class="hint">{{ t('appearance.language.hint') }}</p>
      <div class="segmented" role="radiogroup" :aria-label="t('appearance.language')">
        <button
          v-for="option in localeOptions"
          :key="option.id"
          type="button"
          role="radio"
          class="segment"
          :aria-checked="settings.locale === option.id"
          :data-active="settings.locale === option.id"
          @click="setLocale(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <!-- 每行卡片数：滑块而不是分段控件 —— 4–12 九个档位排成一段太长，
         而且这个值要能一边拖一边看。效果要回书签主页才看得到，所以提示里说了。 -->
    <section class="card">
      <h3>{{ t('appearance.cardsPerRow') }}</h3>
      <p class="hint">{{ t('appearance.cardsPerRow.hint') }}</p>
      <div class="slider-row">
        <input
          type="range"
          class="slider"
          :min="CARDS_PER_ROW_MIN"
          :max="CARDS_PER_ROW_MAX"
          step="1"
          :value="settings.cardsPerRow"
          :aria-label="t('appearance.cardsPerRow')"
          :aria-valuetext="t('appearance.cardsPerRow.value', { n: settings.cardsPerRow })"
          @input="selectCardsPerRow"
        />
        <output class="slider-value">{{ settings.cardsPerRow }}</output>
      </div>
      <div class="slider-scale">
        <span>{{ CARDS_PER_ROW_MIN }}</span>
        <span>{{ CARDS_PER_ROW_MAX }}</span>
      </div>
      <!-- 量尺：一排出流的空格子（真网格），只为让浏览器算出当前窗口实际几列。 -->
      <div
        ref="probeEl"
        class="grid-probe"
        :style="{ '--sidebar-taken': sidebarTaken }"
        aria-hidden="true"
      >
        <span v-for="i in CARDS_PER_ROW_MAX" :key="i"></span>
      </div>
      <p class="probe-line">
        {{ t('appearance.cardsPerRow.actual', { n: achieved }) }}
        <span v-if="achieved < settings.cardsPerRow" class="probe-capped">
          {{ t('appearance.cardsPerRow.capped') }}
        </span>
      </p>
      <details class="fold">
        <summary>{{ t('common.expand') }}</summary>
        <p class="hint" v-html="t('appearance.cardsPerRow.detail')"></p>
      </details>
    </section>
  </div>
</template>

<style scoped>
/* 分段控件：整条用一个外框包住，选中项反白。配色两档、明暗三档、语言三档
   共用这一条（既有约定 起主题拆成配色 × 明暗两颗控件）。 */
.segmented {
  display: inline-flex;
  padding: var(--sp-1);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  gap: var(--sp-1);
}

.segment {
  padding: var(--sp-3) var(--sp-6);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.segment:hover:not([data-active='true']) {
  color: var(--text);
}

.segment[data-active='true'] {
  background: var(--surface);
  color: var(--accent-text);
  font-weight: var(--fw-medium);
  box-shadow: var(--shadow-1);
}

/* ---------- 每行卡片数 ---------- */

.slider-row {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
}

/* 只染色、不自绘轨道：原生 range 的拇指与轨道在两套明暗下都可辨认，
   accent-color 一条就够 —— 与设置页复选框同一个做法。 */
.slider {
  flex: 1;
  accent-color: var(--accent);
}

.slider-value {
  flex: none;
  min-width: var(--sp-9);
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.slider-scale {
  display: flex;
  justify-content: space-between;
  margin-top: var(--sp-3);
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

/* 量出来的"实际几列"：不够 N 时明说被什么挡住 —— 别说都不说就少给几列。 */
.probe-line {
  margin: var(--sp-3) 0 0;
  color: var(--text-2);
  font-size: var(--fs-sm);
}

.probe-capped {
  color: var(--text-3);
  font-size: var(--fs-xs);
}
</style>
