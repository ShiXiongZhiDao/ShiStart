/**
 * 同步领域模型（v3，既有约定）：全量状态快照 + 逐字段 LWW。
 *
 * 取代已删除的 types/sync.ts（旧模型：不可变操作日志 + 向量时钟因果合并，既有约定）。
 * 逻辑根、节点类型、映射这些与模型无关的常量原样搬过来，语义不变。
 *
 * 这里只有类型与常量，不含任何 chrome.* 或网络调用，可在 node 环境被单测覆盖。
 */

export type NodeType = 'folder' | 'bookmark';

/**
 * 逻辑根：书签树里的三个固定起点。**按位置识别，不按标题猜，也不写死浏览器给的 id**
 * —— 不同浏览器、不同语言的 id 与标题都不一样（详见 GLOSSARY「逻辑根」）。
 *
 * 从旧模型搬来并成为唯一定义处：常量本身与旧模型的语义完全一致，
 * 旧文件删除后不会漂移。
 */
export const LOGICAL_ROOT_BAR = 'bar';
export const LOGICAL_ROOT_OTHER = 'other';
export const LOGICAL_ROOT_MOBILE = 'mobile';

export const LOGICAL_ROOT_IDS = [
  LOGICAL_ROOT_BAR,
  LOGICAL_ROOT_OTHER,
  LOGICAL_ROOT_MOBILE,
] as const;

export type LogicalRootId = (typeof LOGICAL_ROOT_IDS)[number];

/**
 * `nativeId → syncId` 的对应表（本地 IndexedDB）里的一条。
 *
 * 只存在本地，绝不上传 —— 同一个书签在 Chrome 和 Edge 里的 nativeId 完全不同。
 * 从旧模型原样搬来（既有约定 不改映射与认领，见 GLOSSARY「映射」）。
 */
export interface NativeMapping {
  nativeId: string;
  syncId: string;
  logicalRootId: string;
  title: string;
  url?: string;
  parentNativeId: string | null;
  index: number;
  updatedAt: number;
}

/** 状态文档的 format 标记与 schema 版本。换版本 = 换一种不兼容的数据形状。 */
export const SYNC_STATE_FORMAT = 'shistart-state';
export const SYNC_STATE_VERSION = 3;

/** 恢复点文件的 format 标记（既有约定 立名；既有约定 起改空间级 `history/` 存放）。 */
export const RESTORE_POINT_FORMAT = 'shistart-restore-point';

/**
 * 一个版本 = `(clock, writerId)`。
 *
 * `clock` 是写入方的逻辑计数器（Lamport 序，只认因果不信墙钟）；
 * `writerId` 是平票时的裁决次序 —— 没有它，两台设备可能为同一个平票选出不同的赢家，
 * 永久分叉。这是"设备概念降级为隐藏写入令牌"之后令牌仍然承重的两件事之一。
 */
export interface Version {
  clock: number;
  writerId: string;
}

/** 参与逐字段 LWW 的字段。`kind` 创建时定死，不参与。 */
export type SyncStateField =
  | 'title'
  | 'url'
  | 'parentSyncId'
  | 'logicalRootId'
  | 'position'
  | 'deleted'
  | 'purged';

export const SYNC_STATE_FIELDS: readonly SyncStateField[] = [
  'title',
  'url',
  'parentSyncId',
  'logicalRootId',
  'position',
  'deleted',
  'purged',
];

/**
 * 一个节点在同步空间里的状态（状态文档扁平映射的一项）。
 *
 * 每个可变字段各带一个版本：两台设备一台改标题、一台改位置，两个改动互不覆盖
 * （沿用 既有约定 的字段级合并，只把求解器从因果换成取最大）。
 *
 * `nv` / `base` 是**节点级**的因果锚：`nv` 在本节点任何字段写入时 bump，
 * `base` 记录这次写入基于哪个节点级版本。删除闸门靠它判断"编辑方有没有见过那个删除"——
 * 逐字段的 `ver` 回答不了这个问题（改标题的 base 只关于标题），必须节点级。
 */
export interface SyncNodeState {
  /**
   * 节点在同步空间里的身份。与它在 `nodes` 映射里的键**必须一致**——
   * 冗余是故意的：应用层/回收站层到处要按 syncId 干活（旧模型的 SyncNode
   * 也自带这个字段），解析时校验两者相等，坏数据当场拦下。
   */
  syncId: string;
  kind: NodeType;
  logicalRootId: LogicalRootId;
  title: string;
  /** 文件夹为 null。 */
  url: string | null;
  /** null = 直接挂在该逻辑根下。 */
  parentSyncId: string | null;
  /** 分数索引排序键（lib/sync/position.ts）。 */
  position: string;
  deleted: boolean;
  /**
   * 删除时刻（**执行删除那台设备**的墙上时钟，毫秒）。
   * 30 天自动过期的年龄判据；null = 未删，或"年龄未知"（一律不清，见 GLOSSARY）。
   */
  deletedAt: number | null;
  /**
   * 粘性标记：彻底清除（用户点的）与 30 天到期过期（后台跑的）共用同一个字段
   * （既有约定 决策六）。单纯从状态里移除无法传播——别人的文档里还有它，
   * 下一轮合并会把它拉回来；粘性标记才可以。
   */
  purged: boolean;
  /** 标记打入的时刻。到期过期时取 `deletedAt + 30 天`（跨设备确定）。 */
  purgedAt: number | null;
  ver: Record<SyncStateField, Version>;
  nv: Version;
  /** 本次写入基于的节点级版本；创建时为 null。 */
  base: Version | null;
}

/**
 * 状态文档：一处安装对同步空间的全量自述（`states/{写入令牌}.json`）。
 *
 * 每轮同步上传的是**合并后的全量目标**（含别人的写入，ver/base 原样携带，
 * 不重新盖戳），所以任何一份状态文档都是"该安装所知的全量真相"。
 */
export interface StateDocument {
  format: typeof SYNC_STATE_FORMAT;
  version: number;
  spaceId: string;
  /** 隐藏写入令牌：本机生成的随机 UUID，产品层不可见（既有约定 决策五）。 */
  writerId: string;
  /** 本写入方已见到的最大时钟。本地写入取 `clock + 1`。 */
  clock: number;
  /** 写入时刻。仅供参考，不参与任何判定。 */
  writtenAt: number;
  /** syncId → 节点状态。含墓碑与 purged 标记。 */
  nodes: Record<string, SyncNodeState>;
}

/**
 * 恢复点：某一轮提交后的全量状态（`history/{状态指纹}.json`）。
 *
 * 中文一律叫「恢复点」，不叫「快照」。内容寻址：指纹只覆盖
 * `nodes`，内容相同必须指纹相同，"内容没变就不写第二份"与跨设备去重才成立
 * （既有约定 的同一理由）。含墓碑——回退时把目标里"没出现"一律当成"该删"
 * 会误删活书签（既有约定 同源的坑）。
 */
export interface RestorePointFile {
  format: typeof RESTORE_POINT_FORMAT;
  version: number;
  spaceId: string;
  /** 捕获时刻（epoch 毫秒）。只用于展示。 */
  createdAt: number;
  /** 只覆盖 `nodes` 的 SHA-256 十六进制指纹。 */
  stateChecksum: string;
  nodes: Record<string, SyncNodeState>;
}

// ---------------------------------------------------------------- 本地配置与状态

/**
 * 同步配置（v3）。
 *
 * 相对旧版的删除：`deviceLabel`（没有设备名册了，既有约定 决策五）、
 * `autoResolve`（所有字段统一 LWW，没有"哪些能自动"这个问题了）。
 */
export interface SyncConfig {
  /** 例如 https://dav.jianguoyun.com/dav/ */
  baseUrl: string;
  username: string;
  /** 可选子目录，拼接在 baseUrl 之后。 */
  remotePath: string;
  spaceId: string;
  /** 参与同步的逻辑根。默认书签栏 + 其他书签。 */
  enabledRoots: string[];
  /** 自动同步：书签变更后的防抖同步 + 定时同步。默认开启。 */
  autoSync: boolean;
  /** 自动同步间隔（分钟）。 */
  intervalMinutes: number;
  /** 用户确认过首次连接后才允许自动同步。 */
  initialized: boolean;
}

export type SyncPhase = 'idle' | 'syncing' | 'error' | 'auth-required' | 'conflict';

export interface SyncStatus {
  phase: SyncPhase;
  lastSuccessAt: number | null;
  lastError: string | null;
  /**
   * 待人工裁决的删除闸门条目数。
   *
   * 刻意没有"待上传改动数"这一项：新模型没有待发队列，每一轮都从整棵书签树
   * 重新算差异，问"还有几条没传上去"没有意义 —— 只有"上一轮什么时候成功的"。
   */
  conflictCount: number;
  /** 上一轮因地址过长没进同步空间的条数。 */
  skipped: number;
  /** 上一轮远端要来、但本机浏览器拒收的条数。 */
  failed: number;
  /**
   * 上一轮**偏好**同步的失败原因。
   *
   * 单独一个字段而不是并进 `lastError`：偏好失败**不阻断书签同步**，
   * 那一轮书签其实是成功的 —— 混进 `lastError` 会让状态点把一次成功的同步报成失败。
   */
  settingsError: string | null;
}

/** 这一轮同步是被谁叫醒的。只用于展示，不参与任何同步判定。 */
export type SyncTriggerReason = 'manual' | 'interval' | 'debounced' | 'setup' | 'trash-expiry';

/** 一轮同步的最终去向。一次 `runSync` 只在出口处记一条，不按步骤刷屏。 */
export type SyncEventKind = 'push' | 'pull' | 'skip' | 'error';

/** 同步记录的环形缓冲上限。够回答"我刚才那次同步怎么样了"，不是审计。 */
export const SYNC_EVENT_LIMIT = 100;

/**
 * 一条同步运行记录。
 *
 * 纯本机数据：不进备份、不进远端、不进基线。写失败静默吞掉（旁路观测数据，既有约定）。
 * v3 起不再有 `requests` 字段——请求预算不再是约束。
 */
export interface SyncEventRecord {
  id: string;
  at: number;
  kind: SyncEventKind;
  trigger: SyncTriggerReason;
  success: boolean;
  /** 本轮上传涉及改动的节点数。 */
  pushed: number;
  /** 本轮合并进去的其他写入方文档数。 */
  pulled: number;
  /** 应用到浏览器的步骤数。 */
  applied: number;
  /** 待处理的删除闸门条目数（口径与 readSyncStatus 一致）。 */
  conflictCount: number;
  /** 地址过长、没进同步空间的条数。 */
  skipped: number;
  /** 远端要来、但本机浏览器拒收的条数。 */
  failed: number;
  detail: string;
}
