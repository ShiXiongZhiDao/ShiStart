/**
 * 规范 JSON 与 payload 指纹（纯函数）。
 *
 * 为什么需要它：同一份 payload 在不同 JS 引擎里 `JSON.stringify` 的键顺序可能不同，
 * 而 `payloadHash` 的用途正是"两台设备各自算一遍、结果必须一致"。
 * 所以这里先按字典序递归排序键、去掉所有空白，再哈希。
 *
 * 这是 JCS（RFC 8785）的子集：我们只产生有限的 JSON 形状（对象/数组/字符串/数字/布尔/null），
 * 没有 NaN、没有超出 double 的整数，因此不需要 JCS 关于数字序列化的完整规则。
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 递归排序键的紧凑序列化。undefined 的成员在 JSON 里本就不存在，这里同步丢掉。 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('规范 JSON 不接受非有限数字');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(serialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const body = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',');
    return `{${body}}`;
  }
  throw new TypeError(`规范 JSON 不支持的值类型：${typeof value}`);
}

/**
 * payload 的 SHA-256 十六进制指纹。
 *
 * 返回 Promise 是因为 Web Crypto 的 digest 天然异步（浏览器与 node 都是）；
 * 不用同步的第三方哈希实现是为了不引入依赖、也不自己发明密码学原语。
 */
export async function payloadHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
