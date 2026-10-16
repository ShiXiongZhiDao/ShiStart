import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { loadSettings, saveSettings } from '../services/settings-service';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  THEME_BG,
  type BgPattern,
  type LocaleMode,
  type ShiStartSettings,
  type ResolvedTheme,
  type ThemeMode,
  type ThemePalette,
} from '../types/settings';

// ---------- 模块级单例 ----------
//
// 以前每次 `useSettings()` 都新建一份 `ref`，两个组件同时用就会互相对着写的
// 旧快照盖来盖去（A 调 update() 时读的是它自己那份寥寥无几的副本）。
// 设置页拆成五个分区之后，这份状态至少有六个使用方，必须只有一份。

const settings = ref<ShiStartSettings>({ ...DEFAULT_SETTINGS });
const systemPrefersDark = ref(false);
/** 首次存储读取完成前为 false：开页第一帧不允许播过渡动画（见 App.vue 的 data-boot）。 */
const ready = ref(false);

let mediaQuery: MediaQueryList | null = null;
let loadPromise: Promise<void> | null = null;
let consumerCount = 0;

function syncSystemPreference(event: MediaQueryList | MediaQueryListEvent): void {
  systemPrefersDark.value = event.matches;
}

function attachMediaQuery(): void {
  if (mediaQuery !== null || typeof window === 'undefined') return;
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  syncSystemPreference(mediaQuery);
  mediaQuery.addEventListener('change', syncSystemPreference);
}

function detachMediaQuery(): void {
  mediaQuery?.removeEventListener('change', syncSystemPreference);
  mediaQuery = null;
}

/** 只 load 一次。第二个调用者拿到的是同一个 promise，不会重复读存储。 */
function ensureLoaded(): Promise<void> {
  if (loadPromise === null) {
    loadPromise = (async () => {
      settings.value = await loadSettings();
      attachMediaQuery();
      ready.value = true;
      bindCrossPageSync();
    })();
  }
  return loadPromise;
}

let crossPageSyncBound = false;

/**
 * 另一个页面（设置页）改了偏好 → 本页即时重读。
 * 不监听的话，"在设置页换个图案，已经开着的新标签页不会动"——用户报过。
 * 自己页面的写入也会触发 onChanged：重读是同值幂等，无害。
 */
function bindCrossPageSync(): void {
  if (crossPageSyncBound) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  crossPageSyncBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SETTINGS_KEY in changes)) return;
    void loadSettings().then((next) => {
      settings.value = next;
    });
  });
}

/**
 * 主题 / 语言 / 搜索引擎 / 上次选中分类的读写与生效。
 * 偏好读取失败时使用默认值，不阻止主页显示书签。
 *
 * 主题是两个正交字段：`themePalette`（配色）× `themeMode`（明暗）。
 * 存储存偏好，`resolvedTheme` 是画在页面上的那一档组合（`warm-light` 等），
 * `resolvedMode` 是 system 解析之后的明暗。CSS 块与 theme-color 都按组合命名。
 */
export function useSettings() {
  onMounted(() => {
    consumerCount += 1;
    void ensureLoaded();
  });

  onUnmounted(() => {
    consumerCount -= 1;
    // 最后一个使用方也走了才解绑：这份状态属于页面，不属于某个组件。
    if (consumerCount <= 0) detachMediaQuery();
  });

  /** system 解析之后的明暗。配色没有 system —— 它跟明暗正交。 */
  const resolvedMode = computed<'light' | 'dark'>(() => {
    if (settings.value.themeMode !== 'system') return settings.value.themeMode;
    return systemPrefersDark.value ? 'dark' : 'light';
  });

  const resolvedTheme = computed<ResolvedTheme>(
    () => `${settings.value.themePalette}-${resolvedMode.value}` as ResolvedTheme,
  );

  watchEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolvedTheme.value;
    // 背景图案：与 theme 同一条路写上去，规则在 style.css。
    document.documentElement.dataset.pattern = settings.value.bgPattern;
    // 每行卡片数：网格列数由一条 CSS 公式算，整数从这里喂进去。
    // 与 data-theme 同一条路写到 <html> 上 —— 主页才认它，设置页写了也无害。
    document.documentElement.style.setProperty(
      '--cards-per-row',
      String(settings.value.cardsPerRow),
    );
    // 告诉浏览器当前页面的真实底色。Chrome 会参考新标签页的 theme-color
    // 来决定周边 UI 的配色，页面深浅切换时必须同步，否则会出现色差。
    // 表在 types/settings.ts（必须与 tokens.css 的各 --bg 一致，改色板两处一起改）。
    const themeColor = THEME_BG[resolvedTheme.value];
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', themeColor);
  });

  /**
   * 主题过渡的开闸时机。
   *
   * 色板令牌被注册成"颜色"之后（tokens.css），改 `data-theme` 会**自动**插值出
   * 一条 240ms 的整页过渡 —— 包括"存储读完、把预置配色校正成真配色"那一次。
   * 那一次不是用户动作，让它淡一下等于每次开新标签页都先看半秒错误配色
   * （侧边栏的 `data-boot` 是同一条纪律，只是它守的是别的过渡）。
   *
   * 所以等"最终配色真的画过至少一帧"才开闸：**两跳 rAF** —— 第一跳把校正后的
   * 配色画出去，第二跳才允许过渡。`immediate` 是给晚挂载的使用方：闸门挂在
   * <html> 上是全局的，早开过了就无所谓再开一次。
   */
  watch(
    ready,
    (isReady) => {
      if (!isReady || typeof document === 'undefined') return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.dataset.themeAnim = 'on';
        });
      });
    },
    { immediate: true },
  );

  async function update(patch: Partial<ShiStartSettings>): Promise<void> {
    settings.value = { ...settings.value, ...patch };
    await saveSettings(settings.value);
  }

  /**
   * 主页主题按钮：只切明暗，**只有两站**（浅 ↔ 深）。
   *
   * 既有约定 决策四原本是"三站循环，第三站是跟随系统"；2026-10-15 修订成两站 ——
   * 用户原话："主页切换主题的时候，只需要明暗，不需要跟随系统"。
   * "跟随系统"没有消失，它仍然在设置页的明暗分段控件里（只是按钮够不到）。
   *
   * 存的是 system 时，按**眼下生效的那一档**翻：系统是浅色就切到深色。
   * 反过来（把 system 钉成当前生效值）会让用户点一下发现什么都没变 —— 更糟的反馈。
   */
  async function toggleMode(): Promise<void> {
    await update({ themeMode: resolvedMode.value === 'dark' ? 'light' : 'dark' });
  }

  async function setPalette(palette: ThemePalette): Promise<void> {
    await update({ themePalette: palette });
  }

  async function setMode(mode: ThemeMode): Promise<void> {
    await update({ themeMode: mode });
  }

  async function setPattern(pattern: BgPattern): Promise<void> {
    await update({ bgPattern: pattern });
  }

  async function setLocale(locale: LocaleMode): Promise<void> {
    await update({ locale });
  }

  /** 每行最多几个书签卡片 / 文件夹瓦片。越界的值在 normalize 里就被夹住了。 */
  async function setCardsPerRow(count: number): Promise<void> {
    await update({ cardsPerRow: count });
  }

  return {
    settings,
    resolvedTheme,
    resolvedMode,
    update,
    toggleMode,
    setPalette,
    setMode,
    setPattern,
    setLocale,
    setCardsPerRow,
    ready,
  };
}
