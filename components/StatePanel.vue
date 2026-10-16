<script setup lang="ts">
/**
 * 统一的状态面板：空状态 / 错误状态 / 无结果。
 * 三种状态共用一套结构（图标 → 标题 → 说明 → 动作），避免每次手写不一致的文案排版。
 */
defineProps<{
  title: string;
  description?: string;
  tone?: 'neutral' | 'error';
}>();
</script>

<template>
  <div
    class="state-panel"
    :class="{ 'is-error': tone === 'error' }"
    :role="tone === 'error' ? 'alert' : 'status'"
  >
    <span class="state-icon" aria-hidden="true">
      <slot name="icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v4h1" />
        </svg>
      </slot>
    </span>
    <strong class="state-title">{{ title }}</strong>
    <p v-if="description" class="state-desc">{{ description }}</p>
    <div v-if="$slots.actions" class="state-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
