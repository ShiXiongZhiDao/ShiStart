/**
 * 本地写入的提交。
 *
 * 回收站恢复/彻底清除、删除闸门裁决、覆盖日志撤销，都是同一个形状：
 * **在基线文档上改几个节点 → 落盘 → 整份上传**。收在这一处，免得五处调用点
 * 各自手写"盖戳、拼文档、PUT"，然后慢慢漂移。
 *
 * 调用方负责把节点状态改好（含新版本）；这里只负责 clock + 1、落盘、上传。
 */

import { serializeStateDoc } from '../lib/sync/state-doc';
import { createRemoteLayout } from '../lib/sync/remote-layout';
import { SYNC_STATE_FORMAT, SYNC_STATE_VERSION, type StateDocument, type SyncNodeState } from '../types/sync-state';
import { createWebDavPort } from './webdav-http';
import { isConfigured, loadCredential, loadSyncConfig } from './sync-config';
import { readBaselineDoc, readMeta, writeBaselineDoc } from './sync-store';

/** 隐藏写入令牌：随机 UUID，产品层不可见（既有约定 决策五）。 */
export function newWriterId(): string {
  return crypto.randomUUID();
}

export class NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}

/**
 * 把改好的节点集落成本机文档并上传。返回推进后的 clock。
 *
 * **没配同步（含断开配置）时只落本机、不上传**（2026-10-17 修，既有约定 修订）：
 * 墓碑存在本机基线里，断开配置不会删它，回收站的恢复与彻底清除因此必须照样能做完
 * —— 只是这些改动要等重新连接之后才传播。spaceId 沿用本机文档里的那个：
 * 空间身份归远端所有，一次纯本机写入没有资格改它。
 *
 * 反过来，**配了同步却缺凭据仍然抛错**：那是明确的坏状态（密码被清了），
 * 该让用户回设置页补上，而不是悄悄写一份传不出去的状态。
 */
export async function commitLocalState(nodes: Record<string, SyncNodeState>): Promise<number> {
  const config = await loadSyncConfig();
  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();

  if (!isConfigured(config)) {
    const baseline = await readBaselineDoc();
    // 连基线都没有（从没同步过）⇒ 没有什么可提交的，按老行为报"还没配置"。
    if (!baseline) throw new NotReadyError('还没有配置 WebDAV 同步。');
    const doc: StateDocument = {
      format: SYNC_STATE_FORMAT,
      version: SYNC_STATE_VERSION,
      spaceId: baseline.spaceId,
      writerId,
      clock: baseline.clock + 1,
      writtenAt: Date.now(),
      nodes,
    };
    await writeBaselineDoc(doc);
    return doc.clock;
  }

  const credential = await loadCredential();
  if (!credential) throw new NotReadyError('缺少 WebDAV 凭据，请重新填写密码。');

  const baseline = await readBaselineDoc();
  const clock = (baseline?.clock ?? 0) + 1;

  const doc: StateDocument = {
    format: SYNC_STATE_FORMAT,
    version: SYNC_STATE_VERSION,
    spaceId: config.spaceId,
    writerId,
    clock,
    writtenAt: Date.now(),
    nodes,
  };
  await writeBaselineDoc(doc);

  const layout = createRemoteLayout(config.baseUrl, config.remotePath);
  const port = createWebDavPort();
  await port.put(layout.stateUrl(writerId), serializeStateDoc(doc), credential);
  return clock;
}
