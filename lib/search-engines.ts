import type { SearchEngineId } from '../types/settings';

/**
 * 本地配置的搜索引擎。仅在用户主动按回车时跳转，
 * 输入过程中不会向任何远程服务发送查询词。
 */
export const SEARCH_ENGINES: Record<SearchEngineId, { label: string; queryUrl: string }> = {
  bing: { label: '必应', queryUrl: 'https://www.bing.com/search?q=' },
  baidu: { label: '百度', queryUrl: 'https://www.baidu.com/s?wd=' },
  google: { label: 'Google', queryUrl: 'https://www.google.com/search?q=' },
};

export const SEARCH_ENGINE_IDS = Object.keys(SEARCH_ENGINES) as SearchEngineId[];

export function buildSearchUrl(engine: SearchEngineId, term: string): string {
  return SEARCH_ENGINES[engine].queryUrl + encodeURIComponent(term);
}
