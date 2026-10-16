import { ALL_FOLDERS } from './bookmarks';

/**
 * 配色方案：一套完整的视觉个性 —— 色相、品牌标识、圆角、背景光、
 * 投影色调。**不管明暗**：同一套配色有浅深两呈（theme × mode 的组合）。
 * 目前两套：暖陶晨光与青柠夏夜；定名见 既有约定。
 */
export type ThemePalette = 'warm' | 'youth';

/**
 * 明暗模式：只管亮度反转，**不拥有任何色相**。
 * `system` 不是一档明暗，而是"跟着操作系统走"的解析规则，对每一套配色都生效
 * （既有约定 起；既有约定 及以前它只绑架暖陶）。
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 主题 = 配色 × 明暗的组合。`data-theme` 属性与 CSS 块按它命名。 */
export type ResolvedTheme = `${ThemePalette}-${'light' | 'dark'}`;

/** 配色的全部合法取值。读取存储时用它把任意值收敛成合法值。 */
export const THEME_PALETTES: ThemePalette[] = ['warm', 'youth'];

/** 明暗的全部合法取值。 */
export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

/**
 * 背景图案：铺在新标签页主内容区底色上的纸纹。纯 CSS 渐变令牌，
 * 不存图、不发请求；颜色跟配方主色，强度按明暗定死，用户不可调。
 * `none` 是关闭档。0063 之前存的对象没有这个字段 —— 读取时收敛成 'none'。
 */
export type BgPattern = 'none' | 'dots' | 'checker' | 'grid';

/** 背景图案的全部合法取值。 */
export const BG_PATTERNS: BgPattern[] = ['none', 'dots', 'checker', 'grid'];

/** 四套主题组合的真实底色（theme-color meta 用）。必须与 tokens.css 的各 --bg 一致。 */
export const THEME_BG: Record<ResolvedTheme, string> = {
  'warm-light': '#faf5ec',
  'warm-dark': '#171310',
  'youth-light': '#f3f9f1',
  'youth-dark': '#0f1611',
};

/**
 * 界面语言的**偏好**。`system` 表示跟随浏览器界面语言，它本身不是一种语言。
 * 实际生效的语言由 `lib/i18n` 的 `resolveLocale()` 收敛成 `LocaleId`。
 */
export type LocaleMode = 'zh-CN' | 'en' | 'system';

/** 真正拿去查字典的语言，只有两档 —— 这里没有 `system`。 */
export type LocaleId = 'zh-CN' | 'en';

export type SearchEngineId = 'bing' | 'baidu' | 'google';

/**
 * 只保存轻量界面偏好。完整书签树、URL 副本、搜索历史一律不入库。
 *
 * 主题是两个正交字段：配色 × 明暗。曾经是一个四值枚举
 * （light/dark/youth/system），那个模型把两个维度混在了一起——见 既有约定。
 */
export interface ShiStartSettings {
  /** 配色方案。 */
  themePalette: ThemePalette;
  /** 明暗模式；`system` 表示跟随操作系统。 */
  themeMode: ThemeMode;
  /** 背景图案。0063 之前存的对象没有这个字段，读取时收敛成 'none'。 */
  bgPattern: BgPattern;
  /** 界面语言偏好。后加的字段：老用户存的对象里没有它，读取时收敛成 'system'。 */
  locale: LocaleMode;
  searchEngine: SearchEngineId;
  selectedFolderId: string;
  /** 侧边栏宽度（px），可拖动调整。 */
  sidebarWidth: number;
  /** 侧边栏是否收起。收起后主区吃满宽度，左缘热区可浮出侧边栏。 */
  sidebarCollapsed: boolean;
  /**
   * 书签卡片与文件夹瓦片**每行最多几个**。上限，不是固定值 ——
   * 窗口窄时自动减列。默认 6（1080p 下每列约 300px；旧的自适应近似 8 列约 197px，
   * 被判定为拥挤）。
   */
  cardsPerRow: number;
  /**
   * 主页能不能直接拖书签与文件夹（排序 / 改归属），既有约定。
   * 默认开。关掉只影响手势，不影响别的功能 —— 它是给"怕手滑"的人留的出口，
   * 不是功能闸门（删除那条已经撤销过一次闸门，见 既有约定 的修订）。
   */
  dragToArrange: boolean;
  /**
   * 主页能不能新建 / 改名书签与文件夹，默认开。
   * 与 `dragToArrange` 分开：拖拽已经上线并调好了手感，别把它跟新功能捆在一起改。
   */
  editBookmarks: boolean;
  /**
   * 主页右缘「最近访问」浮出面版开不开，默认开。
   * 面板读取浏览器自己的浏览历史来显示（manifest 的 `history` 权限就是这个
   * 用途，别无他用）—— 历史本身**不另存副本、不上传**；上云的只有这个开关。
   */
  recentPanel: boolean;
}

export const SETTINGS_KEY = 'shistart.settings.v1';

export const SIDEBAR_MIN_WIDTH = 168;
export const SIDEBAR_MAX_WIDTH = 460;
export const SIDEBAR_DEFAULT_WIDTH = 216;

/**
 * 书签卡片 / 文件夹瓦片**每行最多几个**。
 *
 * 是**上限**不是固定值：窗口窄到放不下这么多列时会自动往下减（列宽有下限）。
 * 所以上限那头取 12 —— 在常见分辨率上它还够不到列宽下限，等价于旧的"能塞几个算几个"。
 * ⚠️ 默认值与 tokens.css 的 `--cards-per-row` 必须一致（改一处要改两处，
 *     与 THEME_BG 同一个规矩）。
 */
export const CARDS_PER_ROW_MIN = 4;
export const CARDS_PER_ROW_MAX = 12;
export const CARDS_PER_ROW_DEFAULT = 6;

/** 语言偏好的全部合法取值，用于把任意存储值收敛成合法值。 */
export const LOCALE_MODES: LocaleMode[] = ['zh-CN', 'en', 'system'];

export const DEFAULT_SETTINGS: ShiStartSettings = {
  // 默认配色 = 青柠夏夜。老用户不受影响：存过值的原样保留，
  // 更老的单值 theme 仍按迁移表（见 settings-service.ts）落到暖陶晨光。
  themePalette: 'youth',
  themeMode: 'system',
  // 默认不铺图案（2026-10-16 用户要求，此前是点阵纸 'dots'）。先干净的新标签页，
  // 想要纸纹的人自己去外观分区挑 —— 默认值是个减法，不替用户先铺一层。
  bgPattern: 'none',
  locale: 'system',
  // 默认引擎 = Google。与配色那条同一个规矩：**老存档里显式存着
  // 别的引擎的原样保留** —— 用户当年是在那个引擎的世界里做的选择，默认值一变
  // 就顺手替他换掉是偷袭（既有约定 决策二）。只有"压根没存过这个字段"的
  // 老存档与全新安装才落到这里。
  searchEngine: 'google',
  selectedFolderId: ALL_FOLDERS,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  // 默认收起：主区全宽是默认面貌，侧边栏靠左缘热区浮出 / `[` / 钉住。
  // 开发阶段零用户，不做"缺字段落旧默认"的特判 —— normalize 照落这里。
  sidebarCollapsed: true,
  cardsPerRow: CARDS_PER_ROW_DEFAULT,
  dragToArrange: true,
  editBookmarks: true,
  // 右缘「最近访问」默认开：默认开的功能不该再让用户去找开关。
  // 它是第 12 个上云字段 —— 加它的时候 satisfies 全集编译不过，就是逼着
  // 对"上不上云"表态（见 SYNCED_SETTING_MAP 的注释）。
  recentPanel: true,
};

/**
 * 会随同步空间上云的偏好字段：**目前是全集十二项**。
 *
 * 写成"每个字段都要显式表态"的形状（`satisfies Record<keyof ShiStartSettings, true>`），
 * 而不是一个字符串数组：加第 13 个偏好字段时这里会**编译不过**，逼着人决定它
 * 上不上云。写成数组的话新字段会**静默**跟着上云 —— 那是"新增了对外上传行为，
 * 却没有任何一处要求谁点过头"。
 * （第 12 项 `recentPanel` 就是这样加进来的，既有约定：默认 true，但上云的
 *  只是开关本身，历史数据从不离开本机。）
 */
const SYNCED_SETTING_MAP = {
  themePalette: true,
  themeMode: true,
  bgPattern: true,
  locale: true,
  searchEngine: true,
  selectedFolderId: true,
  sidebarWidth: true,
  sidebarCollapsed: true,
  cardsPerRow: true,
  dragToArrange: true,
  editBookmarks: true,
  recentPanel: true,
} satisfies Record<keyof ShiStartSettings, true>;

/** 一个会跟着同步空间走的偏好字段。 */
export type SyncedSettingKey = keyof typeof SYNCED_SETTING_MAP;

/** 上云字段清单。顺序无关（逐字段 LWW，各算各的）。 */
export const SYNCED_SETTING_KEYS: readonly SyncedSettingKey[] = Object.keys(
  SYNCED_SETTING_MAP,
) as SyncedSettingKey[];
