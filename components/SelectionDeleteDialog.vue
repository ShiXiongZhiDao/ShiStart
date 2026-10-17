<script setup lang="ts">
import { computed } from 'vue';

import AppDialog from './AppDialog.vue';
import { useI18n } from '../composables/useI18n';

/**
 * 多选删除的确认弹窗。
 *
 * 为什么批量删除**一定要确认**，而单条书签删除不用：
 * 单条删错，回收站里就多一条，找回来是几秒钟的事；批量删错，回收站里会多出 N 条
 * **互不相干**的条目（墓碑按结构分组，平级的 N 条就是 N 个组），逐条恢复很痛。
 * 而"批量撤销"需要给墓碑加字段、动同步协议 —— 与其在删后补一个更贵的救法，
 * 不如在删前多一次点击。
 */
const props = defineProps<{
  count: number;
  /** 其中几个是文件夹（它们的内容会跟着一起删）。 */
  folderCount: number;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const { t } = useI18n();

const subtitle = computed(() =>
  props.folderCount > 0
    ? t('home.selection.deleteBody', { n: props.folderCount })
    : t('home.selection.deleteBodyPlain'),
);
</script>

<template>
  <AppDialog
    :title="t('home.selection.deleteTitle', { n: count })"
    :subtitle="subtitle"
    tone="danger"
    @cancel="emit('cancel')"
  >
    <template #footer>
      <div class="dialog-actions">
        <button type="button" class="dialog-btn" @click="emit('cancel')">
          {{ t('home.selection.cancel') }}
        </button>
        <button type="button" class="dialog-btn is-danger" @click="emit('confirm')">
          {{ t('home.selection.delete') }}
        </button>
      </div>
    </template>
  </AppDialog>
</template>
