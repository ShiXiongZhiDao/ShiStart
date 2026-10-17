<script setup lang="ts">
import { computed } from 'vue';
import { useDragArrange } from '../composables/useDragArrange';
import { useItemMenu } from '../composables/useItemMenu';
import { useI18n } from '../composables/useI18n';
import type { BookmarkFolderNode } from '../types/bookmarks';

const props = defineProps<{
  node: BookmarkFolderNode;
  selectedId: string;
  depth: number;
  isExpanded: (id: string) => boolean;
  /** 拖拽整理有没有开。关掉时整棵树都不参与拖放。 */
  dragEnabled: boolean;
  /** 新建 / 改名有没有开。关掉时不弹右键菜单。 */
  menuEnabled: boolean;
  /**
   * 同一层的兄弟 id（界面顺序）。同父排序的"往前往后"由它决定 ——
   * 指针落在目标的哪一半不参与（2026-10-17 修的那条：抓右半边往左拖永远是"插到前一张之后"）。
   */
  siblingIds?: string[];
}>();

const emit = defineEmits<{ select: [id: string]; toggle: [id: string] }>();

const { t } = useI18n();
const { dragging, begin, cancel, hintZone, over, drop } = useDragArrange();
const { open: openItemMenu } = useItemMenu();

const hasChildren = computed(() => props.node.children.length > 0);
const expanded = computed(() => hasChildren.value && props.isExpanded(props.node.id));

/**
 * 提示只给**被截断的全名**（.nav-title 是 ellipsis，见 style.css）。
 *
 * 以前是原生 `title`，文案还拼着"（文件夹 id: 15）"—— 那是浏览器内部 id，
 * 用户看了只会问"这是什么"；条数行上本来就有（.nav-count），提示里再报一遍是复读。
 * 2026-10-15 换自绘气泡时一并清掉：data-tip 由 .shell 上委托的
 * useCardTip 接管，长相与卡片提示一致。
 */

/**
 * 一级目录（书签栏 / 其他书签 / 移动设备书签）是浏览器给的容器，不可拖动，
 * 也只接受"放进去" —— 改它们的次序等于改浏览器根节点下的顺序（见 既有约定）。
 */
const isTopLevel = computed(() => props.depth === 0);
const draggable = computed(() => props.dragEnabled && !isTopLevel.value);
const zone = computed(() => (props.dragEnabled ? hintZone(props.node.id) : null));

/** 只在"放进去"这一段上给标签：那段没有插入线，光靠高亮说不清会发生什么。 */
const dropLabel = computed(() =>
  zone.value === 'inside' ? t('home.drag.into', { title: props.node.title }) : null,
);

/**
 * 右键菜单。
 *
 * 走模块级单例而不是逐层 emit：这棵目录树是递归的，把"右键了谁"一路 emit 上去
 * 要在每一层都转发一遍（既有约定，与 `useDragArrange` 同一个理由）。
 *
 * `descendants` = 直接子节点数：0 是空文件夹，删除时免预览模态、菜单内两下点击
 * 就够。`isTopLevel` 让菜单把一级目录的删除项收起来 ——
 * 服务层另有一道断言，但菜单先不给才是对的。
 */
function openMenu(event: MouseEvent): void {
  if (!props.menuEnabled) return;
  openItemMenu(
    {
      kind: 'folder',
      id: props.node.id,
      title: props.node.title,
      descendants: props.node.children.length + props.node.bookmarks.length,
      isTopLevel: isTopLevel.value,
    },
    event,
  );
}

/**
 * 点整行 = 选中 + 开合（既有约定 决策二）。
 *
 * 以前开合只能点行尾那个箭头（14px，得瞄准），点行只选中 —— 用户要的是"点一下
 * 就开"。现在整行都能开合；**箭头保留**，因为它不改选中：想收起一层又不想跳过去
 * 时用得上（它 `@click.stop`，不会走到这里）。
 *
 * 无子目录的行没有箭头，这里也就不发 toggle —— 点了只是选中。
 *
 * ⚠️ 顺序不是随便排的：`select` 会改 selectedFolderId，进而触发"展开祖先"那条 watch
 * （`useSidebarTree`）。那条 watch 是 `pre` flush，在这两次 emit 之后才跑，写的也是
 * 同一个 Set —— 它**只加不减**（`Set.add`），所以不会把这一下的折叠又撑开；
 * 但也正因为它是后写的，先 select 后 toggle 才安全：先 toggle 再 select 时，
 * 后跑的 watch 会基于"含本次 toggle"的 Set 再补祖先，两条规则谁覆盖谁就说不清了。
 */
function handleClick(): void {
  emit('select', props.node.id);
  if (hasChildren.value) emit('toggle', props.node.id);
}

/**
 * 键盘导航：右箭头展开、左箭头收起。
 * 展开箭头是纯装饰元素，焦点始终留在行上，键盘和鼠标走同一条路径。
 */
function handleKeydown(event: KeyboardEvent): void {
  if (!hasChildren.value) return;
  if (event.key === 'ArrowRight' && !expanded.value) {
    event.preventDefault();
    emit('toggle', props.node.id);
  } else if (event.key === 'ArrowLeft' && expanded.value) {
    event.preventDefault();
    emit('toggle', props.node.id);
  }
}
</script>

<template>
  <div class="nav-branch">
    <button
      type="button"
      class="nav-item"
      :class="{
        active: node.id === selectedId,
        'is-dragging': dragging?.id === node.id,
        'drop-before': zone === 'before',
        'drop-after': zone === 'after',
        'drop-inside': zone === 'inside',
      }"
      :style="{ paddingLeft: `${10 + depth * 13}px` }"
      :draggable="draggable"
      :data-drop-label="dropLabel"
      :data-tip="node.title"
      :aria-current="node.id === selectedId ? 'true' : undefined"
      :aria-expanded="hasChildren ? expanded : undefined"
      @click="handleClick"
      @keydown="handleKeydown"
      @contextmenu.prevent="openMenu"
      @dragstart="begin({ id: node.id, kind: 'folder', title: node.title, siblingIds: props.siblingIds }, $event)"
      @dragend="cancel()"
      @dragover="over($event, node.id, 'folder', !isTopLevel)"
      @drop="drop($event, node.id, 'folder', !isTopLevel)"
    >
      <!-- 行首图标：提示"这是一层文件夹"，不承担交互。 -->
      <svg
        class="nav-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.1c.6 0 1.2.25 1.6.7l1 1.1h6.9a2.2 2.2 0 0 1 2.2 2.2v7.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z"
        />
      </svg>
      <span class="nav-title">{{ node.title }}</span>
      <span class="nav-count">{{ node.count }}</span>
      <!-- 点它只开合、不改选中（点整行是"选中 + 开合"，既有约定）；
           键盘用方向键，焦点始终在行上 -->
      <span
        v-if="hasChildren"
        class="nav-chevron"
        :class="{ open: expanded }"
        aria-hidden="true"
        @click.stop="emit('toggle', node.id)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
    </button>

    <!-- 高度过渡：Transition 类名对应 style.css 的 .nav-tree-*。
         --rail-x 给引导线定位：父行左内边距（10 + depth×13）+ 图标半宽 7。
         缩进步长或图标尺寸一改，这里和 style.css 的 .nav-children::before 一起改。 -->
    <Transition name="nav-tree">
      <div
        v-if="expanded"
        class="nav-children"
        role="group"
        :aria-label="t('folder.childOf', { title: node.title })"
        :style="{ '--rail-x': `${17 + depth * 13}px` }"
      >
        <div class="nav-children-inner">
          <SidebarNode
            v-for="child in node.children"
            :key="child.id"
            :node="child"
            :selected-id="selectedId"
            :depth="depth + 1"
            :is-expanded="isExpanded"
            :drag-enabled="dragEnabled"
            :menu-enabled="menuEnabled"
            :sibling-ids="node.children.map((sibling) => sibling.id)"
            @select="(id: string) => emit('select', id)"
            @toggle="(id: string) => emit('toggle', id)"
          />
        </div>
      </div>
    </Transition>
  </div>
</template>
