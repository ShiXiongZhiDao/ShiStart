<script setup lang="ts">
/**
 * 同步分区。
 *
 * 既有约定 之后这一档只剩两处需要人动手的地方，界面也因此从 1388 行瘦到这个长度：
 * - **删除闸门**：一边删除、一边编辑，且两边互未见过对方 —— 唯一不自动择一的情况。
 * - **覆盖日志**：自动择一留的痕，可一键撤销。
 *
 * 其余（设备名册、请求数读数、自动处理开关、旧冲突列表）随旧模型一起退休：
 * 设备降级为隐藏写入令牌、每轮请求数塌缩到个位数、逐字段 LWW 没有"哪些能自动"这个问题。
 */
import { computed, onMounted, ref } from 'vue';
import {
  listDeleteGates,
  listOverrideLog,
  readSyncStatus,
  resetSyncSpace,
  resolveDeleteGate,
  runSync,
  setupSync,
  testConnection,
  undoOverride,
} from '../../../services/sync-engine';
import {
  clearSyncConfig,
  loadCredential,
  loadSyncConfig,
  normalizeRemotePath,
  saveCredential,
  saveSyncConfig,
  DEFAULT_REMOTE_PATH,
} from '../../../services/sync-config';
import { purgeSyncState } from '../../../services/sync-store';
import { listSyncEvents } from '../../../services/sync-events';
import { readRestorePointError } from '../../../services/restore-points';
import {
  loadSettingsSyncState,
  saveSettingsSyncState,
  type SettingsSyncState,
} from '../../../services/settings-sync';
import { normalizeBaseUrl } from '../../../lib/sync/remote-layout';
import { RESCHEDULE_MESSAGE } from '../../../lib/messages';
import { useI18n, type TranslateVars } from '../../../composables/useI18n';
import type { MessageKey } from '../../../lib/i18n/zh-CN';
import type { OverrideEntry } from '../../../lib/sync/state-merge';
import type { StoredOverride } from '../../../services/sync-store';
import {
  LOGICAL_ROOT_BAR,
  LOGICAL_ROOT_MOBILE,
  LOGICAL_ROOT_OTHER,
  type SyncConfig,
  type SyncEventRecord,
  type SyncStatus,
  type SyncTriggerReason,
} from '../../../types/sync-state';
import type { DeleteGateEntry } from '../../../lib/sync/state-merge';

const EMPTY_STATUS: SyncStatus = {
  phase: 'idle',
  lastSuccessAt: null,
  lastError: null,
  conflictCount: 0,
  skipped: 0,
  failed: 0,
  settingsError: null,
};

const { t, tRich, resolvedLocale } = useI18n();

const config = ref<SyncConfig | null>(null);
const password = ref('');
const status = ref<SyncStatus>(EMPTY_STATUS);

/** 删除闸门：唯一需要人工裁决的一档（既有约定 决策四）。 */
const gates = ref<DeleteGateEntry[]>([]);
/** 覆盖日志：自动择一留下的痕，每条都可撤销（修订后的 既有约定）。 */
const overrides = ref<StoredOverride[]>([]);
const showOverrides = ref(false);

/** 同步记录。展开时才读一次 —— options 与 background 是两个上下文，
 *  做不到实时推送（见 既有约定）。 */
const syncEvents = ref<SyncEventRecord[]>([]);
const showEvents = ref(false);

/**
 * 「保险断没断」—— 本机 meta 里记的上次写恢复点失败原因，**零网络**
 * （既有约定：恢复点的管理搬去了「快照」分区，这里只留状态 + 跳转；
 * 写失败的原因必须在**不离开同步区**时就看得见，否则等于把它埋进另一个分区）。
 */
const insuranceError = ref<string | null>(null);
/** 偏好同步的开关与基线状态。null = 还没读出来。 */
const prefSync = ref<SettingsSyncState | null>(null);

const busy = ref<'none' | 'test' | 'sync' | 'init'>('none');
const confirmPurge = ref(false);
const confirmReset = ref(false);
const resetBusy = ref(false);

/**
 * 提示语存的是**尚未翻译的形态**：key + 变量，而不是拼好的中文串。
 *
 * 原因很具体：用户在「外观」分区切到英文之后，回到同步分区时旧提示不该还留着中文 ——
 * 那会让人以为切换没生效。异常消息没有 key，那种情况下退化为整句原文。
 */
type NoticeEntry =
  | { tone: 'ok' | 'error'; key: MessageKey; vars?: TranslateVars }
  | { tone: 'ok' | 'error'; text: string };

const notice = ref<NoticeEntry | null>(null);

function setNotice(tone: 'ok' | 'error', key: MessageKey, vars?: TranslateVars): void {
  notice.value = { tone, key, vars };
}

/** 异常消息：没有 key 可用，只能整句原文显示。 */
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

onMounted(() => {
  void reload();
});

async function reload(): Promise<void> {
  config.value = await loadSyncConfig();
  const credential = await loadCredential();
  password.value = credential?.password ?? '';
  status.value = await readSyncStatus();
  gates.value = await listDeleteGates();
  overrides.value = await listOverrideLog();
  // 保险状态读**本机记录**，不打服务器 —— 与「快照」分区、主页红点同一个口。
  insuranceError.value = await readRestorePointError();
  prefSync.value = await loadSettingsSyncState();
}

async function handlePrefToggle(): Promise<void> {
  const next = !(prefSync.value?.enabled ?? true);
  // 关掉只是"不再收发"，已有的偏好基线留着 —— 再打开时接着上次的位置继续，
  // 不用重新认领一次。
  prefSync.value = await saveSettingsSyncState({ enabled: next });
}

/**
 * 偏好"最后一次是谁改的"那一行。
 *
 * 只说**本机 / 另一处安装**：写入令牌是数据层概念，术语表写死了它产品层不可见
 * （没有设备名册、没有标签）。用户真正要问的是"是我这台还是别台"，一个布尔就够，
 * 不值得为这一行把设备概念请回来。
 */
const prefLastLine = computed<string>(() => {
  const state = prefSync.value;
  if (state === null) return '';
  if (!state.enabled) return t('sync.pref.off');
  if (state.lastUpdatedAt === null) return t('sync.pref.last.none');
  return t(state.lastWriterIsLocal ? 'sync.pref.last.local' : 'sync.pref.last.remote', {
    time: formatTime(state.lastUpdatedAt),
  });
});

const configured = computed(() => {
  const value = config.value;
  return Boolean(value && value.baseUrl !== '' && value.spaceId !== '');
});

/**
 * 逻辑根的显示名。**必须走 `t()`** —— 这三项是用户看得见的标签，不是内部 id。
 */
const ROOT_KEY: Record<string, MessageKey> = {
  [LOGICAL_ROOT_BAR]: 'sync.root.bar',
  [LOGICAL_ROOT_OTHER]: 'sync.root.other',
  [LOGICAL_ROOT_MOBILE]: 'sync.root.mobile',
};

function logicalRootLabel(id: string): string {
  const key = ROOT_KEY[id];
  return key ? t(key) : id;
}

const rootOptions = computed(() =>
  [LOGICAL_ROOT_BAR, LOGICAL_ROOT_OTHER, LOGICAL_ROOT_MOBILE].map((id) => ({
    id,
    label: logicalRootLabel(id),
  })),
);

const INTERVAL_KEY: Record<number, MessageKey> = {
  15: 'sync.auto.interval.15',
  30: 'sync.auto.interval.30',
  60: 'sync.auto.interval.60',
  180: 'sync.auto.interval.180',
};

/**
 * 三张折叠卡片的摘要行。
 *
 * 折叠的是**明细**，不是信息：默认收起之后，用户不展开也得知道"现在什么状态"。
 * 偏好那一条尤其要紧 —— 既有约定 决策七要求不留下"不知道它传了什么"的状态，
 * 所以摘要行自己就把「会上传这 12 项」说出来。
 */
const scopeSummary = computed<string>(() => {
  const value = config.value;
  if (!value || value.enabledRoots.length === 0) return '';
  return t('sync.scope.summary', { names: value.enabledRoots.map(logicalRootLabel).join('、') });
});

const autoSummary = computed<string>(() => {
  const value = config.value;
  if (!value) return '';
  if (!value.autoSync) return t('sync.auto.summary.off');
  return t('sync.auto.summary.on', {
    interval: t(INTERVAL_KEY[value.intervalMinutes] ?? 'sync.auto.interval.30'),
  });
});

const prefSummary = computed<string>(() => {
  const state = prefSync.value;
  if (state === null) return '';
  if (!state.enabled) return t('sync.pref.summary.off');
  if (state.lastUpdatedAt === null) return t('sync.pref.summary.on');
  // 摘要行带一句"上次是谁改的"：折叠状态下这是最容易被问到的那个问题。
  const who = t(state.lastWriterIsLocal ? 'sync.pref.who.local' : 'sync.pref.who.remote');
  return `${t('sync.pref.summary.on')} · ${who}`;
});

function patchConfig(patch: Partial<SyncConfig>): void {
  if (!config.value) return;
  config.value = { ...config.value, ...patch };
}

function toggleRoot(id: string): void {
  if (!config.value) return;
  const next = config.value.enabledRoots.includes(id)
    ? config.value.enabledRoots.filter((item) => item !== id)
    : [...config.value.enabledRoots, id];
  patchConfig({ enabledRoots: next });
}

/**
 * 按用户填的服务器申请**最小来源**的主机权限。
 * 不申请 <all_urls>：扩展不该因为一个 WebDAV 地址就获得访问所有网站的资格。
 */
async function requestOrigin(): Promise<boolean> {
  const value = config.value;
  if (!value) return false;
  let normalized: string;
  try {
    normalized = normalizeBaseUrl(value.baseUrl);
  } catch (error) {
    setNoticeError(error);
    return false;
  }
  const origin = new URL(normalized).origin;
  if (typeof chrome === 'undefined' || !chrome.permissions) return true;
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (granted) return true;
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

async function persist(): Promise<boolean> {
  const value = config.value;
  if (!value) return false;
  // 远端子目录留空 = 用默认子目录。归一**在这里**做、并且回写到 config，
  // 而不是等下次读配置 —— 否则"清空后当场点测试连接"会拿服务器根目录去探一次，
  // 与保存后真正落点不一致。
  const next: SyncConfig = { ...value, remotePath: normalizeRemotePath(value.remotePath) };
  config.value = next;
  await saveSyncConfig(next);
  await saveCredential({ username: next.username, password: password.value });
  return true;
}

/**
 * 请后台按新配置重排定时 alarm。
 *
 * 不这么做的话，开关和间隔的改动要等下一次 worker 重启才生效，
 * 用户会觉得"点了没用"。后台没起来时消息会 reject，
 * 这里吞掉即可 —— 下次 worker 启动时的 `ensureAlarm()` 会兜住。
 */
async function rescheduleAlarm(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    await chrome.runtime.sendMessage({ type: RESCHEDULE_MESSAGE });
  } catch {
    // 后台不可达不是错误：配置已经落盘，alarm 会在下次唤醒时重建。
  }
}

async function handleTest(): Promise<void> {
  const value = config.value;
  if (!value) return;
  busy.value = 'test';
  notice.value = null;
  try {
    if (!(await requestOrigin())) {
      setNotice('error', 'sync.notice.permissionAborted');
      return;
    }
    await persist();
    const current = config.value ?? value;
    const result = await testConnection(current, {
      username: current.username,
      password: password.value,
    });
    setNotice(
      result.ok ? 'ok' : 'error',
      result.supportsConditionalWrite
        ? 'sync.notice.conditionalWrite'
        : 'sync.notice.noConditionalWrite',
      { message: result.message },
    );
  } catch (error) {
    setNoticeError(error);
  } finally {
    busy.value = 'none';
  }
}

/** 首次连接：探测 → 建空间（或加入）→ 首次同步。一个按钮走完，不再要求用户点两次。 */
async function handleSetup(): Promise<void> {
  const value = config.value;
  if (!value) return;
  busy.value = 'init';
  notice.value = null;
  try {
    if (!(await requestOrigin())) {
      setNotice('error', 'sync.notice.permission');
      return;
    }
    await persist();
    // 首次连接成功即默认打开自动同步。用户配完就该是"能用的状态"，
    // 不该再要求他理解并手动打开一个开关。老配置里存着 false 的话这里也一并纠过来。
    patchConfig({ autoSync: true });
    await persist();
    const current = config.value ?? value;
    const result = await setupSync(current, {
      username: current.username,
      password: password.value,
    });

    const head = result.joined ? t('sync.notice.joined') : t('sync.notice.created');
    const probeNote = result.probe.supportsConditionalWrite ? '' : t('sync.notice.probeNote');
    setNotice('ok', 'sync.notice.firstSync', {
      head,
      probeNote,
      pushed: result.sync.pushed,
      pulled: result.sync.pulled,
      applied: result.sync.applied,
    });
    await rescheduleAlarm();
    await reload();
    // 首次连接内部跑了一轮同步，记录里会多一条（见 refreshEvents 注释）。
    await refreshEvents();
  } catch (error) {
    setNoticeError(error);
  } finally {
    busy.value = 'none';
  }
}

async function handleSync(): Promise<void> {
  busy.value = 'sync';
  notice.value = null;
  try {
    if (!(await persist())) return;
    const result = await runSync('manual');
    setNotice('ok', 'sync.notice.syncDone', {
      pushed: result.pushed,
      pulled: result.pulled,
      applied: result.applied,
    });
  } catch (error) {
    setNoticeError(error);
  } finally {
    busy.value = 'none';
    await reload();
    // 刚刚这一轮自己写了一条记录、也可能新写了一版快照，立刻反映出来
    // （见 refreshEvents 的注释：不违反 既有约定，那说的是后台 worker 跑完的那种）。
    await refreshEvents();
  }
}

async function handleAutoSyncToggle(): Promise<void> {
  const value = config.value;
  if (!value) return;
  patchConfig({ autoSync: !value.autoSync });
  await persist();
  await rescheduleAlarm();
}

async function handleInterval(event: Event): Promise<void> {
  const minutes = Number((event.target as HTMLSelectElement).value);
  patchConfig({ intervalMinutes: minutes });
  await persist();
  await rescheduleAlarm();
}

/**
 * 闸门裁决：**生成新的写入并同步出去**，不能只改本地状态。
 *
 * 只改本地的话，另一台设备下一次合并还会按旧版本判出同一条闸门 —— 问题会一直复活。
 */
async function handleGate(syncId: string, action: 'keep' | 'delete'): Promise<void> {
  try {
    await resolveDeleteGate(syncId, action);
  } catch (error) {
    setNoticeError(error);
  }
  await reload();
}

/** 覆盖日志的撤销腿：把我的值作为一次普通改动推上去（走正常同步）。 */
async function handleUndoOverride(entry: OverrideEntry): Promise<void> {
  const field = entry.field;
  if (field === 'deleted' || field === 'purged') return;
  try {
    await undoOverride({ syncId: entry.syncId, field, myValue: entry.myValue });
    setNotice('ok', 'sync.notice.overrideUndone');
  } catch (error) {
    setNoticeError(error);
  }
  await reload();
}

const GATE_FIELD_KEY: Record<string, MessageKey> = {
  title: 'sync.gates.field.title',
  url: 'sync.gates.field.url',
  parentSyncId: 'sync.gates.field.parentSyncId',
  position: 'sync.gates.field.position',
  logicalRootId: 'sync.gates.field.logicalRootId',
};

const OVERRIDE_FIELD_KEY: Record<string, MessageKey> = {
  title: 'sync.overrides.field.title',
  url: 'sync.overrides.field.url',
  parentSyncId: 'sync.overrides.field.parentSyncId',
  position: 'sync.overrides.field.position',
  logicalRootId: 'sync.overrides.field.logicalRootId',
};

/**
 * 两张表把**内部字段名**映射成文案 key。
 *
 * 为什么不直接拼 `t(\`sync.gates.field.${field}\`)`：那样编译器就管不住了，
 * 拼错的 key 只会等到运行时才暴露成一串尴尬的原始 key。写成显式表，
 * `MessageKey` 约束仍然有效。
 */
function gateFieldLabel(field: string): string {
  const key: MessageKey | undefined = GATE_FIELD_KEY[field];
  return key === undefined ? field : t(key);
}

function overrideFieldLabel(field: string): string {
  const key: MessageKey | undefined = OVERRIDE_FIELD_KEY[field];
  return key === undefined ? field : t(key);
}

/** 值可能是布尔（deleted）或字符串，展示统一转字符串。空值给个占位符。 */
function displayValue(value: string | boolean | null): string {
  if (value === null) return '—';
  return typeof value === 'boolean' ? String(value) : value === '' ? '—' : value;
}

async function handleDisconnect(): Promise<void> {
  await clearSyncConfig();
  await reload();
  setNotice('ok', 'sync.notice.disconnected');
}

async function handlePurge(): Promise<void> {
  if (!confirmPurge.value) {
    confirmPurge.value = true;
    return;
  }
  confirmPurge.value = false;
  await purgeSyncState();
  await clearSyncConfig();
  await reload();
  setNotice('ok', 'sync.notice.purged');
}

async function handleReset(): Promise<void> {
  if (!confirmReset.value) {
    confirmReset.value = true;
    return;
  }
  confirmReset.value = false;

  if (!config.value) return;
  const credential = await loadCredential();
  if (!credential) {
    setNotice('error', 'sync.notice.noCredential');
    return;
  }

  resetBusy.value = true;
  try {
    const report = await resetSyncSpace(config.value, credential);
    await clearSyncConfig();
    await reload();
    // 重置顺带清空了本机记录，列表要跟着变空，否则还显示着重置前的条目。
    await refreshEvents();
    setNotice('ok', 'sync.notice.resetDone', {
      states: report.removedStates,
      history: report.removedHistory,
    });
  } catch (error) {
    setNoticeError(error);
  } finally {
    resetBusy.value = false;
  }
}

function formatTime(at: number | null): string {
  if (at === null) return t('common.never');
  return eventTime(at);
}

/** 展开/收起同步记录。展开时读一次。 */
async function toggleEvents(): Promise<void> {
  showEvents.value = !showEvents.value;
  if (showEvents.value) await refreshEvents();
}

/**
 * 重新读同步记录。
 *
 * 只在**本页自己触发的动作**之后调用（手动同步、首次连接、重置）——
 * 这些动作刚写了一条记录，不刷新的话列表会停在旧数据，用户得收起再展开
 * 才看得到，像是"同步完了却没记上"。
 *
 * 这不违反 既有约定 的"不做实时刷新"：那条说的是**后台 worker** 跑完的
 * 同步（定时/防抖）不会主动推给设置页 —— options 与 background 是两个上下文。
 * 那种情况仍然要收起再展开才看得到。
 */
async function refreshEvents(): Promise<void> {
  syncEvents.value = await listSyncEvents();
}

const TRIGGER_KEY: Record<SyncTriggerReason, MessageKey> = {
  manual: 'label.trigger.manual',
  interval: 'label.trigger.interval',
  debounced: 'label.trigger.debounced',
  setup: 'label.trigger.setup',
  'trash-expiry': 'label.trigger.trashExpiry',
};

function triggerLabel(record: SyncEventRecord): string {
  return t(TRIGGER_KEY[record.trigger]);
}

const KIND_KEY: Record<SyncEventRecord['kind'], MessageKey> = {
  push: 'label.event.push',
  pull: 'label.event.pull',
  skip: 'label.event.skip',
  error: 'label.event.error',
};

function kindLabelOf(record: SyncEventRecord): string {
  return t(KIND_KEY[record.kind]);
}

/** 列表用什么符号连接 —— 中文用顿号，英文用逗号加空格。 */
const listSeparator = computed(() => (resolvedLocale.value === 'zh-CN' ? '、' : ', '));

/**
 * 一条记录的摘要。
 *
 * 直接拼数字，不解析任何判别串 —— 存原始串再翻译是纯亏损（见 既有约定）。
 */
function eventSummary(record: SyncEventRecord): string {
  if (record.kind === 'error') return record.detail || t('label.event.failFallback');
  if (record.kind === 'skip') return record.detail || t('label.event.skipFallback');
  const parts: string[] = [];
  if (record.pushed > 0) parts.push(t('label.summary.pushed', { n: record.pushed }));
  if (record.pulled > 0) parts.push(t('label.summary.pulled', { n: record.pulled }));
  if (record.applied > 0) parts.push(t('label.summary.applied', { n: record.applied }));
  if (parts.length === 0) return t('label.summary.none');
  // 冲突那种需要行动的事项排在请求数前面 —— 后者只是读数。
  if (record.conflictCount > 0) {
    parts.push(t('label.summary.conflicts', { n: record.conflictCount }));
  }
  // 上一轮"没同步全"的两条同样是要行动的事项：时间线要能看出
  // 这一轮少同步了几条，否则它只活在状态卡片里，翻历史时看不见。
  if (record.skipped > 0) {
    parts.push(t('label.summary.skipped', { n: record.skipped }));
  }
  if (record.failed > 0) {
    parts.push(t('label.summary.failed', { n: record.failed }));
  }
  return parts.join(listSeparator.value);
}

function eventTime(at: number): string {
  return new Date(at).toLocaleString(resolvedLocale.value, { hour12: false });
}

const phaseLabel = computed(() => {
  switch (status.value.phase) {
    case 'conflict':
      return t('sync.phase.conflict');
    case 'auth-required':
      return t('sync.phase.auth');
    case 'error':
      return t('sync.phase.error');
    default:
      return configured.value ? t('sync.phase.ready') : t('sync.phase.unconfigured');
  }
});

const phaseTone = computed(() =>
  status.value.phase === 'idle' ? 'ok' : status.value.phase === 'conflict' ? 'warn' : 'error',
);

/**
 * 去「快照」分区。
 *
 * 就是改 hash —— 外壳监听 hashchange 接管切换（见 OptionsApp）。恢复点的列表、
 * 回退、删除都搬去了那个分区，同步区只留保险状态与这个跳转。
 */
function openSnapshots(): void {
  location.hash = 'snapshot';
}
</script>

<template>
  <div class="stack">
    <div class="section-head">
      <h2>{{ t('sync.title') }}</h2>
      <span class="phase" :data-tone="phaseTone">{{ phaseLabel }}</span>
    </div>

    <p v-if="noticeText !== null" class="notice" :data-tone="noticeTone">{{ noticeText }}</p>

    <section class="card">
      <h3>{{ t('sync.server.title') }}</h3>
      <p class="hint" v-html="tRich('sync.server.hint')"></p>

      <label class="field">
        <span class="field-label">{{ t('sync.server.baseUrl') }}</span>
        <input
          v-if="config"
          v-model="config.baseUrl"
          type="url"
          placeholder="https://dav.jianguoyun.com/dav/"
          spellcheck="false"
        />
      </label>

      <label class="field">
        <span class="field-label">{{ t('sync.server.username') }}</span>
        <input
          v-if="config"
          v-model="config.username"
          type="text"
          autocomplete="username"
          spellcheck="false"
        />
      </label>

      <label class="field">
        <span class="field-label">{{ t('sync.server.password') }}</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          :placeholder="t('sync.server.password.placeholder')"
        />
      </label>

      <!-- 地址 / 账号 / 密码是"每次配置都要填"的，留在首屏；远端子目录有默认值了，
           收进「更多设置」—— 配完就不用再碰的东西不该占着首屏。 -->
      <details class="fold">
        <summary>{{ t('sync.server.more') }}</summary>
        <label class="field">
          <span class="field-label">{{ t('sync.server.remotePath') }}</span>
          <input
            v-if="config"
            v-model="config.remotePath"
            type="text"
            :placeholder="t('sync.server.remotePath.placeholder', { path: DEFAULT_REMOTE_PATH })"
            spellcheck="false"
          />
        </label>
        <p class="hint">{{ t('sync.server.remotePath.hint') }}</p>
      </details>

      <p
        v-if="config?.spaceId"
        class="hint"
        v-html="tRich('sync.server.space', { id: config.spaceId.slice(0, 8) })"
      ></p>
    </section>

    <details class="card card-fold">
      <summary>
        <h3>{{ t('sync.scope.title') }}</h3>
        <span v-if="scopeSummary !== ''" class="fold-sum">{{ scopeSummary }}</span>
      </summary>
      <p class="hint">{{ t('sync.scope.hint') }}</p>
      <div class="checks">
        <label v-for="option in rootOptions" :key="option.id" class="check">
          <input
            type="checkbox"
            :checked="config?.enabledRoots.includes(option.id)"
            @change="toggleRoot(option.id)"
          />
          <span>{{ option.label }}</span>
        </label>
      </div>
    </details>

    <section class="card">
      <h3>{{ t('sync.connection.title') }}</h3>
      <div class="row">
        <button type="button" class="btn" :disabled="busy !== 'none'" @click="handleTest">
          {{ busy === 'test' ? t('sync.connection.testing') : t('sync.connection.test') }}
        </button>
        <button
          v-if="!configured"
          type="button"
          class="btn primary"
          :disabled="busy !== 'none'"
          @click="handleSetup"
        >
          {{ busy === 'init' ? t('sync.connection.settingUp') : t('sync.connection.setup') }}
        </button>
        <button
          v-else
          type="button"
          class="btn primary"
          :disabled="busy !== 'none'"
          @click="handleSync"
        >
          {{ busy === 'sync' ? t('sync.connection.syncing') : t('sync.connection.sync') }}
        </button>
      </div>
      <p class="hint" v-html="tRich('sync.connection.hint')"></p>
    </section>

    <details v-if="configured" class="card card-fold">
      <summary>
        <h3>{{ t('sync.auto.title') }}</h3>
        <span v-if="autoSummary !== ''" class="fold-sum">{{ autoSummary }}</span>
      </summary>
      <label class="check">
        <input
          type="checkbox"
          :checked="config?.autoSync === true"
          @change="handleAutoSyncToggle"
        />
        <span>{{ t('sync.auto.toggle') }}</span>
      </label>
      <p class="hint">{{ t('sync.auto.hint') }}</p>
      <label class="field">
        <span class="field-label">{{ t('sync.auto.interval') }}</span>
        <select :value="config?.intervalMinutes" @change="handleInterval">
          <option :value="15">{{ t('sync.auto.interval.15') }}</option>
          <option :value="30">{{ t('sync.auto.interval.30') }}</option>
          <option :value="60">{{ t('sync.auto.interval.60') }}</option>
          <option :value="180">{{ t('sync.auto.interval.180') }}</option>
        </select>
      </label>
    </details>

    <details v-if="configured" class="card card-fold">
      <summary>
        <h3>{{ t('sync.pref.title') }}</h3>
        <span v-if="prefSummary !== ''" class="fold-sum">{{ prefSummary }}</span>
      </summary>
      <label class="check">
        <input
          type="checkbox"
          :checked="prefSync?.enabled !== false"
          @change="handlePrefToggle"
        />
        <span>{{ t('sync.pref.toggle') }}</span>
      </label>
      <p class="hint">{{ t('sync.pref.hint') }}</p>
      <!-- 「明列上传哪些字段」是决策七的硬要求：不留下"不知道它传了什么"的状态。
           默认折叠之后这条靠摘要行（「会上传这 12 项」）+ 这一行共同承担。 -->
      <p class="hint pref-fields">
        <span class="field-label">{{ t('sync.pref.fields.label') }}</span>
        <span>{{ t('sync.pref.fields') }}</span>
      </p>
      <p v-if="status.settingsError" class="error-line">
        {{ t('sync.pref.error', { error: status.settingsError }) }}
      </p>
      <p v-else class="hint">{{ prefLastLine }}</p>
    </details>

    <section v-if="configured" class="card">
      <h3>{{ t('sync.status.title') }}</h3>

      <dl class="stats">
        <div>
          <dt>{{ t('sync.status.lastSuccess') }}</dt>
          <dd>{{ formatTime(status.lastSuccessAt) }}</dd>
        </div>
        <div>
          <dt>{{ t('sync.status.gates') }}</dt>
          <dd>{{ t('sync.status.conflictsValue', { n: status.conflictCount }) }}</dd>
        </div>
      </dl>

      <!-- 当前状态（上方数字）与历史（下方时间线）是两回事，刻意留在同一张卡片里：
           它们回答的是同一个问题的两半 —— "现在怎么样"和"刚才发生过什么"。 -->
      <p v-if="status.lastError" class="error-line">{{ status.lastError }}</p>

      <div class="events">
        <div class="events-head">
          <span class="events-title">{{ t('sync.events.title') }}</span>
          <button type="button" class="link-btn" @click="toggleEvents">
            {{ showEvents ? t('common.collapse') : t('common.expand') }}
          </button>
        </div>

        <!-- 收起时露一行最近记录：合并两张卡片的主要收益就是让用户不用展开
             也知道"上次同步怎么样了"。 -->
        <p v-if="!showEvents && syncEvents.length === 0" class="event-empty">
          {{ t('sync.events.empty') }}
        </p>
        <p v-else-if="!showEvents" class="event event-latest">
          <span class="event-time">{{ eventTime(syncEvents[0]!.at) }}</span>
          <span class="event-trigger">{{ triggerLabel(syncEvents[0]!) }}</span>
          <span class="event-kind" :data-tone="syncEvents[0]!.success ? 'ok' : 'error'">
            {{ kindLabelOf(syncEvents[0]!) }}
          </span>
          <span class="event-summary">{{ eventSummary(syncEvents[0]!) }}</span>
        </p>

        <template v-else>
          <ul class="event-list">
            <li v-if="syncEvents.length === 0" class="event-empty">{{ t('sync.events.empty') }}</li>
            <li v-for="record in syncEvents" :key="record.id" class="event">
              <span class="event-time">{{ eventTime(record.at) }}</span>
              <span class="event-trigger">{{ triggerLabel(record) }}</span>
              <span class="event-kind" :data-tone="record.success ? 'ok' : 'error'">
                {{ kindLabelOf(record) }}
              </span>
              <span class="event-summary">{{ eventSummary(record) }}</span>
            </li>
          </ul>
          <p class="hint events-note" v-html="tRich('sync.events.note')"></p>
        </template>
      </div>

      <!-- 保险一行：恢复点的列表 / 回退 / 删除搬去了「快照」分区，
           这里只留状态 + 跳转。写失败的原因必须留在同步区可见 —— 全摘走等于把
           "你以为有的保险其实没有"埋进另一个分区，正是这次要治的病。 -->
      <div class="events">
        <div class="events-head">
          <span class="events-title">{{ t('sync.insurance.label') }}</span>
          <button type="button" class="link-btn" @click="openSnapshots">
            {{ t('sync.insurance.open') }}
          </button>
        </div>
        <p v-if="insuranceError !== null" class="error-line">
          {{ t('sync.insurance.broken', { error: insuranceError }) }}
        </p>
        <p v-else-if="configured" class="event-empty">{{ t('sync.insurance.healthy') }}</p>
        <p v-else class="event-empty">{{ t('snapshot.status.unconfigured') }}</p>
      </div>
    </section>

    <!-- 删除闸门：既有约定 之后唯一需要人动手的一档。 -->
    <section v-if="gates.length > 0" class="card">
      <h3>{{ t('sync.gates.title') }}</h3>
      <p class="hint" v-html="tRich('sync.gates.hint')"></p>
      <ul class="conflict-list">
        <li v-for="gate in gates" :key="gate.syncId" class="conflict">
          <div class="conflict-head">
            <span class="conflict-field">{{ gate.title || '—' }}</span>
          </div>
          <ul class="candidates">
            <li v-for="edit in gate.edits" :key="edit.field">
              <code>{{ gateFieldLabel(edit.field) }}</code>
              <span class="candidate-from">{{ displayValue(edit.value) }}</span>
            </li>
          </ul>
          <div class="row">
            <button type="button" class="btn" @click="handleGate(gate.syncId, 'keep')">
              {{ t('sync.gates.keep') }}
            </button>
            <button type="button" class="btn" @click="handleGate(gate.syncId, 'delete')">
              {{ t('sync.gates.delete') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- 覆盖日志：自动择一的留痕，每条都能撤销。不拦路，但绝不无声。 -->
    <section v-if="configured" class="card">
      <h3>
        {{ t('sync.overrides.title') }}
        <button type="button" class="link-btn" @click="showOverrides = !showOverrides">
          {{ showOverrides ? t('common.collapse') : t('common.expand') }}
        </button>
      </h3>
      <p class="hint" v-html="tRich('sync.overrides.hint')"></p>
      <ul v-if="showOverrides" class="conflict-list">
        <li
          v-for="entry in overrides"
          :key="`${entry.syncId}:${entry.field}:${entry.at}`"
          class="conflict"
        >
          <div class="conflict-head">
            <span class="conflict-field">{{ overrideFieldLabel(entry.field) }}</span>
          </div>
          <ul class="candidates">
            <li>
              <code>{{ displayValue(entry.myValue) }}</code>
              <span class="candidate-from">{{ displayValue(entry.winnerValue) }}</span>
            </li>
          </ul>
          <div class="row">
            <button type="button" class="btn" @click="handleUndoOverride(entry)">
              {{ t('sync.overrides.undo') }}
            </button>
          </div>
        </li>
      </ul>
      <p v-else-if="overrides.length === 0" class="event-empty">
        {{ t('sync.overrides.empty') }}
      </p>
    </section>

    <section v-if="configured" class="card danger">
      <h3>{{ t('sync.danger.title') }}</h3>
      <div class="row">
        <button type="button" class="btn" @click="handleDisconnect">
          {{ t('sync.danger.disconnect') }}
        </button>
        <button type="button" class="btn danger-btn" @click="handlePurge">
          {{ confirmPurge ? t('sync.danger.purgeConfirm') : t('sync.danger.purge') }}
        </button>
        <button type="button" class="btn danger-btn" :disabled="resetBusy" @click="handleReset">
          {{
            resetBusy
              ? t('sync.danger.resetting')
              : confirmReset
                ? t('sync.danger.resetConfirm')
                : t('sync.danger.reset')
          }}
        </button>
      </div>
      <p class="hint">{{ t('sync.danger.hint') }}</p>
      <p class="hint" v-html="tRich('sync.danger.resetHint')"></p>
    </section>
  </div>
</template>

<style scoped>
/* 同步自己的样式：时间线、恢复点、闸门条目、 section-head。
   卡片 / 字段 / 按钮 / 链接按钮这些跨分区共用的，已经搬到 ../style.css（见 既有约定）。 */

/* ---------- 可折叠的卡片 ---------- */

/* 标题仍然是 `<h3>`：折叠不该把卡片降级成一行看不出是什么的摘要，
   而且 `.card h3` 也是别处（探针、脚本）认卡的方式。

   一行摆平「标题 · 状态 · 折叠标记」：`summary` 默认是 `list-item`，而它里面
   第一个孩子是块级 `h3` —— 直接用默认摆放，浏览器那个三角会**独占一行**顶在
   标题上方（真机截图抓到的）。所以关掉原生 marker、自己画一个 chevron。 */
.card-fold > summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--sp-4);
  row-gap: var(--sp-1);
  list-style: none;
  cursor: pointer;
}

.card-fold > summary::-webkit-details-marker {
  display: none;
}

.card-fold > summary > h3 {
  margin: 0;
}

/* 摘要行：折叠状态下唯一能看见的一行字，所以说的是"现在什么状态"，
   不是"这里有什么"。折叠的是明细，不是信息。 */
.card-fold .fold-sum {
  color: var(--text-3);
  font-size: var(--fs-sm);
}

/* 收起 ▾ / 展开 ▴：右下两条边框转 45° 就是一个 caret，不必引图标。 */
.card-fold > summary::after {
  content: '';
  align-self: center;
  width: 7px;
  height: 7px;
  margin-left: auto;
  border-right: 1.5px solid var(--text-3);
  border-bottom: 1.5px solid var(--text-3);
  transform: rotate(45deg);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.card-fold[open] > summary::after {
  transform: rotate(-135deg);
}

.card-fold[open] > summary {
  margin-bottom: var(--sp-4);
}

/* 「会上传这 12 项」那一行：标签独占一行，清单跟在下面 ——
   它是一份要被逐条读过的列表，不是一句顺带说明。 */
.pref-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.pref-fields .field-label {
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.phase {
  padding: var(--sp-1) var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  background: var(--surface-2);
  color: var(--text-2);
}

.phase[data-tone='ok'] {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.phase[data-tone='warn'],
.phase[data-tone='error'] {
  background: var(--danger-soft);
  color: var(--danger);
}

.conflict-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.conflict {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: var(--sp-5);
}

.conflict-head {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
  margin-bottom: var(--sp-3);
}

.conflict-field {
  font-weight: var(--fw-semibold);
}

.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 320px;
  overflow-y: auto;
}

/* 时间线是「同步」卡片的下半段，用上边框与上方的当前状态分开。 */
.events {
  margin-top: var(--sp-6);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--line);
}

.events-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.events-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-2);
}

.events-head .link-btn {
  margin-left: 0;
}

.events-note {
  margin: var(--sp-4) 0 0;
}

.event-latest {
  border-bottom: none;
  padding-top: 0;
}

.event-empty {
  color: var(--text-3);
  font-size: var(--fs-sm);
}

.event {
  display: grid;
  grid-template-columns: auto auto auto 1fr;
  align-items: baseline;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-sm);
}

.event:last-child {
  border-bottom: none;
}

.event-time {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.event-trigger {
  color: var(--text-2);
  white-space: nowrap;
}

.event-kind {
  font-weight: var(--fw-medium);
  color: var(--text-2);
  white-space: nowrap;
}

.event-kind[data-tone='ok'] {
  color: var(--accent);
}

.event-kind[data-tone='error'] {
  color: var(--danger);
}

.event-summary {
  color: var(--text-1);
  overflow-wrap: anywhere;
}
</style>
