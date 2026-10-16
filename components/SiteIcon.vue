<script setup lang="ts">
/**
 * 站点图标槽（既有约定：从 BookmarkCard 抽出，回收站卡片共用）。
 *
 * favicon（按 DPR 挑档位）→ 取不到或浏览器默认图时转域名色相字母牌。
 * 两边共用一份逻辑，否则 `faviconFailed` 那类坑（一次批量失败整页降级成字母）
 * 只会各自漂移、各修各的。
 */

import { computed, ref, watch } from 'vue';

import { createFaviconSrcSet, FAVICON_CSS_SIZE, iconHue } from '../lib/favicon';
import { isBrowserDefaultIcon } from '../services/favicon-default';

const props = defineProps<{
  /** 站点图标地址；空串 = 没有，直接走字母牌。 */
  faviconUrl: string;
  /** 站点网址：srcset 与色相都用它派生。 */
  url: string;
  /** 字母牌文字：标题前一到两个字符。 */
  fallbackLabel: string;
  /** 色相种子：域名优先，退回网址。 */
  domain: string;
}>();

const faviconFailed = ref(false);

// 换了一个站点（复用组件实例）时要重新尝试加载图标。
watch(
  () => props.faviconUrl,
  () => {
    faviconFailed.value = false;
  },
);

/**
 * 图标加载完再确认一次它到底是不是**真图标**。
 *
 * `_favicon` 对没有缓存图标的站点**不报错**，而是回 200 + 一张通用占位图 ——
 * 所以光靠 `@error` 是发现不了"这个站点其实没有图标"的，一屏卡片会全是同一张
 * 灰色地球。这里把图丢给 `services/favicon-default` 比对一次，是默认图就转成
 * **按域名色相上色的首字母牌**（`.is-fallback`），一屏才不至于单调。
 *
 * 异步回来时组件可能已经换了站点（列表复用实例），所以比对完要确认还是同一个。
 */
function handleFaviconLoad(event: Event): void {
  const image = event.target as HTMLImageElement;
  const expected = props.faviconUrl;
  void isBrowserDefaultIcon(image).then((isDefault) => {
    if (isDefault && props.faviconUrl === expected) faviconFailed.value = true;
  });
}

/**
 * 交给浏览器按设备像素比挑档位。
 *
 * 图标槽是 24 CSS px（FAVICON_CSS_SIZE，与 style.css 的 `.site-icon` 同步，
 * `lib/favicon.test.ts` 有护栏直接读 CSS），2× 屏上要占 48 个物理像素 ——
 * 固定请求 `size=32` 会被放大到 48，于是发糊（用户报过）。`srcset` 让浏览器
 * 自己按 `24px × DPR` 挑 32/64/128 里合适的那一张，**高分屏才下载大图**，
 * 且窗口换到另一块屏时会自动重挑。
 */
const faviconSrcSet = computed(() => createFaviconSrcSet(props.url));

const hue = computed(() => iconHue(props.domain || props.url));
const hasFavicon = computed(() => props.faviconUrl !== '' && !faviconFailed.value);
const isCompactText = computed(
  () => props.fallbackLabel.length > 1 && /^[\x20-\x7F]+$/.test(props.fallbackLabel),
);
</script>

<template>
  <span
    class="site-icon"
    :class="{ 'is-fallback': !hasFavicon, 'small-text': isCompactText }"
    :style="hasFavicon ? undefined : { '--icon-hue': hue }"
    aria-hidden="true"
  >
    <img
      v-if="hasFavicon"
      class="site-favicon"
      :src="faviconUrl"
      :srcset="faviconSrcSet"
      :sizes="`${FAVICON_CSS_SIZE}px`"
      alt=""
      width="24"
      height="24"
      loading="lazy"
      decoding="async"
      @load="handleFaviconLoad"
      @error="faviconFailed = true"
    />
    <span v-else class="fallback-text">{{ fallbackLabel }}</span>
  </span>
</template>
