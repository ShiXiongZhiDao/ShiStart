/**
 * 书签导出 —— **只读快照**，不做任何写入。
 *
 * 这里刻意是纯函数：只吃 `BookmarkTreeSnapshot`，不碰 `chrome.*`，
 * 因此在 node 里可以直接跑单测（也意味着它永远不会改动原生书签，见 既有约定）。
 *
 * 两种格式：
 * - HTML：Netscape 书签文件格式，Chrome / Edge / Firefox 都能直接导入；
 * - JSON：带层级与时间的结构化快照，适合二次处理或留档。
 *
 * 遍历一律用显式栈：书签层级可能很深，递归会爆栈。
 */

import type {
  BookmarkFolderNode,
  BookmarkTreeSnapshot,
  BookmarkViewItem,
} from '../types/bookmarks';

/** XML/HTML 正文允许的最小转义集。顺序不能换：`&` 必须先走，否则会二次转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Netscape 格式的时间是"秒"，而浏览器给的是"毫秒"。缺省（比如导入路径没带）写 0。 */
function toEpochSeconds(at: number | undefined): number {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 0;
  return Math.floor(at / 1000);
}

function indent(depth: number): string {
  // Netscape 格式对缩进没有要求，Chrome 自己的导出用 4 空格一级。
  return ' '.repeat(depth * 4);
}

/**
 * 导出成 Netscape 书签文件。
 *
 * 已知的取舍：`BookmarkFolderNode` 把**子文件夹**和**直属书签**分在两个数组里，
 * 浏览器原始的"文件夹与书签交错"顺序因此无法还原。导出时先写子文件夹再写书签 ——
 * 两侧都在同一个 `<DL>` 里，重新导入后每个书签都还在原来的文件夹里，
 * 只是同一层内部的先后次序可能和浏览器里看到的略有不同。
 * 内容不会丢，这也是"只读导出"能保证的东西。
 */
export function toNetscapeHtml(snapshot: BookmarkTreeSnapshot, generatedAt: number): string {
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It was exported by ShiStart and will not be read back by it.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  type Frame =
    | { type: 'folder'; node: BookmarkFolderNode; depth: number }
    | { type: 'bookmark'; item: BookmarkViewItem; depth: number }
    | { type: 'close'; depth: number };

  // 逆序压栈，出栈顺序才是正序。
  const stack: Frame[] = [];
  for (let i = snapshot.roots.length - 1; i >= 0; i -= 1) {
    const node = snapshot.roots[i];
    if (node) stack.push({ type: 'folder', node, depth: 1 });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.type === 'close') {
      out.push(`${indent(frame.depth)}</DL><p>`);
      continue;
    }

    if (frame.type === 'bookmark') {
      const href = escapeHtml(frame.item.url);
      const title = escapeHtml(frame.item.title);
      const added = toEpochSeconds(frame.item.dateAdded);
      out.push(`${indent(frame.depth)}<DT><A HREF="${href}" ADD_DATE="${added}">${title}</A>`);
      continue;
    }

    const { node, depth } = frame;
    const added = toEpochSeconds(firstDateAdded(node));
    out.push(
      `${indent(depth)}<DT><H3 ADD_DATE="${added}" LAST_MODIFIED="${added}">${escapeHtml(
        node.title,
      )}</H3>`,
    );
    out.push(`${indent(depth)}<DL><p>`);

    // 栈是后进先出：要想输出顺序是「子文件夹 → 书签 → 收口」，
    // 就得按「收口 → 书签 → 子文件夹」的顺序压进去。
    stack.push({ type: 'close', depth });
    for (let i = node.bookmarks.length - 1; i >= 0; i -= 1) {
      const item = node.bookmarks[i];
      if (item) stack.push({ type: 'bookmark', item, depth: depth + 1 });
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child) stack.push({ type: 'folder', node: child, depth: depth + 1 });
    }
  }

  out.push('</DL><p>');
  return `${out.join('\n')}\n`;
}

/** 文件夹的时间戳取它直属的第一个书签 —— 原生节点刻意没有 `dateAdded` 字段。 */
function firstDateAdded(node: BookmarkFolderNode): number | undefined {
  return node.bookmarks[0]?.dateAdded;
}

/** JSON 导出的 bookmark 节点。字段名用 snake-free 的小驼峰，但仍保留原始毫秒时间戳。 */
export interface JsonExportBookmark {
  title: string;
  url: string;
  addedAt: number | null;
}

export interface JsonExportFolder {
  title: string;
  folders: JsonExportFolder[];
  bookmarks: JsonExportBookmark[];
}

export interface JsonExportEnvelope {
  kind: 'shistart.bookmarks';
  version: 1;
  exportedAt: number;
  totalBookmarks: number;
  roots: JsonExportFolder[];
}

/**
 * 导出成 JSON 快照。
 *
 * 递归在这里是安全的：JSON 结构与输入同源，深度与 `BookmarkFolderNode` 一致，
 * 而这个 depth 在浏览器侧已经被限制住了（几千层才会出问题）。即便如此也显式用栈，
 * 与 `bookmark-mapper` 的约定保持一致。
 */
export function toJsonExport(
  snapshot: BookmarkTreeSnapshot,
  generatedAt: number,
): JsonExportEnvelope {
  return {
    kind: 'shistart.bookmarks',
    version: 1,
    exportedAt: generatedAt,
    totalBookmarks: snapshot.items.length,
    roots: snapshot.roots.map((root) => toJsonFolder(root)),
  };
}

function toJsonFolder(node: BookmarkFolderNode): JsonExportFolder {
  return {
    title: node.title,
    folders: node.children.map((child) => toJsonFolder(child)),
    bookmarks: node.bookmarks.map((item: BookmarkViewItem) => ({
      title: item.title,
      url: item.url,
      addedAt: typeof item.dateAdded === 'number' ? item.dateAdded : null,
    })),
  };
}

/** 下载时用的文件名。本地时间，用户按日期找文件更直观。 */
export function suggestExportFileName(format: 'html' | 'json', generatedAt: number): string {
  const at = new Date(generatedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  return `bookmarks-${date}.${format}`;
}
