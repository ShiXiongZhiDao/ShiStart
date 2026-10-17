/**
 * 主页「新建 / 改名」的写通道，以及**统一的「上一次改动」**。
 *
 * 这是继删除、同步 apply、回收站就地重建、拖拽排序之后的**第五条**从主页写原生书签的
 * 通道，规矩与前四条完全一致：
 * - **不自创语义**：就是 `chrome.bookmarks.create` / `update`，与在书签管理器里做完全等价；
 * - **不碰同步侧的映射与基线**（下一轮 diff 自己会发现，照常产出 `node.create` / `node.update`）；
 * - **失败一律抛出**，不静默吞掉。
 *
 * ## 「上一次改动」是这里的核心
 *
 * 既有约定 / 既有约定 拒绝「新增 / 改名」的理由只有一条：改坏了没有任何地方能退回。
 * 既有约定（拖拽）为这个问题造了「持久化上一次移动 + 撤销」，这里把它**泛化**成
 * 「上一次改动」，一次性覆盖 create / update / move 三种 —— 它们是同一种形状：
 * 记下来处，撤销就是做一次反向操作。
 *
 * **删除不进来。** 删除已经有更强、更持久的找回（墓碑 30 天 + 回收站 + 待同步就地恢复），
 * 再给一条"只记一次"的弱路径只会让人分不清该点哪个。这是刻意的。
 *
 * 一个漂亮的副作用（与 既有约定 同一条）：**撤销若发生在同步之前，本地实况回到基线，
 * diff 不会产出任何操作，一个请求都不发。** 新建再撤销 = 零痕迹。
 */

import { clampDropIndex } from '../lib/drag/drop-plan';
import {
  createNativeBookmark,
  createNativeFolder,
  moveNativeNode,
  removeNativeNode,
  updateNativeNode,
} from './bookmark-sync-adapter';

/** 「上一次改动」存在本机扩展存储里，与界面偏好分开（它不是偏好，是一次待撤销的动作）。 */
export const LAST_EDIT_KEY = 'shistart.lastEdit.v1';

export const EDIT_UNAVAILABLE_MESSAGE = '当前环境不支持写入浏览器书签。';

export type EditErrorCode =
  /** 没有 bookmarks API（权限缺失或非浏览器环境）。 */
  | 'api-unavailable'
  /** 要动的那条书签、或它要回到的地方已经不在了。 */
  | 'node-missing'
  /** 浏览器拒绝了这次写入。 */
  | 'write-failed';

/** 机器码 + 原始信息，文案由界面查表（既有约定 的同一条做法）。 */
export class EditError extends Error {
  readonly code: EditErrorCode;

  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

/**
 * 一次可撤销的改动。
 *
 * 判别联合而不是"一堆可选字段的平铺结构"：每种改动需要的"来处"不一样，
 * 平铺会让"改名的撤销"用到 `fromIndex` 这种不属于它的字段。
 */
export type LastEdit =
  /** 撤销 = 删掉刚建的那个。 */
  | {
      kind: 'create';
      nodeId: string;
      nodeTitle: string;
      parentId: string;
      parentTitle: string;
      at: number;
    }
  /** 撤销 = 把标题 / 网址写回去。 */
  | {
      kind: 'update';
      nodeId: string;
      nodeTitle: string;
      beforeTitle: string;
      /** null = 这是个文件夹（没有网址）。 */
      beforeUrl: string | null;
      at: number;
    }
  /** 撤销 = 移回原来的父目录与下标。 */
  | {
      kind: 'move';
      nodeId: string;
      nodeTitle: string;
      fromParentId: string;
      fromParentTitle: string;
      fromIndex: number;
      toParentId: string;
      toParentTitle: string;
      at: number;
    };

/** 按种类收窄的记录类型：写通道返回它，调用方就不必在运行时再判一次。 */
export type CreateRecord = Extract<LastEdit, { kind: 'create' }>;
export type UpdateRecord = Extract<LastEdit, { kind: 'update' }>;
export type MoveRecord = Extract<LastEdit, { kind: 'move' }>;

export interface EditResult<T extends LastEdit = LastEdit> {
  /** 真的有变化吗 —— 改名时标题与网址都没动就是 false，一次写都不发。 */
  changed: boolean;
  /** 撤销记录写成功了没有。写不进去时界面要说明"撤销不可用"，不能装作有。 */
  undoSaved: boolean;
  record: T | null;
}

interface NativeNode {
  id: string;
  title?: string;
  url?: string;
  parentId?: string;
  index?: number;
}

function api(): typeof chrome.bookmarks | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.bookmarks;
}

export function describeNativeError(error: unknown): string {
  const lastError = typeof chrome === 'undefined' ? undefined : chrome.runtime?.lastError?.message;
  if (lastError) return lastError;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读一个节点。
 *
 * 两种"找不到"都要收成同一个码：Chrome 是**直接 reject** 这个 promise
 * （`Can't find bookmark for id.`），不是返回一个空数组。撤销那条路全靠这个判断。
 */
export async function readNativeNode(nodeId: string): Promise<NativeNode> {
  const bookmarks = api();
  if (!bookmarks) throw new EditError('api-unavailable', EDIT_UNAVAILABLE_MESSAGE);
  let found: NativeNode[];
  try {
    found = (await bookmarks.get(nodeId)) as NativeNode[];
  } catch (error) {
    throw new EditError('node-missing', describeNativeError(error));
  }
  const node = found[0];
  if (!node || typeof node.id !== 'string') {
    throw new EditError('node-missing', `找不到 id 为 ${nodeId} 的书签。`);
  }
  return node;
}

/** 标题只是提示语的一部分，问不出来就留空，不该因此让整次改动失败。 */
export async function readNativeTitle(nodeId: string): Promise<string> {
  try {
    return (await readNativeNode(nodeId)).title ?? '';
  } catch {
    return '';
  }
}

export async function readNativeChildIds(parentId: string): Promise<string[]> {
  const bookmarks = api();
  if (!bookmarks) throw new EditError('api-unavailable', EDIT_UNAVAILABLE_MESSAGE);
  const nodes = (await bookmarks.getChildren(parentId)) as NativeNode[];
  return nodes.map((node) => node.id);
}

// ---------------------------------------------------------------- 存储

export async function readLastEdit(): Promise<LastEdit | null> {
  try {
    const stored = await chrome.storage.local.get([LAST_EDIT_KEY]);
    const current = stored?.[LAST_EDIT_KEY];
    if (current && typeof current === 'object') {
      const parsed = parseLastEdit(current);
      if (parsed) return parsed;
    }
    return null;
  } catch {
    // 读不出来 = 没有可撤销的东西。它是个提示条，不该把整页弄成错误态。
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseLastEdit(raw: unknown): LastEdit | null {
  const value = raw as Record<string, unknown>;
  const kind = value?.kind;
  const nodeId = asText(value?.nodeId);
  if (nodeId === '') return null;
  const at = Number.isFinite(value?.at) ? Number(value.at) : 0;

  if (kind === 'create') {
    return {
      kind: 'create',
      nodeId,
      nodeTitle: asText(value.nodeTitle),
      parentId: asText(value.parentId),
      parentTitle: asText(value.parentTitle),
      at,
    };
  }
  if (kind === 'update') {
    return {
      kind: 'update',
      nodeId,
      nodeTitle: asText(value.nodeTitle),
      beforeTitle: asText(value.beforeTitle),
      beforeUrl: typeof value.beforeUrl === 'string' ? value.beforeUrl : null,
      at,
    };
  }
  if (kind === 'move') {
    return {
      kind: 'move',
      nodeId,
      nodeTitle: asText(value.nodeTitle),
      fromParentId: asText(value.fromParentId),
      fromParentTitle: asText(value.fromParentTitle),
      fromIndex: Number.isFinite(value.fromIndex) ? Number(value.fromIndex) : 0,
      toParentId: asText(value.toParentId),
      toParentTitle: asText(value.toParentTitle),
      at,
    };
  }
  return null;
}

export async function clearLastEdit(): Promise<void> {
  try {
    await chrome.storage.local.remove([LAST_EDIT_KEY]);
  } catch {
    // 清不掉不影响书签本身；条子会自己消失（内存里那份已经清了）。
  }
}

export async function writeLastEdit(record: LastEdit): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [LAST_EDIT_KEY]: record });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 写入

/** 在当前目录下新建一条书签或一个文件夹，追加到末尾。 */
export async function createBookmarkNode(input: {
  parentId: string;
  type: 'bookmark' | 'folder';
  title: string;
  url?: string;
}): Promise<EditResult<CreateRecord>> {
  if (!api()) throw new EditError('api-unavailable', EDIT_UNAVAILABLE_MESSAGE);
  const parentTitle = await readNativeTitle(input.parentId);
  let nodeId: string;
  try {
    // 不传 index —— 交给浏览器追加到末尾，免得撞上 既有约定 那条越界边界。
    nodeId =
      input.type === 'folder'
        ? await createNativeFolder(input.parentId, input.title)
        : await createNativeBookmark(input.parentId, input.title, input.url ?? '');
  } catch (error) {
    throw new EditError('write-failed', describeNativeError(error));
  }

  const record: CreateRecord = {
    kind: 'create',
    nodeId,
    nodeTitle: input.title,
    parentId: input.parentId,
    parentTitle,
    at: Date.now(),
  };
  const undoSaved = await writeLastEdit(record);
  return { changed: true, undoSaved, record };
}

/**
 * 改标题 / 网址。
 *
 * **只写真的变了的字段** —— 整节点覆盖会把"另一台设备在这期间的并发修改"一起盖掉
 * （`updateNativeNode` 的注释里那条）。两个字段都没动就一次写都不发。
 */
export async function renameBookmarkNode(input: {
  nodeId: string;
  title: string;
  /** 只有书签有；文件夹传 undefined。 */
  url?: string;
}): Promise<EditResult<UpdateRecord>> {
  if (!api()) throw new EditError('api-unavailable', EDIT_UNAVAILABLE_MESSAGE);

  const node = await readNativeNode(input.nodeId);
  const beforeTitle = node.title ?? '';
  const beforeUrl = typeof node.url === 'string' ? node.url : null;

  const patch: { title?: string; url?: string } = {};
  if (input.title !== beforeTitle) patch.title = input.title;
  if (input.url !== undefined && input.url !== beforeUrl) patch.url = input.url;
  if (patch.title === undefined && patch.url === undefined) {
    return { changed: false, undoSaved: false, record: null };
  }

  try {
    await updateNativeNode(input.nodeId, patch);
  } catch (error) {
    throw new EditError('write-failed', describeNativeError(error));
  }

  const record: UpdateRecord = {
    kind: 'update',
    nodeId: input.nodeId,
    nodeTitle: input.title,
    beforeTitle,
    beforeUrl,
    at: Date.now(),
  };
  const undoSaved = await writeLastEdit(record);
  return { changed: true, undoSaved, record };
}

/**
 * 撤销上一次改动：按 kind 做一次反向操作。
 *
 * 三个前提都要当场校验 —— 中间这段时间里节点本身、或它要回到的地方都可能没了
 * （同步推来的删除、用户在书签管理器里删掉）。那种情况必须报错，不能假装撤销成功。
 */
export async function undoLastEdit(): Promise<LastEdit> {
  if (!api()) throw new EditError('api-unavailable', EDIT_UNAVAILABLE_MESSAGE);

  const record = await readLastEdit();
  if (!record) throw new EditError('node-missing', '没有可以撤销的改动。');

  if (record.kind === 'create') {
    // 撤销新建 = 删掉它。**还没同步就删** ⇒ 本地实况回到基线 ⇒ 一个操作都不会推。
    await readNativeNode(record.nodeId);
    try {
      await removeNativeNode(record.nodeId);
    } catch (error) {
      throw new EditError('write-failed', describeNativeError(error));
    }
  } else if (record.kind === 'update') {
    await readNativeNode(record.nodeId);
    try {
      await updateNativeNode(record.nodeId, {
        title: record.beforeTitle,
        ...(record.beforeUrl === null ? {} : { url: record.beforeUrl }),
      });
    } catch (error) {
      throw new EditError('write-failed', describeNativeError(error));
    }
  } else {
    await readNativeNode(record.nodeId);
    await readNativeNode(record.fromParentId);
    const childIds = await readNativeChildIds(record.fromParentId);
    const index = clampDropIndex(record.fromIndex, childIds.length);
    try {
      await moveNativeNode(record.nodeId, record.fromParentId, index);
    } catch (error) {
      throw new EditError('write-failed', describeNativeError(error));
    }
  }

  // 只有真的撤销成功了才清掉记录：失败的撤销还能再试一次。
  await clearLastEdit();
  return record;
}
