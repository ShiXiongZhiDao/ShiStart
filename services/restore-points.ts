/**
 * 恢复点（既有约定 决策六：空间级 `history/`，内容寻址）。
 *
 * 产品语义全部保留：中文叫「恢复点」，完整状态存档、含墓碑、
 * 供误删之后整体回退；"内容没变就不写第二份"与跨设备去重都建立在
 * **指纹只覆盖 nodes** 上（createdAt 变而内容不变 ⇒ 同一个文件名）。
 *
 * 相对旧版的迁移：从 `devices/{设备}/snapshots/`（每设备一份目录）改成
 * 空间级 `history/`。保留策略同规则但按**全空间**算：30 天内的一律保留，
 * 之外最多再留最近 20 份。旧规则"只清本机自己的"保护的是"别处的恢复点可能是
 * 它唯一的保险"——30 天地板已经覆盖那个场景（丢了本地状态的安装有 30 天
 * 窗口回来），过期后对所有安装 uniformly stale。
 *
 * ⚠️ **任何一台设备的整理都服务整个空间**（既有约定 决策一/四）——`history/` 是全
 * 空间共用的**一组**，没有"本机自己的那些"这个概念了（写入令牌不可枚举、永不展示）。
 * 所以剪枝**不许**再加回"只清理本机写入的那些"之类的过滤：那等于把已经取消的
 * 每设备边界偷偷请回来，会让别处的孤儿档案永远不被代谢。删除权是共享的，
 * 唯一保险是 30 天地板。
 *
 * 两个刻意的接口切分（沿用旧版）：
 * - 捕获只需要 `WebDavPort`（能写不能删）—— 同步引擎拿不到删除方法，
 *   "同步过程永不删远端档案"因此是签名层面的约束。
 * - 删除只出现在用例层，且只在用户主动点的时候。
 */

import { buildRestorePoint, nodesFingerprint, parseRestorePoint } from '../lib/sync/state-doc';
import {
  createRemoteLayout,
  fingerprintFromFileName,
  fileNameFromHref,
  type RemoteLayout,
} from '../lib/sync/remote-layout';
import { WebDavError, type WebDavAdminPort, type WebDavCredential, type WebDavPort } from '../lib/sync/webdav-port';
import type { RestorePointFile, StateDocument } from '../types/sync-state';
import { isConfigured, loadCredential, loadSyncConfig } from './sync-config';
import { createWebDavPort } from './webdav-http';
import { readMeta, writeMeta } from './sync-store';

export interface RemoteRestorePointContext {
  layout: RemoteLayout;
  credential: WebDavCredential;
}

export interface RestorePointInfo {
  fingerprint: string;
  url: string;
  /** 文件的最后修改时间（≈ 捕获时刻）。问不出来的一律保留。 */
  capturedAt: number | null;
  /**
   * 文件大小（字节）。服务器不报（`contentLength` 缺失）就是 undefined ——
   * 列表照常展示，**不猜 0**：0 字节会被读成"这是个空档案"。
   * 端口层一直都带着这个数（`RemoteResourceMeta.contentLength`，PROPFIND 也
   * 早就请求了 `getcontentlength`），这里只是别再把它丢掉。
   */
  sizeBytes?: number;
}

/** 恢复点保留策略：30 天内一律保留，之外最多再留最近 20 份。 */
export const RESTORE_POINT_KEEP = 20;
export const RESTORE_POINT_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** 状态文档的 GC：30 天没更新过的写入方文档删掉（既有约定 的两条 GC 之一）。 */
export const STALE_STATE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CaptureResult {
  fingerprint: string;
  /** false = 内容没变，没有写第二份。 */
  written: boolean;
}

/**
 * 提交后写一份恢复点。内容没变（指纹与上次相同）就跳过。
 *
 * 失败的处理由调用方拿捏（引擎那边是"绝不让同步失败，但也绝不静默"）——
 * 这个函数本身只管把错误抛出去。
 */
export async function captureRestorePointCore(
  ctx: RemoteRestorePointContext,
  args: {
    spaceId: string;
    nodes: StateDocument['nodes'];
    lastFingerprint: string | null;
    port: WebDavPort;
  },
): Promise<CaptureResult> {
  const fingerprint = (await nodesFingerprint(args.nodes)).slice(0, 32);
  if (fingerprint === args.lastFingerprint) {
    return { fingerprint, written: false };
  }
  const point = await buildRestorePoint(args.spaceId, args.nodes, Date.now());
  await args.port.put(ctx.layout.restorePointUrl(fingerprint), JSON.stringify(point), ctx.credential);
  return { fingerprint, written: true };
}

export async function listRestorePointCores(
  ctx: RemoteRestorePointContext,
  port: WebDavPort,
): Promise<RestorePointInfo[]> {
  let entries;
  try {
    entries = await port.propfind(ctx.layout.historyUrl, ctx.credential, 1);
  } catch (error) {
    if (error instanceof WebDavError && error.kind === 'not-found') return [];
    throw error;
  }
  const out: RestorePointInfo[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const fingerprint = fingerprintFromFileName(fileNameFromHref(entry.url));
    // 认不出文件名的一律忽略：当"有一条恢复点存在"会让保留策略删错东西。
    if (fingerprint === null) continue;
    out.push({
      fingerprint,
      url: entry.url,
      capturedAt: entry.lastModified ?? null,
      sizeBytes: entry.contentLength,
    });
  }
  return out;
}

export type FetchRestorePointResult =
  | { ok: true; file: RestorePointFile }
  | { ok: false; reason: string };

/**
 * 读一份恢复点并**验真**。
 *
 * 半份（或被人改过的）档案绝不能拿来当回退目标——拿它去覆盖整棵树，
 * 等于用一次静默的数据损坏换掉一次误删。校验不过就返回失败，调用方停下。
 */
export async function fetchRestorePointCore(
  ctx: RemoteRestorePointContext,
  fingerprint: string,
  port: WebDavPort,
): Promise<FetchRestorePointResult> {
  let raw: string;
  try {
    raw = await port.get(ctx.layout.restorePointUrl(fingerprint), ctx.credential);
  } catch (error) {
    if (error instanceof WebDavError && error.kind === 'not-found') {
      return { ok: false, reason: '这份恢复点已经不存在了（可能被保留策略清掉）。' };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '文件不是合法的 JSON。' };
  }
  let file: RestorePointFile;
  try {
    file = parseRestorePoint(parsed);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '文件结构校验失败。' };
  }
  const actual = await nodesFingerprint(file.nodes);
  if (actual.slice(0, 32) !== file.stateChecksum.slice(0, 32)) {
    return { ok: false, reason: '内容指纹与声明的不一致（文件可能被改过）。' };
  }
  return { ok: true, file };
}

/**
 * 按保留策略整理：30 天内的一律保留，之外最多再留最近 20 份。
 *
 * ⚠️ 规则对 `history/` **全量**生效——**任何一台设备的整理都服务整个空间**
 * （既有约定 决策一/四）。这里刻意**没有**"只清本机自己的"分支：共享之后
 * 那个边界已经不存在（写入令牌不可枚举），加回来就等于让孤儿设备的档案
 * 永远不被代谢、云上存量失去收敛。
 *
 * `capturedAt` 问不出来的一律保留——不能证明它老，就没有依据删它。
 */
export async function pruneRestorePointsCore(
  ctx: RemoteRestorePointContext,
  port: WebDavPort & WebDavAdminPort,
  now: number = Date.now(),
): Promise<{ removed: number; kept: number }> {
  const all = await listRestorePointCores(ctx, port);
  if (all.length === 0) return { removed: 0, kept: 0 };

  const withTime = all.filter((point) => point.capturedAt !== null);
  const unknown = all.filter((point) => point.capturedAt === null);
  withTime.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));

  const keep = new Set<string>();
  for (const point of withTime) {
    if ((point.capturedAt ?? 0) >= now - RESTORE_POINT_GRACE_MS) keep.add(point.fingerprint);
  }
  for (const point of withTime.slice(0, RESTORE_POINT_KEEP)) keep.add(point.fingerprint);
  for (const point of unknown) keep.add(point.fingerprint);

  let removed = 0;
  for (const point of all) {
    if (keep.has(point.fingerprint)) continue;
    await port.remove(point.url, ctx.credential);
    removed += 1;
  }
  return { removed, kept: keep.size };
}

/**
 * 清理 30 天没更新的状态文档（既有约定 的两条 GC 之一）。
 *
 * 安全性：未同步的改动只存在于原生书签树里，回来时靠本地基线重新生成——
 * 被删的文档不承载任何独有信息。自己的文档每轮同步都会刷新，永远不会被扫到。
 */
export async function removeStaleStateCores(
  ctx: RemoteRestorePointContext,
  port: WebDavPort & WebDavAdminPort,
  now: number,
): Promise<{ removed: number }> {
  let entries;
  try {
    entries = await port.propfind(ctx.layout.statesUrl, ctx.credential, 1);
  } catch (error) {
    if (error instanceof WebDavError && error.kind === 'not-found') return { removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.lastModified === undefined || entry.lastModified === null) continue; // 问不出年龄一律保留
    if (entry.lastModified >= now - STALE_STATE_MS) continue;
    await port.remove(entry.url, ctx.credential);
    removed += 1;
  }
  return { removed };
}

// ------------------------------------------------------------------ UI 包装（自含配置）

export interface RestorePointStatus {
  points: RestorePointInfo[];
  lastFingerprint: string | null;
  error: string | null;
}

/** 设置页的恢复点一档：列表 + 最近写入的那份 + 云上出错原因。 */
export async function readRestorePointStatus(): Promise<RestorePointStatus> {
  const config = await loadSyncConfig();
  const meta = await readMeta();
  if (!isConfigured(config)) return { points: [], lastFingerprint: null, error: null };
  const credential = await loadCredential();
  if (!credential) return { points: [], lastFingerprint: null, error: null };
  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  try {
    const points = await listRestorePointCores({ layout, credential }, port);
    points.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));

    // ---- 跨设备自愈（既有约定 决策三） ----
    // 本机 `lastRestorePointId` 指向的那份可能已经被**别的设备**的每日整理删掉
    // （删除权是共享的，30 天地板是唯一保险）。不修的话：`captureRestorePointCore`
    // 拿 lastFingerprint 一比、判定"内容没变"就继续跳过写入 ⇒ 共享历史里永远缺了
    // 本机当前态，而界面还给它标着「当前」。这正是旧版"以为有备份其实没有"的
    // 跨设备版本，而列表是唯一能看见这个谎言的地方 —— 自愈点就设在这里。
    //
    // 只在**列表读成功**时判（走到这里说明 PROPFIND 没抛错；`history/` 不存在会被
    // 归一成空列表，那同样是权威答案：没有历史 ⇒ 本机那份也确实不在）。读失败
    // 走下面的 catch，一律不动本地记录 —— 把"读不到"当成"不存在"会凭空多写一份。
    const known = new Set(points.map((point) => point.fingerprint));
    let lastFingerprint = meta.lastRestorePointId;
    if (lastFingerprint !== null && !known.has(lastFingerprint)) {
      await writeMeta({ lastRestorePointId: null });
      lastFingerprint = null;
    }

    return { points, lastFingerprint, error: meta.restorePointError };
  } catch (error) {
    return {
      points: [],
      lastFingerprint: meta.lastRestorePointId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 设置页的删除恢复点。删掉"当前"那份必须同时清 meta 里的记录。 */
export async function deleteRestorePoint(fingerprint: string): Promise<void> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) return;
  const credential = await loadCredential();
  if (!credential) return;
  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  await port.remove(layout.restorePointUrl(fingerprint), credential);
  const meta = await readMeta();
  if (meta.lastRestorePointId === fingerprint) {
    await writeMeta({ lastRestorePointId: null });
  }
}

/**
 * 本机记录的"上次写恢复点失败的原因"。**零网络** —— 只读 IndexedDB 的 meta。
 *
 * 为什么单独一个函数而不是复用 `readRestorePointStatus()`：那个要发一次 PROPFIND
 * 列云端目录，而"保险断没断"是个本机事实（同步引擎写入失败时当场记下、成功时清掉）。
 * 设置页同步区那一行、主页顶栏红点都要读它 —— 两处都不该为看一眼状态打服务器
 * （既有约定：原来同步区正是这么干的，注释却写着"不打服务器"，这次把行为对齐注释）。
 */
export async function readRestorePointError(): Promise<string | null> {
  const meta = await readMeta();
  return meta.restorePointError;
}
