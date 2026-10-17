<script setup lang="ts">
import { computed } from 'vue';

import SiteIcon from './SiteIcon.vue';
import { isWebProtocol } from '../lib/bookmark-mapper';
import { useI18n } from '../composables/useI18n';
import type { BookmarkViewItem } from '../types/bookmarks';

const props = defineProps<{
  item: BookmarkViewItem;
  /** 多选模式开没开。关着时不渲染勾选框，卡片与以前一模一样。 */
  selectable?: boolean;
  /** 这一张有没有被选中。 */
  selected?: boolean;
}>();

const emit = defineEmits<{
  /** 非网页协议的书签：交给外面走 `chrome.tabs.create` 并处理失败。 */
  open: [];
  /** 勾选框被点/被键盘激活。 */
  'toggle-select': [];
}>();

const { t } = useI18n();

/**
 * 网页协议才用 `<a target="_blank">`。
 *
 * ⚠️ 非网页协议**不能用链接**：实测在扩展页里点 `<a target="_blank" href="chrome://bookmarks">`
 * 或 `file:///…` 会被浏览器**静默拦掉**（不开标签页、也不报错）—— 卡片看得见却点不动，
 * 等于换个姿势骗人。那些走 `chrome.tabs.create`（它能开 `chrome://` 与 `file://`），
 * 失败时报错（`javascript:` 就是明确被禁的那一类）。
 *
 * 两种根元素用 `<component :is>` 合成一个模板：勾选框、图标、标题那一段内容
 * 不该为了"a 还是 button"写两遍 —— 写两遍的下场是改一处忘一处。
 */
const isWeb = computed(() => isWebProtocol(props.item.protocol));

/** 根元素的差异化属性。`href/target/rel` 只对 `<a>` 有意义，`type` 只对 `<button>`。 */
const rootAttrs = computed(() =>
  isWeb.value
    ? { href: props.item.url, target: '_blank', rel: 'noopener noreferrer' }
    : { type: 'button' as const },
);

const tooltip = computed(() => {
  const path = props.item.folderPath.length > 0 ? ` · ${props.item.folderPath.join(' / ')}` : '';
  return `${props.item.title}${path}`;
});
</script>

<template>
  <component
    :is="isWeb ? 'a' : 'button'"
    class="bookmark-card"
    :class="{ 'is-selected': selected, 'is-selectable': selectable }"
    v-bind="rootAttrs"
    :aria-label="item.title"
    :data-tip="tooltip"
    @click="isWeb ? undefined : emit('open')"
  >
    <!--
      勾选框。
      ⚠️ 它是 `<a>` 里的一个可聚焦 `<span>`，HTML 内容模型上不够干净（交互内容不该嵌在链接里）。
      没有把它改成 `<div>` + 内部 `<a>`：那会动到卡片根元素、拖拽 handle、右键菜单与
      hover/active 样式一整串，收益只是"校验器不抱怨"。这里用 click.stop.prevent 挡住
      链接导航，键盘走 Enter / 空格，读屏能读到 role=checkbox。
    -->
    <span
      v-if="selectable"
      class="card-select"
      role="checkbox"
      :aria-checked="selected === true"
      :aria-label="t('home.select.item', { title: item.title })"
      tabindex="0"
      @click.stop.prevent="emit('toggle-select')"
      @keydown.space.prevent.stop="emit('toggle-select')"
      @keydown.enter.prevent.stop="emit('toggle-select')"
    >
      <svg v-if="selected" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
    </span>
    <SiteIcon
      :favicon-url="item.faviconUrl"
      :url="item.url"
      :fallback-label="item.fallbackLabel"
      :domain="item.domain"
    />
    <span class="meta">
      <span class="site-name">{{ item.title }}</span>
    </span>
  </component>
</template>
