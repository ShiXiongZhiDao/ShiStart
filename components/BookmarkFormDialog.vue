<script setup lang="ts">
/**
 * 新建 / 改名 的表单弹窗（既有约定，公共壳 AppDialog 的第一个表单型消费者）。
 *
 * 它取代了原来的内联输入卡（`BookmarkEditorCard`，既有约定）。
 * 当年选内联的理由写在 既有约定 里："新标签页是低注意力场景，弹窗会把背后的网格
 * 挡住、还会抢焦点"—— 那条理由今天依然成立，但用户选择接受它，换来三件事：
 * ① 增删改的入口统一（删除文件夹早就是模态，新建/改名不再是例外）；
 * ② 弹窗有空间放**目录选择器**（内联卡只能建在当前目录，要换目录得拖）；
 * ③ 顶栏可以有一颗常显的 `+`，不用先去右键。
 *
 * 三条行为（既有约定 之后）：
 * - **网址不再做"像不像网址"的前置校验**：能修的替你修（`example.com` → `https://example.com`，
 *   `localhost:3000` → `http://localhost:3000`），修不了的**明确报错**，
 *   修好但主页显示不出来的**明确告知**。这条以前是硬挡（"这不像一个网址 —— 只支持 http 与 https"），
 *   可输入框的 placeholder 恰好写着"例如 example.com"，而 `example.com` 自己就会被它拒掉；
 * - **标题允许留空**：文件夹会显示成"未命名文件夹"，书签会退回域名，都有兜底；
 * - **Esc 取消 / Enter 提交**，Enter 由 `<form>` 的 submit 接住（壳只负责 Esc）。
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from '../composables/useI18n';
import AppDialog from './AppDialog.vue';
import { coerceBookmarkUrl } from '../lib/bookmark-mapper';
import { resolveChoiceKey } from '../lib/choice-menu';
import type { BookmarkFolderFilter } from '../types/bookmarks';

export type EditorMode = 'create' | 'rename';
export type EditorType = 'bookmark' | 'folder';

const props = withDefaults(
  defineProps<{
    mode: EditorMode;
    type: EditorType;
    /** 改名时预填；新建时为空。 */
    title: string;
    url: string;
    /** 新建时才显示"书签 / 文件夹"切换。 */
    allowTypeSwitch?: boolean;
    /**
     * 新建的默认目录（当前所在目录）。改名时用不上 —— 改归属是拖拽的事。
     */
    parentId: string;
    parentTitle: string;
    /**
     * 全部可选目录（已拍平、带 depth）。**只在这里用一次**：弹窗开着的时候书签树
     * 不会变（模态挡着，且新建/改名不发同步），所以不需要监听刷新。
     */
    folders: BookmarkFolderFilter[];
  }>(),
  { allowTypeSwitch: false },
);

const emit = defineEmits<{
  submit: [value: { type: EditorType; title: string; url?: string; parentId: string }];
  cancel: [];
  'update:type': [type: EditorType];
}>();

const { t } = useI18n();

const dialog = ref<InstanceType<typeof AppDialog> | null>(null);
const draftType = ref<EditorType>(props.type);
const draftTitle = ref(props.title);
const draftUrl = ref(props.url);
const draftParentId = ref(props.parentId);

/**
 * 目录选择器：复用 既有约定 那套键盘状态机（见 `lib/choice-menu.ts`，有单测）。
 *
 * ⚠️ 它是一个**常显的可滚动列表**，不是下拉面板。第一版做成了"按钮 + 绝对定位面板"，
 * 真机截图里面板被卡片裁掉了 —— `.dialog-card` 有 `overflow: auto`，绝对定位的子元素
 * 出不了卡片边界。修法两条（改 fixed 定位 + JS 算坐标 / 放进表单常显），选了后者：
 * 不用定位、不会被裁、打开就看得见目录树（反而更易发现），键盘走同一个状态机。
 */
const menuIndex = ref(0);
const menuList = ref<HTMLElement | null>(null);

const isFolder = computed(() => draftType.value === 'folder');

const heading = computed(() =>
  props.mode === 'create'
    ? t('home.editor.createTitle', { folder: props.parentTitle })
    : t('home.editor.renameTitle'),
);

/**
 * 输入侧唯一的硬挡：**空网址**。
 *
 * 别的都不挡了：浏览器肯收的照收，浏览器拒的交给 `coerceBookmarkUrl` 报错，
 * 主页显示不出来的在下面给一句提醒而不是拦住。空网址是物理上过不去的
 * （`createBookmarkNode` 要传一个 url），所以它留着。
 */
const urlError = computed(() => {
  if (isFolder.value) return '';
  const value = draftUrl.value.trim();
  if (value === '') return t('home.editor.urlRequired');
  return coerceBookmarkUrl(value) === null ? t('home.editor.urlRejected') : '';
});

/** 会把网址改成什么样、以及主页看不看得见。这两件事都当场说，不等到建完。 */
const urlOutcome = computed(() => {
  if (isFolder.value) return null;
  const value = draftUrl.value.trim();
  if (value === '') return null;
  const coerced = coerceBookmarkUrl(value);
  if (!coerced) return null;
  return {
    changed: coerced.url !== value,
    url: coerced.url,
    // ⚠️ 这是"不参与同步"，**不是**"主页看不见" —— 既有约定 之后主页什么都显示。
    notSyncable: !coerced.syncable,
  };
});

const canSubmit = computed(() => urlError.value === '');

const selectedIndex = computed(() =>
  Math.max(
    0,
    props.folders.findIndex((f) => f.id === draftParentId.value),
  ),
);

function switchType(type: EditorType): void {
  draftType.value = type;
  emit('update:type', type);
}

function onMenuKeydown(event: KeyboardEvent): void {
  // 列表常显 ⇒ 状态机永远按"已展开"调：方向键移动、回车选中。Esc 由壳接走（不在这里吞）。
  const action = resolveChoiceKey({
    key: event.key,
    open: true,
    index: menuIndex.value,
    count: props.folders.length,
  });
  switch (action.kind) {
    case 'move':
      event.preventDefault();
      menuIndex.value = action.index;
      scrollIntoView(action.index);
      break;
    case 'select':
      event.preventDefault();
      pick(action.index);
      break;
    default:
      break;
  }
}

function scrollIntoView(index: number): void {
  const el = menuList.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[index];
  el?.scrollIntoView({ block: 'nearest' });
}

function pick(index: number): void {
  const folder = props.folders[index];
  if (!folder) return;
  draftParentId.value = folder.id;
  menuIndex.value = index;
}

onMounted(() => {
  // 打开就落在名称输入框 —— 表单弹窗第一个该填的就是它（壳的 focus 契约）。
  dialog.value?.focus('input');
  // 列表滚到当前目录那一条，省得用户自己找。
  void nextTick(() => {
    menuIndex.value = selectedIndex.value;
    scrollIntoView(selectedIndex.value);
  });
});

function submit(): void {
  if (!canSubmit.value) return;
  const coerced = isFolder.value ? null : coerceBookmarkUrl(draftUrl.value);
  emit('submit', {
    type: draftType.value,
    title: draftTitle.value.trim(),
    // 存的是**修正后**的地址（`example.com` → `https://example.com`），
    // 不是用户敲的那串 —— 否则浏览器会按它自己的 fixup 规则再改一遍，我们说了不算。
    url: coerced ? coerced.url : undefined,
    parentId: draftParentId.value,
  });
}
</script>

<template>
  <AppDialog
    ref="dialog"
    :title="heading"
    :eyebrow="mode === 'create' ? t('app.title') : undefined"
    tone="accent"
    @cancel="emit('cancel')"
  >
    <!-- 新建时切"书签 / 文件夹"：只有新建需要，改名改不了类型。 -->
    <div v-if="allowTypeSwitch" class="dialog-seg" role="group" :aria-label="t('home.editor.typeLabel')">
      <button
        v-for="option in (['bookmark', 'folder'] as const)"
        :key="option"
        type="button"
        class="dialog-seg-btn"
        :data-on="draftType === option"
        :aria-pressed="draftType === option"
        @click="switchType(option)"
      >
        {{ option === 'bookmark' ? t('home.editor.typeBookmark') : t('home.editor.typeFolder') }}
      </button>
    </div>

    <label class="dialog-field">
      <span class="dialog-label">{{ t('home.editor.titleLabel') }}</span>
      <input
        v-model="draftTitle"
        class="dialog-input"
        type="text"
        autocomplete="off"
        :placeholder="t('home.editor.titlePlaceholder')"
      />
    </label>

    <label v-if="!isFolder" class="dialog-field">
      <span class="dialog-label">{{ t('home.editor.urlLabel') }}</span>
      <input
        v-model="draftUrl"
        class="dialog-input"
        type="text"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('home.editor.urlPlaceholder')"
      />
      <span v-if="urlError" class="dialog-error" role="alert">{{ urlError }}</span>
      <span v-else-if="urlOutcome?.changed" class="dialog-hint">
        {{ t('home.editor.urlWillBecome', { url: urlOutcome.url }) }}
      </span>
      <!-- 不会跟着同步走的地址：**不拦，但说清**（现在主页显示得出来，只是换台设备就没了）。 -->
      <span v-if="urlOutcome?.notSyncable" class="dialog-note is-danger">
        {{ t('home.editor.urlNotSyncable') }}
      </span>
    </label>

    <!-- 保存到文件夹：弹窗比内联卡多出来的能力（内联卡只能建在当前目录）。 -->
    <div v-if="mode === 'create'" class="dialog-field">
      <span class="dialog-label">{{ t('home.editor.folderLabel') }}</span>
      <div
        ref="menuList"
        class="dialog-menu"
        role="menu"
        tabindex="0"
        :aria-label="t('home.editor.folderLabel')"
        @keydown="onMenuKeydown"
      >
        <button
          v-for="(folder, at) in folders"
          :key="folder.id"
          type="button"
          class="dialog-menu-item"
          role="menuitemradio"
          :aria-checked="folder.id === draftParentId"
          :data-on="at === menuIndex"
          :style="{ paddingLeft: `calc(var(--sp-5) + ${folder.depth} * 14px)` }"
          @click="pick(at)"
          @mouseenter="menuIndex = at"
        >
          <span class="dialog-menu-title">{{ folder.title }}</span>
          <span class="dialog-menu-count">{{ folder.count }}</span>
        </button>
      </div>
      <p class="dialog-hint">{{ t('home.editor.folderHint') }}</p>
    </div>

    <template #footer>
      <div class="dialog-actions">
        <button type="button" class="dialog-btn" @click="emit('cancel')">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="dialog-btn is-primary" :disabled="!canSubmit" @click="submit">
          {{ mode === 'create' ? t('home.editor.save') : t('home.editor.rename') }}
        </button>
      </div>
    </template>
  </AppDialog>
</template>
