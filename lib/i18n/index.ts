/**
 * 极简 i18n：**一张中文表 + 一张英文表 + 一个查表函数**。
 *
 * 不引入 vue-i18n 的理由见 既有约定：本项目刻意零运行时依赖，
 * 而需求只有"两档语言、约 200 条静态文案、几个 `{n}` 占位符"。
 *
 * 设计约束：
 * - `lib/` 下必须能在 node 里裸跑（单测环境没有 `chrome`、没有 `document`），
 *   所以探测浏览器语言要一路做存在性判断；
 * - 插值缺失变量时**保留原占位符**，不许替换成空串 —— 那会把信息静默吞掉，
 *   界面上什么也没报；
 * - 查不到 key 时**返回 key 本身**，同样是"宁可露出地层也不要一处空白"。
 */

import { en } from './en';
import { zhCN, type MessageKey } from './zh-CN';
import type { LocaleId, LocaleMode, SearchEngineId } from '../../types/settings';

/** 真正可用的语言。这里没有 `system` —— 它只是一种偏好，不是语言。 */
export const LOCALES: LocaleId[] = ['zh-CN', 'en'];

/** 连浏览器语言都拿不到时的兜底。产品主要面向中文用户。 */
export const DEFAULT_LOCALE: LocaleId = 'zh-CN';

export const MESSAGES: Record<LocaleId, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  en,
};

/**
 * 把"偏好"收敛成"实际生效的语言"。
 *
 * `system` 时只看浏览器界面语言的前缀：以 `zh` 开头一律算 `zh-CN`
 * （`zh-TW` / `zh-HK` 用户看简体中文，虽然不完美，但比看错的语言好；
 * 反过来给用户看一种他还不如看懂英文的语言才是更差的结果）。
 */
export function resolveLocale(
  mode: LocaleMode,
  browserLanguage: string | null | undefined,
): LocaleId {
  if (mode !== 'system') return mode;
  if (typeof browserLanguage !== 'string' || browserLanguage === '') return DEFAULT_LOCALE;
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * 读浏览器界面语言。
 *
 * 扩展页里 `chrome.i18n.getUILanguage()` 是权威来源，但它只在扩展上下文存在；
 * 普通网页与第二代测试环境里要靠 `navigator.language`。
 */
export function detectBrowserLanguage(): string | null {
  const chromeApi = typeof chrome === 'undefined' ? undefined : chrome;
  const fromChrome = chromeApi?.i18n?.getUILanguage?.();
  if (typeof fromChrome === 'string' && fromChrome !== '') return fromChrome;

  // navigator 在 node 环境里也不存在，一样要做存在性判断。
  if (typeof navigator === 'undefined') return null;
  return typeof navigator.language === 'string' ? navigator.language : null;
}

/** `{name}` 形式的插值占位符。 */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * 把模板里的 `{name}` 换成传入的值。
 *
 * 缺变量时**保留原样**：把它换成空串会让"上传  条、下载  条"这种输出
 * 看起来像数据就是空的，而不是"这里本该有个数字"。
 */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** 插值变量表。`t('sync.status.ops', { n: 3 })`。 */
export type TranslateVars = Record<string, string | number>;

export type Translator = (key: MessageKey, vars?: TranslateVars) => string;

/**
 * 造一个查表函数。
 *
 * 未知 key 返回 key 本身，**并且 console.error 一声**。
 *
 * 为什么不再静默：类型只挡得住**字面量** key（`MessageKey = keyof typeof zhCN`，
 * 拼错编译就不过）。挡不住的有两类 —— 动态拼出来的 key，以及**旧构建**
 * （组件还在找已被改名的 key，而语言文件已经换了）。第二类真实发生过：
 * 2026-10-14 用户在新标签页上看到一行裸 `home.folderDelete.summary`
 * （那次是把 key 改名成 `subject`，他跑的是改名中间态的构建）。
 * 原样返回 key 只是让界面"看得出来少了什么"，不吭声的话没人知道去补。
 */
export function createTranslator(locale: LocaleId): Translator {
  const dictionary = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  return (key, vars) => {
    const template = dictionary[key];
    if (typeof template !== 'string') {
      console.error(`[i18n] 缺少文案 key：${key}（locale=${locale}）`);
      return key;
    }
    return interpolate(template, vars);
  };
}

/**
 * 搜索引擎名对应的文案 key。
 *
 * 放在这里而不是各自的使用点：主页的搜索框和设置页的下拉都要用同一张表，
 * 分成两处的话将来加引擎时很容易只改一半。
 */
export const SEARCH_ENGINE_LABEL_KEY: Record<SearchEngineId, MessageKey> = {
  bing: 'engine.bing',
  baidu: 'engine.baidu',
  google: 'engine.google',
};

export type { LocaleId, MessageKey };
