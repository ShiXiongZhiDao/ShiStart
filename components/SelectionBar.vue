<script setup lang="ts">
import { useI18n } from '../composables/useI18n';

/**
 * 多选操作条。
 *
 * 选中任何一项就浮出来，说明"选了几项、能做什么、怎么退出"—— 三件事一条说完。
 * 用 `position: fixed` 浮在底部：选中的卡片可能滚出视口，操作条跟着页面走的话
 * 用户会在最需要它的时候看不到它。
 *
 * 拖拽不在这里给按钮：多选状态下直接拖任意一张已选中的卡就是拖整组。
 */
defineProps<{
  count: number;
  /** 选中项里有几个文件夹 —— 删除确认的文案要分情况。 */
  folderCount: number;
}>();

const emit = defineEmits<{
  open: [];
  openWindow: [];
  remove: [];
  clear: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="selection-bar" role="status" aria-live="polite">
    <span class="selection-count">{{ t('home.selection.count', { n: count }) }}</span>
    <div class="selection-actions">
      <button type="button" class="ghost-btn" @click="emit('open')">
        {{ t('home.selection.open') }}
      </button>
      <button type="button" class="ghost-btn" @click="emit('openWindow')">
        {{ t('home.selection.openWindow') }}
      </button>
      <button type="button" class="ghost-btn is-danger" @click="emit('remove')">
        {{ t('home.selection.delete') }}
      </button>
      <button type="button" class="ghost-btn" @click="emit('clear')">
        {{ t('home.selection.clear') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 浮在视口底部中间。
 *
 * `bottom` 用 --sp-7：主页底部有内容、卡片网格还在滚动，贴到底边会让最后一行卡片
 * 永远被这条栏压住。留一个指头的高度差，滚到底时还能看到最后一张卡的完整下沿。
 */
.selection-bar {
  position: fixed;
  left: 50%;
  bottom: var(--sp-7);
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  max-width: calc(100vw - var(--sp-8));
  padding: var(--sp-3) var(--sp-4) var(--sp-3) var(--sp-6);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: var(--surface);
  box-shadow: var(--shadow-3);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.selection-count {
  flex: 0 0 auto;
  font-weight: var(--fw-medium);
  color: var(--text);
  white-space: nowrap;
}

.selection-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  overflow-x: auto;
}

/* 四个动作共用同一种形态（都是 ghost-btn 胶囊）——「取消选择」曾经用 link-btn，
   在一排胶囊里长得不一样，看着像漏了样式（用户截图报过）。
   删除单独给一点颜色：它是这一条里唯一不可逆的动作，别和「打开」长得一样。 */
.selection-actions .ghost-btn {
  height: 26px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.selection-actions .is-danger {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line-strong));
  color: var(--accent-text);
}

.selection-actions .is-danger:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

@media (max-width: 560px) {
  .selection-bar {
    left: var(--sp-5);
    right: var(--sp-5);
    transform: none;
    max-width: none;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-3);
    border-radius: var(--radius-md);
  }

  .selection-actions {
    width: 100%;
  }
}
</style>
