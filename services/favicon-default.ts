import {
  createFaviconUrl,
  ICON_SIGNATURE_SIZE,
  isDefaultIconSignature,
} from '../lib/favicon';

/**
 * 识别"浏览器给的默认占位图"。
 *
 * **为什么需要它**：`_favicon` 对**没有缓存图标**的站点**不报错**，而是回 200 +
 * 一张通用占位图（Chrome 是灰色地球，实测字节完全确定：4 个不同域名在同一 size 下
 * 返回的字节一模一样）。于是 `<img>` 永远加载成功、`@error` 永远不触发 ——
 * `BookmarkCard` 那套"按域名色相上色 + 首字母"的降级**会变成死代码**，
 * 而一屏没有图标的书签就全是同一张占位图，正是"看着单调"的成因。
 *
 * **做法**：把已加载的 `<img>` 画到一个 16×16 画布上取像素签名，与"默认图"的签名比。
 * 不额外发请求（图本来就加载了），也不需要 host permission。
 * `_favicon` 与本页同源（都是 `chrome-extension://<本扩展 id>/`），画布不会被污染 ——
 * 实测 `getImageData` 可用。
 *
 * 纯计算部分（阈值、距离）在 `lib/favicon.ts`，便于无浏览器单测；这里只有 DOM。
 */

/** 参考签名只算一次；`null` 表示算不出来（拿不到默认图/没有画布），此后不再重试。 */
let reference: Promise<Uint8ClampedArray | null> | null = null;

/** 复用同一个画布：一屏可能有几百张卡片，每张新建一个画布太浪费。 */
let scratch: HTMLCanvasElement | null = null;

function rasterize(source: CanvasImageSource): Uint8ClampedArray | null {
  if (typeof document === 'undefined') return null;
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.width = ICON_SIGNATURE_SIZE;
    scratch.height = ICON_SIGNATURE_SIZE;
  }
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, ICON_SIGNATURE_SIZE, ICON_SIGNATURE_SIZE);
  context.drawImage(source, 0, 0, ICON_SIGNATURE_SIZE, ICON_SIGNATURE_SIZE);
  try {
    return context.getImageData(0, 0, ICON_SIGNATURE_SIZE, ICON_SIGNATURE_SIZE).data;
  } catch {
    // 理论上不会发生（同源）；真被污染了就当识别不出来，宁可不降级也不要报错。
    return null;
  }
}

function loadReference(): Promise<Uint8ClampedArray | null> {
  if (!reference) {
    reference = (async () => {
      try {
        // `.invalid` 是 RFC 2606 保留域名，永远解析不到、也就不可能有缓存图标
        // ⇒ 一定拿到浏览器给的默认占位图，作为"这就是默认图"的参照。
        const image = new Image();
        image.src = createFaviconUrl(
          `https://${crypto.randomUUID()}.invalid/`,
          ICON_SIGNATURE_SIZE,
        );
        await image.decode();
        return rasterize(image);
      } catch {
        return null;
      }
    })();
  }
  return reference;
}

/** 预热参照签名。页面挂载时调一次，免得每张卡片都排在它后面等。 */
export function primeDefaultIconSignature(): void {
  void loadReference();
}

/**
 * 这张图是不是浏览器给的默认占位图？
 *
 * 拿不到参照（或画不出像素）时一律返回 `false` —— 保守：宁可显示通用图标，
 * 也不要把真实图标误判成"没有图标"。
 */
export async function isBrowserDefaultIcon(image: HTMLImageElement): Promise<boolean> {
  const target = await loadReference();
  if (!target) return false;
  const signature = rasterize(image);
  if (!signature) return false;
  return isDefaultIconSignature(signature, target);
}
