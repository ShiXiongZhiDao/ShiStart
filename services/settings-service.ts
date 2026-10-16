/**
 * 轻量界面偏好的读写。读取失败一律回退默认值，绝不阻塞书签渲染。
 */

import { ALL_FOLDERS } from '../types/bookmarks';
import {
  BG_PATTERNS,
  CARDS_PER_ROW_MAX,
  CARDS_PER_ROW_MIN,
  DEFAULT_SETTINGS,
  LOCALE_MODES,
  SETTINGS_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  THEME_MODES,
  THEME_PALETTES,
  type BgPattern,
  type LocaleMode,
  type ShiStartSettings,
  type SearchEngineId,
  type ThemeMode,
  type ThemePalette,
} from '../types/settings';
import { SEARCH_ENGINE_IDS } from '../lib/search-engines';

/**
 * 既有约定 之前的旧主题枚举（一个字段混了两个维度）。迁移表：
 * 旧存储 / 旧备份里的 `theme` 单值 → 新的 (themePalette, themeMode) 两字段。
 * 备份 version 不涨（涨了旧备份会被整份拒掉，比迁移糟），所以这条路是
 * **长期有效**的，不是一次性补丁。
 *
 * ⚠️ 这张表**不跟着默认值走**：既有约定 把默认配色改成了 youth，但
 * light/dark/system 照旧迁到 warm —— 老用户当年的选择是在暖陶世界里做的，
 * 默认值一变就顺手换色 = 静默改用户设置。
 */
const LEGACY_THEME: Record<string, { themePalette: ThemePalette; themeMode: ThemeMode }> = {
  light: { themePalette: 'warm', themeMode: 'light' },
  dark: { themePalette: 'warm', themeMode: 'dark' },
  // youth 是"恰好只有浅色"的配色 —— 迁成 youth + light，语义原样。
  youth: { themePalette: 'youth', themeMode: 'light' },
  // system 旧模型里只绑架暖陶，迁成暖陶晨光 + 系统，行为不变。
  system: { themePalette: 'warm', themeMode: 'system' },
};

/** 导出以便单测：把任意存储值收敛成合法的偏好。 */
export function normalizeSettings(raw: unknown): ShiStartSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const value = raw as Partial<Record<keyof ShiStartSettings, unknown>>;

  // 新字段优先；缺失说明是旧存档/旧备份，从 legacy `theme` 迁。
  // legacy 字段不在 ShiStartSettings 里，单独取（它只存在于迁移表里）。
  const legacyTheme = (value as { theme?: unknown }).theme;
  const legacy = typeof legacyTheme === 'string' ? LEGACY_THEME[legacyTheme] : undefined;
  const themePalette = THEME_PALETTES.includes(value.themePalette as ThemePalette)
    ? (value.themePalette as ThemePalette)
    : (legacy?.themePalette ?? DEFAULT_SETTINGS.themePalette);
  const themeMode = THEME_MODES.includes(value.themeMode as ThemeMode)
    ? (value.themeMode as ThemeMode)
    : (legacy?.themeMode ?? DEFAULT_SETTINGS.themeMode);

  // 背景图案：缺字段 = 0063 之前的老存档 → 'none'，不偷袭；非法值同样
  // 收敛 'none'，不猜。新装也已经是 'none' 了（2026-10-16 改了默认），两边一致。
  const bgPattern = BG_PATTERNS.includes(value.bgPattern as BgPattern)
    ? (value.bgPattern as BgPattern)
    : 'none';

  // 后加的字段：老用户存的对象里没有它，这里静默补成默认值。
  // 这也是"导入设置"敢直接喂 foreign JSON 的原因 —— 进来之前必然先过这里。
  const locale = LOCALE_MODES.includes(value.locale as LocaleMode)
    ? (value.locale as LocaleMode)
    : DEFAULT_SETTINGS.locale;

  const searchEngine = SEARCH_ENGINE_IDS.includes(value.searchEngine as SearchEngineId)
    ? (value.searchEngine as SearchEngineId)
    : DEFAULT_SETTINGS.searchEngine;

  const selectedFolderId =
    typeof value.selectedFolderId === 'string' && value.selectedFolderId !== ''
      ? value.selectedFolderId
      : ALL_FOLDERS;

  const sidebarWidth = normalizeWidth(value.sidebarWidth);
  // 默认收起：缺字段 = 0069 之前的老存档/新装，一律落 DEFAULT（true）。
  // 开发阶段零用户，没有"不偷袭老用户"的特判需求 —— 将来有用户了再改默认值时，
  // 照 bgPattern 的先例补"缺字段落旧默认"。
  const sidebarCollapsed =
    typeof value.sidebarCollapsed === 'boolean'
      ? value.sidebarCollapsed
      : DEFAULT_SETTINGS.sidebarCollapsed;
  // 每行卡片数：缺字段 / 非法值落默认；在范围内的数**四舍五入并夹紧** ——
  // 滑块给的一定是整数，但导入的备份里可能是别的数，照 normalizeWidth 的先例处理。
  const cardsPerRow = normalizeCardsPerRow(value.cardsPerRow);
  const dragToArrange =
    typeof value.dragToArrange === 'boolean'
      ? value.dragToArrange
      : DEFAULT_SETTINGS.dragToArrange;
  const editBookmarks =
    typeof value.editBookmarks === 'boolean'
      ? value.editBookmarks
      : DEFAULT_SETTINGS.editBookmarks;
  // 右缘「最近访问」面板：缺字段 = 0088 之前的老存档 → 默认开。
  // 默认开与 sidebarCollapsed 的"缺字段落旧默认"不是一回事：那边默认值是
  // 后改的，这边默认开就是产品决策本身，老存档没有这个字段时照新默认走。
  const recentPanel =
    typeof value.recentPanel === 'boolean' ? value.recentPanel : DEFAULT_SETTINGS.recentPanel;

  return {
    themePalette,
    themeMode,
    bgPattern,
    locale,
    searchEngine,
    selectedFolderId,
    sidebarWidth,
    sidebarCollapsed,
    cardsPerRow,
    dragToArrange,
    editBookmarks,
    recentPanel,
  };
}

function normalizeWidth(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(raw)));
}

/** 每行卡片数：非法值落默认，合法数四舍五入后夹进 [4, 12]。 */
function normalizeCardsPerRow(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS.cardsPerRow;
  return Math.min(CARDS_PER_ROW_MAX, Math.max(CARDS_PER_ROW_MIN, Math.round(raw)));
}

export async function loadSettings(): Promise<ShiStartSettings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: ShiStartSettings): Promise<void> {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch {
    // 偏好保存失败不影响使用，静默忽略。
  }
}

/**
 * 上次选中的分类可能已经不存在了（用户在书签管理器里删掉了那个文件夹）。
 * 这种情况回退到"全部"。
 */
export function resolveSelectedFolder(
  stored: string,
  folderIds: readonly string[],
): string {
  if (stored === ALL_FOLDERS) return ALL_FOLDERS;
  // 文件夹列表还没加载出来时先沿用存储值，否则会先闪回"全部"再跳回原分类。
  if (folderIds.length === 0) return stored;
  return folderIds.includes(stored) ? stored : ALL_FOLDERS;
}
