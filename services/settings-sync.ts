/**
 * 偏好同步：把十一项界面偏好随同步空间带到别的浏览器。
 *
 * 为什么单独一个文件而不是塞进 `sync-engine.ts`：引擎已经 1100 行，而偏好的读写
 * 有它自己的三件事要管（偏好基线、`selectedFolderId` 的 syncId ↔ nativeId 换算、
 * 「本机没改过就不推」）。判据本身在 `lib/sync/settings-doc.ts`（纯函数、有单测），
 * 这里只负责把网络、存储与映射接起来。
 *
 * 两条纪律：
 * 1. **失败一律 throw，由引擎决定要不要阻断本轮**。偏好失败不该让书签同步陪葬，
 *    但也不该被静默吞掉（本仓不接受静默失败）。
 * 2. **写入本机一律走 `saveSettings`**。它写的是 `chrome.storage.local` 的
 *    `shistart.settings.v1`，而所有页面的 `useSettings` 都监听着那个键 ——
 *    落地即生效，不需要额外广播。
 */

import {
  WebDavError,
  type WebDavCredential,
  type WebDavPort,
} from '../lib/sync/webdav-port';
import type { RemoteLayout } from '../lib/sync/remote-layout';
import {
  diffSettingsAgainstBaseline,
  emptySettingsDoc,
  lastWriterOf,
  mergeSettingsDocs,
  parseSettingsDoc,
  serializeSettingsDoc,
  settingsDocToPatch,
  type SettingsDocument,
} from '../lib/sync/settings-doc';
import type { NativeMapping } from '../types/sync-state';
import type { ShiStartSettings, SyncedSettingKey } from '../types/settings';
import { loadSettings, saveSettings } from './settings-service';
import { readMappings } from './sync-store';

/** 偏好同步的本机状态（含偏好基线）。与偏好本体分开两个键，互不干扰。 */
export const SETTINGS_SYNC_KEY = 'shistart.settings.sync.v1';

export interface SettingsSyncState {
  /** 关掉之后既不拉也不推。默认开（既有约定 决策七）。 */
  enabled: boolean;
  /** 上次同步结束时偏好的样子 —— 「本机改过什么」全靠它判断。 */
  baseline: SettingsDocument | null;
  /** 本机已见到的偏好时钟。 */
  clock: number;
  lastError: string | null;
  /**
   * 最后一次更新偏好的是**本机**还是**另一处安装**。
   *
   * 为什么不存写入令牌本身显示给用户：术语表「写入令牌」条写死了它是数据层概念、
   * 产品层没有"设备"这个东西（没有名册、没有标签），用户永远看不到它。
   * 而用户真正想问的是"是我这台改的还是别台改的" —— 一个布尔正好回答这个问题，
   * 且不需要为此引入设备名册（那正是 既有约定 删掉的东西）。
   */
  lastWriterIsLocal: boolean | null;
  lastUpdatedAt: number | null;
}

const DEFAULT_SETTINGS_SYNC_STATE: SettingsSyncState = {
  enabled: true,
  baseline: null,
  clock: 0,
  lastError: null,
  lastWriterIsLocal: null,
  lastUpdatedAt: null,
};

export interface SettingsSyncContext {
  layout: RemoteLayout;
  port: WebDavPort;
  credential: WebDavCredential;
  writerId: string;
  spaceId: string;
}

export interface SettingsSyncOutcome {
  /** 落地到本机的字段数。 */
  applied: number;
  /** 推上去的字段数。 */
  pushed: number;
  /** 功能关着，本轮什么都没做。 */
  skipped: boolean;
}

// ---------------------------------------------------------------- 本机状态

function normalizeState(raw: unknown): SettingsSyncState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS_SYNC_STATE };
  const value = raw as Partial<Record<keyof SettingsSyncState, unknown>>;
  // 基线借 `parseSettingsDoc` 校验：远端与本机的形状是同一份，不该有两套校验。
  const baseline =
    value.baseline === null || value.baseline === undefined
      ? null
      : parseSettingsDoc(JSON.stringify(value.baseline));
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS_SYNC_STATE.enabled,
    baseline,
    clock: typeof value.clock === 'number' ? value.clock : 0,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    lastWriterIsLocal:
      typeof value.lastWriterIsLocal === 'boolean' ? value.lastWriterIsLocal : null,
    lastUpdatedAt: typeof value.lastUpdatedAt === 'number' ? value.lastUpdatedAt : null,
  };
}

export async function loadSettingsSyncState(): Promise<SettingsSyncState> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_SYNC_KEY);
    return normalizeState(stored?.[SETTINGS_SYNC_KEY]);
  } catch {
    // 读不到（无 storage 权限、私有模式异常）就当作"还没同步过"，不阻断。
    return { ...DEFAULT_SETTINGS_SYNC_STATE };
  }
}

export async function saveSettingsSyncState(
  patch: Partial<SettingsSyncState>,
): Promise<SettingsSyncState> {
  const next: SettingsSyncState = { ...(await loadSettingsSyncState()), ...patch };
  try {
    await chrome.storage.local.set({ [SETTINGS_SYNC_KEY]: next });
  } catch {
    // 旁路状态写不进去不影响本轮同步结果本身。
  }
  return next;
}

// ------------------------------------------------- selectedFolderId 的身份换算

/**
 * 本机原生 id → 云端身份。
 *
 * **nativeId 绝不上云**（GLOSSARY「nativeId」）：同一个文件夹在 Chrome 和 Edge 里
 * id 完全不同，同步过去要么指不到、要么撞上另一个文件夹。所以换 syncId。
 * `all` / `__root__` 是"全部""未归类"这两个**虚拟**分类，它们不是任何原生节点
 * 的 id，跨浏览器同义，原样走。查不到映射（那个文件夹不在同步范围内）退成 `all`。
 */
function toCloudFolderId(nativeId: string, mappings: readonly NativeMapping[]): string {
  if (nativeId === 'all' || nativeId === '__root__') return nativeId;
  return mappings.find((entry) => entry.nativeId === nativeId)?.syncId ?? 'all';
}

/**
 * 云端身份 → 本机原生 id。
 *
 * 映射不到（那个文件夹还没同步到本机，或已被删）**退回"全部"** ——
 * 这是正确行为不是失败：宁可打开时落在"全部"，也不能落在一个同名不同物的文件夹里。
 * 本机是否存在由 `resolveSelectedFolder` 再兜一道。
 */
function fromCloudFolderId(cloud: string, mappings: readonly NativeMapping[]): string {
  if (cloud === 'all' || cloud === '__root__') return cloud;
  return mappings.find((entry) => entry.syncId === cloud)?.nativeId ?? 'all';
}

/**
 * 把本机偏好转成"云端视角"：只有 `selectedFolderId` 需要换身份，其余原样。
 *
 * **比较必须与基线在同一个视角上做**，否则本机存 nativeId、基线存 syncId，
 * 每轮都会被判成"改过了"，然后每轮都往上传一次（真正的静默风暴）。
 */
function toCloudView(
  settings: ShiStartSettings,
  mappings: readonly NativeMapping[],
): ShiStartSettings {
  return {
    ...settings,
    selectedFolderId: toCloudFolderId(settings.selectedFolderId, mappings),
  };
}

// ------------------------------------------------------------------ 拉取落地

async function fetchRemoteDoc(ctx: SettingsSyncContext): Promise<SettingsDocument> {
  let raw: string;
  try {
    raw = await ctx.port.get(ctx.layout.settingsFileUrl, ctx.credential);
  } catch (error) {
    // 404 = 这个空间还没有偏好文档（首次）。不是错误，按空文档处理。
    if (error instanceof WebDavError && error.kind === 'not-found') {
      return emptySettingsDoc(ctx.spaceId, ctx.writerId);
    }
    throw error;
  }
  const parsed = parseSettingsDoc(raw);
  // format/version 对不上 ⇒ 未来形状读不懂。宁可本轮不落地，也不能读出半个真值。
  if (parsed === null) throw new Error('云上的偏好文件读不懂，已跳过偏好同步。');
  return parsed;
}

/**
 * 一轮同步的前半段：拉远端 → 与本机改动合并 → 落地 → 更新偏好基线。
 *
 * 本机改动是**先算出来**再参与合并的：不然"远端更新"会盖掉用户这一轮刚改的东西，
 * 而那个改动在下一轮又会被算成新的改动重新推上去 —— 来回抖。
 */
export async function pullSettings(ctx: SettingsSyncContext): Promise<SettingsSyncOutcome> {
  const state = await loadSettingsSyncState();
  if (!state.enabled) return { applied: 0, pushed: 0, skipped: true };

  const remote = await fetchRemoteDoc(ctx);
  const mappings = await readMappings();
  const current = await loadSettings();
  const cloudCurrent = toCloudView(current, mappings);

  const mine = diffSettingsAgainstBaseline({
    current: cloudCurrent,
    baseline: state.baseline,
    spaceId: ctx.spaceId,
    writerId: ctx.writerId,
    clock: state.clock,
  });
  const merged = mergeSettingsDocs([remote, mine.doc], ctx.writerId);

  // 落地：只把"云端视角"里赢出来的字段写回本机，selectedFolderId 换回本机 id。
  const applied = await applyCloudPatch(merged, current, mappings);

  const writer = lastWriterOf(remote);
  // ⚠️ **基线记的是 `remote`，不是 `merged`**。
  //
  // 记 merged 的话，"本机这一轮刚改的东西"会被算进基线，随后 push 阶段一比对
  // 发现"和基线一样" ⇒ 判定没有改动 ⇒ **永远不往上传**（端到端测试第一轮就是这么红的）。
  //
  // 记 remote 才是对的：基线的语义是"上次同步时**云上**有什么"，落地之后本机值
  // 与它之间的差，恰好就是"本机独有的、还没上传的改动" —— push 照着这个差去推。
  // push 成功之后基线才被换成已上传的 merged，下一轮自然不再重复推。
  await saveSettingsSyncState({
    baseline: remote,
    clock: merged.clock,
    lastError: null,
    // 文档作者是谁由 lastWriterOf 算，但只把它翻译成"本机/另一处"这一个布尔 ——
    // 用户看得懂的是这个，不是那串令牌。
    lastWriterIsLocal: writer === null ? null : writer.writerId === ctx.writerId,
    lastUpdatedAt: writer === null ? null : merged.writtenAt,
  });

  return { applied, pushed: 0, skipped: false };
}

/** 把合并结果里"与本机当前不同"的字段写进本机存储，返回写了几个。 */
async function applyCloudPatch(
  merged: SettingsDocument,
  current: ShiStartSettings,
  mappings: readonly NativeMapping[],
): Promise<number> {
  const patch = settingsDocToPatch(merged);
  if (patch.selectedFolderId !== undefined) {
    patch.selectedFolderId = fromCloudFolderId(patch.selectedFolderId, mappings);
  }
  const changed = (Object.keys(patch) as SyncedSettingKey[]).filter(
    (key) => patch[key] !== current[key],
  );
  if (changed.length === 0) return 0;
  const next: ShiStartSettings = { ...current };
  for (const key of changed) {
    // 逐字段赋而不是展开 patch：patch 是 Partial，展开会让 TS 放宽成可选类型。
    Object.assign(next, { [key]: patch[key] });
  }
  await saveSettings(next);
  return changed.length;
}

// ------------------------------------------------------------------ 上传

/**
 * 一轮同步的后半段：本机改过的字段 → 并进空间文档 → PUT。
 *
 * **没有改动就不发这个请求**。远端内容与基线一致时再 PUT 一次是纯粹的多余往返
 * （偏好同步给每轮加的请求数已经按"两次"算过预算了）。
 */
export async function pushSettings(ctx: SettingsSyncContext): Promise<SettingsSyncOutcome> {
  const state = await loadSettingsSyncState();
  if (!state.enabled) return { applied: 0, pushed: 0, skipped: true };

  const mappings = await readMappings();
  const current = await loadSettings();
  const cloudCurrent = toCloudView(current, mappings);

  const { doc, changed } = diffSettingsAgainstBaseline({
    current: cloudCurrent,
    baseline: state.baseline,
    spaceId: ctx.spaceId,
    writerId: ctx.writerId,
    clock: state.clock,
  });
  if (changed.length === 0) return { applied: 0, pushed: 0, skipped: false };

  const merged = mergeSettingsDocs(
    [state.baseline ?? emptySettingsDoc(ctx.spaceId, ctx.writerId), doc],
    ctx.writerId,
  );
  await ctx.port.put(ctx.layout.settingsFileUrl, serializeSettingsDoc(merged), ctx.credential);

  await saveSettingsSyncState({
    baseline: merged,
    clock: merged.clock,
    lastError: null,
    lastWriterIsLocal: true,
    lastUpdatedAt: merged.writtenAt,
  });

  return { applied: 0, pushed: changed.length, skipped: false };
}

/** 偏好同步上一轮的失败原因（设置页那一行）。 */
export async function describeSettingsSyncError(): Promise<string | null> {
  return (await loadSettingsSyncState()).lastError;
}
