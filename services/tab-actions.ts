/**
 * 对浏览器标签页 / 窗口的动作（右键菜单里那几个"打开"和"复制"）。
 *
 * ## 为什么不申请 `tabs` 权限
 *
 * `tabs` 权限只用来读标签页的敏感字段（`url` / `title` / `favIconUrl`）。
 * **创建**标签页与窗口不需要它，这里也一个字段都不读 —— 所以权限清单保持
 * `bookmarks` / `favicon` / `storage` / `alarms` 不变（既有约定 的最小权限）。
 *
 * ## 为什么"做不到"必须说出来
 *
 * 两个动作有前置条件，且都**不是我们能在后台悄悄补上的**：
 * - 无痕窗口：用户必须先给扩展打开「允许在无痕模式下运行」，否则 `incognito: true` 直接失败。
 * - 分屏：需要 Chrome 155+ 的 Split View API；Edge 至今没有对外接口。
 *
 * 做不到的时候**绝不静默降级**成一个普通窗口 —— 用户会以为功能生效了，
 * 下次再遇到同样"没反应"就再也说不清是哪里出了问题。
 *
 * ## 失败原因给码，不给文案
 *
 * 抛出的是 `TabActionError`（带机器可读的 `code`），文案由界面查 i18n 表。
 * 直接在服务里写中文，英文界面下就会漏出一句中文（同 既有约定 里设置备份的做法）。
 */

/** 分屏是否是"打开新链接"这件事，由 `chrome.tabs.getCurrent()` 定位当前标签页。 */
interface TabsWithSplit {
  getCurrent?: () => Promise<{ id?: number } | undefined>;
  create?: (props: { url?: string; splitWithTabId?: number }) => Promise<unknown>;
  /** Chrome 155+。旧版本上这个属性根本不存在 —— 用它来做能力探测。 */
  createSplit?: (tabIds: [number, number]) => Promise<unknown>;
}

export interface ExtensionApis {
  tabs?: typeof chrome.tabs & TabsWithSplit;
  windows?: typeof chrome.windows;
  extension?: { isAllowedIncognitoAccess?: () => Promise<boolean> };
}

function apis(): ExtensionApis {
  if (typeof chrome === 'undefined') return {};
  return chrome as unknown as ExtensionApis;
}

/** 失败原因。界面用这张码表去查文案；`copy-failed` 的 `detail` 是那个没复制成功的网址。 */
export type TabActionFailure =
  | 'no-tab-api'
  | 'no-window-api'
  | 'incognito-not-allowed'
  | 'split-unsupported'
  | 'copy-failed';

export class TabActionError extends Error {
  constructor(
    readonly code: TabActionFailure,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'TabActionError';
  }
}

export async function openLinkInNewTab(url: string): Promise<void> {
  const api = apis().tabs;
  if (!api?.create) throw new TabActionError('no-tab-api');
  // 与直接点卡片等价（卡片本身就是 target="_blank"）。
  await api.create({ url });
}

export async function openLinkInNewWindow(url: string): Promise<void> {
  const api = apis().windows;
  if (!api?.create) throw new TabActionError('no-window-api');
  await api.create({ url, focused: true });
}

/** 扩展有没有被允许在无痕 / InPrivate 里运行。没有就开不出无痕窗口。 */
export async function isIncognitoAccessAllowed(): Promise<boolean> {
  const api = apis().extension;
  if (typeof api?.isAllowedIncognitoAccess !== 'function') return false;
  try {
    return await api.isAllowedIncognitoAccess();
  } catch {
    return false;
  }
}

export async function openLinkInIncognitoWindow(url: string): Promise<void> {
  const api = apis().windows;
  if (!api?.create) throw new TabActionError('no-window-api');
  if (!(await isIncognitoAccessAllowed())) throw new TabActionError('incognito-not-allowed');
  try {
    await api.create({ url, incognito: true, focused: true });
  } catch {
    // 探测与真实调用可能不一致（用户刚改过设置、或浏览器策略拦下），照样把话说明白。
    throw new TabActionError('incognito-not-allowed');
  }
}

/** 分屏 API 只有 Chrome 155+ 有；Edge 没有对外接口。 */
export function supportsSplitView(): boolean {
  const api = apis().tabs;
  return typeof api?.createSplit === 'function' && typeof api?.create === 'function';
}

export async function openLinkInSplitView(url: string): Promise<void> {
  const api = apis().tabs;
  if (!supportsSplitView() || !api?.getCurrent || !api.create) {
    throw new TabActionError('split-unsupported');
  }
  // 分屏必须成对：拿当前这个新标签页当另一半，链接落在它旁边，观感就是"左右并排"。
  const current = await api.getCurrent();
  if (!current?.id) throw new TabActionError('split-unsupported');
  try {
    await api.create({ url, splitWithTabId: current.id });
  } catch {
    throw new TabActionError('split-unsupported');
  }
}

/**
 * 复制链接。
 *
 * 优先用 Clipboard API：这个调用来自用户点击，有"用户手势"，扩展页面不需要额外的剪贴板权限。
 * 失败时退回老办法（临时 textarea + execCommand）—— 不是所有环境都肯给这个 API。
 */
export async function copyLink(url: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return;
    }
  } catch {
    // 落到下面的回退
  }

  const area = document.createElement('textarea');
  area.value = url;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    // execCommand 返回 false 也算失败，一并落到下面的码。
    if (!document.execCommand('copy')) throw new Error('copy-rejected');
  } catch {
    throw new TabActionError('copy-failed', url);
  } finally {
    document.body.removeChild(area);
  }
}
