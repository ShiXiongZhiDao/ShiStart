/**
 * 师兄起页书签领域模型。
 *
 * 这里的类型只描述"展示层"看到的东西，不代表需要被持久化。
 * 浏览器原生书签树是唯一事实来源，每次打开新标签页重新读取。
 */

/** 浏览器 Bookmarks API 返回的原始节点（只声明本扩展实际用到的字段）。 */
export interface NativeBookmarkNode {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  index?: number;
  dateAdded?: number;
  children?: NativeBookmarkNode[];
}

/** 一个可点击的书签卡片。 */
export interface BookmarkViewItem {
  /** 原生节点 id，仅在当前浏览器配置文件内有意义。 */
  id: string;
  title: string;
  /** 用于打开、搜索、构建 favicon 地址；卡片本身不展示 URL 文本。 */
  url: string;
  /**
   * 解析出来的协议，形如 `'https:'` / `'file:'` / `'javascript:'`。
   *
   * 卡片靠它决定**怎么打开**：网页协议当普通链接（`<a target="_blank">`），
   * 其余走 `chrome.tabs.create` 并处理失败 —— 实测 `<a>` 点 `chrome://` 与
   * `file://` 会被浏览器静默拦掉（不开标签页）。
   */
  protocol: string;
  domain: string;
  parentId?: string;
  /** 所属的一级目录 id，用于分类筛选。 */
  rootFolderId?: string;
  rootFolderTitle?: string;
  /** 从一级目录到父目录的标题路径，仅用于搜索。 */
  folderPath: string[];
  index?: number;
  dateAdded?: number;
  faviconUrl: string;
  /** favicon 加载失败时展示的首字/缩写。 */
  fallbackLabel: string;
}

/** 顶部的一个分类筛选项。 */
export interface BookmarkFolderFilter {
  /** 原生文件夹 id；"未归类" 使用哨兵值。 */
  id: string;
  title: string;
  /** 该分类下的书签数量，空文件夹为 0。 */
  count: number;
  /** 在树里的层深，根级为 0。给需要缩进的列表用（新建弹窗的目录选择器）。 */
  depth: number;
}

/**
 * 一个目录节点：直接子目录 + 直接挂在该目录下的书签。
 * 树状结构，和浏览器书签管理器的层级一一对应。
 */
export interface BookmarkFolderNode {
  id: string;
  title: string;
  /** 该目录及其全部后代下的书签总数。 */
  count: number;
  /** 直接子目录，保持浏览器原始顺序。 */
  children: BookmarkFolderNode[];
  /** 直接挂在该目录下的书签，保持原始顺序。 */
  bookmarks: BookmarkViewItem[];
}

export interface BookmarkTreeSnapshot {
  /** 根级目录（含合成的"未归类"），保持原始顺序。 */
  roots: BookmarkFolderNode[];
  /** 全部书签的扁平列表，用于全局搜索。 */
  items: BookmarkViewItem[];
}

export interface BookmarkSnapshot {
  folders: BookmarkFolderFilter[];
  bookmarks: BookmarkViewItem[];
}

/** "全部" 的哨兵 id，永远不是一个真实文件夹 id。 */
export const ALL_FOLDERS = 'all';

/** 直接挂在书签根节点下的网址节点，归入这个合成分类。 */
export const UNFILED_FOLDER = '__root__';
export const UNFILED_FOLDER_TITLE = '未归类';

/** 文件夹标题为空时的显示文案。 */
export const UNNAMED_FOLDER_TITLE = '未命名文件夹';

/** 标题为空的书签卡片回退文案。 */
export const FALLBACK_LABEL = '网';
