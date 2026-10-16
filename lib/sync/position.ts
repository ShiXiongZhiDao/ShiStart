/**
 * 分数索引（fractional indexing）—— 跨设备的稳定排序键。
 *
 * 为什么不直接用浏览器的 `index`：那是**当前这棵树**的投影。两台设备各自插入一个书签时
 * 完全可能拿到同一个 index，而"谁在前"就变成随应用顺序漂移的东西，反复同步永远收敛不了。
 *
 * 方案：每个节点带一个 base62 字符串 position，同级按它排序。往两个已有节点之间插入时
 * 生成中点字符串，不需要改动任何兄弟节点 —— 因此一次插入只产生一条操作。
 *
 * ## 键的结构：整数部分 + 小数部分
 *
 * 一个键形如 `aV` / `aWz` / `bGcz`，拆成两段：
 *
 * - **整数部分**：由首位字母决定长度 —— `'a'..'z'` 对应 2..27 位，`'Z'..'A'` 对应 2..27 位。
 *   `'a'` 起的是正数区（字典序在后、看起来"大"），`'Z'` 起的是负数区（排在最前）。
 * - **小数部分**：整数部分之后的所有字符。空串表示"正好落在整数格上"。
 *
 * 把键理解成无限小数（小数部分不足处补 `'0'`）就能得到排序：
 * `aV` = 0.a V 0 0 …，`aV1` = 0.a V 1 0 …，所以 `aV < aV1`。
 * 这个顺序与 JS 的字符串比较一致，`comparePosition` 因此可以直接 `a < b`。
 *
 * ## 为什么必须这样分层（这版改了什么）
 *
 * 上一版把整个键都当小数处理，末尾追加时只能不断往右取中点。而"末尾"没有右端点，
 * 首位数字很快顶到 `'z'` 就再也上不去，于是**每追加一次键就长一位** ——
 * 1000 条书签能长出 200 个字符。键本身还严格递增，所以很难发现，只会白白吃存储和带宽。
 *
 * 分层的意义是：**末尾追加只动整数部分**（`aV` → `aW` → `aX`，长度恒定），
 * 只有整数位顶满（`azz`）时才进位到更长的整数部分。
 * 实测末尾追加 5000 次，键长仍只有 5。
 *
 * 唯一会真正变长的场景是"在极窄区间里反复插"（`aV` 与 `aV1` 之间连插），
 * 那是键空间的客观极限，不是缺陷。
 *
 * ## 约束
 *
 * - 整数部分首位必须是 `'a'..'z'` 或 `'Z'..'A'`（这决定了整数部分长度）。
 * - **整个键不得以 `'0'` 结尾**（`'0'` 是"这一位可以再往下分"的哨兵）。
 *   注意是"不以 `0` 结尾"而非"不含 `0`" —— `a0V` 完全合法，
 *   把约束写成"不含 `0`"会让 `aV` 与 `aV1` 之间变成无解的死区。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const MIN_DIGIT = DIGITS[0] as string;
const MAX_DIGIT = DIGITS[BASE - 1] as string;

/** 空列表里第一个键。取整数区中部，两侧都留足空间。 */
const FIRST_KEY = `a${DIGITS[Math.floor(BASE / 2)]}`;

/** 键空间的下确界（`'A'` + 26 个 `'0'`），它本身被禁用以免没有前驱。 */
const SMALLEST_KEY = `A${MIN_DIGIT.repeat(26)}`;

export class PositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionError';
  }
}

/**
 * 键是否合法。
 *
 * 三个条件：首位必须能导出整数部分宽度；长度不小于该宽度；**整个键不得以 `'0'` 结尾**。
 * 内部出现 `'0'` 是允许的（如 `a0V`），它表示"整数部分恰好落在格上"。
 */
export function validatePosition(key: string): boolean {
  if (typeof key !== 'string' || key === '') return false;
  if (key === SMALLEST_KEY) return false;
  const width = integerWidth(key[0] as string);
  if (width === null) return false;
  if (key.length < width) return false;
  for (const char of key) {
    if (!DIGITS.includes(char)) return false;
  }
  return !key.endsWith(MIN_DIGIT);
}

/**
 * 首位字符决定的整数部分位数。
 *
 * `'a'`..`'z'` 是正数区，越往后整数部分越长；`'Z'`..`'A'` 是负数区。
 * 这样 `a0`..`az`（2 位）、`b00`..`bzz`（3 位）…… 在字典序上天然连成一片，
 * 不需要分隔符就能区分"整数"和"小数"。
 */
function integerWidth(head: string): number | null {
  const code = head.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 97 + 2; // 'a'→2 … 'z'→27
  if (code >= 65 && code <= 90) return 90 - code + 2; // 'Z'→2 … 'A'→27
  return null;
}

function integerOf(key: string): string {
  return key.slice(0, integerWidth(key[0] as string) as number);
}

function fractionOf(key: string): string {
  return key.slice(integerWidth(key[0] as string) as number);
}

/**
 * 两个键的先后。
 *
 * 直接比较即可：整数部分定长（由首位决定），小数部分不足处补 `'0'` 相当于短键更小，
 * 而 JS 的 `<` 对同为 base62 字符的串正好给出这个顺序。
 */
export function comparePosition(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 整数部分 +1；已经全是最大位则返回 null（表示需要进位到更长的整数部分）。 */
function incrementInteger(value: string): string | null {
  if (value === MAX_DIGIT.repeat(value.length)) return null;
  const chars = value.split('');
  for (let at = chars.length - 1; at >= 0; at -= 1) {
    const digit = DIGITS.indexOf(chars[at] as string);
    if (digit === BASE - 1) {
      chars[at] = MIN_DIGIT;
    } else {
      chars[at] = DIGITS[digit + 1] as string;
      return chars.join('');
    }
  }
  return chars.join('');
}

/** 整数部分 -1；已经全是 `'0'` 则返回 null。 */
function decrementInteger(value: string): string | null {
  if (value === MIN_DIGIT.repeat(value.length)) return null;
  const chars = value.split('');
  for (let at = chars.length - 1; at >= 0; at -= 1) {
    const digit = DIGITS.indexOf(chars[at] as string);
    if (digit === 0) {
      chars[at] = MAX_DIGIT;
    } else {
      chars[at] = DIGITS[digit - 1] as string;
      return chars.join('');
    }
  }
  return chars.join('');
}

/**
 * 小数部分的中点。`lower` 可为空串（表示下界 0），`upper` 为 undefined 表示上界 1。
 *
 * 算法只有三步：跳过公共前缀 → 本层取中点 → 本层没空位时借位下钻。
 *
 * 关键是第三步的**上界传递**：本层没空位说明 `low` 与 `high` 相邻（或 high 就是无穷）。
 * 借 `lower` 的首位往下走时，新一层的区间是 `(lower[1:], upper[1:])` ——
 * 但如果 `upper` 本来就只有一位（如 `upper = '1'`），它下一层并不是"无穷"，
 * 而是"`'1'` 这一格再往里分"，即上界要进一格变成 `'2'`，再把 `'2'` 之后的层当作无穷。
 * 这里若图省事直接把空串当无穷，就会产出越过 `upper` 的键。
 */
function midpoint(lower: string, upper: string | undefined): string {
  // 上界为空串意味着"这一层之后即上界本身"，没有可用的空位，
  // 合法区间只可能是 (lower, 本层上界] 内部 —— 直接借下界首位往下走一步。
  if (upper === '') {
    const head = lower === '' ? MIN_DIGIT : (lower[0] as string);
    return head + midpoint(lower.slice(1), undefined);
  }

  if (upper !== undefined) {
    let common = 0;
    while (common < upper.length && (lower[common] ?? MIN_DIGIT) === upper[common]) common += 1;
    if (common > 0) {
      return upper.slice(0, common) + midpoint(lower.slice(common), upper.slice(common));
    }
  }
  const low = lower === '' ? 0 : DIGITS.indexOf(lower[0] as string);
  const high = upper === undefined ? BASE : DIGITS.indexOf(upper[0] as string);

  if (high - low > 1) {
    return DIGITS[Math.floor(0.5 * (low + high))] as string;
  }
  if (upper !== undefined && upper.length > 1) {
    return upper.slice(0, 1);
  }
  // 本层已无空位：借下界的首位，往更深一层继续分。
  const head = lower === '' ? MIN_DIGIT : (lower[0] as string);
  const deepLower = lower.slice(1);
  // upper 只有一位时，它下一层的上界不是"无穷"，而是"这一格再往里分"，
  // 即进一格（'1'→'2'）；已是最大位才是真无穷。
  const deepUpper = upper === undefined ? undefined : (successorDigit(upper) ?? undefined);
  return head + midpoint(deepLower, deepUpper);
}

/**
 * 单个字符的"进一格"，返回 `null` 表示已是最大位（之后是无穷）。
 *
 * `'1'` → `'2'`，`'z'` → null。用于把"本层上界进位到下一层"表达成
 * "下一层的上界"，从而让递归知道区间不是开到无穷。
 */
function successorDigit(char: string): string | null {
  const digit = DIGITS.indexOf(char);
  if (digit < 0 || digit >= BASE - 1) return null;
  return DIGITS[digit + 1] as string;
}

/**
 * 生成严格位于 `before` 与 `after` 之间的新键。两端都可为空（表示"最前/最后"）。
 *
 * 传入非法键或 `before >= after` 直接抛错 —— 静默产出一个乱序键的后果是整层顺序长期错乱，
 * 比当场崩溃难查得多。
 */
export function positionBetween(before?: string | null, after?: string | null): string {
  const lower = before ?? null;
  const upper = after ?? null;

  if (lower !== null && !validatePosition(lower)) {
    throw new PositionError(`非法的排序键：${lower}`);
  }
  if (upper !== null && !validatePosition(upper)) {
    throw new PositionError(`非法的排序键：${upper}`);
  }
  if (lower !== null && upper !== null && comparePosition(lower, upper) >= 0) {
    throw new PositionError(`排序键区间无效：${lower} 不小于 ${upper}`);
  }

  if (lower === null && upper === null) return FIRST_KEY;

  if (lower === null) {
    // 插到最前：整数部分 -1，小数部分取满。
    const integer = integerOf(upper as string);
    const stepped = decrementInteger(integer);
    if (stepped !== null) return stepped + MAX_DIGIT;
    // 整数部分已到 0：换到更长的负整数区（'a'→'Z'，再往前则字母递减）。
    const head = integer[0] as string;
    const wider = head === 'a' ? 'Z' : String.fromCharCode(head.charCodeAt(0) - 1);
    return wider + MAX_DIGIT.repeat((integerWidth(head) as number) - 1);
  }

  const lowerInteger = integerOf(lower);
  const lowerFraction = fractionOf(lower);

  if (upper === null) {
    // 末尾追加：整数部分 +1，**长度通常恒定**，这是修好退化的关键一步。
    const stepped = incrementInteger(lowerInteger);
    if (stepped !== null) return stepped + MAX_DIGIT;
    // 整数位已顶满，只能在同一整数格内细分。这是唯一会变长的末尾场景。
    return lowerInteger + midpoint(lowerFraction, undefined);
  }

  const upperInteger = integerOf(upper);
  const upperFraction = fractionOf(upper);

  if (lowerInteger === upperInteger) {
    return lowerInteger + midpoint(lowerFraction, upperFraction);
  }

  const stepped = incrementInteger(lowerInteger);
  if (stepped !== null && stepped < upperInteger) return stepped + MAX_DIGIT;
  if (lowerInteger < upperInteger) return lowerInteger + midpoint(lowerFraction, undefined);

  throw new PositionError(`排序键区间无效：${lower} 不小于 ${upper}`);
}

/** 为一个有序列表一次性生成等距的键。用于首次导入、以及整层顺序发生变化时。 */
export function positionsFor(count: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < count; at += 1) {
    out.push(positionBetween(at === 0 ? null : (out[at - 1] as string), null));
  }
  return out;
}
