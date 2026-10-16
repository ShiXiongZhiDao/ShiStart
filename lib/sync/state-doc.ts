/**
 * 状态文档的编解码、指纹与校验（纯函数，既有约定 决策一）。
 *
 * 两条设计约束：
 * 1. **文档是原子的传输单位** —— 要么整份旧的要么整份新的，不存在写了一半的日志，
 *    所以不需要应用日志 journal（崩溃后重算 diff 自然续上）。
 * 2. **远端是不可信输入** —— 形状不对就抛，不"尽力读"。静默把坏文档读成默认值，
 *    和悄悄丢掉用户数据没有区别。
 */

import { canonicalJson, payloadHash } from './canonical';
import {
  RESTORE_POINT_FORMAT,
  SYNC_STATE_FIELDS,
  SYNC_STATE_FORMAT,
  SYNC_STATE_VERSION,
  type RestorePointFile,
  type StateDocument,
  type SyncNodeState,
} from '../../types/sync-state';

export function emptyStateDoc(spaceId: string, writerId: string, now: number): StateDocument {
  return {
    format: SYNC_STATE_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId,
    writerId,
    clock: 0,
    writtenAt: now,
    nodes: {},
  };
}

/**
 * 序列化为规范 JSON（键按字典序、无空白）。
 *
 * 两台设备对同一份 nodes 必须算出同一个指纹，所以不能依赖 `JSON.stringify` 的
 * 插入顺序 —— canonicalJson 递归排序键（RFC 8785 的子集，见 canonical.ts）。
 */
export function serializeStateDoc(doc: StateDocument): string {
  return canonicalJson(doc);
}

/**
 * nodes 的 SHA-256 十六进制指纹。
 *
 * **刻意只覆盖 nodes**，不含 writtenAt / clock / writerId —— 内容相同必须指纹相同，
 * "内容没变就不写第二份恢复点"与跨设备去重才成立（既有约定 的同一理由）。
 */
export async function nodesFingerprint(nodes: Record<string, SyncNodeState>): Promise<string> {
  return payloadHash(nodes);
}

// ------------------------------------------------------------------ 解析

function bad(message: string): never {
  throw new Error(`状态文档损坏：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVersion(value: unknown, where: string): { clock: number; writerId: string } {
  if (!isRecord(value)) bad(`${where} 不是对象`);
  const clock = value.clock;
  const writerId = value.writerId;
  if (typeof clock !== 'number' || !Number.isFinite(clock) || clock < 0) {
    bad(`${where}.clock 不是非负有限数`);
  }
  if (typeof writerId !== 'string' || writerId.length === 0) bad(`${where}.writerId 不是非空串`);
  return { clock, writerId };
}

function parseNode(raw: unknown, syncId: string): SyncNodeState {
  if (!isRecord(raw)) bad(`节点 ${syncId} 不是对象`);
  if (raw.syncId !== syncId) bad(`节点 ${syncId} 的 syncId 字段与映射键不一致`);
  const kind = raw.kind;
  if (kind !== 'folder' && kind !== 'bookmark') bad(`节点 ${syncId} 的 kind 非法`);
  if (typeof raw.logicalRootId !== 'string' || raw.logicalRootId.length === 0) {
    bad(`节点 ${syncId} 的 logicalRootId 非法`);
  }
  if (typeof raw.title !== 'string') bad(`节点 ${syncId} 的 title 不是串`);
  if (raw.url !== null && typeof raw.url !== 'string') bad(`节点 ${syncId} 的 url 既不是串也不是 null`);
  if (kind === 'folder' && raw.url !== null) bad(`节点 ${syncId} 是文件夹却带了 url`);
  if (raw.parentSyncId !== null && typeof raw.parentSyncId !== 'string') {
    bad(`节点 ${syncId} 的 parentSyncId 既不是串也不是 null`);
  }
  if (typeof raw.position !== 'string' || raw.position.length === 0) {
    bad(`节点 ${syncId} 的 position 不是非空串`);
  }
  if (typeof raw.deleted !== 'boolean') bad(`节点 ${syncId} 的 deleted 不是布尔`);
  if (raw.deletedAt !== null && typeof raw.deletedAt !== 'number') {
    bad(`节点 ${syncId} 的 deletedAt 既不是数也不是 null`);
  }
  if (typeof raw.purged !== 'boolean') bad(`节点 ${syncId} 的 purged 不是布尔`);
  if (raw.purgedAt !== null && typeof raw.purgedAt !== 'number') {
    bad(`节点 ${syncId} 的 purgedAt 既不是数也不是 null`);
  }
  // purged 只可能发生在墓碑上：清除的是"已经删掉的节点"，不是活书签。
  if (raw.purged === true && raw.deleted !== true) {
    bad(`节点 ${syncId} 带 purged 标记却不是墓碑`);
  }

  if (!isRecord(raw.ver)) bad(`节点 ${syncId} 的 ver 不是对象`);
  const ver = {} as SyncNodeState['ver'];
  for (const field of SYNC_STATE_FIELDS) {
    ver[field] = parseVersion(raw.ver[field], `节点 ${syncId} 的 ver.${field}`);
  }

  const nv = parseVersion(raw.nv, `节点 ${syncId} 的 nv`);
  const base = raw.base === null ? null : parseVersion(raw.base, `节点 ${syncId} 的 base`);

  return {
    syncId,
    kind,
    logicalRootId: raw.logicalRootId as SyncNodeState['logicalRootId'],
    title: raw.title,
    url: (raw.url ?? null) as string | null,
    parentSyncId: raw.parentSyncId as string | null,
    position: raw.position,
    deleted: raw.deleted,
    deletedAt: raw.deletedAt as number | null,
    purged: raw.purged,
    purgedAt: raw.purgedAt as number | null,
    ver,
    nv,
    base,
  };
}

/**
 * 解析并校验一份远端状态文档。
 *
 * version 不匹配时抛错并说清方向：空间里躺着**更新版本**的数据（别人的客户端
 * 升过级）时，旧客户端硬读等于把新形状当坏数据丢——必须停下来让人升级。
 */
export function parseStateDoc(raw: unknown): StateDocument {
  if (!isRecord(raw)) bad('文档本身不是对象');
  if (raw.format !== SYNC_STATE_FORMAT) bad(`format 应为 ${SYNC_STATE_FORMAT}`);
  if (raw.version !== SYNC_STATE_VERSION) {
    bad(`version 应为 ${SYNC_STATE_VERSION}，实际是 ${String(raw.version)}（空间里有别的版本的数据，请升级扩展）`);
  }
  if (typeof raw.spaceId !== 'string' || raw.spaceId.length === 0) bad('spaceId 非法');
  if (typeof raw.writerId !== 'string' || raw.writerId.length === 0) bad('writerId 非法');
  if (typeof raw.clock !== 'number' || !Number.isFinite(raw.clock) || raw.clock < 0) {
    bad('clock 不是非负有限数');
  }
  if (typeof raw.writtenAt !== 'number' || !Number.isFinite(raw.writtenAt)) bad('writtenAt 不是有限数');
  if (!isRecord(raw.nodes)) bad('nodes 不是对象');

  const nodes: Record<string, SyncNodeState> = {};
  for (const [syncId, value] of Object.entries(raw.nodes)) {
    nodes[syncId] = parseNode(value, syncId);
  }

  return {
    format: SYNC_STATE_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId: raw.spaceId,
    writerId: raw.writerId,
    clock: raw.clock,
    writtenAt: raw.writtenAt,
    nodes,
  };
}

// ------------------------------------------------------------------ 恢复点

export async function buildRestorePoint(
  spaceId: string,
  nodes: Record<string, SyncNodeState>,
  now: number,
): Promise<RestorePointFile> {
  const stateChecksum = await nodesFingerprint(nodes);
  return {
    format: RESTORE_POINT_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId,
    createdAt: now,
    stateChecksum,
    nodes,
  };
}

export function parseRestorePoint(raw: unknown): RestorePointFile {
  if (!isRecord(raw)) bad('恢复点本身不是对象');
  if (raw.format !== RESTORE_POINT_FORMAT) bad(`恢复点 format 应为 ${RESTORE_POINT_FORMAT}`);
  if (raw.version !== SYNC_STATE_VERSION) bad(`恢复点 version 应为 ${SYNC_STATE_VERSION}`);
  if (typeof raw.spaceId !== 'string' || raw.spaceId.length === 0) bad('恢复点 spaceId 非法');
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) bad('恢复点 createdAt 非法');
  if (typeof raw.stateChecksum !== 'string') bad('恢复点 stateChecksum 不是串');
  if (!isRecord(raw.nodes)) bad('恢复点 nodes 不是对象');
  const nodes: Record<string, SyncNodeState> = {};
  for (const [syncId, value] of Object.entries(raw.nodes)) {
    nodes[syncId] = parseNode(value, syncId);
  }
  return {
    format: RESTORE_POINT_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId: raw.spaceId,
    createdAt: raw.createdAt,
    stateChecksum: raw.stateChecksum,
    nodes,
  };
}
