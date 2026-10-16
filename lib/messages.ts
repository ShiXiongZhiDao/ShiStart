/**
 * 页面 ↔ 后台的消息名。
 *
 * 单独放一处，**不要各写一份字面量**：这类通道靠"两边都拼对同一个字符串"才成立，
 * 而拼错的表现是**点了完全没反应** —— 没有编译错误、没有异常、没有日志。
 * 抽成常量之后，`import` 会把两边绑在一起，名字改了编译就过不去。
 */

/** 设置页改完自动同步配置后，请后台重排 alarm。 */
export const RESCHEDULE_MESSAGE = 'shistart:reschedule-alarm';

/**
 * 请后台**立刻**跑一轮同步。
 *
 * 现在的用法是主页删掉书签之后：回收站是墓碑的视图，而墓碑要等同步跑完才产生，
 * 后台那条防抖 alarm 又受 `chrome.alarms` 的 30 秒下限约束 —— 不立刻同步的话，
 * 用户删完去看回收站必然是空的。
 */
export const SYNC_SOON_MESSAGE = 'shistart:sync-soon';

/**
 * 同步跑完了，通知打开着的页面刷新。
 *
 * 为什么需要它：回收站读的是**本机同步状态**（墓碑、基线），而同步跑在后台的
 * service worker 里 —— 页面自己不知道它什么时候结束。没有这条通知，用户在主页删完
 * 就得手动刷新才看得到，那正是"删了但回收站是空的"的另一半成因。
 *
 * 单向广播：**没有接收方时 `sendMessage` 会 reject，发的一方必须吞掉**。
 */
export const SYNC_DONE_MESSAGE = 'shistart:sync-done';
