import { defineBackground } from 'wxt/utils/define-background';
import { RESCHEDULE_MESSAGE, SYNC_SOON_MESSAGE } from '../lib/messages';

/**
 * 后台职责：
 * 1. 工具栏图标点击 = 打开书签主页（不需要任何权限）。
 * 2. 定时同步用的 alarm。MV3 的 service worker 随时会被杀，
 *    **绝不能**用 setInterval 或全局变量保存计划 —— 每次唤醒都重新读配置并重建 alarm。
 * 3. 书签事件只负责"安排一次稍后的同步"，不在事件回调里跑网络请求（长任务会被平台掐断）。
 * 4. 每日维护：回收站自动过期 + 恢复点按保留策略整理，
 *    同样走 alarm，不做常驻定时器。两件事都受「自动同步」开关管辖。
 */

const SYNC_ALARM = 'shistart-sync';
const SYNC_DEBOUNCE_ALARM = 'shistart-sync-debounce';
const TRASH_EXPIRY_ALARM = 'shistart-trash-expiry';
/** 回收站自动过期的检查周期：一天一次。 */
const TRASH_EXPIRY_PERIOD_MINUTES = 24 * 60;

/**
 * 收到"立刻同步"请求后，若上一轮还没跑完，等这么久再补一次。
 *
 * 2 秒远小于 MV3 的 30 秒空闲回收阈值，所以这个 `setTimeout` 实际等得到。
 * 就算等不到（worker 被回收），`onRemoved` 那条防抖 alarm 仍是兜底。
 */
const SYNC_SOON_RETRY_MS = 2_000;

/**
 * 跑一轮"立刻"的同步（主页删完书签会请我们做）。
 *
 * **为什么不在页面里直接跑**：页面随时可能被用户关掉，而同步跑到一半被掐断会**占着租约**
 * 直到超时（120 秒），那期间后台的防抖 alarm 也会被挡下 —— 结果比不做还晚。
 * service worker 由浏览器管生命周期，比一个正在被关掉的标签页可靠得多。
 *
 * 受「自动同步」开关管辖：关掉自动同步是用户的明确选择，不能借这条通道偷偷跑。
 * 被拒（`busy`）时补一次 —— 上一轮同步是**在删除之前**开始的话，它不包含这次删除。
 *
 * 既有约定 之前的 60 秒早同步冷却已退休：快照模型下一轮只有个位数请求，
 * "删几十个变成几十轮"不再有请求风暴的后果，冷却只是让删除看起来更迟钝。
 *
 * 注意：**这里不再广播"同步跑完了"** —— `runSync` 自己会在收尾时广播（收进引擎，
 * 免得设置页那种"另一个调用点"漏掉，那正是"手动同步后回收站不刷新"的成因）。
 */
async function runSyncSoon(): Promise<void> {
  const { loadSyncConfig, isConfigured } = await import('../services/sync-config');
  const config = await loadSyncConfig();
  if (!isConfigured(config) || !config.autoSync) return;

  const { runSync, SyncError } = await import('../services/sync-engine');
  try {
    await runSync('debounced');
  } catch (error) {
    if (!(error instanceof SyncError) || error.kind !== 'busy') return;
    await new Promise((resolve) => setTimeout(resolve, SYNC_SOON_RETRY_MS));
    await runSync('debounced').catch(() => undefined);
  }
}

async function ensureAlarm(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  const { loadSyncConfig, isConfigured } = await import('../services/sync-config');
  const config = await loadSyncConfig();
  const existing = await chrome.alarms.get(SYNC_ALARM);

  // 关掉自动同步就撤掉 alarm：留着一个定时唤醒的定时器是纯粹的耗电。
  if (!isConfigured(config) || !config.autoSync) {
    if (existing) await chrome.alarms.clear(SYNC_ALARM);
    return;
  }

  const periodInMinutes = Math.max(5, Math.min(720, config.intervalMinutes));
  if (existing && Math.round(existing.periodInMinutes ?? 0) === periodInMinutes) return;
  await chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes,
    // 装好之后先等一会儿，避免扩展一加载就抢着同步。
    delayInMinutes: Math.max(1, Math.min(periodInMinutes, 2)),
  });
}

/**
 * 回收站自动过期的 alarm。
 *
 * **受「自动同步」开关同时管辖**：自动过期要推 purge 操作、还要删云端档案，都是网络动作。
 * 用户关掉自动同步就是说"别自动跑网络"，那时连过期也不该跑（见 既有约定）。这一点
 * 在回收站的提示里写明了，不能让用户以为它还在跑。
 */
async function ensureTrashExpiryAlarm(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  const { loadSyncConfig, isConfigured } = await import('../services/sync-config');
  const config = await loadSyncConfig();
  const existing = await chrome.alarms.get(TRASH_EXPIRY_ALARM);

  if (!isConfigured(config) || !config.autoSync) {
    if (existing) await chrome.alarms.clear(TRASH_EXPIRY_ALARM);
    return;
  }
  if (existing && Math.round(existing.periodInMinutes ?? 0) === TRASH_EXPIRY_PERIOD_MINUTES) return;
  await chrome.alarms.create(TRASH_EXPIRY_ALARM, {
    periodInMinutes: TRASH_EXPIRY_PERIOD_MINUTES,
    // 先等一会儿：没到期的东西再等半小时也还是没到期。
    delayInMinutes: 30,
  });
}

/**
 * 跑一次每日维护：回收站到期清理+ 恢复点按保留策略整理。
 *
 * 两件事挂在同一个日更 alarm 上，因为它们是同一个问题的两半 —— **云上"曾经存在过的数据"的存量**。
 * 到期清理把墓碑清掉（从各设备与同步状态里消失），保留策略把恢复点份数压住
 * （`彻底删除` 不回改旧档案，所以这是那些副本唯一的收敛机制，见 既有约定）。
 *
 * **到期检查没有到期条目时一个请求都不发**（判定在 `purgeExpiredTrash` 里先做完）。
 * 整理那一步则**每天至少一次 PROPFIND** —— 不列一遍目录就不知道有几份，
 * 这是"知道份数"的固定成本，量级是每天 1 次，可以接受。
 *
 * **闸门放在这里而不是只放在 alarm 的创建处**：两者都要推操作、删云端档案，都是网络动作，
 * 必须受「自动同步」开关管辖。`ensureTrashExpiryAlarm`
 * 已经会在关掉开关时撤掉 alarm，但 `bootstrap()` 还会在启动/安装时**直接**调一次 ——
 * 只靠 alarm 的存在与否拦不住那条路径，于是"关了自动同步、重启浏览器"仍会偷偷清理。
 * 在这里查一次，所有入口都拦得住。
 */
async function runDailyUpkeep(): Promise<void> {
  try {
    const { loadSyncConfig, isConfigured } = await import('../services/sync-config');
    const config = await loadSyncConfig();
    if (!isConfigured(config) || !config.autoSync) return;

    // 既有约定 之后三件事合成一个入口：跑一轮同步会把到期的墓碑打成 purged（过期在
    // 合并时确定性计算），然后整理恢复点、清理 30 天没更新的状态文档。
    const { runDailyMaintenance } = await import('../services/sync-engine');
    await runDailyMaintenance();
  } catch (error) {
    // 自动动作失败**不弹任何东西**，只写进同步记录。
    const { SyncError } = await import('../services/sync-engine');
    // "已有一次同步在进行中"是正常并发（定时撞上手动），不是故障 —— 记成错误会白吓人一跳。
    if (error instanceof SyncError && error.kind === 'busy') return;
    const { appendSyncEvent } = await import('../services/sync-events');
    await appendSyncEvent({
      kind: 'error',
      trigger: 'trash-expiry',
      success: false,
      detail: `自动维护没做成：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function bootstrap(): Promise<void> {
  await ensureAlarm();
  await ensureTrashExpiryAlarm();
  // 启动时那一次：否则关了浏览器 40 天再打开，要等到下一个定时点才清，
  // 那期间回收站显示的是过期数据。
  await runDailyUpkeep();
}

export default defineBackground(() => {
  chrome.action.onClicked.addListener(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
  });

  // 启动、安装、更新都要重建 alarm —— worker 是新的，上一次的定时器已经不存在了。
  void bootstrap();
  chrome.runtime.onInstalled.addListener(() => void bootstrap());
  chrome.runtime.onStartup.addListener(() => void bootstrap());

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TRASH_EXPIRY_ALARM) {
      void runDailyUpkeep();
      return;
    }
    if (alarm.name !== SYNC_ALARM && alarm.name !== SYNC_DEBOUNCE_ALARM) return;
    void (async () => {
      // 既有约定 之前的"防抖轮先问有没有变化"已退休：那一问是为了省 op-log 模型下
      // 十来个请求的空转，快照模型下一轮是 1 次列目录 + 每台设备 1 次读 + 1 次写，
      // 省下来的还抵不上判定本身的成本。
      try {
        const { runSync } = await import('../services/sync-engine');
        // 把 alarm 名映射成触发原因枚举，而不是拼一个裸字符串。
        // 记录一旦落盘字段语义就冻结了，所以类型在这里就要准（见 既有约定）。
        await runSync(alarm.name === SYNC_DEBOUNCE_ALARM ? 'debounced' : 'interval');
      } catch {
        // 自动同步的失败不弹任何东西：错误已经写进状态里，设置页能看到。
        // 静默是为了不让后台的每一次网络抖动都变成一次打断。
      }
      // 成功失败都会由 `runSync` 自己广播"同步跑完了"，这里不用再发一次。
    })();
  });

  /**
   * 书签变化 → 安排一次稍后的同步。
   *
   * 刻意不在这里生成操作：事件可能丢（worker 被杀）、可能重复（浏览器自己的账号同步），
   * 也可能就是我们刚写进去的远端变更。真正的对账在同步开始时整树重读做一次。
   */
  const scheduleDebounced = (): void => {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    void (async () => {
      const { loadSyncConfig, isConfigured } = await import('../services/sync-config');
      const config = await loadSyncConfig();
      if (!isConfigured(config) || !config.autoSync) return;
      await chrome.alarms.create(SYNC_DEBOUNCE_ALARM, { delayInMinutes: 0.5 });
    })();
  };

  const events = [
    chrome.bookmarks?.onCreated,
    chrome.bookmarks?.onChanged,
    chrome.bookmarks?.onMoved,
    chrome.bookmarks?.onRemoved,
    chrome.bookmarks?.onChildrenReordered,
  ];
  for (const event of events) {
    if (event) event.addListener(scheduleDebounced);
  }

  // 设置页改完「自动同步」开关或间隔后请后台重排。没有这条通道的话，
  // 改动要等下一次 worker 重启（浏览器重启 / 扩展更新）才生效 ——
  // 用户会觉得开关"点了没用"。
  //
  // 另一条是「立刻同步」：主页删掉书签之后要马上把它变成可找回的墓碑，
  // 不然用户去看回收站是空的（见 runSyncSoon 的说明）。
  chrome.runtime.onMessage.addListener((message) => {
    const type = (message as { type?: string } | undefined)?.type;
    if (type === RESCHEDULE_MESSAGE) {
      // 自动同步开关/间隔一改，两个 alarm 都要重排：回收站过期的那个也受同一个开关管辖。
      void ensureAlarm();
      void ensureTrashExpiryAlarm();
      return;
    }
    if (type === SYNC_SOON_MESSAGE) void runSyncSoon();
  });
});
