/**
 * 版本全序（纯函数）。
 *
 * 逐字段 LWW 的胜负判定、删除闸门的因果判定都建立在这个序上。
 * 两条硬规则：
 * 1. **只认因果，不信墙钟** —— 时钟不准的那台设备的改动静默消失，
 *    是 既有约定 反对 LWW 的核心理由；Lamport 序不受墙上时钟影响。
 * 2. **平票必须确定** —— 两个并发写入 clock 相同时，两台设备必须选出
 *    同一个赢家，否则各活各的、永久分叉。writerId 字典序是任意的但确定。
 */

import type { Version } from '../../types/sync-state';

/** 全序：clock 大的赢；平票比 writerId 字典序。 */
export function compareVersion(a: Version, b: Version): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.writerId === b.writerId) return 0;
  return a.writerId < b.writerId ? -1 : 1;
}

export function maxVersion(a: Version | null, b: Version | null): Version | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareVersion(a, b) >= 0 ? a : b;
}

/**
 * `base` 的写入方有没有"见过" `target` 这个版本？删除闸门的判定核心。
 *
 * 混合规则，三个场景各自推导过：
 * 1. **clock 严格大 ⇒ 见过**。旧状态场景靠它：设备 B 两天没同步（手里是 `nv=(3,c)`
 *    的旧写入），设备 A 在 `base=(20,d)` 上删除同一个节点——A 显然见过那套旧状态，
 *    判"没见过"会让每台落后设备都触发一次假闸门，正是 既有约定 的淹没失败模式。
 *    （这是 Lamport 序的实用假设：见过更新的东西 ⇒ 上下文覆盖了更旧的。没有版本向量，
 *     它不是定理；破产时漏报，由覆盖日志兜底。）
 * 2. **clock 相等 ⇒ 只有同一写入方算见过**。同钟不同写入方时全序判不了"见过"——
 *    B 的 clock 爬到 5 只说明它见过某条 clock=5 的写入，不说明见过 A 的那一条。
 *    这种碰撞罕见（两台设备计数器撞同一个值又互没看过），偏向误报：多问用户一句，
 *    好过把并发编辑静默贴在已删节点上。
 * 3. **clock 小 ⇒ 没见过**。真正的并发：两边基于同一套旧状态各自写。
 *
 * 最常见的两个精确场景：复活写入的 base 恰好是被删节点的 nv（同钟同写入方 ⇒ 见过），
 * 知情删除的反向判定同理。
 */
export function versionSees(base: Version | null, target: Version): boolean {
  if (base === null) return false;
  if (base.clock !== target.clock) return base.clock > target.clock;
  return base.writerId === target.writerId;
}

/** 本机时钟推进：取"我已见过的最大 clock"，本地写入在它基础上 +1。 */
export function advanceClock(current: number, observed: readonly Version[]): number {
  let next = current;
  for (const version of observed) {
    if (version.clock > next) next = version.clock;
  }
  return next;
}
