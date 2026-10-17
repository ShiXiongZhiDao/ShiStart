import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

/**
 * 按**绝对截止时间**倒计时。
 *
 * 为什么不用"从现在起数 N 秒"：撤销窗口的起点是**那次移动发生的时刻**（记录里的 `at`），
 * 不是"这一屏渲染出来的时刻"。用户移动完立刻关掉标签页、20 秒后再打开，
 * 撤销窗口已经过了 —— 用相对时长会让它重新数一遍，凭空多给一次机会，
 * 而且每次开新标签页都会冒出同一条提示。
 *
 * 暂停/恢复是必需的，不是锦上添花：用户看到提示、把鼠标移过去点「撤销」，
 * 中途到点消失等于在他伸手时把东西抽走 —— 比不自动关更糟。键盘 Tab 到按钮上同理。
 *
 * 精度用 `tick`（默认 100ms）而不是逐帧 rAF：调用方拿 `progress` 驱动一条
 * 带 `transition` 的进度条，100ms 的粒度在 10 秒里每步 1%，肉眼是连续的。
 * 而且 setInterval 在测试里能被 fake timers 完整接管，rAF 不行。
 */

export interface CountdownOptions {
  /** 截止的绝对时间戳（`Date.now()` 口径）。返回 `null` = 这一轮不计时。 */
  deadline: () => number | null;
  /** 到点时调一次。 */
  onExpire: () => void;
  /** 整段窗口多长（ms），只用来算 `progress`。 */
  total: number;
  /** 检查间隔（ms），默认 100。 */
  tick?: number;
  /** 取"现在"，默认 `Date.now`。测试注入用。 */
  now?: () => number;
}

export interface Countdown {
  /** 剩余毫秒。到点后停在 0。 */
  remaining: Ref<number>;
  /** 1 → 0，给进度条用。 */
  progress: ComputedRef<number>;
  /** 按 `deadline()` 重开一轮。deadline 已过期或为 null ⇒ 不跑，剩余 0。 */
  restart: () => void;
  /** 冻结剩余时间。已经在暂停中就是空操作。 */
  pause: () => void;
  /** 从冻结处继续。没暂停过就是空操作。 */
  resume: () => void;
  /** 停表并归零，不再回调。 */
  stop: () => void;
}

export function useCountdown(options: CountdownOptions): Countdown {
  const { total, tick = 100 } = options;
  const now = options.now ?? Date.now;

  const remaining = ref(0);
  const progress = computed(() => {
    if (!(total > 0)) return 0;
    return Math.min(1, Math.max(0, remaining.value / total));
  });

  let handle: ReturnType<typeof setInterval> | null = null;
  /** 这一轮真正的截止时间：暂停恢复会把它整体后移，所以不能直接读 `deadline()`。 */
  let endsAt = 0;
  /** 暂停发生的那一刻；0 = 没在暂停。 */
  let pausedAt = 0;

  function clearTimer(): void {
    if (handle !== null) {
      clearInterval(handle);
      handle = null;
    }
  }

  function schedule(): void {
    clearTimer();
    if (pausedAt || remaining.value <= 0) return;
    handle = setInterval(sync, tick);
  }

  /** 重新读一次"还剩多久"。归零就停表并回调。 */
  function sync(): void {
    if (pausedAt) return;
    remaining.value = Math.max(0, endsAt - now());
    if (remaining.value > 0) return;
    clearTimer();
    options.onExpire();
  }

  function restart(): void {
    clearTimer();
    pausedAt = 0;
    const at = options.deadline();
    endsAt = typeof at === 'number' ? at : 0;
    remaining.value = endsAt > 0 ? Math.max(0, endsAt - now()) : 0;
    schedule();
  }

  function pause(): void {
    if (pausedAt || remaining.value <= 0) return;
    pausedAt = now();
    clearTimer();
  }

  function resume(): void {
    if (!pausedAt) return;
    // 把停住的那一段补回去，而不是重新给满 —— 暂停前已经走过的时间不该被抹掉。
    endsAt += now() - pausedAt;
    pausedAt = 0;
    sync();
    schedule();
  }

  function stop(): void {
    clearTimer();
    pausedAt = 0;
    endsAt = 0;
    remaining.value = 0;
  }

  // 组件卸载要收掉 interval；脱离 effect scope 调用时（单测直接调）没有 scope，跳过。
  if (getCurrentScope()) onScopeDispose(stop);

  return { remaining, progress, restart, pause, resume, stop };
}
