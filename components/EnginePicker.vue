<script setup lang="ts">
/**
 * 搜索框里的搜索引擎选择器。
 *
 * 为什么不用原生 `<select>`：**闭合态能改，下拉面板改不了** —— 那颗面板由系统绘制，
 * 深色主题下是白底灰边、选中行是一道系统蓝（用户截图里就是它），和本仓的暖陶/青柠
 * 两套配色完全不是一回事。所以这里自己画，但**把系统给的键盘与读屏语义照抄回来**：
 *
 * - `aria-haspopup="menu"` + `role="menu"` + `role="menuitemradio"` + `aria-checked`
 *   —— 这正是 WAI-ARIA 的 menu button 模式（"从一组单选里挑一个"）。
 * - 键盘全在 `lib/choice-menu.ts`（可单测）：上下键、Home/End、回车/空格、Esc、Tab。
 * - 打开时焦点**进入**菜单并落在当前选中项上；收起时还给触发按钮。
 *   焦点在菜单里而不是靠 `aria-activedescendant` 的虚拟高亮：少一层间接，
 *   读屏念的就是真正有焦点那个元素。
 *
 * 组件的边界：**只 emit 用户挑了谁**，写偏好是 App.vue 的事（它握着 settings）。
 * 这跟 `BookmarkContextMenu` 同一个分工。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import { SEARCH_ENGINE_LABEL_KEY } from '../lib/i18n';
import { SEARCH_ENGINE_IDS } from '../lib/search-engines';
import { resolveChoiceKey, type ChoiceMenuAction } from '../lib/choice-menu';
import type { SearchEngineId } from '../types/settings';

const props = defineProps<{
  /** 当前生效的搜索引擎（真值在 settings 里，这里只是显示）。 */
  value: SearchEngineId;
}>();

const emit = defineEmits<{ change: [id: SearchEngineId] }>();

const { t } = useI18n();

/** 标签跟着界面语言走。 */
const options = computed(() =>
  SEARCH_ENGINE_IDS.map((id) => ({ id, label: t(SEARCH_ENGINE_LABEL_KEY[id]) })),
);

const currentIndex = computed(() => {
  const index = options.value.findIndex((option) => option.id === props.value);
  return index < 0 ? 0 : index;
});
const currentLabel = computed(() => options.value[currentIndex.value]?.label ?? '');

const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const itemEls = ref<HTMLButtonElement[]>([]);

const open = ref(false);
/** 高亮/键盘焦点所在项。收起时它 = 当前选中项，下次打开就从这儿开始。 */
const activeIndex = ref(currentIndex.value);

function setItemRef(el: unknown, index: number): void {
  if (el instanceof HTMLButtonElement) itemEls.value[index] = el;
}

function focusActive(): void {
  void nextTick(() => itemEls.value[activeIndex.value]?.focus());
}

function openMenu(index: number): void {
  activeIndex.value = index;
  open.value = true;
  focusActive();
}

/**
 * 收起并把焦点还给触发按钮。
 *
 * `refocus` 为假（点到外面去）时不抢焦点：用户已经用鼠标点了别处，
 * 再把焦点拽回来是抢操作。
 */
function closeMenu(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  itemEls.value = [];
  if (refocus) triggerEl.value?.focus();
}

/**
 * 外面改了偏好（设置页那一份控件、或另一个标签页）时，收起态的高亮要跟上 ——
 * 否则下次打开会从**旧值**那一项开始，用户以为选错了。
 * 菜单开着时不动：那是键盘正在操作的现场，别被异步更新抢走焦点。
 */
watch(currentIndex, (index) => {
  if (!open.value) activeIndex.value = index;
});

function apply(action: ChoiceMenuAction): void {
  switch (action.kind) {
    case 'open':
      openMenu(action.index);
      break;
    case 'move':
      activeIndex.value = action.index;
      focusActive();
      break;
    case 'select':
      choose(options.value[action.index]?.id);
      break;
    case 'close':
      closeMenu(true);
      break;
    default:
      break;
  }
}

/**
 * 触发按钮与菜单共用一个按键处理器。
 *
 * 打开后焦点在菜单项上，按键从菜单冒泡上来；但"刚点开、焦点还没进菜单"那一瞬间
 * 按下的键落在按钮上 —— 两条路都得走同一套判定，否则那一下会静默丢失。
 */
function onKeydown(event: KeyboardEvent): void {
  const action = resolveChoiceKey({
    key: event.key,
    open: open.value,
    index: activeIndex.value,
    count: options.value.length,
  });
  if (action.kind === 'none') return;
  event.preventDefault();
  apply(action);
}

function toggle(): void {
  if (open.value) closeMenu(true);
  else openMenu(activeIndex.value);
}

/** 悬停也跟着高亮：鼠标和键盘共用一条"高亮 = 焦点"的规则，不给两套。 */
function hover(index: number): void {
  activeIndex.value = index;
}

function choose(id: SearchEngineId | undefined): void {
  if (id === undefined) return;
  emit('change', id);
  closeMenu(true);
}

/** 点到外面去就收（捕获阶段：抢在别人的点击之前判定）。 */
function onPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootEl.value?.contains(target)) return;
  closeMenu(false);
}

/** 窗口失焦就收（用户切走了，菜单留着只会挡住下一次操作）。 */
function onWindowBlur(): void {
  closeMenu(false);
}

onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', onWindowBlur);
});

onUnmounted(() => {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('blur', onWindowBlur);
});
</script>

<template>
  <span ref="rootEl" class="engine-wrap">
    <button
      ref="triggerEl"
      type="button"
      class="engine-btn"
      :aria-label="t('home.engineAria')"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span>{{ currentLabel }}</span>
      <svg
        class="engine-caret"
        :class="{ open }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <div
      v-if="open"
      class="engine-menu"
      role="menu"
      :aria-label="t('home.engineAria')"
      @keydown="onKeydown"
    >
      <button
        v-for="(option, index) in options"
        :key="option.id"
        :ref="(el) => setItemRef(el, index)"
        type="button"
        class="engine-option"
        role="menuitemradio"
        :aria-checked="option.id === value ? 'true' : 'false'"
        :tabindex="index === activeIndex ? 0 : -1"
        @click="choose(option.id)"
        @mouseenter="hover(index)"
      >
        <span>{{ option.label }}</span>
        <!-- 当前生效那一项打勾（accent 色）。勾而不是底色：底色的对比度撑不起
             "这一项是当前值"这么重要的一件事（见 既有约定 的对比度表）。 -->
        <svg
          v-if="option.id === value"
          class="engine-check"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      </button>
    </div>
  </span>
</template>
