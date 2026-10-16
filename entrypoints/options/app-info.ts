/**
 * 扩展元信息。
 *
 * 版本号取 `chrome.runtime.getManifest().version`，而不是 import package.json：
 * 后者会把整个 JSON 打进包里，而且构建产物上的版本才是对用户可见的那个。
 */

/** manifest.json 没给出版本时的兜底。宁可显示一个明显不对的版本，也不要空白。 */
const UNKNOWN = '0.0.0';

export function appVersion(): string {
  const api = typeof chrome === 'undefined' ? undefined : chrome.runtime;
  const manifest = api?.getManifest?.();
  return typeof manifest?.version === 'string' ? manifest.version : UNKNOWN;
}
