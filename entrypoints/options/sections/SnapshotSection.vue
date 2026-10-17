<script setup lang="ts">
/**
 * 快照分区（既有约定 建 / 既有约定 修订改名 / 2026-10-15 重做版面）。
 *
 * 恢复点（数据层的名）的界面层名字 —— 用户可见的每一处都叫「快照」。
 * 命名分层见 GLOSSARY「恢复点」条与 既有约定 修订节（先例：墓碑 / 回收站）。
 *
 * ## 版面为什么长这样（2026-10-15 第二次重做，用户：「太难看了，也很复杂，也不好操作」）
 *
 * 上一版把三件事全塞进了同一段散文里：状态、保留策略、操作说明。后果是
 * **全页最重要的信息最不显眼**（"保险生效中 / 写入失败" 是一行 fs-sm 的灰字，
 * 压在四行长文下面），而回退 —— 这一页唯一的主操作 —— 长得和删除一模一样
 * （都是 fs-xs 的灰色下划线小字）。难看、复杂、不好操作三个抱怨是同一件事。
 *
 * 这一版按「一屏内先回答什么」重排三层：
 * 1. **状态区**：彩色状态胶囊（生效中 / 写入失败 / 未配置）+ 两个数字方块
 *    （上次写入 / 云端份数）。状态是**颜色**，不是一段要读的话。
 * 2. **版本列表**：一条 = 时间线上的一颗点。时间用相对口径当主文（"3 小时前"比
 *    一串绝对时间好认），绝对时间与大小退成副文。**回退是描边按钮**，删除是
 *    无边框的危险色文字钮 —— 主次靠形态分，不靠读文字分。
 * 3. **说明折叠**：保留策略与全部「为什么这样设计」收进 `<details>`。首次用户
 *    需要一次，之后每一次都是噪音。
 *
 * **指纹仍然不显示**（既有约定 的纪律：内部 id 不上界面）；时间足够指认一份快照。
 *
 * 为什么回退预览是**行内面板而不是模态弹窗**：设置页自己的重动作（重置同步 ——
 * 删整个云端历史）走的是行内两下点击，弹窗壳（AppDialog）目前只接在新标签页那边。
 * 行内还算白赚一个好处：算账时列表还在视线里，"退到哪一份"的对照不丢。
 *
 * 网络面：进分区读一次列表（一次 PROPFIND，与原来"展开折叠区"同级，没有变重）；
 * "保险断没断"读**本机 meta**（零网络）—— 同一个读取口同时供主页红点与同步区
 * 那一行使用（`readRestorePointError`，既有约定 决策四）。
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '../../../composables/useI18n';
import {
  deleteRestorePoint,
  readRestorePointError,
  readRestorePointStatus,
  type RestorePointInfo,
  type RestorePointStatus,
} from '../../../services/restore-points';
import {
  previewRollback,
  rollbackToRestorePoint,
  type RollbackPreview,
} from '../../../services/sync-engine';
import {
  formatAbsoluteTime,
  formatDate,
  formatFileSize,
  formatRelativeTime,
} from '../../../lib/format-time';
import { isConfigured, loadSyncConfig } from '../../../services/sync-config';
import type { MessageKey } from '../../../lib/i18n/zh-CN';

const { t, tRich, resolvedLocale } = useI18n();

/** 列表（一次 PROPFIND）。null = 还没读出来。 */
const status = ref<RestorePointStatus | null>(null);
/** 列表读失败。与"一份都没有"是两件事 —— 读不到不能说成不存在。 */
const listError = ref<string | null>(null);
/** 本机记的"上次写恢复点失败"（零网络）。保险胶囊与同步区那一行共用它。 */
const localError = ref<string | null>(null);
/** 配过同步没有。没配时"没写过"要说成"还没配置"，不是"还没有写入过"。 */
const configured = ref(false);

/** 两下点击才真删：删除是这条链路上唯一不可逆的动作（共享的，见 snapshot.detail）。 */
const pendingDeleteId = ref<string | null>(null);
/** 行内预览：正在算账的那一份、算账结果、算账失败。 */
const previewId = ref<string | null>(null);
const preview = ref<RollbackPreview | null>(null);
const previewError = ref<string | null>(null);
const busyId = ref<string | null>(null);

/**
 * 提示语存**尚未翻译的形态**（key + 变量）—— 与同步分区同一条理由：
 * 用户在「外观」切到英文之后，旧提示不该还留着中文。异常消息没有 key，整句原文。
 */
type NoticeEntry =
  | { tone: 'ok' | 'error'; key: MessageKey; vars?: Record<string, string | number> }
  | { tone: 'ok' | 'error'; text: string };

const notice = ref<NoticeEntry | null>(null);

function setNotice(
  tone: 'ok' | 'error',
  key: MessageKey,
  vars?: Record<string, string | number>,
): void {
  notice.value = { tone, key, vars };
}

function setNoticeRaw(tone: 'ok' | 'error', text: string): void {
  notice.value = { tone, text };
}

function setNoticeError(error: unknown): void {
  setNoticeRaw('error', error instanceof Error ? error.message : String(error));
}

const noticeText = computed<string | null>(() => {
  const entry = notice.value;
  if (entry === null) return null;
  return 'text' in entry ? entry.text : t(entry.key, entry.vars);
});

const noticeTone = computed<'ok' | 'error' | null>(() => notice.value?.tone ?? null);

/** 中文顿号、英文逗号 —— 与同步分区同一个口径（列表连接符）。 */
const listSeparator = computed(() => (resolvedLocale.value === 'zh-CN' ? '、' : ', '));

/**
 * 状态胶囊。**顺序即优先级**：本机记的写入失败 > 没配同步 > 列表读失败 >
 * 还在读 > 一份都没有 > 一切正常。
 *
 * 为什么"没配同步"要排在"列表读失败"前面：没配同步时列表必然也读不到，
 * 先报"读取失败"会把人吓一跳 —— 那不是故障，只是这个功能还没开。
 */
const insurance = computed<{
  tone: 'ok' | 'error' | 'muted';
  pill: string;
  reason: string | null;
}>(() => {
  if (localError.value !== null) {
    return { tone: 'error', pill: t('snapshot.status.pill.broken'), reason: localError.value };
  }
  if (!configured.value) {
    return { tone: 'muted', pill: t('snapshot.status.pill.unconfigured'), reason: null };
  }
  if (listError.value !== null) {
    return { tone: 'error', pill: t('snapshot.status.pill.error'), reason: listError.value };
  }
  if (status.value === null) {
    return { tone: 'muted', pill: t('snapshot.status.pill.loading'), reason: null };
  }
  if (status.value.points.length === 0) {
    return { tone: 'muted', pill: t('snapshot.status.pill.never'), reason: null };
  }
  return { tone: 'ok', pill: t('snapshot.status.pill.healthy'), reason: null };
});

/** 上次写入 = 「当前」那一份的时间；没有「当前」就不知道写过没有。 */
const lastWriteText = computed<string>(() => {
  const state = status.value;
  if (!state) return '—';
  const current = state.points.find((point) => point.fingerprint === state.lastFingerprint);
  if (!current) return '—';
  return current.capturedAt === null
    ? t('common.unknownTime')
    : formatAbsoluteTime(current.capturedAt, resolvedLocale.value);
});

const countText = computed<string>(() => {
  const state = status.value;
  if (!state) return '—';
  // 0 也要带单位（"0 份"）—— 同一格里出现 "3 份" 和 "0" 两种写法会让人以为单位是另算的。
  return t('snapshot.status.countValue', { n: state.points.length });
});

/** 空态的两个变体：没配同步（要给一个去配置的按钮）与配了但还没写过。 */
const emptyTitle = computed(() =>
  configured.value ? t('snapshot.empty.title') : t('snapshot.empty.unconfigured'),
);

const emptyText = computed(() =>
  configured.value ? t('snapshot.empty.text') : t('snapshot.empty.textUnconfigured'),
);

/** 一条版本的主文：7 天内相对时间，之外绝对日期。 */
function primaryTime(point: RestorePointInfo): string {
  if (point.capturedAt === null) return t('common.unknownTime');
  return (
    formatRelativeTime(point.capturedAt, Date.now(), resolvedLocale.value) ??
    formatDate(point.capturedAt, resolvedLocale.value)
  );
}

/** 副文：绝对时间（精确到秒），有大小就跟在后面。 */
function secondaryMeta(point: RestorePointInfo): string {
  const parts: string[] = [];
  if (point.capturedAt !== null) parts.push(formatAbsoluteTime(point.capturedAt, resolvedLocale.value));
  if (point.sizeBytes !== undefined) parts.push(formatFileSize(point.sizeBytes));
  return parts.join(' · ');
}

/** 一次回退会改动什么，说成人话。全为 0 时说清楚"没有差异"。 */
function rollbackSummary(counts: RollbackPreview['counts']): string {
  const parts: string[] = [];
  if (counts.create > 0) parts.push(t('label.rollback.created', { n: counts.create }));
  if (counts.update > 0) parts.push(t('label.rollback.updated', { n: counts.update }));
  if (counts.delete > 0) parts.push(t('label.rollback.deleted', { n: counts.delete }));
  if (parts.length === 0) return t('label.rollback.none');
  return parts.join(listSeparator.value);
}

/** 预览里的计数胶囊：只出现非零的类，按"带回 / 删除 / 改动"排。 */
const previewChips = computed<Array<{ kind: string; label: string }>>(() => {
  const target = preview.value;
  if (target === null) return [];
  const chips: Array<{ kind: string; label: string }> = [];
  if (target.counts.create > 0) {
    chips.push({ kind: 'create', label: t('label.rollback.created', { n: target.counts.create }) });
  }
  if (target.counts.delete > 0) {
    chips.push({ kind: 'delete', label: t('label.rollback.deleted', { n: target.counts.delete }) });
  }
  if (target.counts.update > 0) {
    chips.push({ kind: 'update', label: t('label.rollback.updated', { n: target.counts.update }) });
  }
  return chips;
});

/**
 * 样本行：「带回：A、B、C」—— 计数已经在胶囊里了，这里只列名字，
 * 不重复数字（重复一遍反而让人以为两个数不一样）。空的类不出现。
 */
const sampleLines = computed<string[]>(() => {
  const target = preview.value;
  if (target === null) return [];
  const groups: Array<[string, string[]]> = [
    [t('snapshot.preview.created'), target.samples.create],
    [t('snapshot.preview.deleted'), target.samples.delete],
    [t('snapshot.preview.updated'), target.samples.update],
  ];
  return groups
    .filter(([, titles]) => titles.length > 0)
    .map(([kind, titles]) => `${kind}：${titles.join(listSeparator.value)}`);
});

async function refresh(): Promise<void> {
  listError.value = null;
  configured.value = isConfigured(await loadSyncConfig());
  try {
    status.value = await readRestorePointStatus();
    listError.value = status.value.error;
  } catch (error) {
    status.value = { points: [], lastFingerprint: null, error: null };
    listError.value = error instanceof Error ? error.message : String(error);
  }
  localError.value = await readRestorePointError();
  // 已经不存在的那些份，连同它的算账结果一起丢掉：留着会让按钮重新显示旧账。
  const alive = new Set(status.value?.points.map((point) => point.fingerprint) ?? []);
  if (previewId.value !== null && !alive.has(previewId.value)) closePreview();
}

onMounted(() => {
  void refresh();
});

/** 空态里的指路：去「同步」分区配同步。hash 变化由外壳接管。 */
function goSync(): void {
  location.hash = 'sync';
}

function closePreview(): void {
  previewId.value = null;
  preview.value = null;
  previewError.value = null;
}

/**
 * 第一下只算账（读恢复点、验真、与当前实况比一遍），行内展开预览；
 * 预览里的「确认回退」才真的动手。验真失败在这里就是明确报错 —— 原来那颗独立的
 * 「检查」按钮因此撤掉（预览第一步做的就是检查，既有约定 决策三）。
 */
async function openPreview(id: string): Promise<void> {
  if (previewId.value === id) {
    closePreview();
    return;
  }
  previewId.value = id;
  preview.value = null;
  previewError.value = null;
  try {
    preview.value = await previewRollback(id);
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  }
}

async function confirmRollback(id: string): Promise<void> {
  busyId.value = id;
  try {
    const report = await rollbackToRestorePoint(id);
    if (!report.sync) {
      setNotice('ok', 'snapshot.notice.rollbackNoop');
    } else {
      const conflictNote =
        report.sync.conflictCount > 0
          ? `${listSeparator.value}${t('label.summary.conflicts', { n: report.sync.conflictCount })}`
          : '';
      setNotice('ok', 'snapshot.notice.rollbackDone', {
        summary: rollbackSummary(report.counts),
        applied: report.sync.applied,
        conflictNote,
      });
    }
    closePreview();
  } catch (error) {
    setNoticeError(error);
  } finally {
    busyId.value = null;
    await refresh();
  }
}

async function handleDelete(id: string): Promise<void> {
  if (pendingDeleteId.value !== id) {
    pendingDeleteId.value = id;
    return;
  }
  pendingDeleteId.value = null;
  busyId.value = id;
  try {
    await deleteRestorePoint(id);
    setNotice('ok', 'snapshot.notice.pointDeleted');
  } catch (error) {
    setNoticeError(error);
  } finally {
    busyId.value = null;
    await refresh();
  }
}
</script>

<template>
  <div class="stack">
    <div class="section-head">
      <h2>{{ t('snapshot.title') }}</h2>
    </div>

    <p v-if="noticeText !== null" class="notice" :data-tone="noticeTone">{{ noticeText }}</p>

    <!-- ① 状态区：这一页第一眼要回答的问题。导语按用户要求留在卡内（放在 h2 与卡片
         之间飘一段，切分区时会显得脱节 —— 其余每个分区都是标题直接接卡片）。 -->
    <section class="card">
      <div class="status-head">
        <h3>{{ t('snapshot.status.title') }}</h3>
        <span class="pill" :data-tone="insurance.tone">
          <span class="pill-dot" aria-hidden="true"></span>{{ insurance.pill }}
        </span>
      </div>

      <p class="hint">{{ t('snapshot.lead') }}</p>

      <dl class="stats">
        <div class="stat">
          <dt>{{ t('snapshot.status.lastWrite') }}</dt>
          <dd>{{ lastWriteText }}</dd>
        </div>
        <div class="stat">
          <dt>{{ t('snapshot.status.count') }}</dt>
          <dd>{{ countText }}</dd>
        </div>
      </dl>

      <!-- 失败原因单独一条：胶囊负责"要不要紧"，这里负责"为什么"。 -->
      <p v-if="insurance.reason !== null" class="reason">
        <svg class="reason-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" />
          <path d="M12 7.5v5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path
            d="M12 16.4h.01"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
          />
        </svg>
        <span>{{ insurance.reason }}</span>
      </p>
    </section>

    <!-- ② 版本列表 -->
    <section class="card">
      <div class="list-head">
        <h3>{{ t('snapshot.list.title') }}</h3>
        <span v-if="status !== null && status.points.length > 0" class="list-count">
          {{ t('snapshot.total', { n: status.points.length }) }}
        </span>
      </div>

      <p v-if="status === null && listError === null" class="hint">{{ t('common.loading') }}</p>
      <p v-else-if="listError !== null && configured" class="error-line">{{ listError }}</p>

      <template v-else-if="status !== null">
        <!-- 空态：一个图标 + 一句话 + 一个真按钮（原来是一句连读的话里塞个下划线链接） -->
        <div v-if="status.points.length === 0" class="empty">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path
              d="m3 12.5 9 4.5 9-4.5"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path
              d="m3 17 9 4.5 9-4.5"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          </svg>
          <p class="empty-title">{{ emptyTitle }}</p>
          <p class="empty-text">{{ emptyText }}</p>
          <button v-if="!configured" type="button" class="btn primary" @click="goSync">
            {{ t('snapshot.empty.action') }}
          </button>
        </div>

        <!-- 时间线：每一条是一颗点，连成"这份历史"的序列感 -->
        <ul v-else class="rail">
          <li
            v-for="point in status.points"
            :key="point.fingerprint"
            class="version"
            :class="{ 'is-current': point.fingerprint === status.lastFingerprint }"
          >
            <div class="version-main">
              <span class="t-main">{{ primaryTime(point) }}</span>
              <span class="t-sub">{{ secondaryMeta(point) }}</span>
              <span v-if="point.fingerprint === status.lastFingerprint" class="badge">
                {{ t('snapshot.current') }}
              </span>
            </div>

            <div class="version-actions">
              <button
                type="button"
                class="act act-rollback"
                :disabled="busyId === point.fingerprint"
                @click="openPreview(point.fingerprint)"
              >
                {{ t('snapshot.rollback') }}
              </button>
              <button
                type="button"
                class="act act-delete"
                :class="{ 'is-armed': pendingDeleteId === point.fingerprint }"
                :disabled="busyId === point.fingerprint"
                @click="handleDelete(point.fingerprint)"
              >
                {{
                  pendingDeleteId === point.fingerprint
                    ? t('common.confirmDelete')
                    : t('common.delete')
                }}
              </button>
            </div>

            <!-- 行内算账：计数胶囊 + 名字样本 + 确认。算账时列表还在视线里。 -->
            <div v-if="previewId === point.fingerprint" class="preview">
              <p v-if="preview === null && previewError === null" class="preview-lead">
                {{ t('common.loading') }}
              </p>
              <p v-else-if="previewError !== null" class="preview-error">{{ previewError }}</p>
              <template v-else-if="preview !== null">
                <p class="preview-lead">{{ t('snapshot.preview.title') }}</p>
                <div class="chips">
                  <span
                    v-for="chip in previewChips"
                    :key="chip.kind"
                    class="chip"
                    :data-kind="chip.kind"
                  >
                    {{ chip.label }}
                  </span>
                  <span v-if="previewChips.length === 0" class="chip">{{ t('label.rollback.none') }}</span>
                </div>
                <p class="preview-note">{{ t('snapshot.preview.note') }}</p>
                <template v-if="sampleLines.length > 0">
                  <p class="preview-samples-title">{{ t('snapshot.preview.samples') }}</p>
                  <ul class="samples">
                    <li v-for="line in sampleLines" :key="line">{{ line }}</li>
                  </ul>
                </template>
                <div class="preview-actions">
                  <button type="button" class="btn" @click="closePreview">
                    {{ t('common.cancel') }}
                  </button>
                  <button
                    type="button"
                    class="btn primary"
                    :disabled="busyId === point.fingerprint"
                    @click="confirmRollback(point.fingerprint)"
                  >
                    {{
                      busyId === point.fingerprint
                        ? t('snapshot.rollingBack')
                        : t('snapshot.confirmRollback')
                    }}
                  </button>
                </div>
              </template>
            </div>
          </li>
        </ul>
      </template>

      <div class="list-foot">
        <details class="fold">
          <summary>{{ t('snapshot.fold') }}</summary>
          <p class="hint" v-html="tRich('snapshot.retention')"></p>
          <p class="hint" v-html="tRich('snapshot.detail')"></p>
        </details>
        <p class="foot-hint">{{ t('snapshot.trashHint') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ---------- ① 状态区 ---------- */

.status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-5);
  margin-bottom: var(--sp-5);
}

.status-head h3 {
  margin: 0;
}

/* 状态是**颜色**，不是一段要读的话 —— 全页最重要的一格用它承载。 */
.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  flex: none;
  padding: var(--sp-2) var(--sp-5);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  background: var(--surface-2);
  color: var(--text-3);
}

.pill-dot {
  width: var(--sp-3);
  height: var(--sp-3);
  border-radius: var(--radius-pill);
  background: currentColor;
}

.pill[data-tone='ok'] {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.pill[data-tone='error'] {
  background: var(--danger-soft);
  color: var(--danger);
}

/* 两个数字方块：标签弱、数字强，扫一眼就够。 */
.stat {
  padding: var(--sp-5) var(--sp-6);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-2);
}

.stat dd {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-lg);
  font-variant-numeric: tabular-nums;
}

.reason {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-4);
  margin: var(--sp-5) 0 0;
  padding: var(--sp-5) var(--sp-6);
  border-radius: var(--radius-md);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.reason-icon {
  width: var(--sp-7);
  height: var(--sp-7);
  flex: none;
  margin-top: var(--sp-1);
}

/* ---------- ② 版本列表 ---------- */

.list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-5);
  margin-bottom: var(--sp-5);
}

.list-head h3 {
  margin: 0;
}

.list-count {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.rail {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* 时间线：每条一颗点。当前那一条填实，其余空心环。 */
.version {
  position: relative;
  padding: 0 0 var(--sp-7) var(--sp-9);
  font-size: var(--fs-sm);
}

.version:last-child {
  padding-bottom: 0;
}

.version::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--sp-1);
  width: var(--sp-4);
  height: var(--sp-4);
  box-sizing: border-box;
  border: 2px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: var(--surface);
}

/* 连线段画到下一颗点；最后一条不画。 */
.version:not(:last-child)::after {
  content: '';
  position: absolute;
  left: calc(var(--sp-4) / 2 - 1px);
  top: calc(var(--sp-1) + var(--sp-4) + var(--sp-2));
  bottom: var(--sp-1);
  width: 2px;
  background: var(--line);
}

.version.is-current::before {
  border-color: var(--accent);
  background: var(--accent);
}

.version-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-2) var(--sp-5);
}

/* 主文：相对时间（或绝对日期），压得住场；副文弱一格。 */
.t-main {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--text);
}

.t-sub {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

/* 「当前」= 本机最近一次写上去的那一份。 */
.badge {
  margin-left: auto;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
}

.version-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-4);
}

/* 操作靠**形态**分主次：回退是描边按钮，删除是无边框的危险色文字钮。
   上一版两个都是同款灰下划线小字，等于没说哪个是主操作。 */
.act {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-6);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.act:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.act-rollback {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line-strong));
  background: var(--accent-soft);
  color: var(--accent-text);
}

.act-rollback:hover:not(:disabled) {
  border-color: var(--accent);
}

/* 只把边框**变透明**、不移除（`border-style` 仍是 solid）：盒子与主按钮一样大，
   「再点一次确认删除」亮出红边时行不会跳一下。 */
.act-delete {
  border-color: transparent;
  background: none;
  color: var(--text-3);
}

.act-delete:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--danger);
}

/* 「再点一次确认删除」：把破坏性状态画出来，别只换文字。 */
.act-delete.is-armed {
  border-color: var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
}

/* ---------- 行内回退预览 ---------- */

.preview {
  margin-top: var(--sp-5);
  padding: var(--sp-5) var(--sp-6);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--surface-2);
}

.preview-lead {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.preview-error {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--danger);
  overflow-wrap: anywhere;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}

.chip {
  padding: var(--sp-2) var(--sp-5);
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
}

.chip[data-kind='create'] {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.chip[data-kind='delete'] {
  background: var(--danger-soft);
  color: var(--danger);
}

.preview-note {
  margin: 0 0 var(--sp-4);
  color: var(--text-3);
  font-size: var(--fs-xs);
  line-height: 1.7;
}

.preview-samples-title {
  margin: 0 0 var(--sp-2);
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.samples {
  list-style: none;
  margin: 0 0 var(--sp-5);
  padding: 0;
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.8;
  overflow-wrap: anywhere;
}

.preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-4);
}

/* ---------- 空态 ---------- */

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-9) var(--sp-7);
  text-align: center;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-xl);
  background: var(--surface-2);
}

.empty-icon {
  width: var(--sp-10);
  height: var(--sp-10);
  /* 比 --line-strong 亮一档：空态里它是唯一的图形，用分隔线的颜色会淡到看不见。 */
  color: var(--text-3);
}

.empty-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-medium);
}

.empty-text {
  max-width: 380px;
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-sm);
  line-height: 1.7;
}

.empty .btn {
  margin-top: var(--sp-2);
}

/* ---------- 页脚：说明折叠 + 互指路 ---------- */

.list-foot {
  margin-top: var(--sp-6);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--line);
}

/* `.fold` 的样式已搬到 ../style.css —— 「关于」页的「最近更新」也用它。 */

.foot-hint {
  margin: var(--sp-5) 0 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
  line-height: 1.7;
}
</style>
