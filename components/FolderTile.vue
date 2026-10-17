<script setup lang="ts">
import { computed } from 'vue';

import { useI18n } from '../composables/useI18n';
import type { BookmarkFolderNode } from '../types/bookmarks';

const props = defineProps<{
  node: BookmarkFolderNode;
  /** 多选模式开没开。关着时不渲染勾选框。 */
  selectable?: boolean;
  /** 这个文件夹有没有被选中。 */
  selected?: boolean;
}>();

const emit = defineEmits<{ open: [id: string]; 'toggle-select': [] }>();

const { t } = useI18n();

/**
 * 提示只说用户用得上的两件事：名字 + 里面有几条。
 *
 * **不再带浏览器内部 id** —— 原生 `title` 时代拼过"（文件夹 id: 15）"，那是实现细节，
 * 用户看了只会问"这是什么"；2026-10-15 换自绘提示时一并去掉。
 * 文案也顺手从硬编码中文挪进 i18n（英文用户以前看到的是中文）。
 */
const tip = computed(() =>
  t('home.folderTile.tip', { name: props.node.title, count: props.node.count }),
);
</script>

<template>
  <button
    type="button"
    class="folder-tile"
    :class="{ 'is-selected': selected, 'is-selectable': selectable }"
    :data-tip="tip"
    @click="emit('open', props.node.id)"
  >
    <!-- 勾选框：与书签卡同一套 role/aria/键盘约定。 -->
    <span
      v-if="selectable"
      class="card-select"
      role="checkbox"
      :aria-checked="selected === true"
      :aria-label="t('home.select.item', { title: node.title })"
      tabindex="0"
      @click.stop.prevent="emit('toggle-select')"
      @keydown.space.prevent.stop="emit('toggle-select')"
      @keydown.enter.prevent.stop="emit('toggle-select')"
    >
      <svg v-if="selected" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
    </span>
    <span class="tile-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.1c.6 0 1.2.25 1.6.7l1 1.1h6.9a2.2 2.2 0 0 1 2.2 2.2v7.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z" />
      </svg>
    </span>
    <span class="tile-title">{{ props.node.title }}</span>
  </button>
</template>
