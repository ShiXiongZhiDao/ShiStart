<script setup lang="ts">
import { computed } from 'vue';

import SiteIcon from './SiteIcon.vue';
import { isWebProtocol } from '../lib/bookmark-mapper';
import type { BookmarkViewItem } from '../types/bookmarks';

const props = defineProps<{ item: BookmarkViewItem }>();

const emit = defineEmits<{
  /** 非网页协议的书签：交给外面走 `chrome.tabs.create` 并处理失败。 */
  open: [];
}>();

/**
 * 网页协议才用 `<a target="_blank">`。
 *
 * ⚠️ 非网页协议**不能用链接**：实测在扩展页里点 `<a target="_blank" href="chrome://bookmarks">`
 * 或 `file:///…` 会被浏览器**静默拦掉**（不开标签页、也不报错）—— 卡片看得见却点不动，
 * 等于换个姿势骗人。那些走 `chrome.tabs.create`（它能开 `chrome://` 与 `file://`），
 * 失败时报错（`javascript:` 就是明确被禁的那一类）。
 */
const isWeb = computed(() => isWebProtocol(props.item.protocol));

const tooltip = computed(() => {
  const path = props.item.folderPath.length > 0 ? ` · ${props.item.folderPath.join(' / ')}` : '';
  return `${props.item.title}${path}`;
});
</script>

<template>
  <a
    v-if="isWeb"
    class="bookmark-card"
    :href="item.url"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="item.title"
    :data-tip="tooltip"
  >
    <SiteIcon
      :favicon-url="item.faviconUrl"
      :url="item.url"
      :fallback-label="item.fallbackLabel"
      :domain="item.domain"
    />
    <span class="meta">
      <span class="site-name">{{ item.title }}</span>
    </span>
  </a>
  <button
    v-else
    type="button"
    class="bookmark-card"
    :aria-label="item.title"
    :data-tip="tooltip"
    @click="emit('open')"
  >
    <SiteIcon
      :favicon-url="item.faviconUrl"
      :url="item.url"
      :fallback-label="item.fallbackLabel"
      :domain="item.domain"
    />
    <span class="meta">
      <span class="site-name">{{ item.title }}</span>
    </span>
  </button>
</template>
