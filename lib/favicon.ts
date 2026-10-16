/**
 * 使用浏览器自带的扩展 Favicon 机制取图标。
 * 不发起自定义 fetch、不申请任何站点 host permission。
 *
 * ⚠️ `size` 是**要浏览器缩放到多大**，不是"原图像素尺寸"。实测（Chrome 154）：
 * 无论请求 16 还是 256，返回的位图边长**恒等于请求值** —— 缓存里只有 16px 时，
 * 请求 64 会得到一张放大过的模糊 64。所以它**不能**用来判断原图清不清晰。
 */
export function createFaviconUrl(pageUrl: string, size = 32): string {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

/**
 * 卡片图标槽的 CSS 边长。**改这个值要同时改 `style.css` 的 `.site-icon`** ——
 * `srcset` 的 `sizes` 描述必须与实际渲染尺寸一致，否则浏览器会挑错档位。
 * （`lib/favicon.test.ts` 有一条用例直接读 `style.css` 校验两处一致。）
 *
 * 定 24px 的理由：favicon 的常见源尺寸只有 **16 / 32px**，而槽位在实际屏幕上占的
 * 物理像素是 `CSS × DPR`。槽越大，源要放大的倍数越高、越糊 —— 对只有 16px favicon
 * 的内网站点尤其明显。24px 在 1.25× 屏上占 30 个物理像素，32px 的源是**被缩小**画的
 * （缩小永远比放大锐），16px 源的放大倍数也从 28px 时的 2.19× 降到 1.88×。
 * 凭"要更多像素"盲目放大是错的 —— 源不够时那只是把糊一起放大。
 */
export const FAVICON_CSS_SIZE = 24;

/**
 * 供 `srcset` 用的候选尺寸。浏览器按 `FAVICON_CSS_SIZE × devicePixelRatio` 挑档，
 * **只会真下载挑中的那一张**：
 *
 * | DPR  | 需要 | 挑中 | 富余 |
 * |------|------|------|------|
 * | 1    | 24   | 32   | 1.33 |
 * | 1.25 | 30   | 32   | 1.07 |
 * | 1.5  | 36   | 40   | 1.11 |
 * | 2    | 48   | 48   | 1.00 |
 * | 2.5  | 60   | 64   | 1.07 |
 * | 3    | 72   | 96   | 1.33 |
 * | 4    | 96   | 96   | 1.00 |
 *
 * 档位刻意排得比"够大就行"**紧**：`_favicon` 会把请求的尺寸**硬做出来**
 * （源只有 32px 时请求 64 就给一张放大过的 64），所以请求值远超实际所需会让
 * 缓存里的小图先被放大、再被浏览器缩回去 —— 白白糊一道。贴着需要的值取最稳。
 * 改 `FAVICON_CSS_SIZE` 时要按上表重排（测试会检查每个档位都"贴紧"某个 DPR）。
 */
export const FAVICON_SRCSET_SIZES = [32, 40, 48, 64, 96, 128] as const;

/** 生成 `srcset` 字符串（`url 32w, url 64w, …`）。 */
export function createFaviconSrcSet(
  pageUrl: string,
  sizes: readonly number[] = FAVICON_SRCSET_SIZES,
): string {
  return sizes.map((size) => `${createFaviconUrl(pageUrl, size)} ${size}w`).join(', ');
}

/**
 * 由域名派生一个稳定的色相，用于 favicon 失败时的文字底色。
 * 同一个站点每次刷新颜色一致；深浅主题下的明度交给 CSS 变量处理。
 */
export function iconHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * 图标签名边长。把任意尺寸的图标归一到 N×N 的 RGBA 再比较 —— 归一是必须的：
 * 同一张默认占位图在不同 DPR 下会被取成不同尺寸（实测 16 / 32 / 64）。
 */
export const ICON_SIGNATURE_SIZE = 16;

/**
 * 两张签名之间的判定阈值（逐像素平均绝对差，0–255）。
 * 取这个量级的理由：归一化重采样会带来几个灰阶的差异，而"默认图 vs 任意真实图标"
 * 的差异远大于它（实测默认图与 Google/GitHub 图标的平均差在 30 以上）。
 */
export const DEFAULT_ICON_DISTANCE_TOLERANCE = 6;

/**
 * 两张签名图的逐像素平均绝对差（RGBA 四通道一起算）。
 *
 * 纯函数，便于在 node 环境单测；画布取像素那部分在 `services/favicon-default.ts`。
 * 长度不一致时返回 `Infinity`（不可能是同一张图）。
 */
export function signatureDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** 这张签名是不是"浏览器默认占位图"。 */
export function isDefaultIconSignature(
  signature: ArrayLike<number>,
  reference: ArrayLike<number>,
  tolerance: number = DEFAULT_ICON_DISTANCE_TOLERANCE,
): boolean {
  return signatureDistance(signature, reference) <= tolerance;
}
