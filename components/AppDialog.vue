<script setup lang="ts">
/**
 * 公共弹窗壳—— 全站唯一的模态，删除文件夹是它的第一个用户。
 *
 * 为什么值得有一个壳：主页以前只有一个模态（`DeleteFolderDialog`），它的样式是
 * 自己 scoped 的一份 —— 内边距 10px、按钮高 24px，比全站任何控件都小，
 * 这就是"弹窗难看"的可量化来源（既有约定 背景）。第二个模态（设置页的重置、
 * 以及任何将来的危险操作）会原样复制那份难看，所以先把壳立起来：
 * **间距按浮层卡片的档位走**（`--sp-8`~`--sp-9`、按钮 ≥36px），颜色只引用令牌。
 *
 * 壳只管四件事，别的一律不碰：
 * - **背板与卡片**：`role="dialog" aria-modal="true"`、宽高上限、滚动；
 * - **键盘**：Esc 取消、Tab 圈在卡内（破坏性操作的默认焦点不该是"确认"，
 *   但"落在哪"由内容方决定，见下面的 `focus()`）；
 * - **背板点击**：点外面算取消（可关）；
 * - **背景滚动锁**：弹窗开着的时候背后不该跟着滚。
 *
 * 内容（标题区 / 正文 / 动作区）全部走插槽，**壳不认识任何具体业务** ——
 * 删除文件夹的统计、样本、输名，设置页的清单，都该由各自的组件决定。
 */
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** 卡片标题。也用作 aria-label（读屏念它就是念这个）。 */
    title: string;
    /** 标题上方的小字（产品名 / 场景名），可省。 */
    eyebrow?: string;
    /** 标题下方的一句话摘要，可省。 */
    subtitle?: string;
    /**
     * 语气：`accent` = 常规操作（保存 / 恢复默认），`danger` = 破坏性操作。
     * 只影响**图标底的色调**与统计数字的颜色；主按钮的颜色由内容方自己选
     * （`.dialog-btn.is-danger` / `.is-primary`），因为不是每个壳都有主按钮。
     */
    tone?: 'accent' | 'danger';
    /**
     * 能不能被"顺手关掉"：Esc / 点背板 / ✦✕。
     * 关掉之后只剩内容方给的出口（例如删除要输名字那幕，Esc 仍然有效 ——
     * 见 `onKeydown`，Esc 属于键盘可达性，不属于"顺手关掉"）。
     */
    dismissible?: boolean;
  }>(),
  { tone: 'accent', dismissible: true },
);

const emit = defineEmits<{ cancel: [] }>();

const card = ref<HTMLElement | null>(null);

/**
 * 把焦点交给内容方指定的元素。
 *
 * 为什么不是壳自己决定：**"打开时焦点落在哪"是业务规则** —— 删除文件夹要输名字时
 * 落在输入框（键盘用户唯一要过的关），否则落在「取消」上（既有约定 定的：
 * 破坏性操作的默认焦点不该是"确认"）。壳猜不出该落哪，所以交出这个方法，
 * 由内容方在数据读完之后调用。
 *
 * @param selector 卡内 CSS 选择器，例如 `'input'` 或 `'[data-cancel]'`。
 */
function focus(selector: string): void {
  void nextTick(() => {
    const el = card.value?.querySelector<HTMLElement>(selector);
    el?.focus();
  });
}
defineExpose({ focus });

/** 焦点圈在卡内：Tab 到最后一个回头一个，Shift+Tab 到第一个回最后一个。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('cancel');
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = card.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable || focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  }
}

/** 弹窗开着时锁背景滚动；关闭后还原（可能是别的组件设的值，所以读旧值而不是写死）。 */
let previousOverflow = '';
function lockScroll(): void {
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}
function unlockScroll(): void {
  document.body.style.overflow = previousOverflow;
}

function onScrimClick(): void {
  if (props.dismissible) emit('cancel');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
  lockScroll();
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown, true);
  unlockScroll();
});
</script>

<template>
  <Teleport to="body">
    <div class="dialog-scrim" @click.self="onScrimClick">
      <div
        ref="card"
        class="dialog-card"
        :data-tone="tone"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <header class="dialog-head">
          <!-- 图标块：破坏性操作用 danger 底，其余用 16% 强调色（M5 的处理）。 -->
          <span class="dialog-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />
            </svg>
          </span>
          <div class="dialog-headings">
            <p v-if="eyebrow" class="dialog-eyebrow">{{ eyebrow }}</p>
            <h2 class="dialog-title">{{ title }}</h2>
            <p v-if="subtitle" class="dialog-sub">{{ subtitle }}</p>
          </div>
          <button
            v-if="dismissible"
            type="button"
            class="dialog-close"
            :aria-label="t('common.close')"
            @click="emit('cancel')"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div class="dialog-body">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="dialog-foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
