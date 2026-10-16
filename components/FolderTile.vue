<script setup lang="ts">
import { computed } from 'vue';

import { useI18n } from '../composables/useI18n';
import type { BookmarkFolderNode } from '../types/bookmarks';

const props = defineProps<{ node: BookmarkFolderNode }>();

const emit = defineEmits<{ open: [id: string] }>();

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
    :data-tip="tip"
    @click="emit('open', props.node.id)"
  >
    <span class="tile-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.1c.6 0 1.2.25 1.6.7l1 1.1h6.9a2.2 2.2 0 0 1 2.2 2.2v7.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z" />
      </svg>
    </span>
    <span class="tile-title">{{ props.node.title }}</span>
  </button>
</template>
