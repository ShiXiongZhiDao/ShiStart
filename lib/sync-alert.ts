/**
 * 顶栏同步按钮上那颗红点该不该出现（既有约定，2026-10-15 修订）。
 *
 * 为什么单独成文件：`entrypoints/newtab/App.vue` 是个 ~1800 行的组件，而仓库
 * **没有组件测试基座**（`vitest.config.ts` 是 node 环境，只收 `lib/**` +
 * `services/**` + `composables/**`）。"哪几种 phase 算异常"是纯判断，抽到这里
 * 就能被单测锁住，不会哪次改样式时顺手改坏了口径。
 *
 * 口径本身：状态点只回答一个问题 —— "有没有需要我去看一眼的事"。所以**正常就是
 * 没有点**，不是"灰点"。灰点看着温和，实际上是把一个本来零信息量的像素常年挂在
 * 顶栏，看久了只会让人想把它抠掉（本次修订的直接动因）。
 *
 * 既有约定 起第四条：**恢复点写入失败也算**（`restorePointError`）。保险断了
 * 但书签照常同步，不挂点的话这个事实只有设置页一处看得见 —— "亮点不藏太深"的
 * 另一面是它坏的时候也不能藏。判据读本机 meta，零网络。
 */

import type { SyncStatus } from '../types/sync-state';

/**
 * 同步是不是"有事要你看一眼"。
 *
 * 恰好四种，都是**不处理就一直挂着**的状态：
 * - `conflict`：删除闸门里躺着待裁决的条目（`conflictCount > 0` 才会是这个 phase，
 *   见 `readSyncStatus`）；
 * - `error` / `auth-required`：上一轮没跑完，原因写在 `lastError`；
 * - `restorePointError` 非空：上次写恢复点失败（本机 meta 的记录，见
 *   `readRestorePointError`）。
 *
 * 反过来，这几种**不挂点**：
 * - `null`（还没读出来）/ `idle`：同步正常，包括从没同步过 —— "没配同步"不是异常，
 *   它只是没开这个功能，用户自己知道；
 * - `syncing`：正在跑，跑完自有结论，中途挂个点没有可行动的信息。
 */
export function syncNeedsAttention(status: SyncStatus | null, restorePointError: string | null = null): boolean {
  if (!status) return restorePointError !== null;
  if (status.phase === 'conflict' || status.phase === 'error' || status.phase === 'auth-required') {
    return true;
  }
  return restorePointError !== null;
}

/**
 * 状态点该落哪个分区（既有约定 决策四）。
 *
 * 分流而不是统一落 `#sync`：冲突 / 上轮失败 / 凭据失效的处置在「同步」区，
 * "保险断"的处置在「快照」区（那里有失败原因与整份列表）。两者同时存在时
 * 落「同步」—— 冲突是挡住正确同步的事，比保险断更重，且保险断的同一行错误
 * 在同步区也看得见（`sync.insurance.broken`）。
 */
export function syncDotHash(status: SyncStatus | null, restorePointError: string | null): '' | '#sync' | '#snapshot' {
  if (status && (status.phase === 'conflict' || status.phase === 'error' || status.phase === 'auth-required')) {
    return '#sync';
  }
  return restorePointError !== null ? '#snapshot' : '#sync';
}
