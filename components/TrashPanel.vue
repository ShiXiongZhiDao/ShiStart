<script setup lang="ts">
/**
 * 回收站面板（既有约定；既有约定 起墓碑 = 状态文档里的字段；
 * 既有约定 起改主页卡片网格：图标 + 标题 + 一行 meta + 常驻小按钮）。
 *
 * 两个档：
 * - **待同步**：本机删了、同步还没接手的。零网络可见，可以**就地恢复**
 *   （既有约定：重建原生书签 + 换绑映射，syncId 原样保留）。
 * - **墓碑**：同步已经接手、躺在回收站里的。恢复 = 清掉 `deleted` 标记走正常同步；
 *   彻底清除 = 打上 `purged` 粘性标记。
 *
 * 按"一次删除"分组：一次删掉一个 300 项的文件夹，
 * 平铺会把回收站里更早的条目全部冲散——用户回来找的是"我刚才删的那个文件夹"。
 * 分组键现算（墓碑的父也是墓碑 ⇒ 随父一起来的），不碰存储。组根是文件夹块同形的
 * 卡片，点「另有 n 项」chip 就地展开成员卡（成员卡轻一档，见 style.css）。
 *
 * 既有约定 信息减密：URL 只进卡片 tooltip；「谁删的」收敛为 本机 / 其他设备 /
 * 未知设备（截断写入令牌是产品层不该见的噪音，术语表「写入令牌」条）；底部大段
 * 说明收进 <details>。两个文件一起改文案（lib/i18n）。
 */

import { computed, onMounted, ref } from 'vue';

import {
  previewPurge,
  previewRestore,
  purgeAllFromTrash,
  purgeFromTrash,
  readTrashView,
  restoreFromTrash,
  restorePendingFromTrash,
  type PurgePreview,
  type RestorePreview,
  type TrashItem,
  type TrashView,
} from '../services/trash';
import { readMeta } from '../services/sync-store';
import { isConfigured, loadSyncConfig } from '../services/sync-config';
import { groupTrashItems, type TrashGroup } from '../lib/folder/delete-preview';
import { fallbackLabel } from '../lib/bookmark-mapper';
import { createFaviconUrl } from '../lib/favicon';
import SiteIcon from './SiteIcon.vue';
import { LOGICAL_ROOT_BAR, LOGICAL_ROOT_MOBILE, LOGICAL_ROOT_OTHER } from '../types/sync-state';
import { useI18n } from '../composables/useI18n';
import type { MessageKey } from '../lib/i18n/zh-CN';

const emit = defineEmits<{ changed: [] }>();

/**
 * 顶栏搜索框的关键词（App 传进来）。
 *
 * 搜索框过滤的是**当前这一屏**：浏览屏过滤书签树，这里过滤回收站的两档
 * （标题或网址包含即命中，大小写不敏感）。早先一打字就被弹去浏览屏，
 * 而回收站条目不在书签树里 ⇒ 回收站永远搜不到（2026-10-17 用户报）。
 */
const props = withDefaults(defineProps<{ filter?: string }>(), { filter: '' });

const { t, tRich, resolvedLocale } = useI18n();

const view = ref<TrashView | null>(null);
const loadError = ref<string | null>(null);
const notice = ref<string | null>(null);

const previews = ref<Record<string, RestorePreview>>({});
/** 「待同步」那一档的算账结果。与墓碑共用一个形状，但分开存——刷新时的清理方式不同。 */
const pendingPreviews = ref<Record<string, RestorePreview>>({});
const purgePreviews = ref<Record<string, PurgePreview>>({});
const purgeAllPreview = ref<{ targetCount: number; livingDescendants: number } | null>(null);
const busy = ref<string | null>(null);
const purgeAllBusy = ref(false);

/** 本机写入令牌（截断到 8 位，与墓碑里存的那段同宽），用来把"谁删的"收敛成本机/其他设备。 */
const localWriterId = ref<string | null>(null);

/**
 * 配没配同步（既有约定 修订，2026-10-17）。**曾经配过又断开配置的用户**本地墓碑还在、
 * 也能就地恢复，所以面板要在这种状态下照常工作 —— 但恢复/彻底清除的文案必须换一套：
 * 没有任何东西被发出去，不能说"其它设备会照常合并"。
 *
 * 在 `refresh()` 里读而不是只在挂载时读：用户可能开着这个面板去设置页断开/连上同步，
 * 而同步跑完的广播会让 App 调 `trashPanel.refresh()`。
 */
const syncConfigured = ref(false);

const tombs = computed(() => view.value?.tombs ?? []);
const pending = computed(() => view.value?.pending ?? []);
const isEmpty = computed(() => tombs.value.length === 0 && pending.value.length === 0);

/** 关键词（小写）；空串 = 不过滤。 */
const needle = computed(() => props.filter.trim().toLowerCase());
const filtering = computed(() => needle.value !== '');

/** 标题或网址包含关键词就算命中。文件夹没网址，只看标题。 */
function matchesFilter(item: TrashItem): boolean {
  if (!filtering.value) return true;
  return item.title.toLowerCase().includes(needle.value) || (item.url ?? '').toLowerCase().includes(needle.value);
}

const matchedTombs = computed(() => tombs.value.filter(matchesFilter));
const matchedPending = computed(() => pending.value.filter(matchesFilter));
/** 有东西、但都被关键词筛掉了 —— 要说"没有匹配"，不能说"还没有删除记录"。 */
const noMatch = computed(() => !isEmpty.value && matchedTombs.value.length === 0 && matchedPending.value.length === 0);

/** 删除时间新的在上，未知时间垫底（Array#sort 稳定，同时间保持读入序）。 */
function byDeletedAtDesc(a: TrashItem, b: TrashItem): number {
  if (a.deletedAt === null && b.deletedAt === null) return 0;
  if (a.deletedAt === null) return 1;
  if (b.deletedAt === null) return -1;
  return b.deletedAt - a.deletedAt;
}

const sortedTombs = computed(() => [...matchedTombs.value].sort(byDeletedAtDesc));
const groups = computed(() => groupTrashItems(sortedTombs.value));
const pendingGroups = computed(() => groupTrashItems(matchedPending.value));

/** 展开着的组（组根 syncId）。Set 整体替换，保持响应式。 */
const expandedGroups = ref<ReadonlySet<string>>(new Set());
const expandedPendingGroups = ref<ReadonlySet<string>>(new Set());

interface TrashRow {
  item: TrashItem;
  /** 属于哪一档：决定走哪条恢复路径、meta 里显不显示时间与谁删的。 */
  scope: 'pending' | 'trash';
  /** 相对组根的深度，0 = 组根。 */
  depth: number;
  /** 同组成员数（组根才可能 >0）。 */
  memberCount: number;
  groupId: string;
}

/** 把分组森林摊成带深度的行序列：父在子前，折叠的组只留组根一行。 */
function toRows(
  grouped: readonly TrashGroup<TrashItem>[],
  expanded: ReadonlySet<string>,
  scope: 'pending' | 'trash',
): TrashRow[] {
  const out: TrashRow[] = [];
  for (const group of grouped) {
    out.push({
      item: group.root,
      scope,
      depth: 0,
      memberCount: group.members.length,
      groupId: group.root.syncId,
    });
    if (group.members.length === 0 || !expanded.has(group.root.syncId)) continue;
    for (const member of group.members) {
      out.push({ item: member.item, scope, depth: member.depth, memberCount: 0, groupId: group.root.syncId });
    }
  }
  return out;
}

const rows = computed(() => toRows(groups.value, expandedGroups.value, 'trash'));
const pendingRows = computed(() => toRows(pendingGroups.value, expandedPendingGroups.value, 'pending'));

interface TrashSection {
  scope: 'pending' | 'trash';
  rows: TrashRow[];
}

/** 两档各自成区、各自一张卡片网格；模板里只写一遍卡片。 */
const sections = computed<TrashSection[]>(() => {
  const out: TrashSection[] = [];
  if (matchedPending.value.length > 0) out.push({ scope: 'pending', rows: pendingRows.value });
  if (matchedTombs.value.length > 0) out.push({ scope: 'trash', rows: rows.value });
  return out;
});

function toggleGroup(scope: 'trash' | 'pending', groupId: string): void {
  const source = scope === 'trash' ? expandedGroups.value : expandedPendingGroups.value;
  const next = new Set(source);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  if (scope === 'trash') expandedGroups.value = next;
  else expandedPendingGroups.value = next;
}

function eventTime(at: number): string {
  return new Date(at).toLocaleString(resolvedLocale.value, { hour12: false });
}

const ROOT_KEY: Record<string, MessageKey> = {
  [LOGICAL_ROOT_BAR]: 'sync.root.bar',
  [LOGICAL_ROOT_OTHER]: 'sync.root.other',
  [LOGICAL_ROOT_MOBILE]: 'sync.root.mobile',
};

/** 这一屏里的 syncId → 标题。父标题现算：墓碑自带标题，不需要额外的索引。 */
const titleOf = computed(() => {
  const map = new Map<string, string>();
  for (const item of [...tombs.value, ...pending.value]) map.set(item.syncId, item.title);
  return map;
});

/** 每个墓碑在这一屏里的后代数（组根展开提示用）。 */
const descendantCountOf = computed(() => {
  const counts = new Map<string, number>();
  for (const item of tombs.value) {
    let parent = item.parentSyncId;
    const seen = new Set<string>([item.syncId]);
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
      parent = tombs.value.find((entry) => entry.syncId === parent)?.parentSyncId ?? null;
    }
  }
  return counts;
});

/** 父也在这屏墓碑里 ⇒ 它是"随父一起来的"，恢复/清除时会一起处理。 */
const parentDeletedOf = computed(() => {
  const ids = new Set(tombs.value.map((item) => item.syncId));
  return (item: TrashItem): boolean => item.parentSyncId !== null && ids.has(item.parentSyncId);
});

function locationOf(item: TrashItem): string {
  if (item.parentSyncId !== null) {
    const parentTitle = titleOf.value.get(item.parentSyncId);
    if (parentTitle) return parentTitle;
  }
  const key = ROOT_KEY[item.logicalRootId];
  return key ? t(key) : item.logicalRootId;
}

function kindOf(item: TrashItem): string {
  return item.kind === 'folder' ? t('trash.kindFolder') : t('trash.kindBookmark');
}

/**
 * 谁删的。写入令牌截断显示对用户是纯噪音（没有设备名册，认不出那串字符）——
 * 收敛为 本机 / 其他设备 / 未知设备（术语表「写入令牌」条：产品层没有"设备"）。
 */
function deviceOf(item: TrashItem): string {
  if (item.writerId === null) return t('trash.deviceUnknown');
  if (localWriterId.value !== null && item.writerId === localWriterId.value) return t('trash.deviceLocal');
  return t('trash.deviceOther');
}

/** 卡片 tooltip：标题 + 类型（图标是 aria-hidden 的，读屏靠这里）+ URL。 */
function cardTitle(row: TrashRow): string {
  const parts = [row.item.title, kindOf(row.item)];
  if (row.item.url) parts.push(row.item.url);
  return parts.join(' · ');
}

/** meta 一行：墓碑档 = 时间 · 谁删的 · 原位置；待同步档只有原位置（删除还没落时间）。 */
function metaText(row: TrashRow): string {
  const parts: string[] = [];
  if (row.scope === 'trash') {
    parts.push(row.item.deletedAt === null ? t('trash.timeUnknown') : eventTime(row.item.deletedAt));
    parts.push(t('trash.deletedBy', { device: deviceOf(row.item) }));
  }
  parts.push(t('trash.location', { parent: locationOf(row.item) }));
  return parts.join(' · ');
}

/** 域名的派生规则与 bookmark-mapper 对齐（hostname 去 www），字母牌色相才和主页卡片一致。 */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function faviconUrlOf(item: TrashItem): string {
  return item.url ? createFaviconUrl(item.url) : '';
}

/**
 * 「这次会恢复 N 个节点」的账。拆成主句 + 可选片段，英文语序与中文不同，
 * 拼死的整句在另一种语言里会读不通。
 */
function restoreNote(preview: RestorePreview, item: TrashItem): string {
  const extraPart =
    preview.extraCount > 0
      ? t('trash.restoreNote.extra', {
          extra: preview.extraCount,
          descPart:
            (descendantCountOf.value.get(item.syncId) ?? 0) > 0
              ? t('trash.restoreNote.desc', {
                  n: descendantCountOf.value.get(item.syncId) ?? 0,
                })
              : '',
        })
      : '';
  return t('trash.restoreNote', { n: preview.targetCount, extraPart });
}

/** 「待同步」那一档的账：它会**就地**放回去，措辞里不带"同步/冲突"那些词。 */
function pendingRestoreNote(preview: RestorePreview): string {
  const extraPart = preview.extraCount > 0 ? t('trash.pendingRestoreNote.extra', { n: preview.extraCount }) : '';
  return t('trash.pendingRestoreNote', { extraPart });
}

function purgeNote(preview: PurgePreview): string {
  const parts = {
    n: preview.targetCount,
    extraPart: '',
    orphanPart: preview.livingDescendants > 0 ? t('trash.purgeNote.orphan', { n: preview.livingDescendants }) : '',
  };
  return syncConfigured.value
    ? t('trash.purgeNote', parts)
    : t('trash.purgeNoteOffline', parts);
}

function purgeAllNote(preview: { targetCount: number; livingDescendants: number }): string {
  const orphanPart =
    preview.livingDescendants > 0
      ? t('trash.purgeAllNote.orphan', { records: tombs.value.length, n: preview.livingDescendants })
      : '';
  return syncConfigured.value
    ? t('trash.purgeAllNote', { n: preview.targetCount, orphanPart })
    : t('trash.purgeAllNoteOffline', { n: preview.targetCount, orphanPart });
}

/**
 * 读回收站。**纯本机，不发网络请求**（"待同步"那一档也是本地对账算出来的）。
 *
 * 失败不能只吞掉：读不到时如果显示成"一条都没有"，用户会以为东西真没了——
 * 那是把"读不到"伪装成"不存在"。
 *
 * 顺手重读"配没配同步"：面板可能在用户去设置页动过配置之后还开着，
 * 而同步跑完的广播会把这里再刷一次（App 的 onAfterSync）。
 */
async function refresh(): Promise<void> {
  try {
    syncConfigured.value = isConfigured(await loadSyncConfig());
  } catch {
    // 读不出来按没配 —— 恢复/清除会走本机那条路，最坏只是多一行"未开启同步"的说明。
    syncConfigured.value = false;
  }
  try {
    const next = await readTrashView();
    view.value = next;
    loadError.value = null;
    // 已经不在回收站（两档都算）里的，连它的"算账结果"一起丢掉。
    const alive = new Set([...next.tombs, ...next.pending].map((item) => item.syncId));
    previews.value = Object.fromEntries(Object.entries(previews.value).filter(([id]) => alive.has(id)));
    pendingPreviews.value = Object.fromEntries(
      Object.entries(pendingPreviews.value).filter(([id]) => alive.has(id)),
    );
    purgePreviews.value = Object.fromEntries(Object.entries(purgePreviews.value).filter(([id]) => alive.has(id)));
    purgeAllPreview.value = null;
    const aliveGroups = new Set([
      ...groupTrashItems(next.tombs).map((group) => group.root.syncId),
      ...groupTrashItems(next.pending).map((group) => group.root.syncId),
    ]);
    expandedGroups.value = new Set([...expandedGroups.value].filter((id) => aliveGroups.has(id)));
    expandedPendingGroups.value = new Set(
      [...expandedPendingGroups.value].filter((id) => aliveGroups.has(id)),
    );
  } catch (error) {
    view.value = { tombs: [], pending: [] };
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

/** 两下点击才真的恢复。第一下只算账，把"会连带带回什么"摆出来。 */
async function handleRestore(syncId: string): Promise<void> {
  const preview = previews.value[syncId];
  if (!preview) {
    previews.value = { ...previews.value, [syncId]: await previewRestore([syncId]) };
    return;
  }
  previews.value = Object.fromEntries(Object.entries(previews.value).filter(([id]) => id !== syncId));
  busy.value = syncId;
  try {
    await restoreFromTrash([syncId]);
    notice.value = syncConfigured.value
      ? t('trash.notice.restoreDone', { n: preview.targetCount })
      : t('trash.notice.restoreDoneOffline', { n: preview.targetCount });
    await refresh();
    emit('changed');
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = null;
  }
}

/** 待同步档的就地恢复：同样两下点击，第一下算账。 */
async function handlePendingRestore(syncId: string): Promise<void> {
  const preview = pendingPreviews.value[syncId];
  if (!preview) {
    pendingPreviews.value = { ...pendingPreviews.value, [syncId]: await previewRestore([syncId]) };
    return;
  }
  pendingPreviews.value = Object.fromEntries(
    Object.entries(pendingPreviews.value).filter(([id]) => id !== syncId),
  );
  busy.value = syncId;
  try {
    await restorePendingFromTrash([syncId]);
    notice.value = t('trash.notice.pendingRestoreDone', { n: preview.targetCount });
    await refresh();
    emit('changed');
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = null;
  }
}

/** 彻底清除：两下点击。第一下算账（会连带抹掉什么、多少活后代会被挂回根下）。 */
async function handlePurgeItem(syncId: string): Promise<void> {
  const preview = purgePreviews.value[syncId];
  if (!preview) {
    purgePreviews.value = { ...purgePreviews.value, [syncId]: await previewPurge([syncId]) };
    return;
  }
  purgePreviews.value = Object.fromEntries(Object.entries(purgePreviews.value).filter(([id]) => id !== syncId));
  busy.value = syncId;
  try {
    await purgeFromTrash([syncId]);
    notice.value = syncConfigured.value
      ? t('trash.notice.purgeDone', { n: preview.targetCount })
      : t('trash.notice.purgeDoneOffline', { n: preview.targetCount });
    await refresh();
    emit('changed');
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = null;
  }
}

/** 全部彻底清除：第一下对**当前这一屏**算账，第二下才真删。 */
async function handlePurgeAll(): Promise<void> {
  if (!purgeAllPreview.value) {
    const all = tombs.value.map((item) => item.syncId);
    purgeAllPreview.value = await previewPurge(all);
    return;
  }
  purgeAllBusy.value = true;
  try {
    const result = await purgeAllFromTrash();
    notice.value = syncConfigured.value
      ? t('trash.notice.purgeAllDone', { n: result.purged })
      : t('trash.notice.purgeDoneOffline', { n: result.purged });
    await refresh();
    emit('changed');
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    purgeAllBusy.value = false;
  }
}

function restorePreviewOf(row: TrashRow): RestorePreview | undefined {
  return row.scope === 'pending'
    ? pendingPreviews.value[row.item.syncId]
    : previews.value[row.item.syncId];
}

function onRestoreClick(row: TrashRow): void {
  if (row.scope === 'pending') void handlePendingRestore(row.item.syncId);
  else void handleRestore(row.item.syncId);
}

onMounted(async () => {
  const meta = await readMeta();
  localWriterId.value = meta.writerId === '' ? null : meta.writerId.slice(0, 8);
  await refresh();
});

defineExpose({ refresh });
</script>

<template>
  <div class="trash">
    <header class="trash-head">
      <h2 class="trash-title-main" :title="t('trash.titleCount', { n: tombs.length + pending.length })">
        {{ t('trash.title') }}
      </h2>
      <button
        v-if="tombs.length > 0"
        type="button"
        class="trash-danger-btn"
        :disabled="purgeAllBusy"
        @click="handlePurgeAll"
      >
        {{
          purgeAllBusy
            ? t('trash.busy')
            : purgeAllPreview
              ? t('trash.purgeAllConfirm', { n: purgeAllPreview.targetCount })
              : t('trash.purgeAll')
        }}
      </button>
    </header>

    <p v-if="purgeAllPreview" class="trash-note trash-note-danger" v-html="purgeAllNote(purgeAllPreview)"></p>
    <p v-if="notice" class="trash-note">{{ notice }}</p>
    <p v-if="loadError" class="trash-error">{{ loadError }}</p>

    <!-- 断开同步配置时的一行口径（既有约定 修订）：入口对这种用户照样显示，
         但恢复与彻底清除的传播规则和在线时不同 —— 在看任何操作之前先说清。 -->
    <p v-if="!syncConfigured && !isEmpty && !noMatch" class="trash-hint" v-html="tRich('trash.offlineNote')"></p>

    <!-- 待同步：零等待可见，而且**可以就地恢复**—— 删除还没离开这台机器。
         整棵子树也给恢复（既有约定 修订）：先创建后换映射，syncId 原样保留、
         一个操作都不推；断网时这是唯一一条恢复路径。 -->
    <section v-for="section in sections" :key="section.scope" class="trash-section">
      <h3 class="trash-section-title">
        {{
          section.scope === 'pending'
            ? t('trash.pendingTitle', { n: matchedPending.length })
            : t('trash.tombsTitle', { n: matchedTombs.length })
        }}
      </h3>
      <p v-if="section.scope === 'pending'" class="trash-hint" v-html="tRich('trash.pendingNote')"></p>

      <ul class="trash-card-grid">
        <li
          v-for="row in section.rows"
          :key="row.item.syncId"
          class="trash-card"
          :class="{ 'is-nested': row.depth > 0, 'is-pending': row.scope === 'pending' }"
          :title="cardTitle(row)"
        >
          <div class="trash-card-top">
            <span v-if="row.item.kind === 'folder'" class="trash-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.1c.6 0 1.2.25 1.6.7l1 1.1h6.9a2.2 2.2 0 0 1 2.2 2.2v7.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z" />
              </svg>
            </span>
            <SiteIcon
              v-else
              :favicon-url="faviconUrlOf(row.item)"
              :url="row.item.url ?? ''"
              :fallback-label="fallbackLabel(row.item.title)"
              :domain="domainOf(row.item.url ?? '')"
            />
            <span class="trash-card-title">{{ row.item.title }}</span>
            <span v-if="row.scope === 'pending'" class="trash-chip trash-chip-pending">
              {{ t('trash.pendingChip') }}
            </span>
            <button
              v-if="row.memberCount > 0"
              type="button"
              class="trash-group-chip"
              :aria-expanded="section.scope === 'pending' ? expandedPendingGroups.has(row.groupId) : expandedGroups.has(row.groupId)"
              @click="toggleGroup(section.scope, row.groupId)"
            >
              {{
                (section.scope === 'pending'
                  ? expandedPendingGroups.has(row.groupId)
                  : expandedGroups.has(row.groupId))
                  ? t('trash.groupCollapse')
                  : t('trash.groupExpand', { n: row.memberCount })
              }}
            </button>
          </div>

          <p class="trash-card-meta">{{ metaText(row) }}</p>

          <div class="trash-card-actions">
            <button
              type="button"
              class="trash-btn"
              :disabled="busy === row.item.syncId"
              @click="onRestoreClick(row)"
            >
              {{
                busy === row.item.syncId
                  ? t('trash.busy')
                  : restorePreviewOf(row)
                    ? t('trash.restoreConfirm')
                    : t('trash.restore')
              }}
            </button>
            <button
              v-if="row.scope === 'trash'"
              type="button"
              class="trash-btn trash-btn-danger"
              :disabled="busy === row.item.syncId"
              @click="handlePurgeItem(row.item.syncId)"
            >
              {{
                busy === row.item.syncId
                  ? t('trash.busy')
                  : purgePreviews[row.item.syncId]
                    ? t('trash.purgeConfirm')
                    : t('trash.purge')
              }}
            </button>
          </div>

          <!-- 恢复的最小改动单位不是"一条"：不带上祖先，恢复出来的就是孤儿。 -->
          <p
            v-if="restorePreviewOf(row)"
            class="trash-note trash-note-plan"
            v-html="
              row.scope === 'pending'
                ? pendingRestoreNote(restorePreviewOf(row)!)
                : restoreNote(restorePreviewOf(row)!, row.item)
            "
          ></p>
          <p
            v-if="row.scope === 'trash' && purgePreviews[row.item.syncId]"
            class="trash-note trash-note-danger"
            v-html="purgeNote(purgePreviews[row.item.syncId]!)"
          ></p>
          <p v-if="row.scope === 'trash' && parentDeletedOf(row.item)" class="trash-card-note">
            {{ t('trash.parentDeleted') }}
          </p>
        </li>
      </ul>
    </section>

    <!-- 空态加一句指路：回收站什么都没有 = 单条找回这条路走到头了，
         此时该告诉用户还有"整树退回"这条路。有内容时不显示 —— 日常误删秒撤，
         不该天天对着一句用不到的话。 -->
    <template v-if="isEmpty">
      <p class="trash-empty">{{ t('trash.empty') }}</p>
      <p class="trash-empty trash-empty-hint">{{ t('trash.toSnapshots') }}</p>
    </template>
    <!-- 有东西、但都被关键词筛掉了：说"没有匹配"，不能说"还没有删除记录" —— 后者是假话。 -->
    <template v-else-if="noMatch">
      <p class="trash-empty">{{ t('trash.noMatch') }}</p>
    </template>

    <!-- 大段说明是参考材料不是操作信息：默认折叠，点开才读（既有约定 决策五）。 -->
    <details v-if="!isEmpty" class="trash-details">
      <summary class="trash-details-summary">{{ t('trash.noteTitle') }}</summary>
      <ul class="trash-details-list">
        <li v-html="tRich('trash.noteRestore')"></li>
        <li v-html="tRich('trash.notePurge')"></li>
        <li v-html="tRich('trash.noteGrace')"></li>
      </ul>
    </details>
  </div>
</template>
