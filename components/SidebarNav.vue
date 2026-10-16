<script setup lang="ts">
import SidebarNode from './SidebarNode.vue';
import type { BookmarkFolderNode } from '../types/bookmarks';

defineProps<{
  roots: BookmarkFolderNode[];
  selectedId: string;
  isExpanded: (id: string) => boolean;
  /** 拖拽整理有没有开。 */
  dragEnabled: boolean;
  /** 新建 / 改名有没有开。 */
  menuEnabled: boolean;
}>();

const emit = defineEmits<{ select: [id: string]; toggle: [id: string] }>();
</script>

<template>
  <nav class="sidebar-nav" aria-label="书签分类">
    <SidebarNode
      v-for="node in roots"
      :key="node.id"
      :node="node"
      :selected-id="selectedId"
      :depth="0"
      :is-expanded="isExpanded"
      :drag-enabled="dragEnabled"
      :menu-enabled="menuEnabled"
      @select="(id: string) => emit('select', id)"
      @toggle="(id: string) => emit('toggle', id)"
    />
  </nav>
</template>
