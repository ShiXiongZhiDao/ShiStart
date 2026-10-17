<script lang="ts">
/** 菜单能发出的动作。动作的实现在页面层（`entrypoints/newtab/App.vue`），组件只管"点了哪个"。 */
export type ContextMenuAction =
  | 'open-tab'
  | 'open-window'
  | 'open-incognito'
  | 'open-split'
  | 'copy-link'
  | 'new-bookmark'
  | 'new-folder'
  | 'rename'
  | 'remove'
  | 'delete-folder';
</script>

<script setup lang="ts">
/**
 * 书签与文件夹的右键菜单（既有约定 起两者共用这一个）。
 *
 * 三类动作，性质完全不同，所以在菜单里也用分隔线分开：
 * - **打开 / 复制**：不改变任何东西，只是把网址交出去（只有书签有）。
 * - **新建 / 改名**：会改动书签，但**可撤销** —— 每一次都记进「上一次改动」，
 *   撤销条就在内容区顶部。这是 既有约定 当年拒绝它们的那个洞的补法。
 * - **删除**：唯一不可逆的一类。
 *   - 书签：菜单内两下点击。
 *   - 文件夹：**空文件夹**同样两下点击；**非空**直接开删除预览模态 ——
 *     模态里那串数量才是这种量级的确认，菜单里再点一遍只是多一次误触机会。
 *     删除入口跟着 `editEnabled` 走，不像书签删除那样常在。
 *
 * 分屏与无痕这两项有前置条件（分屏要 Chrome 155+，无痕要用户先在扩展详情里授权），
 * 做不到时**如实说**，不静默降级成普通窗口（见 `services/tab-actions.ts`）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import type { MenuTarget } from '../composables/useItemMenu';
// `ContextMenuAction` 来自上面那个普通 <script> 块 —— 两个块编译进同一个模块，直接可用。

const { t, tRich } = useI18n();

const props = defineProps<{
  /** 右键点的到底是**一条书签**还是**一个文件夹** —— 两类能做的事不一样。 */
  target: MenuTarget;
  x: number;
  y: number;
  /**
   * 「新建 / 重命名」有没有开（既有约定 的设置项）。
   *
   * 关掉时这两类动作从菜单里消失，但**删除入口永远在** —— 那是 既有约定 定下的：
   * 删除的可用性不随这个开关消失。打开 / 复制同理，它们不改数据。
   */
  editEnabled: boolean;
  /**
   * 这个书签删了之后**到底能不能在回收站里找回**。
   *
   * 三档，不是两档 —— `manual`（配了同步、但自动同步关着）是一条**独立**的情形：
   * 那时删除不会自己进回收站，要用户手动同步一次。把它并进"可以找回"里，
   * 用户就会删完去刷新设置页、然后发现回收站是空的。
   *
   * **它只影响确认那行的措辞，不决定删不删** —— 删除入口一直都在（见 既有约定 的修订）。
   */
  recovery: 'none' | 'auto' | 'manual';
  /** 扩展已被允许在无痕 / InPrivate 里运行。false 时点了给开启办法。 */
  incognitoReady: boolean;
  /** 浏览器提供分屏 API（Chrome 155+）。false 时该项不可点。 */
  splitReady: boolean;
}>();

const emit = defineEmits<{
  close: [];
  action: [action: ContextMenuAction];
}>();

const root = ref<HTMLElement | null>(null);
const confirming = ref(false);
const pos = ref({ left: '0px', top: '0px' });

const isBookmark = computed(() => props.target.kind === 'bookmark');
const url = computed(() => (props.target.kind === 'bookmark' ? props.target.url : ''));

/**
 * 空文件夹 = 直接子节点为空（没有书签、没有子文件夹）。
 *
 * 判据刻意卡在"直接子节点"：装着空壳子文件夹的目录**不**算空 —— 它照样会带走东西，
 * 该走模态。真正空的才配两下点击（它不带走任何书签，删了也进回收站可恢复）。
 */
const folderIsEmpty = computed(() => {
  if (props.target.kind !== 'folder') return false;
  return props.target.descendants === 0;
});

/** 一级目录（书签栏 / 其他书签 / 移动设备书签）不给删 —— 既有约定。 */
const isTopLevelFolder = computed(() => {
  if (props.target.kind !== 'folder') return false;
  return props.target.isTopLevel;
});

/** Edge 里这个功能叫 InPrivate，Chrome 里叫无痕 —— 用用户那边的说法，不强行统一。 */
const isEdge = computed(() => /Edg\//.test(navigator.userAgent));
const incognitoLabel = computed(() =>
  isEdge.value ? t('menu.openIncognitoEdge') : t('menu.openIncognito'),
);

/**
 * 贴着光标开，但不许开到视口外面去：右边放不下就往左收，下边放不下就翻到光标上方。
 * 菜单高度是变的（确认态会多出一段说明），所以每次变化都重新量一次。
 */
function place(): void {
  const el = root.value;
  if (!el) return;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const gap = 8;
  const left = Math.max(gap, Math.min(props.x, window.innerWidth - width - gap));
  const top =
    props.y + height + gap > window.innerHeight
      ? Math.max(gap, props.y - height)
      : props.y;
  pos.value = { left: `${left}px`, top: `${top}px` };
}

/**
 * 换了目标或换了位置就回到未确认态。
 *
 * 不重置会很难看：右键 A → 点一下「删除」（进入确认态）→ 直接右键 B，
 * 菜单还停在确认态，B 会显示成「确认删除」—— 那一瞬间再点一下就把 B 删了。
 * 第一次点击必须是"对这个书签"的，不能顺着上一次的意图蹭过去。
 */
watch(
  () => [props.target.id, props.x, props.y] as const,
  () => {
    confirming.value = false;
    void nextTick(place);
  },
);

// 确认态会让菜单变高，位置要跟着重算一次，否则可能顶到屏幕外。
watch(confirming, () => void nextTick(place));

function close(): void {
  emit('close');
}

function fire(action: ContextMenuAction): void {
  // 删除的两下点击只给**空文件夹**与书签：第一下算"想清楚了没有"，不做任何改动。
  // 非空文件夹的第一下就直接放行 —— 后面跟着删除预览模态，那才是这个量级的确认。
  if (
    !confirming.value &&
    ((action === 'remove') || (action === 'delete-folder' && folderIsEmpty.value))
  ) {
    confirming.value = true;
    return;
  }
  emit('action', action);
  // 打开 / 复制 / 新建 / 改名 / 删文件夹点完就关；书签删除交给页面层，成功了它自己会关。
  if (action !== 'remove') close();
}

function onPointerDown(event: PointerEvent): void {
  const node = root.value;
  if (node && event.target instanceof Node && node.contains(event.target)) return;
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

onMounted(() => {
  place();
  // 捕获阶段：抢在卡片自己的点击之前判定"是不是点在菜单外面"。
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);
});

onUnmounted(() => {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('blur', close);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="card-menu"
      :style="pos"
      role="menu"
      :aria-label="t('menu.aria', { title: target.title })"
    >
      <div class="card-menu-title" :title="url">{{ target.title }}</div>

      <template v-if="isBookmark">
        <button type="button" class="card-menu-item" role="menuitem" @click="fire('open-tab')">
          {{ t('menu.openTab') }}
        </button>
        <button type="button" class="card-menu-item" role="menuitem" @click="fire('open-window')">
          {{ t('menu.openWindow') }}
        </button>
        <button
          type="button"
          class="card-menu-item"
          role="menuitem"
          :title="incognitoReady ? '' : t('menu.incognitoHint')"
          @click="fire('open-incognito')"
        >
          {{ incognitoLabel }}
        </button>
        <button
          type="button"
          class="card-menu-item"
          role="menuitem"
          :disabled="!splitReady"
          :title="splitReady ? '' : t('menu.splitHint')"
          @click="fire('open-split')"
        >
          {{ t('menu.openSplit') }}
        </button>

        <div class="card-menu-sep" role="separator"></div>

        <button type="button" class="card-menu-item" role="menuitem" @click="fire('copy-link')">
          {{ t('menu.copyLink') }}
        </button>
      </template>

      <!-- 文件夹：能在这里新建东西，是"整理"的另一半（另一半是拖拽）。 -->
      <template v-else>
        <button
          v-if="editEnabled"
          type="button"
          class="card-menu-item"
          role="menuitem"
          @click="fire('new-bookmark')"
        >
          {{ t('menu.newBookmark') }}
        </button>
        <button
          v-if="editEnabled"
          type="button"
          class="card-menu-item"
          role="menuitem"
          @click="fire('new-folder')"
        >
          {{ t('menu.newFolder') }}
        </button>
      </template>

      <!-- 重命名跟着设置项走。它的分隔线与它绑在一起：关掉时不该留下两道挨着的线。 -->
      <template v-if="editEnabled">
        <div class="card-menu-sep" role="separator"></div>
        <button type="button" class="card-menu-item" role="menuitem" @click="fire('rename')">
          {{ t('menu.rename') }}
        </button>
      </template>

      <!-- 删除：书签常在，文件夹跟着 editEnabled 走，
           一级目录一律不给删（决策 1 —— 删它等于删书签栏本身）。 -->
      <template v-if="isBookmark || (editEnabled && !isTopLevelFolder)">
        <div class="card-menu-sep" role="separator"></div>
        <button
          type="button"
          class="card-menu-item"
          :class="{ 'is-danger': confirming }"
          role="menuitem"
          @click="fire(isBookmark ? 'remove' : 'delete-folder')"
        >
          {{
            confirming
              ? isBookmark
                ? t('menu.deleteConfirm')
                : t('menu.deleteFolderConfirm')
              : isBookmark
                ? t('menu.delete')
                : t('menu.deleteFolder')
          }}
        </button>
        <!-- 只有"两下点击"那一幕才需要菜单里的备注；非空文件夹的确认在模态里。 -->
        <p v-if="confirming && (!isBookmark ? folderIsEmpty : true)" class="card-menu-note">
          <span v-if="recovery === 'auto'" v-html="tRich(isBookmark ? 'menu.deleteNote' : 'menu.deleteFolderNote')"></span>
          <span v-else-if="recovery === 'manual'" v-html="tRich(isBookmark ? 'menu.deleteNoteManualSync' : 'menu.deleteFolderNoteManualSync')"></span>
          <span v-else v-html="tRich(isBookmark ? 'menu.deleteNoteLocal' : 'menu.deleteFolderNoteLocal')"></span>
        </p>
      </template>
    </div>
  </Teleport>
</template>
