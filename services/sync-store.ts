/**
 * 同步的本地持久化（IndexedDB，既有约定 的 v3 schema）。
 *
 * 为什么不用 `chrome.storage.local`：它适合几 KB 的偏好，不适合整棵树的映射与
 * 状态文档 —— 每次改动都要整份读取再整份写回。IndexedDB 能按条读写、能开事务。
 * 凭据**不放这里**，见 services/sync-config.ts。
 *
 * v3 相对 v2 的 store 变化：9 个 store 缩到 5 个。
 * - 删：outbox（无常驻队列——本地改动 = diff 后整份上传）、seen（无操作可重放）、
 *   conflicts（只剩删除闸门一个 store）、journal（diff 幂等，重算即续）、
 *   trash（墓碑信息全在状态文档里，回收站索引整个变成派生视图）、trash-age（既有约定 已退休）。
 * - 改：baseline 从"每节点一条"改成"一份状态文档一条记录"。
 * - 增：gates（删除闸门条目）、overrides（覆盖日志环形缓冲）。
 *
 * 升级路径：v3 的 onupgradeneeded 里删掉退休 store、重建 baseline。旧数据本就与
 * 新模型不兼容（开发阶段可清除），删掉比留着让人误读安全。
 */

import type { NativeMapping } from '../types/sync-state';
import type { DeleteGateEntry, OverrideEntry } from '../lib/sync/state-merge';
import type { StateDocument } from '../types/sync-state';

export const SYNC_DB_NAME = 'shistart-sync';
export const SYNC_DB_VERSION = 3;

export const STORE_META = 'meta';
export const STORE_MAPPING = 'mapping';
export const STORE_BASELINE = 'baseline';
export const STORE_GATES = 'gates';
export const STORE_OVERRIDES = 'overrides';

/** 覆盖日志的环形缓冲上限。够回答"刚才我的改动被谁盖了"，不是审计。 */
export const OVERRIDE_LIMIT = 100;

/** 基线文档在 store 里的固定键。 */
const BASELINE_KEY = 'doc';

export interface SyncMeta {
  /** 隐藏写入令牌：本机生成的随机 UUID，产品层不可见（既有约定 决策五）。 */
  writerId: string;
  /** 本机已见到的最大时钟（Lamport 计数器）。本地写入取 clock + 1。 */
  clock: number;
  lastSyncAt: number | null;
  lastError: string | null;
  /**
   * 上一轮"没同步全"的两个计数。
   *
   * 存在 meta 里而不是只写事件：状态点与设置页读的是它 —— 事件是时间线，
   * 状态回答的是"现在怎么样"。
   */
  lastSkipped: number;
  lastFailed: number;
  /** 最近一次写上去的恢复点指纹。只用来回答"内容没变就别再写第二份"。 */
  lastRestorePointId: string | null;
  restorePointError: string | null;
  lastPruneAt: number | null;
  lastPruneRemoved: number;
  restorePointPruneError: string | null;
}

const DEFAULT_META: SyncMeta = {
  writerId: '',
  clock: 0,
  lastSyncAt: null,
  lastError: null,
  lastSkipped: 0,
  lastFailed: 0,
  lastRestorePointId: null,
  restorePointError: null,
  lastPruneAt: null,
  lastPruneRemoved: 0,
  restorePointPruneError: null,
};

export class SyncStoreUnavailableError extends Error {
  constructor() {
    super('当前环境不支持 IndexedDB，同步功能不可用。');
    this.name = 'SyncStoreUnavailableError';
  }
}

function factory(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

// 刻意**不提供** "把 IDBRequest 包成 Promise 然后 await" 的工具函数。
// 那种写法在事务里必然踩到自动提交（见 withStore 的注释）。

let dbPromise: Promise<IDBDatabase> | null = null;

/** **只给测试用**：丢掉打开连接的缓存（测试要在每个用例之间删库重建）。 */
export function __resetDbPromiseForTest(): void {
  dbPromise = null;
}

export function openSyncDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const idb = factory();
  if (!idb) return Promise.reject(new SyncStoreUnavailableError());

  dbPromise = new Promise((resolve, reject) => {
    const request = idb.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 退休 store 先删：旧数据与新模型不兼容，留着只会让人误读。
      for (const name of [
        'outbox',
        'seen',
        'conflicts',
        'journal',
        'trash',
        'trash-age',
      ]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      // baseline 换了形状（每节点一条 → 一份文档一条），必须重建。
      if (db.objectStoreNames.contains(STORE_BASELINE)) db.deleteObjectStore(STORE_BASELINE);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_MAPPING)) {
        db.createObjectStore(STORE_MAPPING, { keyPath: 'nativeId' });
      }
      db.createObjectStore(STORE_BASELINE);
      if (!db.objectStoreNames.contains(STORE_GATES)) {
        db.createObjectStore(STORE_GATES, { keyPath: 'syncId' });
      }
      if (!db.objectStoreNames.contains(STORE_OVERRIDES)) {
        // 自增键：裁剪时"最旧的"就是键最小的，不依赖记录里的任何字段。
        db.createObjectStore(STORE_OVERRIDES, { autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // 别人要升级时主动让路（v1→v2 时被 blocked 过，既有约定）。
      db.onversionchange = () => {
        db.close();
        if (dbPromise !== null) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开同步数据库'));
    request.onblocked = () => {
      dbPromise = null;
      reject(
        new Error(
          '同步数据库正在升级，但被这个扩展的另一个页面占着。关掉其它师兄起页标签页后重试；' +
            '如果一直这样，到扩展管理页重新加载一次扩展。',
        ),
      );
    };
  });
  return dbPromise;
}

/**
 * 在一个事务里干活。
 *
 * ⚠️ **事务里绝不能 `await` IndexedDB 请求。** 事务是自动提交的：只要有一刻没有
 * 待处理的请求就立刻提交，之后再 `store.put()` 会抛 TransactionInactiveError。
 * 本项目真实发生过：`writeMeta` 静默失败 ⇒ 每同步一次生成一个新 deviceId。
 * 正确写法只有一种：同一次事务里所有请求一次性排出去，然后等 `oncomplete`。
 */
async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => T,
): Promise<T> {
  const db = await openSyncDb();
  const tx = db.transaction(name, mode);
  const result = work(tx.objectStore(name));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('同步数据库事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('同步数据库被中止'));
  });
  return result;
}

/** 只读事务：排一个读请求，等事务提交后返回结果。 */
async function readInTx<T>(
  name: string,
  request: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  let box: { result?: T } = {};
  await withStore(name, 'readonly', (store) => {
    const req = request(store);
    req.onsuccess = () => {
      box = { result: req.result };
    };
    return undefined;
  });
  return box.result as T;
}

// ------------------------------------------------------------------ meta 与租约

export async function readMeta(): Promise<SyncMeta> {
  const raw = await readInTx<Partial<SyncMeta> | undefined>(STORE_META, (store) =>
    store.get('meta') as IDBRequest<Partial<SyncMeta> | undefined>,
  );
  return { ...DEFAULT_META, ...(raw ?? {}) };
}

export function writeMeta(patch: Partial<SyncMeta>): Promise<SyncMeta> {
  // 先读后写：读的结果在 onsuccess 里接，put 紧接着排进**同一个**事务。
  return withStore(STORE_META, 'readwrite', (store) => {
    let next: SyncMeta = { ...DEFAULT_META, ...patch };
    const request = store.get('meta') as IDBRequest<Partial<SyncMeta> | undefined>;
    request.onsuccess = () => {
      next = { ...DEFAULT_META, ...(request.result ?? {}), ...patch };
      store.put(next, 'meta');
    };
    return { get current() { return next; } };
  }).then((box) => box.current);
}

/**
 * 同步租约：同一个安装实例内串行。
 *
 * 不能用全局变量：MV3 的 service worker 随时被杀，popup / 主页 / 后台可能同时开跑。
 * 租约带过期时间，崩溃后不会永远卡住。
 */
export interface SyncLease {
  owner: string;
  expiresAt: number;
}

export const SYNC_LEASE_TTL_MS = 120_000;

export function acquireLease(owner: string): Promise<boolean> {
  return withStore(STORE_META, 'readwrite', (store) => {
    let acquired = true;
    const request = store.get('lease') as IDBRequest<SyncLease | undefined>;
    request.onsuccess = () => {
      const raw = request.result;
      const now = Date.now();
      if (raw && raw.expiresAt > now && raw.owner !== owner) {
        acquired = false;
        return;
      }
      store.put({ owner, expiresAt: now + SYNC_LEASE_TTL_MS } satisfies SyncLease, 'lease');
    };
    return { get acquired() { return acquired; } };
  }).then((box) => box.acquired);
}

export async function releaseLease(owner: string): Promise<void> {
  await withStore(STORE_META, 'readwrite', (store) => {
    const request = store.get('lease') as IDBRequest<SyncLease | undefined>;
    request.onsuccess = () => {
      const raw = request.result;
      if (raw && raw.owner === owner) store.delete('lease');
    };
  });
}

// ------------------------------------------------------------------ 映射

export async function readMappings(): Promise<NativeMapping[]> {
  return readInTx<NativeMapping[]>(STORE_MAPPING, (store) =>
    store.getAll() as IDBRequest<NativeMapping[]>,
  );
}

export async function putMappings(entries: readonly NativeMapping[]): Promise<void> {
  if (entries.length === 0) return;
  await withStore(STORE_MAPPING, 'readwrite', (store) => {
    for (const entry of entries) store.put(entry);
  });
}

export async function removeMappings(nativeIds: readonly string[]): Promise<void> {
  if (nativeIds.length === 0) return;
  await withStore(STORE_MAPPING, 'readwrite', (store) => {
    for (const id of nativeIds) store.delete(id);
  });
}

// ------------------------------------------------------------------ 基线（一份状态文档）

/** 没有基线 = 这台设备还没同步过（全新安装 / 重置过）。 */
export async function readBaselineDoc(): Promise<StateDocument | null> {
  const doc = await readInTx<StateDocument | undefined>(STORE_BASELINE, (store) =>
    store.get(BASELINE_KEY) as IDBRequest<StateDocument | undefined>,
  );
  return doc ?? null;
}

export async function writeBaselineDoc(doc: StateDocument): Promise<void> {
  await withStore(STORE_BASELINE, 'readwrite', (store) => {
    store.put(doc, BASELINE_KEY);
  });
}

// ------------------------------------------------------------------ 删除闸门

/** 删除闸门条目是**唯一**的待处理概念（既有约定 决策三）。 */
export async function readGates(): Promise<DeleteGateEntry[]> {
  return readInTx<DeleteGateEntry[]>(STORE_GATES, (store) =>
    store.getAll() as IDBRequest<DeleteGateEntry[]>,
  );
}

/** 整份替换：闸门条目每轮由合并重新计算，过期的一律不留。 */
export async function replaceGates(entries: readonly DeleteGateEntry[]): Promise<void> {
  await withStore(STORE_GATES, 'readwrite', (store) => {
    store.clear();
    for (const entry of entries) store.put(entry);
  });
}

// ------------------------------------------------------------------ 覆盖日志

/** 落盘时的覆盖日志条目（记录里不带键；键是自增的，只用于裁剪）。 */
export interface StoredOverride extends OverrideEntry {
  at: number;
}

export async function readOverrides(): Promise<StoredOverride[]> {
  const all = await readInTx<StoredOverride[]>(STORE_OVERRIDES, (store) =>
    store.getAll() as IDBRequest<StoredOverride[]>,
  );
  return all.sort((a, b) => b.at - a.at);
}

/** 追加并做环形裁剪。永不抛（旁路观测数据）。 */
export async function appendOverrides(entries: readonly OverrideEntry[], now: number): Promise<void> {
  if (entries.length === 0) return;
  await withStore(STORE_OVERRIDES, 'readwrite', (store) => {
    for (const entry of entries) {
      // 不指定键：自增键分配，"先进来"就是键最小。
      store.put({ ...entry, at: now });
    }
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count <= OVERRIDE_LIMIT) return;
      const keysRequest = store.getAllKeys() as IDBRequest<IDBValidKey[]>;
      keysRequest.onsuccess = () => {
        // 自增键升序就是写入顺序，删最前面那几条。
        const keys = keysRequest.result.slice().sort((a, b) => Number(a) - Number(b));
        for (const key of keys.slice(0, count - OVERRIDE_LIMIT)) store.delete(key);
      };
    };
  });
}

// ------------------------------------------------------------------ 重置

/** 彻底断开同步并清空本地同步状态。UI 里必须二次确认才允许调用。 */
export async function purgeSyncState(): Promise<void> {
  for (const name of [STORE_MAPPING, STORE_BASELINE, STORE_GATES, STORE_OVERRIDES]) {
    await withStore(name, 'readwrite', (store) => store.clear());
  }
  await withStore(STORE_META, 'readwrite', (store) => {
    store.clear();
  });
}
