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

/** 把改好的节点集落成本机文档并上传。返回推进后的 clock。 */
export async function commitLocalState(nodes: Record<string, SyncNodeState>): Promise<number> {
  const config = await loadSyncConfig();
  if (!isConfigured(config)) throw new NotReadyError('还没有配置 WebDAV 同步。');
  const credential = await loadCredential();
  if (!credential) throw new NotReadyError('缺少 WebDAV 凭据，请重新填写密码。');

  const meta = await readMeta();
  const writerId = meta.writerId || newWriterId();
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
