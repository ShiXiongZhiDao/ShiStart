/**
 * 主页「删除文件夹」的写通道与**期望核对**。
 *
 * 这是继删除书签、同步 apply、回收站就地重建、拖拽、新增 / 删改之后的**第六条**
 * 从主页写原生书签的通道，规矩与前五条完全一致：
 * - **不自创语义**：原生侧就是一次 `chrome.bookmarks.removeTree`，
 *   与在书签管理器里删这个文件夹完全等价；
 * - **不碰同步侧的映射与基线**（下一轮 diff 自己会发现 N 个节点消失，
 *   照常产出 N 条 `node.delete`、照常传播、照常留下墓碑）；
 * - **失败一律抛出**，不静默吞掉。
 *
 * ## 为什么需要一个"期望记录"
 *
 * 删除冲突的既定策略是"不删、保留节点、标记冲突"（GLOSSARY：删除是唯一不可逆的操作，
 * 宁可多留一个）。于是一次文件夹删除**可能部分落空**：删了 300 项，299 项消失，
 * 1 项因另一台设备正在编辑而幸存、按孤儿规则挂回逻辑根。
 *
 * 不说什么，就是静默。所以删除时记下"我期望这 N 个 syncId 都变成墓碑"，
 * 删完之后第一轮成功的同步逐个核对，对不上的说一声。
 *
 * 两条闸门决定"哪一轮同步有资格核对"：
 * 1. `lastSuccessAt` 必须**晚于**删除时刻 —— 否则这轮在我们删除之前就成功了
 *    （同步完成的广播可能后到，不能因此提前核对）；
 * 2. 同步没配过（`lastSuccessAt` 为 null）时永远不核对。
 *
 * （旧模型还有一条"待发操作必须为 0"，随 outbox 在 既有约定 里一起退休。）
 *
 * 判据用**冲突记录**而不是"没成为墓碑"：从回收站恢复回来的节点同样不是墓碑，
 * 但它不是被并发编辑挡下的 —— 两者必须分开，否则恢复完会弹一条假警报。
 */

import {
  BookmarkWriteUnavailableError,
  detectLogicalRoots,
  readNativeSubtree,
  removeNativeTree,
} from './bookmark-sync-adapter';
import { describeNativeError } from './bookmark-edit';
import {
  collectSubtreeNativeIds,
  requiresTypedName,
  sampleDirectBookmarkTitles,
  summarizeNativeSubtree,
  type NativeSubtreeNode,
} from '../lib/folder/delete-preview';
import { readBaselineDoc, readGates, readMappings } from './sync-store';
import { readSyncStatus } from './sync-engine';

export type FolderDeleteErrorCode =
  /** 没有 bookmarks API（权限缺失或非浏览器环境）。 */
  | 'api-unavailable'
  /** 文件夹已经不在了（右键之后被别处删掉）。 */
  | 'node-missing'
  /** 一级目录（书签栏 / 其他书签 / 移动设备书签）不能删。 */
  | 'root-folder'
  /** 浏览器拒绝了这次删除。 */
  | 'write-failed';

/** 机器码 + 原始信息，文案由界面查表（既有约定 的同一条做法）。 */
export class FolderDeleteError extends Error {
  readonly code: FolderDeleteErrorCode;

  constructor(code: FolderDeleteErrorCode, message: string) {
    super(message);
    this.name = 'FolderDeleteError';
    this.code = code;
  }
}

/** 期望记录存在本机扩展存储里。它不是偏好，是一次"等着对账"的动作。 */
export const FOLDER_DELETE_EXPECTATION_KEY = 'shistart.pendingFolderDelete.v1';

export interface FolderDeletePreview {
  title: string;
  bookmarkCount: number;
  folderCount: number;
  /** 直属书签的标题样本（前几条，只为确认没删错行）。 */
  sampleTitles: string[];
  /** 要不要手动输入文件夹名（超过阈值且标题非空）。 */
  requiresTypedName: boolean;
}

async function readSubtreeOrThrow(folderId: string): Promise<NativeSubtreeNode> {
  try {
    return await readNativeSubtree(folderId);
  } catch (error) {
    if (error instanceof BookmarkWriteUnavailableError) {
      throw new FolderDeleteError('api-unavailable', error.message);
    }
    // 浏览器对不存在的 id 是直接 reject（`Can't find bookmark for id.`）。
    throw new FolderDeleteError('node-missing', describeNativeError(error));
  }
}

/**
 * 删除前的账：**只读**，一次 `getSubTree` 现算。
 *
 * 界面必须把数量说出来 —— 确认弹层只说"删除这个文件夹"、不说里面有几条，
 * 正是 既有约定 当年拒绝这个功能的那条理由。
 */
export async function previewFolderDelete(folderId: string): Promise<FolderDeletePreview> {
  const root = await readSubtreeOrThrow(folderId);
  const { bookmarkCount, folderCount } = summarizeNativeSubtree(root);
  const title = root.title ?? '';
  return {
    title,
    bookmarkCount,
    folderCount,
    sampleTitles: sampleDirectBookmarkTitles(root),
    requiresTypedName: requiresTypedName(bookmarkCount, title),
  };
}

export interface FolderDeleteResult {
  bookmarkCount: number;
  folderCount: number;
  /** 记进了期望记录的 syncId 数（0 = 这个文件夹从没参与过同步）。 */
  expectedSyncIds: number;
}

/**
 * 删掉一个文件夹**及其全部内容**。
 *
 * 一级目录有显式守卫：`readSyncTree` 只遍历三个根的子节点，逻辑根结构性地
 * 拿不到映射、进不了同步的删除计划 —— 但那是"碰巧"安全，`removeNativeTree`
 * 内部没有任何校验，Chrome API 会不会拒绝删根容器仓内也无从判定。
 * 所以这里自己拦一道：菜单层不出现，service 层断言拒绝。
 */
export async function deleteFolder(folderId: string): Promise<FolderDeleteResult> {
  const roots = await detectLogicalRoots();
  if (Object.values(roots).includes(folderId)) {
    throw new FolderDeleteError(
      'root-folder',
      '书签栏、其他书签与移动设备书签是浏览器的根目录，不能删除。',
    );
  }

  const root = await readSubtreeOrThrow(folderId);
  const { bookmarkCount, folderCount } = summarizeNativeSubtree(root);
  const nativeIds = collectSubtreeNativeIds(root);
  // 期望记的是 **syncId**：墓碑按 syncId 认，nativeId 在删除之后就没有意义了。
  // 没有映射的节点（从没参与过同步）不进期望 —— 它们不会变成墓碑，diff 也对它们无话可说。
  const mappings = await readMappings();
  const expectedSyncIds = mappings
    .filter((entry) => nativeIds.has(entry.nativeId))
    .map((entry) => entry.syncId);

  await writeFolderDeleteExpectation({
    at: Date.now(),
    rootTitle: root.title ?? '',
    expectedSyncIds,
  });

  try {
    await removeNativeTree(folderId);
  } catch (error) {
    // 没删成就不能留着"期望 N 个墓碑"——下一轮同步会对着一个从没发生过的删除对账。
    await clearFolderDeleteExpectation();
    throw new FolderDeleteError('write-failed', describeNativeError(error));
  }

  return { bookmarkCount, folderCount, expectedSyncIds: expectedSyncIds.length };
}

// ---------------------------------------------------------------- 期望记录

export interface FolderDeleteExpectation {
  /** 删除时刻（`Date.now()`）。 */
  at: number;
  rootTitle: string;
  expectedSyncIds: string[];
}

export interface FolderDeleteOutcome {
  rootTitle: string;
  blockedCount: number;
  blockedTitles: string[];
}

export async function readFolderDeleteExpectation(): Promise<FolderDeleteExpectation | null> {
  try {
    const stored = await chrome.storage.local.get(FOLDER_DELETE_EXPECTATION_KEY);
    const raw = stored?.[FOLDER_DELETE_EXPECTATION_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const at = Number.isFinite(value.at) ? Number(value.at) : 0;
    const expectedSyncIds = Array.isArray(value.expectedSyncIds)
      ? value.expectedSyncIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (at === 0 || expectedSyncIds.length === 0) return null;
    return {
      at,
      rootTitle: typeof value.rootTitle === 'string' ? value.rootTitle : '',
      expectedSyncIds,
    };
  } catch {
    // 读不出来 = 没有可核对的期望。它是个对账机制，不该把整页弄成错误态。
    return null;
  }
}

async function writeFolderDeleteExpectation(record: FolderDeleteExpectation): Promise<void> {
  try {
    await chrome.storage.local.set({ [FOLDER_DELETE_EXPECTATION_KEY]: record });
  } catch {
    // 写不进去不影响删除本身：只是这次删除核对不了，界面不会因此说谎。
  }
}

export async function clearFolderDeleteExpectation(): Promise<void> {
  try {
    await chrome.storage.local.remove(FOLDER_DELETE_EXPECTATION_KEY);
  } catch {
    // 清不掉不影响书签本身；下一次删除会把它整个替换掉。
  }
}

/**
 * 同步跑完之后的核对：**被并发编辑挡下的节点，说出来**。
 *
 * 返回 null = 没什么要说的（没有期望、还没到核对的时候、或全部如期成为墓碑）。
 * 无论说不说，期望记录都在核对成功时消费掉 —— 它只对紧接着的那一轮有效
 * （既有约定：迟到地提示仍然是真的，但文案不许装"刚刚"）。
 */
export async function consumeFolderDeleteExpectation(): Promise<FolderDeleteOutcome | null> {
  const expectation = await readFolderDeleteExpectation();
  if (!expectation) return null;

  let status;
  try {
    status = await readSyncStatus();
  } catch {
    return null;
  }
  // 两条闸门见文件头。注意 `lastSuccessAt` 是严格大于：同一毫秒算不清谁覆盖谁，
  // 宁可多等一轮，也不拿一轮可能没包含本次删除的同步来对账。
  //
  // 旧模型还有第三条"待发操作非空就不核对"，随 outbox 一起退休：新模型没有待发
  // 队列，一轮同步要么整树重算过（包含本次删除），要么没跑完，没有中间态。
  if (status.lastSuccessAt === null || status.lastSuccessAt <= expectation.at) {
    return null;
  }

  let gates;
  try {
    gates = await readGates();
  } catch {
    return null;
  }
  const expected = new Set(expectation.expectedSyncIds);
  // 既有约定 之后「待处理」只剩删除闸门一档，条目本身就是 delete-vs-edit，
  // 不需要再按 kind / status 过滤。
  const blockedIds = gates.filter((gate) => expected.has(gate.syncId)).map((gate) => gate.syncId);

  await clearFolderDeleteExpectation();
  if (blockedIds.length === 0) return null;

  let blockedTitles: string[] = [];
  try {
    const baseline = await readBaselineDoc();
    blockedTitles = blockedIds.map((id) => baseline?.nodes[id]?.title ?? '');
  } catch {
    // 标题读不出来只报数 —— 数字是真的，标题是锦上添花。
  }

  return {
    rootTitle: expectation.rootTitle,
    blockedCount: blockedIds.length,
    blockedTitles,
  };
}
