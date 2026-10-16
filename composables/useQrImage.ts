/**
 * 一张远程图的取图状态机：按候选地址**一张张退**，退完了明说。
 *
 * ## 为什么抽出来
 *
 * 这段逻辑原来只长在 `QrTile` 里。公众号那张改版成"横幅图 + 名称/说明块"之后，
 * 它和方形图位**结构完全不同**（一个是 figure>box>img + figcaption，
 * 一个是铺满的 frame + 下方文案块），但取图这一段是一模一样的。
 *
 * 复制一份的代价不是多写几行，而是**两份回落逻辑会各自漂移** ——
 * 一边改了夹取范围、另一边没改，单张图挂掉时两种图位表现不一致，且没人会发现。
 *
 * 另外：本仓的规矩是**组件不写单测**（vitest 的 node 环境只收 lib / services /
 * composables），所以行为只有落进 composable 才验得到。抽出来之后
 * "退到第几张、退完了没有、比例记没记住"这三件事第一次有了单测。
 *
 * ## 为什么逐张回落
 *
 * `chooseQrMirror` 只探了支付宝那一张。探测时的胜者**未必**每张图都通
 * （单张 404、CDN 缓存脏、Gitee 的 raw 链接是每次现签的 302……）。
 * 不回落的话，这种小概率事件在用户眼里就是一张碎图或一块空白。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

export interface QrImage {
  /** 当前该试的地址；候选全退完时是空串。 */
  current: ComputedRef<string>;
  /** 当前这张是否已经真的渲染出来（用来做淡入，别让空框先闪一下）。 */
  loaded: Ref<boolean>;
  /** 候选是不是全部退完了 —— 真时该显示错误文本，而不是继续挂一个空 `<img>`。 */
  exhausted: ComputedRef<boolean>;
  /** 图片自己的宽高比；还没加载出来时为 null。 */
  ratio: Ref<number | null>;
  /** 绑到 `<img @load>`。 */
  onLoad: (event: Event) => void;
  /** 绑到 `<img @error>`：换下一个候选。 */
  onError: () => void;
}

export interface UseQrImageOptions {
  /**
   * 比例的夹取范围，默认 `[1/2, 3]`。
   *
   * 换图换出个奇怪比例时，不许把容器撑成长条或细缝。注意**正常值不该被夹到** ——
   * 常见的方形码是 1:1、横幅是 2.7:1，都在范围里；夹取只在图真的离谱时生效。
   */
  minRatio?: number;
  maxRatio?: number;
}

/**
 * @param urls 取一个**取值函数**而不是数组：候选由上层每次重算（重试 / 换源），
 *             传函数能直接跟住，不用上层再包一层 watch。
 */
export function useQrImage(
  urls: () => string[],
  options: UseQrImageOptions = {},
): QrImage {
  const minRatio = options.minRatio ?? 1 / 2;
  const maxRatio = options.maxRatio ?? 3;

  const index = ref(0);
  const loaded = ref(false);
  const ratio = ref<number | null>(null);

  const list = computed(() => urls());
  const exhausted = computed(() => index.value >= list.value.length);
  const current = computed(() => list.value[index.value] ?? '');

  // 换了一批候选（重试 / 换了源）⇒ 从头再来。不重置的话，上一轮的 index 会
  // 落在新一轮的中间，用户点了"重试"却从第三张开始试。
  watch(
    () => list.value.join('|'),
    () => {
      index.value = 0;
      loaded.value = false;
      ratio.value = null;
    },
  );

  function onLoad(event: Event): void {
    loaded.value = true;
    const img = event.target as HTMLImageElement | null;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    // 拿不到真实尺寸时**不动** ratio（保持 null），而不是塞一个 1 进去 ——
    // 塞 1 会让容器按方形收拢，看起来就像"图是方的"，把一个未知说成了已知。
    ratio.value = Math.min(maxRatio, Math.max(minRatio, img.naturalWidth / img.naturalHeight));
  }

  function onError(): void {
    index.value += 1;
    loaded.value = false;
    ratio.value = null;
  }

  return { current, loaded, exhausted, ratio, onLoad, onError };
}
