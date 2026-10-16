<script setup lang="ts">
/**
 * 数据分区：书签导出 + 设置备份导入导出。
 *
 * 这里**刻意没有「导入书签」**（见 既有约定）：师兄起页对原生书签只有读，
 * 唯一的写入通道是同步。加一个"导入书签"就等于开第二条写入通道，
 * 与同步的因果合并、冲突裁决会正面打架，而浏览器自带的书签管理器本来就能做。
 */
import { computed, ref } from 'vue';
import { useBookmarks } from '../../../composables/useBookmarks';
import { useI18n } from '../../../composables/useI18n';
import { useSettings } from '../../../composables/useSettings';
import { readBookmarkSnapshot } from '../../../services/bookmarks-service';
import {
  suggestExportFileName,
  toJsonExport,
  toNetscapeHtml,
} from '../../../lib/bookmark-export';
import {
  parseSettingsBackup,
  serializeSettingsBackup,
  type SettingsBackupError,
} from '../../../lib/settings-backup';
import { flattenFolders } from '../../../lib/bookmark-mapper';
import type { MessageKey } from '../../../lib/i18n/zh-CN';
import { appVersion } from '../app-info';

const { t, tRich } = useI18n();
const { settings, update } = useSettings();
const { status, roots, items, errorMessage } = useBookmarks();

const notice = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);
const exportBusy = ref<'html' | 'json' | null>(null);
const importError = ref<SettingsBackupError | null>(null);

const folderCount = computed(() => flattenFolders(roots.value).length);

const IMPORT_ERROR_KEY: Record<SettingsBackupError, MessageKey> = {
  'not-json': 'data.settings.importError.notJson',
  'not-object': 'data.settings.importError.notObject',
  'kind-mismatch': 'data.settings.importError.kindMismatch',
  'version-mismatch': 'data.settings.importError.versionMismatch',
};

/**
 * 把文本交给浏览器下载。
 *
 * `URL.createObjectURL` + 一个临时 `<a download>` —— 不引任何 CDN 或打包器插件。
 */
function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器来不及取数据，放到下一轮事件循环足够安全。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportBookmarks(format: 'html' | 'json'): Promise<void> {
  exportBusy.value = format;
  notice.value = null;
  try {
    // 现读现导：师兄起页从不持有书签副本，导出的一定是此刻浏览器的真实状态。
    const snapshot = await readBookmarkSnapshot();
    const generatedAt = Date.now();
    const text =
      format === 'html'
        ? toNetscapeHtml(snapshot, generatedAt)
        : JSON.stringify(toJsonExport(snapshot, generatedAt), null, 2);
    downloadTextFile(
      suggestExportFileName(format, generatedAt),
      text,
      format === 'html' ? 'text/html' : 'application/json',
    );
  } catch (error) {
    notice.value = {
      tone: 'error',
      text: t('data.export.failed', { reason: error instanceof Error ? error.message : String(error) }),
    };
  } finally {
    exportBusy.value = null;
  }
}

function exportSettings(): void {
  const at = Date.now();
  downloadTextFile(
    `shistart-settings-${new Date(at).toISOString().slice(0, 10)}.json`,
    serializeSettingsBackup(settings.value, appVersion(), at),
    'application/json',
  );
}

async function importSettings(file: File): Promise<void> {
  importError.value = null;
  notice.value = null;
  try {
    const result = parseSettingsBackup(await file.text());
    if (!result.ok) {
      // 外壳对不上一律明确报错，绝不"尽力读" ——
      // 静默把偏好变成默认值，和悄悄丢掉用户设置没有区别。
      importError.value = result.reason;
      return;
    }
    // 归一化后的结果写回单例：单例负责落盘（见 useSettings），这里不要再调一次 save。
    await update(result.settings);
    notice.value = { tone: 'ok', text: t('data.settings.importDone') };
    // 主题、语言、侧边栏宽度都是加载时生效的，重载一次最省事也最不容易留下半改的状态。
    setTimeout(() => location.reload(), 600);
  } catch (error) {
    notice.value = {
      tone: 'error',
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

function onPickFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空 value，否则连续选同一个文件不会触发 change。
  input.value = '';
  if (file) void importSettings(file);
}
</script>

<template>
  <div class="stack">
    <div class="section-head">
      <h2>{{ t('data.title') }}</h2>
    </div>

    <p v-if="notice" class="notice" :data-tone="notice.tone">{{ notice.text }}</p>

    <section class="card">
      <h3>{{ t('data.export') }}</h3>
      <p class="hint">{{ t('data.export.hint') }}</p>

      <p v-if="errorMessage" class="error-line">{{ errorMessage }}</p>
      <p v-else-if="status === 'loading'" class="hint">{{ t('common.loading') }}</p>
      <p v-else class="hint">
        {{ t('data.stats', { bookmarks: items.length, folders: folderCount }) }}
      </p>

      <div class="row">
        <button
          type="button"
          class="btn"
          :disabled="exportBusy !== null"
          @click="exportBookmarks('html')"
        >
          {{ exportBusy === 'html' ? t('data.export.busy') : t('data.export.html') }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="exportBusy !== null"
          @click="exportBookmarks('json')"
        >
          {{ exportBusy === 'json' ? t('data.export.busy') : t('data.export.json') }}
        </button>
      </div>
      <ul class="format-notes">
        <li>{{ t('data.export.html.hint') }}</li>
        <li>{{ t('data.export.json.hint') }}</li>
      </ul>
    </section>

    <section class="card">
      <h3>{{ t('data.settings') }}</h3>
      <p class="hint">{{ t('data.settings.hint') }}</p>
      <div class="row">
        <button type="button" class="btn" @click="exportSettings">
          {{ t('data.settings.export') }}
        </button>
        <label class="btn file-btn">
          {{ t('data.settings.import') }}
          <input type="file" accept="application/json,.json" @change="onPickFile" />
        </label>
      </div>
      <p v-if="importError" class="error-line">{{ t(IMPORT_ERROR_KEY[importError]) }}</p>
    </section>

    <!-- "为什么不能从这里导入书签"必须写在界面上：用户带着这个预期来，
         看到一排导入按钮却没有书签那一项，会以为是功能没做完。 -->
    <section class="card">
      <h3>{{ t('data.import') }}</h3>
      <p class="hint" v-html="tRich('data.import.hint')"></p>
    </section>
  </div>
</template>

<style scoped>
.format-notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  color: var(--text-3);
  font-size: var(--fs-sm);
}

/* `<label>` 伪装成按钮：这样"选择文件"这个原生动作不需要额外 JS，
   键盘可达性与真正的按钮一致。 */
.file-btn {
  position: relative;
  overflow: hidden;
  margin: 0;
}

.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
</style>
