<script setup lang="ts">
/**
 * 一张方形二维码（收款码）：按候选地址**一张张退**，全退完了明说"加载不出来"。
 *
 * 取图那一段（候选回落 / 加载态 / 比例）住在 `composables/useQrImage.ts` ——
 * 公众号那张横幅结构完全不同、但取图规则一模一样，共用一份才不会两边各自漂移。
 *
 * 全部候选都失败时给出**明确的错误文本**（不是占位碎图）：本仓的规矩是
 * "读取失败走错误态、绝不静默"。
 */
import { useI18n } from '../composables/useI18n';
import { useQrImage } from '../composables/useQrImage';

const props = defineProps<{
  /** 候选地址，按优先级排好（选中的源在前）。 */
  urls: string[];
  /** 图下的说明，同时当 alt。 */
  caption: string;
}>();

const { t } = useI18n();

const { current, loaded, exhausted, ratio, onLoad, onError } = useQrImage(() => props.urls);
</script>

<template>
  <figure class="qr-tile">
    <div
      class="qr-box"
      :data-loaded="loaded"
      :style="ratio ? { aspectRatio: String(ratio) } : undefined"
    >
      <img
        v-if="!exhausted"
        class="qr-img"
        :src="current"
        :alt="caption"
        loading="lazy"
        @load="onLoad"
        @error="onError"
      />
      <p v-else class="qr-error">{{ t('about.sponsor.imageError') }}</p>
    </div>
    <figcaption class="qr-caption">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
/* 方形收款码的图位宽度。公众号那张横幅走 QrBanner，不在这里。 */
.qr-tile {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: 132px;
}

/* 正方形先占位：图没到之前不该让下面的说明跳来跳去。
   图到了之后由行内 aspect-ratio 接手，按真实比例收拢（方形码本来就是 1，基本不动）。 */
.qr-box {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  overflow: hidden;
}

.qr-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.qr-box[data-loaded='true'] .qr-img {
  opacity: 1;
}

.qr-error {
  position: absolute;
  inset: 0;
  margin: 0;
  display: grid;
  place-items: center;
  padding: var(--sp-3);
  text-align: center;
  color: var(--text-3);
  font-size: var(--fs-xs);
  line-height: 1.5;
}

.qr-caption {
  color: var(--text-2);
  font-size: var(--fs-sm);
  text-align: center;
}
</style>
