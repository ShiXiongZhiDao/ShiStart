<script setup lang="ts">
/**
 * 删除文件夹的**预览模态**（既有约定 定行为，既有约定 换壳）。
 *
 * 主页的第一个模态，也是 `AppDialog` 公共壳的第一个用户 —— 它自己的样式已经
 * 搬进壳里（见 style.css 的「公共弹窗壳」段），这个文件只剩**内容**：
 * 统计、样本、输名闸门、回收站去向、动作区。
 *
 * 三条硬规矩（既有约定，搬家之后一条没变）：
 * - **数量必须说出来**：主按钮带项数，正文列书签 / 子文件夹各多少、附几条直属样本；
 * - **Enter 只在"输入名"那一幕等于确认** —— 那一幕用户正在主动输入，误触风险低；
 *   没有输入框的模态里 Enter 一律不确认（误触一个回车 = 几百项没了）；
 * - **Esc 永远算取消**，焦点关在模态里，打开时落在「取消」上 ——
 *   破坏性操作的默认焦点不该是"确认"。
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '../composables/useI18n';
import AppDialog from './AppDialog.vue';
import { previewFolderDelete, type FolderDeletePreview } from '../services/bookmark-folder-delete';

const props = defineProps<{
  folderId: string;
  /**
   * 删掉之后**到底能不能在回收站里找回**（三档，与右键菜单同一个口径）。
   * 只影响警告那一行的措辞，不决定能不能删 —— 既有约定 修订定下的立场。
   */
  recovery: 'none' | 'auto' | 'manual';
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const { t, tRich } = useI18n();

const preview = ref<FolderDeletePreview | null>(null);
const loadError = ref('');
const typedName = ref('');
const dialog = ref<InstanceType<typeof AppDialog> | null>(null);

/** 项数 = 书签 + 子文件夹（不含被删的文件夹自己）—— 与正文的口径一致。 */
const total = computed(() =>
  preview.value ? preview.value.bookmarkCount + preview.value.folderCount : 0,
);

const nameMismatch = computed(() => {
  if (!preview.value?.requiresTypedName) return false;
  return typedName.value.trim() !== preview.value.title.trim();
});

const canConfirm = computed(() => preview.value !== null && !nameMismatch.value);

onMounted(async () => {
  try {
    preview.value = await previewFolderDelete(props.folderId);
    // 要输名字时焦点落在输入框（键盘用户唯一要过的关）；否则落在取消上。
    // **落点由内容方决定** —— 壳猜不出该落哪（见 AppDialog.focus 的注释）。
    if (preview.value.requiresTypedName) dialog.value?.focus('input');
    else dialog.value?.focus('[data-cancel]');
  } catch {
    loadError.value = t('home.folderDelete.unreadable');
    dialog.value?.focus('[data-cancel]');
  }
});

/** Enter 只在"要输名字"那一幕算确认；其余情况按了什么都不该发生。 */
function onEnter(): void {
  if (preview.value?.requiresTypedName && canConfirm.value) emit('confirm');
}
</script>

<template>
  <AppDialog
    ref="dialog"
    :title="t('home.folderDelete.title')"
    :subtitle="
      preview
        ? t('home.folderDelete.subject', { title: preview.title })
        : undefined
    "
    tone="danger"
    @cancel="emit('cancel')"
  >
    <p v-if="loadError" class="dialog-error" role="alert">{{ loadError }}</p>

    <template v-else-if="preview">
      <div class="dialog-stats">
        <span class="dialog-num">{{ total }}</span>
        <span class="dialog-num-label">
          {{
            preview.folderCount > 0
              ? t('home.folderDelete.statLine', { n: preview.bookmarkCount, m: preview.folderCount })
              : t('home.folderDelete.statLineBookmarks', { n: preview.bookmarkCount })
          }}
        </span>
      </div>

      <div v-if="preview.sampleTitles.length > 0">
        <span class="dialog-label">{{ t('home.folderDelete.samples') }}</span>
        <div class="dialog-items" style="margin-top: var(--sp-3)">
          <div v-for="(title, at) in preview.sampleTitles" :key="at" class="dialog-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />
            </svg>
            <span>{{ title }}</span>
          </div>
        </div>
      </div>

      <label v-if="preview.requiresTypedName" class="dialog-field">
        <span class="dialog-label">{{ t('home.folderDelete.typedNameLabel') }}</span>
        <input
          v-model="typedName"
          class="dialog-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="preview.title"
          @keydown.enter.prevent="onEnter"
        />
        <!-- 输错了当场说，别等按了删除才说。 -->
        <span v-if="typedName.trim() !== '' && nameMismatch" class="dialog-error" role="alert">
          {{ t('home.folderDelete.typedNameMismatch') }}
        </span>
      </label>

      <!-- 说不说得清"找不找得回"，决定这两行里用哪一行。
           ⚠️ 这不是可选的装饰：既有约定（0040 决策 6）要求照实披露
           "这次删除能不能找回"，没开同步时删了就是真没了。用户 2026-10-14 要求
           连它一起删掉，我压成了一行、去掉了粉色警告盒，但**没有删掉这个事实** ——
           要真删得先改那三条 既有约定（既有约定 修订记录里记着这笔账）。 -->
      <p
        v-if="props.recovery === 'none'"
        class="dialog-note is-danger"
        v-html="tRich('home.folderDelete.noSync')"
      ></p>
      <p
        v-else-if="props.recovery === 'manual'"
        class="dialog-note is-danger"
        v-html="tRich('home.folderDelete.manualSync')"
      ></p>
    </template>

    <template v-else>
      <div style="display: flex; flex-direction: column; gap: var(--sp-4)">
        <span class="dialog-skeleton is-wide"></span>
        <span class="dialog-skeleton is-mid"></span>
        <span class="dialog-skeleton is-narrow"></span>
      </div>
      <p class="dialog-lead">{{ t('home.folderDelete.loading') }}</p>
    </template>

    <template #footer>
      <div class="dialog-actions">
        <button data-cancel type="button" class="dialog-btn" @click="emit('cancel')">
          {{ t('home.folderDelete.cancel') }}
        </button>
        <button
          type="button"
          class="dialog-btn is-danger"
          :disabled="!canConfirm"
          @click="emit('confirm')"
        >
          {{ preview ? t('home.folderDelete.confirm', { n: total }) : t('home.folderDelete.loading') }}
        </button>
      </div>
    </template>
  </AppDialog>
</template>
