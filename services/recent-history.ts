/**
 * 最近访问：读浏览器自己的浏览历史。
 *
 * 与书签同构 —— **实时读、不另存副本**：浏览器是唯一事实来源，本扩展不留
 * 历史库、不做聚合、不上传。换来的是 manifest 里多一个 `history` 权限
 * （安装时一条「读取您的浏览历史」警告），这笔账记在 既有约定。
 *
 * 为什么排序自己做：`chrome.history.search` 的返回顺序没有文档保证，
 * 别把"最新在前"押在 API 的未述行为上 —— 拉回来按 lastVisitTime 排一遍。
 * 为什么去重：search 理论上按 URL 给一条，但不去重的话一旦返回重复行，
 * 列表前二十行会被同一批站点占满（面板只有 50 个坑）。
 */

import { fallbackLabel } from '../lib/bookmark-mapper';
import { dayBucketOf, type DayBucket } from '../lib/format-time';

/** 面板容量：50 条。再多一屏放不下，也更难扫。 */
export const RECENT_LIMIT = 50;

/** 一条最近访问（展示模型：域名与字母牌在这里兜好，组件直接画）。 */
export interface RecentVisit {
  url: string;
  /** 标题；历史里可能为空，已兜底成域名（仍为空才退回网址本身）。 */
  title: string;
  /** 最后一次访问时间（ms）。 */
  lastVisitTime: number;
  /** 主机名去 `www.`，图标色相种子。 */
  domain: string;
  /** 字母牌文字：标题前 1–2 字符（复用书签那边同一份规则）。 */
  fallbackLabel: string;
}

/** `chrome.history.search` 返回单条的最小形状（node 测试里整个换掉）。 */
export interface HistoryItemLike {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}

/** 浏览器历史 API 的最小形状（node 测试里整个换掉）。 */
export interface HistoryApiLike {
  search?: (query: { text: string; maxResults: number }) => Promise<HistoryItemLike[]>;
  onVisited?: {
    addListener: (listener: (result: HistoryItemLike) => void) => void;
    removeListener: (listener: (result: HistoryItemLike) => void) => void;
  };
}

function historyApi(): HistoryApiLike | undefined {
  if (typeof chrome === 'undefined') return undefined;
  return (chrome as { history?: HistoryApiLike }).history;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 把一条原始历史记录整成展示模型。标题空 ⇒ 域名 ⇒ 网址，逐级兜底。 */
function toVisit(url: string, rawTitle: string | undefined, lastVisitTime: number): RecentVisit {
  const domain = domainOf(url);
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const display = title !== '' ? title : domain || url;
  return { url, title: display, lastVisitTime, domain, fallbackLabel: fallbackLabel(display) };
}

/**
 * 去重 + 排序 + 截断（纯函数，node 可测）。
 *
 * 同一网址只留**最近一次**访问；空 url 的记录跳过（浏览器偶尔会有）；
 * `lastVisitTime` 缺失当 0 处理（排最后，不猜时间）。
 */
export function pickRecentVisits(
  items: readonly HistoryItemLike[],
  limit: number = RECENT_LIMIT,
): RecentVisit[] {
  const byUrl = new Map<string, RecentVisit>();
  for (const item of items) {
    const url = typeof item?.url === 'string' ? item.url : '';
    if (url === '') continue;
    const at =
      typeof item.lastVisitTime === 'number' && Number.isFinite(item.lastVisitTime)
        ? item.lastVisitTime
        : 0;
    const seen = byUrl.get(url);
    if (seen && seen.lastVisitTime >= at) continue;
    byUrl.set(url, toVisit(url, item.title, at));
  }
  return [...byUrl.values()].sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, limit);
}

/**
 * 是不是**本扩展自己**的新标签页。
 *
 * 真机探针逮到的：chrome_url_overrides 接管的新标签页**会进浏览器历史**
 * （每次开新标签都记一条）。它没有任何用户意图，却因为"每次开标签都访问"
 * 永远冒在列表最前面 —— 把用户真正的最近访问全埋掉。所以自己这台页不算
 * "访问过"。（别的扩展的页面不滤：用户确实主动去过。）
 */
function isOwnPage(url: string): boolean {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return false;
  return url.startsWith(chrome.runtime.getURL('/'));
}

/** 读最近 `limit` 条访问。API 不存在或调用失败一律抛给调用方（界面走错误态）。 */
export async function fetchRecentVisits(limit: number = RECENT_LIMIT): Promise<RecentVisit[]> {
  const api = historyApi();
  if (!api?.search) throw new Error('history-unavailable');
  const items = await api.search({ text: '', maxResults: limit });
  // 先滤自己的新标签页，再去重排序截断 —— 不然它会占掉 50 个坑里最前面的一个。
  const foreign = (items ?? []).filter((item) => !isOwnPage(item?.url ?? ''));
  return pickRecentVisits(foreign, limit);
}

/**
 * 一档访问（既有约定 重设计：50 条平铺是一面墙，分成 今天/昨天/更早 三档）。
 * 桶内顺序 = 传入顺序 = 最新在前。
 */
export interface RecentVisitGroup {
  bucket: DayBucket;
  visits: RecentVisit[];
}

/** 分组顺序（也是空桶被跳过的顺序）。 */
const BUCKET_ORDER: readonly DayBucket[] = ['today', 'yesterday', 'earlier'];

/** 按日历天分档。空档不返回；档位顺序固定 今天 → 昨天 → 更早。 */
export function groupRecentVisits(
  visits: readonly RecentVisit[],
  now: number,
): RecentVisitGroup[] {
  const buckets = new Map<DayBucket, RecentVisit[]>();
  for (const visit of visits) {
    const bucket = dayBucketOf(visit.lastVisitTime, now);
    const list = buckets.get(bucket);
    if (list) list.push(visit);
    else buckets.set(bucket, [visit]);
  }
  return BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) => ({
    bucket,
    visits: buckets.get(bucket) as RecentVisit[],
  }));
}

/**
 * 订阅「有新访问」事件。返回退订函数。
 *
 * 为什么订阅住在服务层：`chrome.history` 的访问点只此一处，与 search 对称；
 * 调用方（useRecentVisits）拿到的listener 只在面板开着时才该起作用，
 * 那条策略属于组合层，不在这里。
 */
export function onHistoryVisited(listener: (result: HistoryItemLike) => void): () => void {
  const api = historyApi();
  if (!api?.onVisited) return () => {};
  api.onVisited.addListener(listener);
  return () => {
    api.onVisited?.removeListener(listener);
  };
}
