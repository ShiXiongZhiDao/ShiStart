/**
 * 同步引擎：全量状态快照 + 逐字段 LWW。
 *
 * 一轮同步的顺序：
 *   1. 取租约（同一个安装实例内串行）
 *   2. ensureSpace：space.json 在不在（不在就建）；远端 spaceId 说了算
 *   3. 拉取：列 states/ 目录 → 逐份 GET 其他写入方的状态文档（404 = 过期文件，跳过；
 *      解析失败 = remote-corrupt，停下——远端是不可信输入）
 *   4. 本地对账：原生书签树 vs 基线文档 → 本机这轮的写入（盖本机时钟）
 *      —— 没有基线时（全新安装/重置后）先把远端合并结果采纳成基线，再对账
 *   5. 合并：本机文档 + 远端文档 → 全量目标 + 删除闸门 + 覆盖日志
 *   6. 应用：目标 vs 原生树 → 有序写入（先建后改再移最后删；崩溃后重算即续）
 *   7. 落盘：基线文档、映射、闸门、覆盖日志、meta
 *   8. 上传：整份目标文档 PUT 到 states/{writerId}.json（原子的，没有半份）
 *   9. 收尾：内容没变就不写第二份恢复点；记一条同步记录
 *
 * 任何一步失败都不清空任何东西：本地基线没写就不会被应用半截的状态污染，
 * 下一轮从未完成的步骤继续。
 */

import { nodesFingerprint, parseStateDoc, serializeStateDoc } from '../lib/sync/state-doc';
import { SYNC_DONE_MESSAGE } from '../lib/messages';
import { computeLocalDiff } from '../lib/sync/local-diff';
import { mergeStateDocs } from '../lib/sync/state-merge';
import { clampMoveIndex, planApply, type ApplyStep } from '../lib/sync/state-apply';
import { decideSpaceIdentity, remoteSpaceIdOf } from '../lib/sync/space-identity';
import {
  WebDavError,
  type WebDavAdminPort,
  type WebDavCredential,
  type WebDavPort,
} from '../lib/sync/webdav-port';
import {
  createRemoteLayout,
  fingerprintFromFileName,
  writerIdFromFileName,
  type RemoteLayout,
} from '../lib/sync/remote-layout';
import {
  SYNC_STATE_FORMAT,
  SYNC_STATE_VERSION,
  type StateDocument,
  type SyncConfig,
  type SyncEventRecord,
  type SyncStatus,
  type SyncTriggerReason,
} from '../types/sync-state';
import {
  createNativeBookmark,
  createNativeFolder,
  moveNativeNode,
  readNativeChildrenCount,
  readSyncTree,
  removeNativeTree,
  updateNativeNode,
} from './bookmark-sync-adapter';
import { isConfigured, loadCredential, loadSyncConfig, saveSyncConfig } from './sync-config';
import {
  acquireLease,
  appendOverrides,
  putMappings,
  purgeSyncState,
  readBaselineDoc,
  readGates,
  readMeta,
  readMappings,
  readOverrides,
  releaseLease,
  removeMappings,
  replaceGates,
  writeBaselineDoc,
  writeMeta,
} from './sync-store';
import { appendSyncEvent, clearSyncEvents, type SyncEventInput } from './sync-events';
import {
  captureRestorePointCore,
  fetchRestorePointCore,
  listRestorePointCores,
  pruneRestorePointsCore,
  removeStaleStateCores,
} from './restore-points';
import { createWebDavPort } from './webdav-http';
import {
  loadSettingsSyncState,
  pullSettings,
  pushSettings,
  saveSettingsSyncState,
  type SettingsSyncContext,
  type SettingsSyncOutcome,
} from './settings-sync';

export class SyncError extends Error {
  constructor(
    readonly kind:
      | 'not-configured'
      | 'no-credential'
      | 'busy'
      | 'auth'
      | 'network'
      | 'remote-corrupt'
      | 'apply-failed'
      | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface RunSyncResult {
  pushed: number;
  pulled: number;
  applied: number;
  conflictCount: number;
  /**
   * 本机**没往同步空间里放的**条数：地址过长（既有约定 的唯一护栏）。
   *
   * 以前这个数只活在内部返回值里、界面上从不显示 —— 用户不知道有书签没同步。
   * 现在一路报到状态里。
   */
  skipped: number;
  /** 远端要来、但**本机浏览器写不进去**的条数（Chrome 自己的校验拒收）。 */
  failed: number;
  lastError: string | null;
}

interface Context {
  config: SyncConfig;
  credential: WebDavCredential;
  layout: RemoteLayout;
  port: WebDavPort & WebDavAdminPort;
  writerId: string;
  owner: string;
}

function newWriterId(): string {
  // 隐藏写入令牌：随机 UUID，产品层不可见（既有约定 决策五）。
  return crypto.randomUUID();
}

/**
 * 通知打开着的页面"同步跑完了，该刷新了"。
 *
 * **为什么由引擎自己发，而不是各调用点各发一次**：回收站读的是本机同步状态
 * （墓碑、基线），而同步可能跑在**别的上下文**里（后台 alarm、设置页「立即同步」、
 * 一键连接、一键回退），页面不知道它什么时候结束。以前这条广播散在各调用点的
 * `finally` 里 —— 于是设置页那句 `runSync('manual')` 就漏了：手动同步之后主页的
 * 回收站永远不更新。散着放 = 谁新增调用点谁就可能再漏一次，所以收进 `runSync`。
 *
 * 单向广播：**没有接收方时 `sendMessage` 会 reject**，那不是错误（没有页面开着
 * 是正常情况），必须吞掉 —— 否则同步会因为"没人听"而失败。
 */
function broadcastSyncDone(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    void Promise.resolve(chrome.runtime.sendMessage({ type: SYNC_DONE_MESSAGE })).catch(() => {
      // 没有接收方：正常情况，不是错误。
    });
  } catch {
    // 同上。广播失败不影响同步本身。
  }
}

// ------------------------------------------------------------------ 入口

export async function runSync(
  reason: SyncTriggerReason,
  options: { detail?: string } = {},
): Promise<RunSyncResult> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) {
    // 不记事件：这不是"同步失败"，而是还没配。记了日志会被"未配置"塞满。
    throw new SyncError('not-configured', '还没有配置 WebDAV 同步。');
  }
  const credential = await loadCredential();
  if (!credential) {
    await recordEvent({
      kind: 'error',
      trigger: reason,
      success: false,
      detail: '缺少 WebDAV 凭据，请重新填写密码。',
    });
    throw new SyncError('no-credential', '缺少 WebDAV 凭据，请重新填写密码。');
  }

  const owner = `${reason}-${newWriterId().slice(0, 8)}`;
  const acquired = await acquireLease(owner);
  if (!acquired) {
    // 记 skip 而非 error：这是**正常并发**（定时同步撞上手动点击），不是故障。
    await recordEvent({
      kind: 'skip',
      trigger: reason,
      success: true,
      detail: '已有一次同步在进行中，这一轮跳过。',
    });
    throw new SyncError('busy', '已有一次同步在进行中。');
  }

  try {
    const meta = await readMeta();
    const writerId = meta.writerId || newWriterId();
    if (writerId !== meta.writerId) await writeMeta({ writerId });

    const ctx: Context = {
      config,
      credential,
      layout: createRemoteLayout(config.baseUrl, config.remotePath),
      port: createWebDavPort(),
      writerId,
      owner,
    };

    await ensureSpace(ctx);

    // ---- 偏好前半段：拉下来、与本机改动合并、落地 ----
    await runSettingsPhase(ctx, pullSettings);

    // ---- 拉取其他写入方的文档 ----
    const remotes = await pullRemoteDocs(ctx);

    // ---- 本地对账（没有基线时先采纳远端） ----
    let baseline = await readBaselineDoc();
    if (baseline === null) {
      // 全新安装/重置后：把远端合并结果采纳成基线，再对账。这样原生树里
      // 与远端内容对得上的节点会**认领**回原来的 syncId，
      // 绝不会因为"没映射"就把整棵树当新书签重传一遍。
      const adopted = mergeStateDocs({
        mine: emptyDoc(config.spaceId, writerId),
        remotes,
        now: Date.now(),
      });
      baseline = {
        format: SYNC_STATE_FORMAT,
        version: SYNC_STATE_VERSION,
        spaceId: config.spaceId,
        writerId,
        clock: adopted.clock,
        writtenAt: Date.now(),
        nodes: adopted.nodes,
      };
      await writeBaselineDoc(baseline);
    }
    if (baseline.spaceId !== config.spaceId) {
      baseline = { ...baseline, spaceId: config.spaceId };
    }

    const tree = await readSyncTree(config.enabledRoots);
    const mappings = await readMappings();
    const local = computeLocalDiff({
      nodes: tree.nodes,
      mappings,
      baseline,
      enabledRoots: config.enabledRoots,
      now: Date.now(),
    });

    // ---- 合并 ----
    const merged = mergeStateDocs({
      mine: {
        format: SYNC_STATE_FORMAT,
        version: SYNC_STATE_VERSION,
        spaceId: config.spaceId,
        writerId,
        clock: baseline.clock,
        writtenAt: Date.now(),
        nodes: local.nodes,
      },
      remotes,
      now: Date.now(),
    });

    // ---- 应用 ----
    const mappingBySync = new Map(mappings.map((entry) => [entry.syncId, entry]));
    for (const entry of local.mappings) mappingBySync.set(entry.syncId, entry);
    const plan = planApply({
      target: merged.nodes,
      nodes: tree.nodes,
      mappings: [...mappingBySync.values()],
      rootIds: tree.rootIds,
      enabledRoots: config.enabledRoots,
    });
    const applied = await applySteps(plan.steps);

    // ---- 落盘 ----
    const target: StateDocument = {
      format: SYNC_STATE_FORMAT,
      version: SYNC_STATE_VERSION,
      spaceId: config.spaceId,
      writerId,
      clock: merged.clock,
      writtenAt: Date.now(),
      nodes: merged.nodes,
    };
    await writeBaselineDoc(target);
    await putMappings(local.mappings);
    const staleNativeIds = [...new Set([...plan.staleNativeIds, ...local.staleNativeIds])];
    if (staleNativeIds.length > 0) await removeMappings(staleNativeIds);
    await replaceGates(merged.gates);
    await appendOverrides(merged.overrides, Date.now());
    await writeMeta({
      clock: merged.clock,
      lastSyncAt: Date.now(),
      lastError: null,
      // 两个计数也落盘：状态点与设置页要在**下一轮之前**说得出"上次有几条没同步完"。
      lastSkipped: tree.skipped,
      lastFailed: applied.failures.length,
    });

    // ---- 上传（原子的整份文档） ----
    await ctx.port.put(ctx.layout.stateUrl(writerId), serializeStateDoc(target), ctx.credential);

    // ---- 偏好后半段：本机改过的字段推上去 ----
    await runSettingsPhase(ctx, pushSettings);

    // ---- 收尾：恢复点（内容没变就跳过） ----
    await captureRestorePointQuietly(ctx, target.nodes);

    const result: RunSyncResult = {
      pushed: local.changed.length,
      pulled: remotes.length,
      applied: applied.count,
      conflictCount: merged.gates.length,
      // 读侧：地址过长没进同步空间的条数（`readSyncTree` 一直在数，只是从没上报过）。
      skipped: tree.skipped,
      // 写侧：远端要来、但本机浏览器拒收的条数。
      failed: applied.failures.length,
      lastError: null,
    };
    const failureNote =
      applied.failures.length > 0
        ? `有 ${applied.failures.length} 条没能写入本机浏览器（例如：${applied.failures[0]?.reason ?? ''}）`
        : '';
    await recordEvent({
      kind: result.pushed > 0 ? 'push' : 'pull',
      trigger: reason,
      success: true,
      pushed: result.pushed,
      pulled: result.pulled,
      applied: result.applied,
      conflictCount: result.conflictCount,
      skipped: result.skipped,
      failed: result.failed,
      ...(options.detail || failureNote
        ? { detail: [options.detail, failureNote].filter(Boolean).join('；') }
        : {}),
    });
    return result;
  } catch (error) {
    const message = describeError(error);
    await writeMeta({ lastError: message });
    await recordEvent({ kind: 'error', trigger: reason, success: false, detail: message });
    throw error;
  } finally {
    await releaseLease(owner);
    // 成功失败都广播（失败了页面也该刷新，好把状态点变红给用户看）。
    // 放在释放租约**之后**：页面收到通知可能立刻又发起一轮同步，那时租约必须已经放开。
    broadcastSyncDone();
  }
}

/**
 * 跑偏好的一个半段（拉或推，既有约定）。
 *
 * **失败不阻断本轮书签同步**：偏好没同步上，书签仍然是同步好的 —— 为了偏好把整轮
 * 判失败，是把轻决策当重决策处理。
 *
 * **但也不许静默**：原因写进偏好同步状态，同步分区单独一行说出来。
 * 本仓不接受"失败了而界面上什么都看不出来"，这条对偏好一样成立。
 */
async function runSettingsPhase(
  ctx: Context,
  phase: (input: SettingsSyncContext) => Promise<SettingsSyncOutcome>,
): Promise<void> {
  const input: SettingsSyncContext = {
    layout: ctx.layout,
    port: ctx.port,
    credential: ctx.credential,
    writerId: ctx.writerId,
    spaceId: ctx.config.spaceId,
  };
  try {
    await phase(input);
  } catch (error) {
    await saveSettingsSyncState({ lastError: describeError(error) });
  }
}

function emptyDoc(spaceId: string, writerId: string): StateDocument {
  return {
    format: SYNC_STATE_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId,
    writerId,
    clock: 0,
    writtenAt: Date.now(),
    nodes: {},
  };
}

async function recordEvent(input: SyncEventInput): Promise<void> {
  try {
    await appendSyncEvent(input);
  } catch {
    // 旁路观测数据，写不进去不该让一次真实的同步失败。
  }
}

export function describeError(error: unknown): string {
  if (error instanceof SyncError) return error.message;
  if (error instanceof WebDavError) {
    if (error.kind === 'credentials') return 'WebDAV 用户名或密码不正确，请检查后重试。';
    if (error.kind === 'forbidden') return 'WebDAV 服务器拒绝了访问，请检查目录权限。';
    if (error.kind === 'network') return '连不上 WebDAV 服务器，请检查网络后重试。';
    if (error.kind === 'not-found') return '远端同步目录不存在。';
    if (error.kind === 'unsupported-method') return '这台 WebDAV 服务器不支持所需的请求方法。';
    if (error.kind === 'throttled') {
      return '服务器限流了（坚果云免费版每 30 分钟 600 次请求）。本次改动都还留在本机，请等约半小时再同步。';
    }
    if (error.kind === 'server') {
      return 'WebDAV 服务器暂时不可用（可能是请求太密被限流）。请稍等一会儿再试，改动都还留在本机。';
    }
    return `WebDAV 请求失败：${error.kind}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ 空间

/**
 * 确保 space.json 存在，并处理空间身份（既有约定：远端说了算）。
 *
 * space.json 不在 ⇒ 目录极可能也没了，重新确认并重建，然后写一份新的。
 */
async function ensureSpace(ctx: Context): Promise<void> {
  const { layout, port, credential, config } = ctx;

  let raw: string;
  try {
    raw = await port.get(layout.spaceFileUrl, credential);
  } catch (error) {
    if (error instanceof WebDavError && error.kind === 'not-found') {
      await port.ensureCollection(layout.spaceUrl, credential);
      await port.put(
        layout.spaceFileUrl,
        JSON.stringify({
          protocolVersion: SYNC_STATE_VERSION,
          spaceId: config.spaceId,
          createdAt: Date.now(),
          layoutVersion: 3,
        }),
        credential,
      );
      return;
    }
    throw error;
  }

  const decision = decideSpaceIdentity(config.spaceId, remoteSpaceIdOf(parseJson(raw)));
  if (decision.kind === 'adopt') {
    // 只改 spaceId 一个字段。本地的映射与基线是按 syncId 存的、与 spaceId 无关，
    // 所以**不能**顺手清掉它们（既有约定 同源：清了就等于每次同步都把整棵树当新书签重来）。
    const next: SyncConfig = { ...config, spaceId: decision.spaceId };
    await saveSyncConfig(next);
    ctx.config = next;
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 拉取

/** 列出并下载所有其他写入方的状态文档。自己的那份跳过（本地基线就是它）。 */
async function pullRemoteDocs(ctx: Context): Promise<StateDocument[]> {
  const { layout, port, credential, writerId } = ctx;

  let entries;
  try {
    entries = await port.propfind(layout.statesUrl, credential, 1);
  } catch (error) {
    // states/ 目录不在（空间刚建 / 被外部清过）：当作"没有别的写入方"。
    if (error instanceof WebDavError && error.kind === 'not-found') return [];
    throw error;
  }

  const out: StateDocument[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const fileName = fileNameOf(entry.url);
    const id = writerIdFromFileName(fileName);
    // 认不出文件名的条目一律忽略（可能是别的客户端留下的垃圾）。
    if (id === null || id === writerId) continue;

    let raw: string;
    try {
      raw = await port.get(entry.url, credential);
    } catch (error) {
      // 404 = 这份文档在列出之后被删了（并发 GC）——跳过，不是错误。
      if (error instanceof WebDavError && error.kind === 'not-found') continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SyncError('remote-corrupt', `远端状态文档 ${fileName} 不是合法的 JSON。`);
    }
    const doc = parseStateDoc(parsed);
    if (doc.spaceId !== ctx.config.spaceId) {
      throw new SyncError(
        'remote-corrupt',
        `远端状态文档 ${fileName} 属于另一个同步空间，这个目录可能被别的设备混用了。`,
      );
    }
    out.push(doc);
  }
  return out;
}

function fileNameOf(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const segments = withoutQuery.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] ?? '';
}

// ------------------------------------------------------------------ 应用

/**
 * 执行应用计划。**不设应用日志**：目标状态是确定的全量文档、diff 幂等，
 * worker 中途被杀后下一轮重算自然续上（既有约定 决策一）。
 *
 * ⚠️ 单条失败**不中断**整轮（既有约定 决策二）：只记下来，最后报到结果里。
 */
interface ApplyFailure {
  stepId: string;
  action: string;
  reason: string;
}

async function applySteps(
  steps: readonly ApplyStep[],
): Promise<{ count: number; failures: ApplyFailure[] }> {
  /** 本次新建出来的 syncId → 原生 id（计划阶段父节点还没建出来，用的是占位符）。 */
  const createdBySync = new Map<string, string>();
  const resolveParent = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (!value.startsWith('pending-sync:')) return value;
    return createdBySync.get(value.slice('pending-sync:'.length));
  };

  let count = 0;
  /** 写不进去的步骤：记下来继续跑，最后报到结果里。 */
  const failures: ApplyFailure[] = [];
  for (const step of steps) {
    const parentNativeId = resolveParent(step.parentNativeId);
    try {
      if (step.action === 'create-folder' || step.action === 'create-bookmark') {
        // 父节点解析不出来，说明创建计划本身就立不住（祖先链断了）。
        // **不能静默跳过**——跳过后同步对外报成功，但书签少了一批。
        if (!parentNativeId) {
          throw new Error(`步骤 ${step.stepId} 的父节点无法解析（父链可能不完整）。`);
        }
        // 新建必须**插到目标下标**，不能一律追加到末尾 —— 否则同层新建兄弟的最终顺序
        // 就是创建顺序（文件夹在前、书签在后），"文件夹夹着书签"的层永远复现不出来。
        // 上界取**子节点数**（create 允许追加到末尾，与 move 不同，不需要减一）；
        // 越界会让 create 直接抛错，而那会按 既有约定 的教训把整次同步判死 ——
        // 宁可落错一位，下一轮同步会用准确位置纠正。
        const index =
          step.index === undefined
            ? undefined
            : Math.min(Math.max(0, step.index), await readNativeChildrenCount(parentNativeId));
        const nativeId =
          step.action === 'create-folder'
            ? await createNativeFolder(parentNativeId, step.title ?? '', index)
            : await createNativeBookmark(parentNativeId, step.title ?? '', step.url ?? '', index);
        if (nativeId) createdBySync.set(step.syncId, nativeId);
      } else if (step.action === 'update' && step.nativeId) {
        const patch: { title?: string; url?: string } = {};
        if (step.title !== undefined) patch.title = step.title;
        if (step.url !== undefined) patch.url = step.url;
        await updateNativeNode(step.nativeId, patch);
      } else if (step.action === 'move' && step.nativeId && parentNativeId) {
        // 计划里的 index 是"目标顺序里的第几位"，执行时父节点下实际有几个子节点
        // 完全可能不同。必须按真实子节点数收敛（既有约定 的 Index out of bounds）。
        const siblings = await readNativeChildrenCount(parentNativeId);
        await moveNativeNode(step.nativeId, parentNativeId, clampMoveIndex(step.index ?? 0, siblings));
      } else if (step.action === 'delete' && step.nativeId) {
        await removeNativeTree(step.nativeId);
      }
      count += 1;
    } catch (error) {
      // 单条写不进去**不再拖垮整轮**（既有约定 决策二）。
      //
      // 以前这里 `throw SyncError('apply-failed')` ⇒ **本轮后面所有书签都不应用**：
      // 只要远端有一条本机 Chrome 拒收的地址（超长 `data:`、或它那边校验更严），
      // 其余书签全跟着同步不了 —— "一条坏的拖垮全部"比"某一条没同步"严重得多。
      //
      // 代价如实记：那一台设备上会永远缺这几条，且每轮同步都会重试、每轮都会再报一次
      // （自我纠正的循环）—— 这是它诚实的形状，不是 bug。失败原因进 detail，界面显示条数。
      failures.push({
        stepId: step.stepId,
        action: step.action,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { count, failures };
}

// ------------------------------------------------------------------ 恢复点收尾

/**
 * 提交之后写一份恢复点。失败的处理是这条链路里最需要拿准的一点：
 * - **绝不让同步失败。** 书签确实已经同步好了；把它报成失败，用户会反复重试。
 * - **但也绝不静默。** 原因写进 meta，设置页把它显示成红字。
 */
async function captureRestorePointQuietly(ctx: Context, nodes: StateDocument['nodes']): Promise<void> {
  try {
    const result = await captureRestorePointCore(
      { layout: ctx.layout, credential: ctx.credential },
      {
        spaceId: ctx.config.spaceId,
        nodes,
        lastFingerprint: (await readMeta()).lastRestorePointId,
        port: ctx.port,
      },
    );
    await writeMeta({ lastRestorePointId: result.fingerprint, restorePointError: null });
  } catch (error) {
    await writeMeta({ restorePointError: describeError(error) });
  }
}

// ------------------------------------------------------------------ 用例：连接与首次连接

export interface ConnectionProbe {
  ok: boolean;
  message: string;
  supportsConditionalWrite: boolean;
}

/**
 * 连接测试：**只写再删一个临时文件**，不碰任何业务数据。
 * 顺带探测条件写支持（新布局不依赖它，但探测结果对排障有用）。
 */
export async function testConnection(
  config: SyncConfig,
  credential: WebDavCredential,
  port: WebDavPort & WebDavAdminPort = createWebDavPort(),
): Promise<ConnectionProbe> {
  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  try {
    await port.ensureCollection(layout.spaceUrl, credential);

    const probeUrl = layout.probeUrl(Math.random().toString(36).slice(2, 10));
    await port.put(probeUrl, JSON.stringify({ probe: true }), credential);

    let conditional = false;
    try {
      await port.put(probeUrl, JSON.stringify({ probe: true }), credential, {
        ifMatch: '"shistart-does-not-exist"',
      });
    } catch (error) {
      conditional = error instanceof WebDavError && error.kind === 'precondition-failed';
    }

    await port.remove(probeUrl, credential);
    return { ok: true, message: '连接成功，可以写入。', supportsConditionalWrite: conditional };
  } catch (error) {
    return { ok: false, message: describeError(error), supportsConditionalWrite: false };
  }
}

export interface SetupResult {
  probe: ConnectionProbe;
  /** 远端这个地址上本来就有的空间（本次是"加入"），还是本次"新建"。 */
  joined: boolean;
  sync: RunSyncResult;
}

/**
 * 首次一键连接：探测 → 建空间（或加入）→ 立即首次同步。
 *
 * 顺序刻意是"先探测再建空间再同步"，每一步都为下一步挡掉一类错误：
 * 先探测：凭据错 / 地址错 / 目录不可写，在**什么都没建**的时候就被拦下。
 */
export async function setupSync(
  config: SyncConfig,
  credential: WebDavCredential,
): Promise<SetupResult> {
  const probe = await testConnection(config, credential);
  if (!probe.ok) {
    throw new SyncError('auth', probe.message);
  }

  const requested = config.spaceId || newWriterId();
  await saveSyncConfig({ ...config, spaceId: requested });

  // 建空间（或加入）：确保 space.json 与 states/ 存在，采纳远端 spaceId。
  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  let joined = false;
  try {
    await port.ensureCollection(layout.spaceUrl, credential);
    let existing: string | null = null;
    try {
      existing = await port.get(layout.spaceFileUrl, credential);
    } catch (error) {
      if (!(error instanceof WebDavError && error.kind === 'not-found')) throw error;
    }
    const decision = decideSpaceIdentity(
      requested,
      remoteSpaceIdOf(parseJson(existing ?? '')),
    );
    const spaceId = decision.kind === 'adopt' ? decision.spaceId : requested;
    joined = decision.kind === 'adopt';
    if (!existing) {
      await port.put(
        layout.spaceFileUrl,
        JSON.stringify({
          protocolVersion: SYNC_STATE_VERSION,
          spaceId,
          createdAt: Date.now(),
          layoutVersion: 3,
        }),
        credential,
      );
    }
    await port.ensureCollection(layout.statesUrl, credential);
    await saveSyncConfig({ ...config, spaceId, initialized: true });
  } catch (error) {
    throw new SyncError('unsupported', `初始化同步空间失败：${describeError(error)}`);
  }

  const sync = await runSync('setup');
  return { probe, joined, sync };
}

// ------------------------------------------------------------------ 用例：重置同步

export interface ResetReport {
  /** 删掉的状态文档数。 */
  removedStates: number;
  /** 删掉的恢复点份数。 */
  removedHistory: number;
}

/**
 * 把同步**整个重来一遍**：清空远端的状态与恢复点、以及本地全部同步元数据。
 *
 * 哪些**不动**：
 * - `space.json` 不动。空间身份还在，另一台设备不需要重新配对。
 * - 浏览器的书签**一条都不动**。
 *
 * 重置后第一次同步等同于"首次同步"：把本地书签现状整体推上去。
 */
export async function resetSyncSpace(
  config: SyncConfig,
  credential: WebDavCredential,
): Promise<ResetReport> {
  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  const meta = await readMeta();
  const owner = `reset-${newWriterId().slice(0, 8)}`;
  if (!(await acquireLease(owner))) {
    throw new SyncError('busy', '已有一次同步在进行中，请稍后再重置。');
  }

  let removedStates = 0;
  let removedHistory = 0;
  const listCtx: Context = { config, credential, layout, port, writerId: meta.writerId, owner };
  try {
    const states = await listStateFileUrls(listCtx);
    for (const url of states) {
      await port.remove(url, credential);
      removedStates += 1;
    }
    const points = await listRestorePointCores({ layout, credential }, port);
    for (const point of points) {
      await port.remove(point.url, credential);
      removedHistory += 1;
    }
  } finally {
    await releaseLease(owner);
  }

  // 本地状态后清：远端失败时本地还完整，用户重试一次就到位（反过来的话两边都残缺）。
  await purgeSyncState();
  await clearSyncEvents();
  await writeMeta({ writerId: meta.writerId, clock: 0, lastError: null });
  return { removedStates, removedHistory };
}

/** 列出 states/ 下全部文档的 URL（重置用）。 */
async function listStateFileUrls(ctx: Context): Promise<string[]> {
  try {
    const entries = await ctx.port.propfind(ctx.layout.statesUrl, ctx.credential, 1);
    return entries
      .filter((entry) => !entry.isDirectory && writerIdFromFileName(fileNameOf(entry.url)) !== null)
      .map((entry) => entry.url);
  } catch (error) {
    if (error instanceof WebDavError && error.kind === 'not-found') return [];
    throw error;
  }
}

// ------------------------------------------------------------------ 用例：删除闸门

/**
 * 用户在闸门条目里选定某一方。
 *
 * 关键：裁决**必须生成新的写入并同步出去**，不能只改本地状态——只改本地的话
 * 另一台设备下一次合并还会按旧版本判出同一条闸门。
 */
export async function resolveDeleteGate(
  syncId: string,
  action: 'keep' | 'delete',
): Promise<void> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) throw new SyncError('not-configured', '还没有配置 WebDAV 同步。');
  const credential = await loadCredential();
  if (!credential) throw new SyncError('no-credential', '缺少 WebDAV 凭据，请重新填写密码。');

  const baseline = await readBaselineDoc();
  if (!baseline) return;
  const node = baseline.nodes[syncId];
  if (!node) return;

  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
  const write = { clock: baseline.clock + 1, writerId };
  const now = Date.now();

  const decided = {
    ...node,
    deleted: action === 'delete',
    deletedAt: action === 'delete' ? now : null,
    ver: { ...node.ver, deleted: write },
    nv: write,
    base: node.nv,
  };
  const target: StateDocument = {
    ...baseline,
    writerId,
    clock: baseline.clock + 1,
    writtenAt: now,
    nodes: { ...baseline.nodes, [syncId]: decided },
  };
  await writeBaselineDoc(target);

  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  await port.put(layout.stateUrl(writerId), serializeStateDoc(target), credential);

  // 闸门条目在下一轮合并时重新计算，裁决生效后它自然消失；本地立刻摘掉，
  // 免得用户看着一条已经决定的东西。
  const gates = (await readGates()).filter((entry) => entry.syncId !== syncId);
  await replaceGates(gates);
}

// ------------------------------------------------------------------ 用例：回退

/** 每类受影响条目的标题样本上限。样本是为了"看得见是哪几条"，不是当清单用。 */
export const ROLLBACK_SAMPLE_LIMIT = 5;

export interface RollbackPreview {
  restorePointId: string;
  /** 目标里比现在多/少/不同的节点数（只读预览）。 */
  counts: { create: number; update: number; delete: number };
  /**
   * 每类受影响条目的**标题样本**（各最多 `ROLLBACK_SAMPLE_LIMIT` 条）。
   *
   * "会删除 12 条"与"会删除 12 条：XX、XX…"的决策质量差一个量级 —— 用户要点
   * 的是"确认回退"这个不可逆按钮，样本是他唯一能核对"这版是不是我要的那版"
   * 材料。diff 本来就在逐节点遍历，采标题不额外花一次网络或一遍循环。
   */
  samples: { create: string[]; update: string[]; delete: string[] };
  isLatest: boolean;
}

export interface RollbackReport extends RollbackPreview {
  /** 回退前补拍的那一份「当前状态」。真出问题时退回到它，就等于撤销这次回退。 */
  safetyPointId: string | null;
  /** 回退写入之后那轮正常同步的结果。 */
  sync: RunSyncResult | null;
}

/** 回退 diff：恢复点目标 vs 当前基线。计数与样本一次算清（预览与执行共用，保证说的一致）。 */
function diffRestorePoint(
  pointNodes: StateDocument['nodes'],
  currentNodes: StateDocument['nodes'],
): { counts: RollbackPreview['counts']; samples: RollbackPreview['samples'] } {
  const counts = { create: 0, update: 0, delete: 0 };
  const samples: RollbackPreview['samples'] = { create: [], update: [], delete: [] };
  for (const [syncId, node] of Object.entries(pointNodes)) {
    const current = currentNodes[syncId];
    if (!current) {
      counts.create += 1;
      if (samples.create.length < ROLLBACK_SAMPLE_LIMIT) samples.create.push(node.title);
    } else if (!sameNode(current, node)) {
      counts.update += 1;
      if (samples.update.length < ROLLBACK_SAMPLE_LIMIT) samples.update.push(node.title);
    }
  }
  for (const [syncId, current] of Object.entries(currentNodes)) {
    if (pointNodes[syncId]) continue;
    counts.delete += 1;
    if (samples.delete.length < ROLLBACK_SAMPLE_LIMIT) samples.delete.push(current.title);
  }
  return { counts, samples };
}

/**
 * 把整棵树退回某个恢复点（既有约定 的三条规矩，快照模型下的形态）：
 *
 * 1. **前进式**：把恢复点的状态**重新盖戳**成本机的一次全量写入推上去，
 *    不回退任何游标、不重写远端历史 —— 对其它安装就是一次普通同步。
 *    重新盖戳是必须的：恢复点里的版本是旧的，不盖戳的话任何一台有更新的
 *    写入的设备都会在 LWW 中赢过它，回退就静默失效了。
 * 2. **先补拍，再动手**。补拍失败就**中止**——宁可回退不了，也不要回退完之后退不回来。
 * 3. **过冲突检测**。重新盖戳的删除带着"基于我上一轮的状态"的 base，
 *    与并发编辑互未见过时照样进删除闸门，绝不静默覆盖。
 */
export async function rollbackToRestorePoint(restorePointId: string): Promise<RollbackReport> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) throw new SyncError('not-configured', '还没有配置 WebDAV 同步。');
  const credential = await loadCredential();
  if (!credential) throw new SyncError('no-credential', '缺少 WebDAV 凭据，请重新填写密码。');

  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
  const ctx: Context = { config, credential, layout, port, writerId, owner: 'rollback' };

  const point = await fetchRestorePointCore({ layout, credential }, restorePointId, port);
  if (!point.ok) {
    throw new SyncError('remote-corrupt', `这份恢复点不能用：${point.reason}。已中止，书签未改动。`);
  }

  const baseline = await readBaselineDoc();
  const currentNodes = baseline?.nodes ?? {};
  const diff = diffRestorePoint(point.file.nodes, currentNodes);

  if (diff.counts.create === 0 && diff.counts.update === 0 && diff.counts.delete === 0) {
    // 没有任何差异：这一版就是现在的样子。不补拍、不跑同步。
    return {
      restorePointId,
      counts: diff.counts,
      samples: diff.samples,
      isLatest: meta.lastRestorePointId === restorePointId,
      safetyPointId: null,
      sync: null,
    };
  }

  // ---- 补拍：给这次回退留一条退路 ----
  let safetyPointId: string;
  try {
    const safety = await captureRestorePointCore(
      { layout, credential },
      { spaceId: config.spaceId, nodes: currentNodes, lastFingerprint: meta.lastRestorePointId, port },
    );
    safetyPointId = safety.fingerprint;
    await writeMeta({ lastRestorePointId: safety.fingerprint, restorePointError: null });
  } catch (error) {
    throw new SyncError(
      'unsupported',
      `回退前没能把当前状态存到云端（${describeError(error)}），已中止，书签一条都没改。`,
    );
  }

  const owner = `rollback-${newWriterId().slice(0, 8)}`;
  if (!(await acquireLease(owner))) {
    throw new SyncError('busy', '已有一次同步在进行中，请稍后再回退。');
  }
  try {
    // 重新盖戳：clock 取"全场最大 + 1"——先拉一遍远端文档才知道全场最大是多少。
    const remotes = await pullRemoteDocs(ctx);
    let clock = baseline?.clock ?? 0;
    for (const doc of remotes) clock = Math.max(clock, doc.clock);
    clock += 1;

    const write = { clock, writerId };
    const nodes: StateDocument['nodes'] = {};
    for (const [syncId, node] of Object.entries(point.file.nodes)) {
      const current = currentNodes[syncId];
      const base = current ? current.nv : null;
      const ver = {} as StateDocument['nodes'][string]['ver'];
      for (const field of Object.keys(node.ver) as Array<keyof typeof node.ver>) {
        ver[field] = write;
      }
      nodes[syncId] = {
        ...node,
        ver,
        nv: write,
        base,
        deletedAt: node.deleted ? (node.deletedAt ?? Date.now()) : null,
      };
    }
    // 现在有、恢复点里没有的节点：写成墓碑（删掉的要找得回来，见 既有约定）。
    for (const [syncId, current] of Object.entries(currentNodes)) {
      if (point.file.nodes[syncId]) continue;
      if (current.deleted) {
        nodes[syncId] = current;
        continue;
      }
      nodes[syncId] = {
        ...current,
        deleted: true,
        deletedAt: Date.now(),
        ver: { ...current.ver, deleted: write },
        nv: write,
        base: current.nv,
      };
    }

    const target: StateDocument = {
      format: SYNC_STATE_FORMAT,
      version: SYNC_STATE_VERSION,
      spaceId: config.spaceId,
      writerId,
      clock,
      writtenAt: Date.now(),
      nodes,
    };
    await writeBaselineDoc(target);
    await port.put(layout.stateUrl(writerId), serializeStateDoc(target), credential);
    await writeMeta({ clock, lastError: null });
  } finally {
    await releaseLease(owner);
  }

  // 走一遍正常同步：把回退写入与其它安装的文档合并、应用、再存档。
  const sync = await runSync('manual');
  return {
    restorePointId,
    counts: diff.counts,
    samples: diff.samples,
    isLatest: meta.lastRestorePointId === restorePointId,
    safetyPointId,
    sync,
  };
}

function sameNode(a: StateDocument['nodes'][string], b: StateDocument['nodes'][string]): boolean {
  return (
    a.title === b.title &&
    a.url === b.url &&
    a.parentSyncId === b.parentSyncId &&
    a.position === b.position &&
    a.kind === b.kind &&
    a.logicalRootId === b.logicalRootId &&
    a.deleted === b.deleted
  );
}

/** 回退预览：只读，不改任何东西。 */
export async function previewRollback(restorePointId: string): Promise<RollbackPreview> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) throw new SyncError('not-configured', '还没有配置 WebDAV 同步。');
  const credential = await loadCredential();
  if (!credential) throw new SyncError('no-credential', '缺少 WebDAV 凭据，请重新填写密码。');

  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  const meta = await readMeta();
  const point = await fetchRestorePointCore({ layout, credential }, restorePointId, port);
  if (!point.ok) {
    throw new SyncError('remote-corrupt', `这份恢复点不能用：${point.reason}。`);
  }
  const baseline = await readBaselineDoc();
  const currentNodes = baseline?.nodes ?? {};
  const diff = diffRestorePoint(point.file.nodes, currentNodes);
  return {
    restorePointId,
    counts: diff.counts,
    samples: diff.samples,
    isLatest: meta.lastRestorePointId === restorePointId,
  };
}

// ------------------------------------------------------------------ 状态

export async function readSyncStatus(): Promise<SyncStatus> {
  const config = await loadSyncConfig();
  const meta = await readMeta();
  const gates = await readGates();
  const settingsState = await loadSettingsSyncState();

  if (!isConfigured(config)) {
    return {
      phase: 'idle',
      lastSuccessAt: meta.lastSyncAt,
      lastError: null,
      conflictCount: gates.length,
      // 没配置时也如实报：这两个数说的是"上一轮同步的结果"，与配没配置无关。
      skipped: meta.lastSkipped,
      failed: meta.lastFailed,
      settingsError: settingsState.lastError,
    };
  }

  const error = meta.lastError ?? '';
  const phase: SyncStatus['phase'] =
    gates.length > 0
      ? 'conflict'
      : error.includes('密码') || error.includes('凭据')
        ? 'auth-required'
        : error !== ''
          ? 'error'
          : 'idle';

  return {
    phase,
    lastSuccessAt: meta.lastSyncAt,
    lastError: error === '' ? null : error,
    skipped: meta.lastSkipped,
    failed: meta.lastFailed,
    conflictCount: gates.length,
    settingsError: settingsState.lastError,
  };
}

/** 待人工裁决的删除闸门条目。 */
export async function listDeleteGates() {
  return readGates();
}

/** 覆盖日志（最近的在前）。 */
export async function listOverrideLog() {
  return readOverrides();
}

/**
 * 撤销一条覆盖日志：把我的值作为新写入盖回去。
 *
 * 这就是"自动择一 + 必留痕可撤销"的撤销腿（修订 既有约定）—— 一次普通的
 * 本地改动，走正常同步。
 */
export async function undoOverride(entry: {
  syncId: string;
  field: 'title' | 'url' | 'parentSyncId' | 'logicalRootId' | 'position';
  myValue: string | boolean | null;
}): Promise<void> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) throw new SyncError('not-configured', '还没有配置 WebDAV 同步。');
  const credential = await loadCredential();
  if (!credential) throw new SyncError('no-credential', '缺少 WebDAV 凭据，请重新填写密码。');

  const baseline = await readBaselineDoc();
  if (!baseline) return;
  const node = baseline.nodes[entry.syncId];
  if (!node) return;

  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
  const write = { clock: baseline.clock + 1, writerId };
  const next = { ...node, ver: { ...node.ver, [entry.field]: write }, nv: write, base: node.nv };
  if (entry.field === 'title' && typeof entry.myValue === 'string') next.title = entry.myValue;
  if (entry.field === 'url') next.url = typeof entry.myValue === 'string' ? entry.myValue : null;
  if (entry.field === 'parentSyncId') {
    next.parentSyncId = typeof entry.myValue === 'string' ? entry.myValue : null;
  }
  if (entry.field === 'logicalRootId' && typeof entry.myValue === 'string') {
    next.logicalRootId = entry.myValue as typeof next.logicalRootId;
  }
  if (entry.field === 'position' && typeof entry.myValue === 'string') next.position = entry.myValue;

  const target: StateDocument = {
    ...baseline,
    writerId,
    clock: baseline.clock + 1,
    writtenAt: Date.now(),
    nodes: { ...baseline.nodes, [entry.syncId]: next },
  };
  await writeBaselineDoc(target);
  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  await port.put(layout.stateUrl(writerId), serializeStateDoc(target), credential);
}

// ------------------------------------------------------------------ 后台维护

/**
 * 每日维护：过期墓碑打标（合并时计算，跑一轮同步就会生效并传播）+
 * 恢复点保留策略 + 清理 30 天没更新的过期状态文档。
 *
 * 刻意**不自己取租约**：下面的 runSync 自己会取，外层再取就是自己锁自己。
 * 各项都是幂等的，撞上"正在同步"就跳过，下一轮维护再来。
 */
export async function runDailyMaintenance(): Promise<{
  prunedPoints: number;
  removedStates: number;
}> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) return { prunedPoints: 0, removedStates: 0 };
  const credential = await loadCredential();
  if (!credential) return { prunedPoints: 0, removedStates: 0 };

  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  try {
    await runSync('trash-expiry');
  } catch {
    // 维护轮失败不抛：同步自己会报错，这里继续做云上清理。
  }
  const pruned = await pruneRestorePointsCore({ layout, credential }, port);
  const removed = await removeStaleStateCores({ layout, credential }, port, Date.now());
  return { prunedPoints: pruned.removed, removedStates: removed.removed };
}
