import { computed, onMounted, ref, watchEffect } from 'vue';
import { useSettings } from './useSettings';
import {
  createTranslator,
  detectBrowserLanguage,
  resolveLocale,
  type TranslateVars,
  type Translator,
} from '../lib/i18n';
import type { MessageKey } from '../lib/i18n/zh-CN';
import type { LocaleId, LocaleMode } from '../types/settings';

// 浏览器语言是进程级常量，没必要每个组件各探测一遍。
const browserLanguage = ref<string | null>(null);
let detected = false;

function ensureDetected(): void {
  if (detected) return;
  detected = true;
  browserLanguage.value = detectBrowserLanguage();
}

/**
 * 界面文案。
 *
 * 唯一的入口 —— 组件不许自己 import `lib/i18n` 去查表，也不许自己去读写
 * settings：语言偏好是持久化偏好，跟主题一样属于 `useSettings` 的地盘。
 */
export function useI18n() {
  const { settings, setLocale } = useSettings();
  ensureDetected();

  onMounted(ensureDetected);

  const resolvedLocale = computed<LocaleId>(() =>
    resolveLocale(settings.value.locale, browserLanguage.value),
  );

  const translator = computed<Translator>(() => createTranslator(resolvedLocale.value));

  const t = (key: MessageKey, vars?: TranslateVars): string => translator.value(key, vars);

  watchEffect(() => {
    if (typeof document === 'undefined') return;
    // 让读屏软件与浏览器的拼写检查跟上界面语言。
    document.documentElement.lang = resolvedLocale.value;
  });

  return {
    t,
    /**
     * 与上者同一个函数，只是名字不同：它渲染出来的是 HTML。
     *
     * **只喂 `lib/i18n` 里的常量**。文案里那点 `<strong>` / `<code>` 是仓库内写死的，
     * 一旦有人把用户输入的书签标题塞进来，这里就成了注入面（见 既有约定）。
     */
    tRich: t,
    resolvedLocale,
    setLocale,
  };
}

export type { MessageKey, TranslateVars };
