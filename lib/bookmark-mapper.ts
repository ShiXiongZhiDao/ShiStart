/**
 * 把浏览器原生书签树转换成展示模型。
 *
 * 这里刻意保持纯函数：不触碰任何 chrome.* API，favicon 地址由调用方注入，
 * 因此可以在没有浏览器环境的情况下被单元测试覆盖。
 *
 * 遍历全部使用显式栈而不是递归 —— 书签层级可能非常深，递归会爆栈。
 */

import {
  FALLBACK_LABEL,
  UNFILED_FOLDER,
  UNFILED_FOLDER_TITLE,
  UNNAMED_FOLDER_TITLE,
  type BookmarkFolderFilter,
  type BookmarkFolderNode,
  type BookmarkViewItem,
  type BookmarkTreeSnapshot,
  type NativeBookmarkNode,
} from '../types/bookmarks';

export interface MapOptions {
  /** 由调用方注入，生产环境使用 chrome.runtime.getURL('/_favicon/')。 */
  buildFaviconUrl?: (pageUrl: string) => string;
}

/**
 * 解析一条书签地址。**任何能解析的协议都收**。
 *
 * 以前这里只放行 http/https，其余一律 `null` —— 那些节点因此在主页上**整条消失**
 * （连计数与搜索都不含）。可用户是在浏览器里存的书签，主页凭什么替他藏起来：
 * 他存了 `javascript:` 书签小工具、`file://` 本地文件、`chrome://` 内部页，
 * 打开主页却一条都看不见，还不知道为什么。
 *
 * 现在口径是「**浏览器里有什么就显示什么**」：协议只决定**怎么打开**（见
 * `isWebProtocol`）与**要不要参与同步**（同步仍只收 http/https，见 既有约定）。
 */
export function parseBookmarkUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * 是不是"网页协议"。
 *
 * 用途有两个，都是**能力问题**而不是"该不该显示"：
 * - 卡片能不能当普通链接（`<a target="_blank">`）点 —— 非网页协议的链接会被浏览器
 *   静默拦掉（实测 `chrome://` 与 `file://` 的 `<a>` 点击**不开标签页**），得走
 *   `chrome.tabs.create` 并处理失败；
 * - 参不参与同步 —— 只有它能跨设备成立（`file:///C:/...` 在另一台机器上是空的）。
 */
export function isWebProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

/** 这些主机名上 `https` 通常是假的（本地开发机、内网、局域网），补 `http` 更可能对。 */
function looksLocal(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export interface CoercedUrl {
  /** 真正交给浏览器的地址。 */
  url: string;
  /**
   * 这条地址**参不参与师兄起页的同步**（只有 http/https 参与，既有约定）。
   *
   * `false` 不代表主页看不见 —— 现在主页什么都显示；它只表示
   * "换一台设备就没了"（`file:///C:/x.html` 在别的机器上是空的），
   * 所以弹窗里那句话说的是同步，不是显示。
   */
  syncable: boolean;
}

/** 写没写协议：`scheme://` 算写了；少数不带 `//` 的协议单独认。 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEME_WITHOUT_SLASHES = /^(mailto|javascript|data|about|tel):/i;

/**
 * 把用户输入修成"浏览器肯收的地址"。
 *
 * 为什么不能只做"不校验"：**浏览器自己就会拒掉一部分**。实测
 * `chrome.bookmarks.create`（探针 `F:/temp/probe-url-accept.mjs`）：
 * `example.com` / `www.baidu.com` / 一个内网地址 / `就是一个词` 一律 `Invalid URL.`；
 * （内网地址的字面值刻意不写出：私网地址是发布前扫描的四类形状之一，写出来每次都红。）
 * 而 `localhost:3000` 它自己会补成 `http://localhost:3000/`；
 * `file://` `chrome://` `javascript:` `ftp://` `mailto:` 照收不误。
 *
 * 所以这里的立场是：**替用户把能修好的修好，修不好的明确报错，修好但主页显示不出来的
 * 明确告知**（`displayable`）。返回 `null` 只表示"连浏览器都会拒"。
 */
export function coerceBookmarkUrl(raw: string): CoercedUrl | null {
  const value = raw.trim();
  if (value === '') return null;

  // ① 写了协议：原样交给浏览器。它接受的形状比我们多（mailto: / ftp: / javascript: …），
  //    我们只负责标出"这条主页看得见吗"。
  if (HAS_SCHEME.test(value) || SCHEME_WITHOUT_SLASHES.test(value)) {
    try {
      const parsed = new URL(value);
      return { url: parsed.href, syncable: isWebProtocol(parsed.protocol) };
    } catch {
      return null;
    }
  }

  // ② 没写协议（`example.com`、`localhost:3000`、一个内网地址）——补一个再试。
  //    （内网 IP 的字面值刻意留白：私网地址是公开发布扫描的四类形状之一，写了每次都红。
  //     它是注释里的示例，不是配置 —— 但扫描器分不出这两种，所以这里统一不写。）
  //    ⚠️ 别拿 `new URL(value)` 先试：`localhost:3000` 会被当成"协议 localhost:"解析成功，
  //    于是漏到 ① 去、还挂上"主页显示不出来"的错误警告（第一版就这么错）。
  //    ⚠️ 也别用 `http://` 兜底：2026 年绝大多数站点是 https，补 http 要多一次跳转、
  //    还可能撞 HSTS；只有本机 / 内网才补 http。
  try {
    const parsed = new URL(`https://${value}`);
    const host = parsed.hostname;
    // 光一个词（"就是一个词"）解析出来是没有点的主机名 —— 浏览器地址栏对它的处理是
    // "去搜索"，不是"当网站打开"。要求有点、或是 localhost、或是 IP 字面量。
    const ipLike = /^[\d.]+$/.test(host) || host.includes(':');
    if (host === '' || (!host.includes('.') && host !== 'localhost' && !ipLike)) return null;

    if (looksLocal(host)) {
      return {
        url: `http://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`,
        syncable: true,
      };
    }
    return { url: parsed.href, syncable: true };
  } catch {
    return null;
  }
}

/** 取标题前 1–2 个字符；用 Array.from 避免把 emoji 代理对切成两半。 */
export function fallbackLabel(title: string): string {
  const value = title.trim();
  if (!value) return FALLBACK_LABEL;
  return Array.from(value).slice(0, 2).join('');
}

export function displayFolderTitle(title: unknown): string {
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : UNNAMED_FOLDER_TITLE;
}

function isUrlNode(node: NativeBookmarkNode): boolean {
  return typeof node.url === 'string' && node.url !== '';
}

function hasUsableId(node: NativeBookmarkNode): boolean {
  return typeof node.id === 'string' && node.id !== '';
}

function mapUrlNode(
  node: NativeBookmarkNode,
  rootFolderId: string | undefined,
  rootFolderTitle: string | undefined,
  folderPath: string[],
  buildFaviconUrl: (pageUrl: string) => string,
): BookmarkViewItem | null {
  if (!hasUsableId(node)) return null;
  // **任何协议都收**：浏览器里有什么就显示什么。
  const parsed = parseBookmarkUrl(node.url);
  if (!parsed) return null;

  const isWeb = isWebProtocol(parsed.protocol);
  const rawTitle = typeof node.title === 'string' ? node.title.trim() : '';
  // 标题留空时的兜底：网页用主机名；`file://` / `javascript:` 这类主机名是空的，
  // 退回协议名（`file` / `javascript`）——总比空白好，而且稳定。
  const titleFallback = parsed.hostname || parsed.protocol.replace(':', '');
  const title = rawTitle !== '' ? rawTitle : titleFallback;

  return {
    id: node.id,
    title,
    url: parsed.href,
    protocol: parsed.protocol,
    // 颜色的种子：非网页协议没有主机名（`file://` 是空、`javascript:` 是空），
    // 用协议名当种子 ⇒ 同类地址颜色一致且稳定。
    domain: (parsed.hostname || parsed.protocol.replace(':', '')).replace(/^www\./i, ''),
    parentId: node.parentId,
    rootFolderId,
    rootFolderTitle,
    folderPath,
    index: node.index,
    dateAdded: node.dateAdded,
    // ⚠️ 非网页协议**不发 favicon 请求**：`_favicon` 只查本地缓存，对没访问过的
    // 协议返回占位图，还要靠那套 RGBA 签名比对才认得出（见 既有约定xx 与
    // `services/favicon-default.ts`）。直接给空串 ⇒ `SiteIcon` 走字母牌，零请求。
    faviconUrl: isWeb ? buildFaviconUrl(parsed.href) : '',
    fallbackLabel: fallbackLabel(title),
  };
}

/**
 * 深度优先构建一棵目录子树。
 * 子目录节点先创建、再压栈处理，因此不依赖递归调用栈。
 */
function buildFolderNode(
  native: NativeBookmarkNode,
  title: string,
  rootFolderId: string,
  rootFolderTitle: string,
  parentPath: string[],
  items: BookmarkViewItem[],
  buildFaviconUrl: (pageUrl: string) => string,
): BookmarkFolderNode {
  const folder: BookmarkFolderNode = {
    id: native.id,
    title,
    count: 0,
    children: [],
    bookmarks: [],
  };

  const stack: Array<{
    native: NativeBookmarkNode;
    folder: BookmarkFolderNode;
    path: string[];
  }> = [{ native, folder, path: parentPath }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.native.children;
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      if (!child || typeof child !== 'object') continue;

      if (isUrlNode(child)) {
        const item = mapUrlNode(child, rootFolderId, rootFolderTitle, frame.path, buildFaviconUrl);
        if (item) {
          frame.folder.bookmarks.push(item);
          items.push(item);
        }
        continue;
      }

      if (!hasUsableId(child)) continue;
      const childTitle = displayFolderTitle(child.title);
      const childNode: BookmarkFolderNode = {
        id: child.id,
        title: childTitle,
        count: 0,
        children: [],
        bookmarks: [],
      };
      frame.folder.children.push(childNode);
      stack.push({ native: child, folder: childNode, path: [...frame.path, childTitle] });
    }
  }

  return folder;
}

/** 后序遍历算出每个目录的后代书签总数，同样用显式栈。 */
function computeCounts(roots: BookmarkFolderNode[]): void {
  const stack: Array<{ node: BookmarkFolderNode; phase: 'enter' | 'exit' }> = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const node = roots[i];
    if (node) stack.push({ node, phase: 'enter' });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.phase === 'exit') {
      let total = frame.node.bookmarks.length;
      for (const child of frame.node.children) total += child.count;
      frame.node.count = total;
      continue;
    }
    stack.push({ node: frame.node, phase: 'exit' });
    for (let i = frame.node.children.length - 1; i >= 0; i -= 1) {
      const child = frame.node.children[i];
      if (child) stack.push({ node: child, phase: 'enter' });
    }
  }
}

/**
 * 根节点 children 里可能是文件夹（正常情况），也可能直接挂着网址节点
 * （部分导入路径会产生）。后者没有一级目录可归属，单独收进 "未归类"，
 * 否则它们会出现在搜索结果里、却无法从侧边栏到达。
 */
export function mapBookmarkTree(
  tree: NativeBookmarkNode[],
  options: MapOptions = {},
): BookmarkTreeSnapshot {
  const buildFaviconUrl = options.buildFaviconUrl ?? (() => '');
  const root = tree[0];
  const rootChildren = root?.children ?? [];

  const roots: BookmarkFolderNode[] = [];
  const items: BookmarkViewItem[] = [];

  for (const node of rootChildren) {
    if (!node || typeof node !== 'object' || !hasUsableId(node)) continue;

    if (isUrlNode(node)) {
      const item = mapUrlNode(
        node,
        UNFILED_FOLDER,
        UNFILED_FOLDER_TITLE,
        [],
        buildFaviconUrl,
      );
      if (item) items.push(item);
      continue;
    }

    const title = displayFolderTitle(node.title);
    roots.push(buildFolderNode(node, title, node.id, title, [title], items, buildFaviconUrl));
  }

  const unfiled = items.filter((item) => item.rootFolderId === UNFILED_FOLDER);
  if (unfiled.length > 0) {
    roots.push({
      id: UNFILED_FOLDER,
      title: UNFILED_FOLDER_TITLE,
      count: unfiled.length,
      children: [],
      bookmarks: unfiled,
    });
  }

  computeCounts(roots);
  return { roots, items };
}

/** 按 id 在目录树里找节点，找不到返回 null。 */
export function findFolderNode(
  roots: BookmarkFolderNode[],
  id: string,
): BookmarkFolderNode | null {
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === id) return node;
    for (const child of node.children) stack.push(child);
  }
  return null;
}

/** 从一级目录到目标目录的链路，用于面包屑。找不到返回空数组。 */
export function folderPathOf(
  roots: BookmarkFolderNode[],
  id: string,
): BookmarkFolderNode[] {
  const stack: Array<{ node: BookmarkFolderNode; path: BookmarkFolderNode[] }> = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const node = roots[i];
    if (node) stack.push({ node, path: [node] });
  }

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    if (frame.node.id === id) return frame.path;
    for (let i = frame.node.children.length - 1; i >= 0; i -= 1) {
      const child = frame.node.children[i];
      if (child) stack.push({ node: child, path: [...frame.path, child] });
    }
  }
  return [];
}

/** 把树拍平成一维分类列表（树的先序），供默认选中与有效性校验使用。 */
/**
 * 把目录树拍扁成一维列表（深度优先，**显式栈迭代，不递归** —— 深层书签树会爆调用栈）。
 *
 * 每项带 `depth`，供需要缩进的列表用（新建弹窗的"保存到文件夹"）。
 * 顺序是"先父后子"，同层保持浏览器原始顺序。
 */
export function flattenFolders(roots: BookmarkFolderNode[]): BookmarkFolderFilter[] {
  const out: BookmarkFolderFilter[] = [];
  // 栈里放 {node, depth} 对：拍扁还要知道每项沉到哪一层。
  const stack: { node: BookmarkFolderNode; depth: number }[] = roots
    .map((node) => ({ node, depth: 0 }))
    .reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    const { node, depth } = entry;
    out.push({ id: node.id, title: node.title, count: node.count, depth });
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return out;
}
