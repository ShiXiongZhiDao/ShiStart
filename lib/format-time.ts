/**
 * 时间的两副面孔：相对（"3 小时前"）与绝对（"2026/10/12 14:30"）。
 *
 * 为什么单独成文件：设置页「快照」分区的版本列表两者都要（主文相对、副文绝对），
 * 而同步分区原来各有一份私有 `eventTime`。它们是**纯函数**（不吃 chrome.*），
 * 所以能进 node 测试 —— 仓库没有组件测试基座，`lib/**` 是行为可锁的地方
 * （与 `lib/tooltip-place.ts` 同一条纪律）。
 *
 * 相对时间的窗口是 **7 天**：之外回落到绝对日期。理由很直白 —— "12 天前"对
 * "该退回哪一版"这个决策没有信息量，用户要的是日期；7 天内"3 小时前"才真的
 * 比一串日期数字更好懂。窗口是展示策略，不参与任何判定。
 */

import type { LocaleId } from './i18n';

/** 相对时间的上限：超过这个窗口回落到绝对日期。 */
export const RELATIVE_TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 绝对时间：`toLocaleString(locale, { hour12: false })`。
 *
 * 与同步分区原来的 `eventTime` 逐字一致 —— 换格式是视觉决定，不在这趟改动里做。
 */
export function formatAbsoluteTime(at: number, locale: LocaleId): string {
  return new Date(at).toLocaleString(locale, { hour12: false });
}

/**
 * 绝对日期（不带时刻）：相对时间窗口外的主文。
 *
 * 单独一个函数而不是让调用方传 option：窗口外主文若退回绝对**时间**，就与副文
 * 逐字重复（副文永远带时刻，选版本要精确到那个程度）。
 */
export function formatDate(at: number, locale: LocaleId): string {
  return new Date(at).toLocaleDateString(locale);
}

/**
 * 相对时间（"3小时前" / "3 hours ago"）；超出窗口返回 null，调用方用绝对时间。
 *
 * 走 `Intl.RelativeTimeFormat` 而不是自己拼"X小时前"：英文的 "3 hours ago"
 * 与中文的"3小时前"不是同一个模板，自己拼就要维护两套复数规则（英语还有
 * "1 hour ago" 的单数）。`numeric: 'always'` 保证 0 也给出确定值
 * （'auto' 在部分引擎上会把 0 渲染成"现在"之类的自然语言，测试钉不住）。
 *
 * 秒数向上取整到 1：刚写入的版本显示"1秒前"而不是"0秒前"—— 显示取整，
 * 不是数据说谎。
 */
export function formatRelativeTime(at: number, now: number, locale: LocaleId): string | null {
  const diff = now - at;
  if (!Number.isFinite(diff) || diff < 0) return null; // 时钟跳到未来：不猜
  if (diff >= RELATIVE_TIME_WINDOW_MS) return null;

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (diff < MINUTE) return rtf.format(-Math.max(1, Math.round(diff / 1000)), 'second');
  if (diff < HOUR) return rtf.format(-Math.round(diff / MINUTE), 'minute');
  if (diff < DAY) return rtf.format(-Math.round(diff / HOUR), 'hour');
  return rtf.format(-Math.round(diff / DAY), 'day');
}

/**
 * 一天之内的分档：今天 / 昨天 / 更早。右缘「最近访问」按它分组——
 * 50 条平铺是一面墙，分档给它层次，且沿用浏览器历史页的既有心智模型。
 */
export type DayBucket = 'today' | 'yesterday' | 'earlier';

/** 本地零点。分组按**日历天**算，不是 24 小时窗口。 */
function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 落在哪一档。
 *
 * 按**日历天**差而不是毫秒差：凌晨 0:30 看昨晚 23:50 的访问，用户认的是
 * "昨天"，不是"40 分钟前所以算今天"。跨夏令时时天差会有 ±1 小时偏移，
 * `Math.round` 把它收掉（0.96 / 1.04 都落回正确整数）。未来时间（时钟跳了）
 * 算今天 —— 不猜、也不抛。
 */
export function dayBucketOf(at: number, now: number): DayBucket {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return 'earlier';
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(at)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return 'earlier';
}

/**
 * 时刻（不带日期）："14:30"。
 *
 * 给「昨天」那一档的行用 —— 组头已经说了是哪天，行里再报日期是重复；钟点才是
 * 用来指认"就是下午那条"的信息。与 `formatDate` 分开而不是让调用方传 option，
 * 与上面两个函数同一条理由。
 */
export function formatClock(at: number, locale: LocaleId): string {
  return new Date(at).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 文件大小：字节 → "1.2 MB" / "340 KB"。
 *
 * 千进制（1000）不是 1024：网盘面板与浏览器下载列表都用千进制，用户心里的
 * "MB" 是那个 MB。服务器不报大小（`contentLength` 缺失）时调用方根本不该
 * 走到这里 —— 这一层只负责"有数字时怎么说"，不负责编一个。
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // 整数字节不跟小数点；其余保留一位（1.2 MB 够指认，1.24 MB 是噪音）。
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}
