<script setup lang="ts">
/**
 * 通用分区：搜索引擎、侧边栏、快捷键。
 *
 * 这一页改的全是界面偏好本身，没有任何远端操作，也没有需要"确认"的动作 ——
 * 改完立即生效，所以这里刻意不放保存按钮。
 */
import { computed } from 'vue';
import { useSettings } from '../../../composables/useSettings';
import { useI18n } from '../../../composables/useI18n';
import { SEARCH_ENGINE_IDS } from '../../../lib/search-engines';
import { SEARCH_ENGINE_LABEL_KEY } from '../../../lib/i18n';
import { SIDEBAR_DEFAULT_WIDTH } from '../../../types/settings';
import type { SearchEngineId } from '../../../types/settings';

const { t, tRich } = useI18n();
const { settings, update } = useSettings();

// 引擎名始终跟着当前语言，所以放在 computed 里查表，而不是在模块加载时就定死。
const engineOptions = computed(() =>
  SEARCH_ENGINE_IDS.map((id) => ({ id, label: t(SEARCH_ENGINE_LABEL_KEY[id]) })),
);

const sidebarVisible = computed(() => !settings.value.sidebarCollapsed);

function selectEngine(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  if (!SEARCH_ENGINE_IDS.includes(id as SearchEngineId)) return;
  void update({ searchEngine: id as SearchEngineId });
}

function toggleSidebar(event: Event): void {
  void update({ sidebarCollapsed: !(event.target as HTMLInputElement).checked });
}

function resetWidth(): void {
  void update({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
}

function toggleDrag(event: Event): void {
  void update({ dragToArrange: (event.target as HTMLInputElement).checked });
}

function toggleEdit(event: Event): void {
  void update({ editBookmarks: (event.target as HTMLInputElement).checked });
}

function toggleRecentPanel(event: Event): void {
  void update({ recentPanel: (event.target as HTMLInputElement).checked });
}
</script>

<template>
  <div class="stack">
    <div class="section-head">
      <h2>{{ t('general.title') }}</h2>
    </div>

    <section class="card">
      <h3>{{ t('general.searchEngine') }}</h3>
      <p class="hint">{{ t('general.searchEngine.hint') }}</p>
      <label class="field">
        <span class="field-label">{{ t('general.searchEngine') }}</span>
        <select :value="settings.searchEngine" @change="selectEngine">
          <option v-for="option in engineOptions" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
      </label>
    </section>

    <section class="card">
      <h3>{{ t('general.sidebar') }}</h3>
      <p class="hint">{{ t('general.sidebar.hint') }}</p>
      <label class="check">
        <input
          type="checkbox"
          :checked="sidebarVisible"
          @change="toggleSidebar"
        />
        <span>{{ t('general.sidebar.show') }}</span>
      </label>
      <div class="row sidebar-row">
        <button type="button" class="btn" @click="resetWidth">
          {{ t('general.sidebar.resetWidth') }}
        </button>
      </div>
    </section>

    <!-- 拖拽整理：默认开。它是给"怕手滑"的人留的出口，不是功能闸门。 -->
    <section class="card">
      <h3>{{ t('general.drag') }}</h3>
      <p class="hint" v-html="tRich('general.drag.hint')"></p>
      <label class="check">
        <input type="checkbox" :checked="settings.dragToArrange" @change="toggleDrag" />
        <span>{{ t('general.drag.toggle') }}</span>
      </label>
    </section>

    <!-- 新建与重命名：默认开。与拖拽整理**分开两个开关** ——
         拖拽已经上线并调好了手感，别把它跟新功能捆在一起改。 -->
    <section class="card">
      <h3>{{ t('general.editBookmarks') }}</h3>
      <p class="hint" v-html="tRich('general.editBookmarks.hint')"></p>
      <label class="check">
        <input type="checkbox" :checked="settings.editBookmarks" @change="toggleEdit" />
        <span>{{ t('general.editBookmarks.toggle') }}</span>
      </label>
    </section>

    <!-- 右缘「最近访问」：默认开。它读浏览器浏览历史来显示，
         说明文案里必须明说这条权限代价 —— 设置页是知情同意的场合。 -->
    <section class="card">
      <h3>{{ t('general.recentPanel') }}</h3>
      <p class="hint">{{ t('general.recentPanel.hint') }}</p>
      <label class="check">
        <input type="checkbox" :checked="settings.recentPanel" @change="toggleRecentPanel" />
        <span>{{ t('general.recentPanel.toggle') }}</span>
      </label>
    </section>

    <section class="card">
      <h3>{{ t('general.shortcuts') }}</h3>
      <ul class="shortcuts">
        <li>{{ t('general.shortcuts.focus') }}</li>
        <li>{{ t('general.shortcuts.clear') }}</li>
        <li>{{ t('general.shortcuts.sidebar') }}</li>
        <li>{{ t('general.shortcuts.recent') }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sidebar-row {
  margin-top: var(--sp-5);
  margin-bottom: 0;
}

.shortcuts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  color: var(--text-2);
  font-size: var(--fs-sm);
}
</style>
