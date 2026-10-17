<script setup lang="ts">
/**
 * 关于分区：版本、隐私说明、赞助二维码、公众号、重置全部设置。
 *
 * 「重置」只动界面偏好，不动浏览器书签、也不动同步配置 ——
 * 这一点必须写在按钮旁边，否则没人敢点。
 *
 * 赞助二维码走 GitHub / Gitee 双镜像：**切到这一页才发探测**
 * （本组件是 v-if 挂载的，onMounted 就是用户打开「关于」的那一刻），
 * 不拖累设置页的打开，也不给根本不点「关于」的人发请求。
 */
import { onMounted, ref } from 'vue';
import QrBanner from '../../../components/QrBanner.vue';
import QrTile from '../../../components/QrTile.vue';
import { latestRelease, parseReleaseSections } from '../../../lib/changelog';
import { chooseQrMirror, qrUrls, type QrMirror } from '../../../lib/qr-mirror';
// `?raw` 在构建时把整份日志读成字符串打进包里（约 4 KB）。**没有第二个版本号的真值** ——
// 卡片上那个版本号来自 manifest，日志里的版本号由它自己对上（守卫在 changelog.test.ts）。
import changelogRaw from '../../../CHANGELOG.md?raw';
import { useI18n } from '../../../composables/useI18n';
import { useSettings } from '../../../composables/useSettings';
import { DEFAULT_SETTINGS } from '../../../types/settings';
import { appVersion } from '../app-info';

const { t } = useI18n();
const { update } = useSettings();

const version = appVersion();
const confirmReset = ref(false);
const done = ref(false);

/**
 * 最近一版的更新内容。
 *
 * 只显示**最新一版**：历史留在仓库里的 `CHANGELOG.md`，界面要回答的是
 * "我这次装到/升级到的这个版本改了什么"，不是一份档案。
 */
const release = latestRelease(changelogRaw);
const releaseSections = release === null ? [] : parseReleaseSections(release.body);

const probing = ref(true);
const mirror = ref<QrMirror | null>(null);
const probeFailed = ref(false);

async function probeMirrors(): Promise<void> {
  probing.value = true;
  probeFailed.value = false;
  // 全部不通时是 null（不拿默认源冒充"有图"）—— 那一档由下面明说，不静默。
  mirror.value = await chooseQrMirror();
  probing.value = false;
  probeFailed.value = mirror.value === null;
}

onMounted(() => {
  void probeMirrors();
});

async function resetAll(): Promise<void> {
  if (!confirmReset.value) {
    confirmReset.value = true;
    return;
  }
  confirmReset.value = false;
  done.value = true;

  // 走 useSettings 的 update 而不是自己调 saveSettings：
  // 存储的写入路径保持只有一条，免得两边写出不同形状的对象。
  await update({ ...DEFAULT_SETTINGS });
  // 重载一次：主题、语言、侧边栏宽度都是在加载时生效的，让它们半改半留着更让人困惑。
  window.setTimeout(() => location.reload(), 600);
}
</script>

<template>
  <div class="stack">
    <div class="section-head">
      <h2>{{ t('about.title') }}</h2>
      <span class="phase">{{ t('about.version', { version }) }}</span>
    </div>

    <section class="card">
      <h3>{{ t('about.privacy') }}</h3>
      <p class="hint">{{ t('about.privacy.body') }}</p>
    </section>

    <section class="card">
      <h3>{{ t('about.credits') }}</h3>
      <p class="hint">{{ t('about.credits.body') }}</p>
    </section>

    <!-- 开源仓库与作者主页。两个公仓内容一致（一个推送到另一个），
         国内访问 Gitee 更快、GitHub 那边能看到 Release 与更新节奏。
         三项都是外链：扩展页里 `<a target="_blank">` 直接新开标签页即可。 -->
    <section class="card">
      <h3>{{ t('about.links') }}</h3>
      <ul class="about-links">
        <li>
          <a href="https://github.com/ShiXiongZhiDao/ShiStart" target="_blank" rel="noopener noreferrer">
            {{ t('about.links.github') }}
          </a>
        </li>
        <li>
          <a href="https://gitee.com/ShiXiongZhiDao/ShiStart" target="_blank" rel="noopener noreferrer">
            {{ t('about.links.gitee') }}
          </a>
        </li>
        <li>
          <a href="https://shixiongzhidao.cn" target="_blank" rel="noopener noreferrer">
            {{ t('about.links.home') }}
          </a>
        </li>
      </ul>
    </section>

    <section class="card">
      <h3>{{ t('about.changelog') }}</h3>
      <p v-if="release" class="hint">
        <span class="phase">{{ release.version }}</span>
        {{ release.date === null ? '' : t('about.changelog.released', { date: release.date }) }}
      </p>
      <!-- 默认收起：这一页已经有五张卡，更新记录是"想看才看"的东西。 -->
      <details v-if="releaseSections.length > 0" class="fold">
        <summary>{{ t('about.changelog.fold') }}</summary>
        <div class="changelog">
          <div v-for="section in releaseSections" :key="section.title" class="changelog-group">
            <h4 v-if="section.title !== ''">{{ section.title }}</h4>
            <ul>
              <li v-for="(item, index) in section.items" :key="index">{{ item }}</li>
            </ul>
          </div>
        </div>
      </details>
      <p v-else class="hint">{{ t('about.changelog.empty') }}</p>
    </section>

    <!-- 关注公众号在前、赞助作者在后（2026-10-16 用户指定）：
         公众号是"关注一下有事会通知你"，赞助是"愿意支持就支持" —— 前者对用户有用，
         后者对作者有用，有用的放前面。 -->
    <section class="card">
      <h3>{{ t('about.official') }}</h3>
      <div v-if="mirror" class="qr-banner-slot">
        <QrBanner
          :urls="qrUrls(mirror, 'wechatOfficial')"
          :name="t('about.official.name')"
          :body="t('about.official.body')"
        />
      </div>      <p v-if="probing" class="hint qr-status">{{ t('about.sponsor.loading') }}</p>
      <!-- 这张卡也要带按钮：只写"请检查网络后重试"却不给按钮，就是一句无从执行的指令
           （两张卡的按钮走同一个 probeMirrors，点哪个都一样修好两张）。 -->
      <template v-if="probeFailed">
        <p class="notice" data-tone="error">{{ t('about.sponsor.unavailable') }}</p>
        <div class="row">
          <button type="button" class="btn" @click="probeMirrors">
            {{ t('about.sponsor.retry') }}
          </button>
        </div>
      </template>
    </section>

    <section class="card">
      <h3>{{ t('about.sponsor') }}</h3>
      <p class="hint">{{ t('about.sponsor.hint') }}</p>
      <!-- 选源失败时不渲染图位：那时两个源都够不着，留着图位只会显示一排"加载不出来"，
           和上面那句提示说的是同一件事。给一句明确的错误 + 重试按钮就够了。 -->
      <div v-if="mirror" class="qr-row">
        <QrTile :urls="qrUrls(mirror, 'alipay')" :caption="t('about.sponsor.alipay')" />
        <QrTile :urls="qrUrls(mirror, 'wechatPay')" :caption="t('about.sponsor.wechatPay')" />
      </div>
      <p v-if="probing" class="hint qr-status">{{ t('about.sponsor.loading') }}</p>
      <template v-if="probeFailed">
        <p class="notice" data-tone="error">{{ t('about.sponsor.unavailable') }}</p>
        <div class="row">
          <button type="button" class="btn" @click="probeMirrors">
            {{ t('about.sponsor.retry') }}
          </button>
        </div>
      </template>
    </section>

    <section class="card danger">
      <h3>{{ t('about.reset') }}</h3>
      <p class="hint">{{ t('about.reset.hint') }}</p>
      <div class="row">
        <button type="button" class="btn danger-btn" @click="resetAll">
          {{ confirmReset ? t('about.reset.confirm') : t('about.reset') }}
        </button>
      </div>
      <p v-if="done" class="notice" data-tone="ok">{{ t('about.reset.done') }}</p>
    </section>
  </div>
</template>

<style scoped>
/* 版本号不参与状态判断，用最轻的底色 —— 它是说明，不是报警。 */
.phase {
  padding: var(--sp-1) var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  background: var(--surface-2);
  color: var(--text-2);
}

/*
 * 开源仓库与作者主页。
 *
 * 做成胶囊而不是下划线链接：这一页其它卡片都是"一整块可点的按钮"，
 * 突然冒出三个裸文字链接会显得像漏了样式；而胶囊的点击区域也更大。
 */
.about-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.about-links a {
  display: inline-flex;
  align-items: center;
  padding: var(--sp-2) var(--sp-5);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-sm);
  text-decoration: none;
  transition:
    border-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard);
}

.about-links a:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.qr-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-7);
}

/* 横幅与卡标题之间留一口气（h3 自己只给 8px）。 */
.qr-banner-slot {
  margin-top: var(--sp-4);
}

.qr-status {
  margin-top: var(--sp-5);
}

/* ---------- 最近更新 ---------- */

.changelog {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.changelog-group h4 {
  margin: 0 0 var(--sp-2);
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
}

.changelog-group ul {
  margin: 0;
  padding-left: var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  color: var(--text-2);
  font-size: var(--fs-sm);
  line-height: 1.7;
}
</style>
