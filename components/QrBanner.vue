<script setup lang="ts">
/**
 * 公众号横幅：图铺满卡片内容宽，图下跟一块**加粗名称 + 灰色说明**。
 *
 * ## 为什么和 QrTile 分成两个组件
 *
 * 两张收款码是方形图位（132px、图下挂一行居中说明），公众号这张是
 * "二维码 + 微信搜一搜 / 师兄知道"的**合成横幅**（实测 1040×380，约 2.74:1）。
 * 它们连结构都不一样 —— 硬合成一个组件就得在里面按 `layout` 分叉，
 * 那比两个各自短小的组件更难读。
 *
 * **取图那一段（候选回落 / 加载态 / 比例）是共用的**，住在 `useQrImage` 里：
 * 复制一份的代价不是多写几行，而是两份回落逻辑会各自漂移。
 *
 * ## 为什么图要铺满，而不是塞进固定尺寸的框
 *
 * 横幅里的二维码只占左边一小块。按 132px 的方图位放，那个码只剩五十来像素 ——
 * 屏幕上根本扫不动。铺满之后码本身约 175px，正常手机能扫。
 */
import { useI18n } from '../composables/useI18n';
import { useQrImage } from '../composables/useQrImage';

const props = defineProps<{
  /** 候选地址，按优先级排好（选中的源在前）。 */
  urls: string[];
  /** 公众号名字，加粗显示，同时当 alt。 */
  name: string;
  /** 名字下面那句说明。 */
  body: string;
}>();

const { t } = useI18n();

// 上限放宽到 4：横幅本来就比方形码扁得多，3 会把它夹到失真。
const { current, loaded, exhausted, onLoad, onError } = useQrImage(() => props.urls, {
  maxRatio: 4,
});
</script>

<template>
  <figure class="banner">
    <div class="frame" :data-loaded="loaded">
      <img
        v-if="!exhausted"
        class="img"
        :src="current"
        :alt="name"
        loading="lazy"
        @load="onLoad"
        @error="onError"
      />
      <p v-else class="err">{{ t('about.sponsor.imageError') }}</p>
    </div>
    <figcaption class="meta">
      <p class="name">{{ name }}</p>
      <p class="body">{{ body }}</p>
    </figcaption>
  </figure>
</template>

<style scoped>
.banner {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

/*
 * 加载前按**当前那张横幅的实测比例**占位（1040 / 380 ≈ 2.74）。
 * 不占位的话，一张七百多像素宽的横幅落进来会把下面整叠卡片往下推两百多像素 ——
 * 那是这一页最刺眼的一次跳动。换图之后第一帧的占位会差一点，加载完自动纠正。
 */
.frame {
  --banner-ratio: 2.74;
  position: relative;
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  overflow: hidden;
}

/* 占位比例放在 <img> 上、且只在**没加载出来时**生效：
   一旦加载成功就撤掉，让它用图片自己的固有比例 —— 两边严丝合缝，零位移。
   如果把 aspect-ratio 常驻在 <img> 上，它会**盖掉**固有比例，换一张方图就会被拉扁。 */
.frame[data-loaded='false'] .img {
  aspect-ratio: var(--banner-ratio);
}

.img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--radius-md);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.frame[data-loaded='true'] .img {
  opacity: 1;
}

/* 全退完了：给错误文字一块正经地方，别让它顶着一条 0 高的框。 */
.err {
  margin: 0;
  min-height: 120px;
  display: grid;
  place-items: center;
  padding: var(--sp-6);
  text-align: center;
  color: var(--text-3);
  font-size: var(--fs-sm);
  line-height: 1.6;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.name {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
}

.body {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text-3);
}
</style>
