<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import BookmarkCard from '../../components/BookmarkCard.vue';
import BookmarkContextMenu, {
  type ContextMenuAction,
} from '../../components/BookmarkContextMenu.vue';
import FolderTile from '../../components/FolderTile.vue';
import RecentPanel from '../../components/RecentPanel.vue';
import SidebarNav from '../../components/SidebarNav.vue';
import StatePanel from '../../components/StatePanel.vue';
import { useBookmarks } from '../../composables/useBookmarks';
import { useSettings } from '../../composables/useSettings';
import { useI18n } from '../../composables/useI18n';
import { useSyncPresence } from '../../composables/useSyncPresence';
import { useSidebarTree } from '../../composables/useSidebarTree';
import { useSidebarPeek } from '../../composables/useSidebarPeek';
import { useRecentVisits } from '../../composables/useRecentVisits';
import { useCardTip } from '../../composables/useCardTip';
import { primeDefaultIconSignature } from '../../services/favicon-default';
import { filterBookmarks } from '../../lib/filter';
import { syncDotHash, syncNeedsAttention } from '../../lib/sync-alert';
import { viewIdentityKey } from '../../lib/view-identity';
import { type MessageKey } from '../../lib/i18n';
import {
  findFolderNode,
  flattenFolders,
  folderPathOf,
} from '../../lib/bookmark-mapper';
import {
  SEARCH_ENGINE_IDS,
  buildSearchUrl,
} from '../../lib/search-engines';
import { resolveSelectedFolder } from '../../services/settings-service';
import { removeBookmarkNode } from '../../services/bookmarks-service';
import { SYNC_SOON_MESSAGE } from '../../lib/messages';
import BookmarkFormDialog from '../../components/BookmarkFormDialog.vue';
import EnginePicker from '../../components/EnginePicker.vue';
import DeleteFolderDialog from '../../components/DeleteFolderDialog.vue';
import TrashPanel from '../../components/TrashPanel.vue';
import { useDragArrange, type DropRequest } from '../../composables/useDragArrange';
import { useItemMenu, type MenuTarget } from '../../composables/useItemMenu';
import { resolveDrop, type DropRejectCode } from '../../lib/drag/drop-plan';
import { moveBookmarkNode } from '../../services/bookmark-drag';
import {
  clearLastEdit,
  createBookmarkNode,
  EditError,
  readLastEdit,
  renameBookmarkNode,
  undoLastEdit,
  type LastEdit,
} from '../../services/bookmark-edit';
import {
  consumeFolderDeleteExpectation,
  deleteFolder,
  FolderDeleteError,
} from '../../services/bookmark-folder-delete';
import { findFolderParentId, nodeExistsInTree } from '../../lib/folder/delete-preview';
import {
  copyLink,
  openLinkInIncognitoWindow,
  openLinkInNewTab,
  openLinkInNewWindow,
  openLinkInSplitView,
  TabActionError,
  type TabActionFailure,
} from '../../services/tab-actions';
import {
  ALL_FOLDERS,
  UNFILED_FOLDER,
  type BookmarkFolderNode,
  type BookmarkViewItem,
} from '../../types/bookmarks';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type SearchEngineId,
} from '../../types/settings';

const { status, errorMessage, roots, items, refresh } = useBookmarks();
const { settings, resolvedMode, update, toggleMode, ready } = useSettings();
const { t } = useI18n();

const searchText = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
/** 顶栏下面那一行给用户看的提示（打开设置页 / 书签管理器失败、删除结果…）。 */
const notice = ref('');

/**
 * 同步状态点、配没配同步、自动同步开关、回收站角标、菜单能力探测 —— 这些事实**都由
 * 本页之外的上下文改变**（后台 alarm、设置页的「立即同步」/「一键连接」/「一键回退」），
 * 所以它们单独住在 `useSyncPresence` 里：一处定义"收到「同步跑完了」该刷什么"，
 * 而且能在 node 里测（本组件太大，仓库没有组件测试基座）。
 *
 * `syncConfigured` 除了决定删除确认那行怎么写，**还是侧边栏回收站入口的 `v-if`**；
 * `autoSyncOn` 与它配合，把"删了能不能找回"分成三档而不是两档（见 recoveryMode）。
 */
const {
  syncStatus,
  restorePointError,
  syncConfigured,
  autoSyncOn,
  incognitoReady,
  splitReady,
  trashCount,
  refreshSyncStatus,
  refreshMenuCapabilities,
  refreshTrashCount,
  start: startSyncPresence,
  stop: stopSyncPresence,
} = useSyncPresence({
  // 同步跑完后，本组件还要自己刷的两样：回收站面板、删除文件夹的期望核对。
  onAfterSync: () => {
    void trashPanel.value?.refresh();
    // 删除文件夹的期望核对：被并发编辑挡下的节点，说出来。
    void checkFolderDeleteOutcome();
  },
});

/** 删完之后"删到回收站可见"的全部延迟。见 `earlySync` 的说明。 */
const DELETE_SYNC_WINDOW_MS = 1_500;

/**
 * 删完之后**立刻**把书签变成可找回的墓碑。
 *
 * 为什么非做不可：回收站是**墓碑的视图**，而墓碑只在同步跑完一轮之后才产生。
 * 删除本身只调 `chrome.bookmarks.remove`，一个同步请求都不发。后台那条防抖同步
 * 受 `chrome.alarms` 的硬下限约束，**最短就是 30 秒** —— 用户删完去看回收站，
 * 必然是空的，而且没有任何提示告诉他在等什么。把系统内部的时序暴露成用户的问题，
 * 是"删了就该在回收站看到"这件事上唯一的毛病。
 *
 * 三条边界：
 * - **交给后台跑，不在页面里跑**（见 `runSyncSoon`）：页面随时可能被关掉，
 *   而同步跑到一半被掐断会占着租约直到超时，反而让回收站更晚出现。
 * - **只在配了同步且自动同步开着时发。** 关掉自动同步是用户的明确选择；
 *   那种情况的措辞在下面单独一支，直接告诉用户要点哪里。
 * - **发不出去也不说**：`onRemoved` 触发的后台防抖 alarm 始终在，是兜底。
 *
 * 窗口取 1.5 秒：它同时也是"删完到回收站出现"的延迟，所以必须短到察觉不出来；
 * 而又要挡得住连着删几条（连着删只同步一次）。
 */
let earlySyncTimer: ReturnType<typeof setTimeout> | null = null;

function requestEarlySync(): void {
  if (!syncConfigured.value || !autoSyncOn.value) return;
  // 窗口内重复调用只发一次 —— 连着删几条合并成一轮（原来用 lib/sync/coalesce，
  // 那个模块随 既有约定 退休；这里只需要一个定时器，不值得为它留一层抽象）。
  if (earlySyncTimer !== null) clearTimeout(earlySyncTimer);
  earlySyncTimer = setTimeout(() => {
    earlySyncTimer = null;
    void (async () => {
      try {
        await chrome.runtime.sendMessage({ type: SYNC_SOON_MESSAGE });
      } catch {
        // 后台没接住（极罕见）不影响结果：`onRemoved` 那条防抖 alarm 会把这一轮补上。
      }
    })();
  }, DELETE_SYNC_WINDOW_MS);
}

/**
 * 删掉之后这条**到底能不能找回来**，三档而不是两档。
 *
 * 以前只有"配没配同步"两档，于是"配了同步但自动同步关着"被归进了"可以找回"那一档 ——
 * 而实际上它不会自己进回收站。用户看到的是"可以找回"，做的是删掉、刷新设置页、
 * 然后发现回收站是空的。判据越粗，这种"说错话"越多。
 */
const recoveryMode = computed<'none' | 'auto' | 'manual'>(() => {
  if (!syncConfigured.value) return 'none';
  return autoSyncOn.value ? 'auto' : 'manual';
});

// ---------------------------------------------------------------- 回收站

/** 主区显示哪一屏。回收站与浏览书签是**两屏**，不是一块嵌在列表下面的区域。 */
const activeView = ref<'browse' | 'trash'>('browse');

/**
 * 视图身份键：内容区切换动效的 key（挂在 .view-host 上）。
 *
 * **刻意是个只在用户动作里更新的 ref，不是 computed**：从解析后的 selectedFolderId
 * 算的话，启动加载阶段（设置与书签树陆续读入）它会漂移，每次打开新标签页都会
 * 白播一次切换。数据刷新不碰它 ⇒ "同目录数据增删改不动"从机制上成立。
 * 初值只存在到第一次用户动作 —— 首屏不播切换（那是包装层 appear 的 page-in 的活）。
 */
const viewSwitchKey = ref('boot');

/**
 * 交叉淡入的离开层"三件套"里的两件：消失中的旧目录必须当场从可聚焦树
 * 与读屏树里摘掉 —— 卡片是 <a>，不摘的话 Tab / 读屏会摸到正在淡出的旧内容。
 * 第三件（pointer-events）在 .view-switch-leave-active。元素动画结束即被移除，
 * 无需还原。
 */
function onViewSwitchLeave(el: Element): void {
  el.setAttribute('aria-hidden', 'true');
  (el as HTMLElement).inert = true;
}

/**
 * appear 的空实现：只为**切断 appear → enter 的兜底** —— 首屏要保留卡片错峰，
 * 不能被下面那个"去动画"顺手清掉。别删。
 */
function onViewSwitchAppear(): void {
  // 故意为空：见上。
}

/**
 * 交叉淡入里新层的"去花斑"（既有约定 第二轮修订）：卡片自身还会播 card-in
 * 错峰入场，但此刻旧层还在场 —— 差序入场会让"还没到"的卡片位置露出旧卡片
 * （帧级抓拍过：整片网格新旧交错）。切换时把新层内卡片的入场动画整层拆掉，
 * 让新层以**统一的淡入**出场；错峰只留给首屏（appear 那条路）。
 * 用 inline 写、随元素生命周期自然消失；此后新挂载的卡片（数据层加书签等）
 * 不受影响，仍会轻轻淡入。
 */
function onViewSwitchEnter(el: Element): void {
  el.querySelectorAll('.bookmark-card').forEach((card) => {
    (card as HTMLElement).style.animation = 'none';
  });
}
const trashPanel = ref<InstanceType<typeof TrashPanel> | null>(null);

/**
 * 侧边栏那颗角标的数、以及"收到同步完成广播该刷什么"，都住在 `useSyncPresence` 里
 * （回收站入口的 `v-if` 也看那里的 `syncConfigured`）。
 */
function openTrash(): void {
  activeView.value = 'trash';
  viewSwitchKey.value = viewIdentityKey('trash', null, false);
}

onMounted(() => {
  void (async () => {
    await refreshSyncStatus();
    await refreshMenuCapabilities();
    // 角标要跟着同步走 —— `startSyncPresence()` 订阅的那条广播会在同步跑完时重刷它。
    await refreshTrashCount();
    // 撤销是持久的：上次改动之后关掉过新标签页，那条"上一次改动"仍然要在这儿。
    lastEdit.value = await readLastEdit();
  })();
  // 预热"浏览器默认图标"的参照签名，免得每张没有图标的卡片都排在它后面等一次。
  primeDefaultIconSignature();
  startSyncPresence();
  // 侧边栏宽度要按窗口夹紧（既有约定 决策五），所以得知道窗口多宽。
  window.addEventListener('resize', syncWindowWidth);
  // 侧边栏浮出：热区靠 .shell 的 pointermove（模板上挂），
  // 这里只启动 composable 自己的两条监听（matchMedia + document 捕获点击）。
  startPeek();
  // 右缘「最近访问」浮出：同一套监听，另一个实例。
  startRecentPeek();
  // 最近访问的数据层：挂 onVisited 订阅（面板开着才追新，见 useRecentVisits）。
  startRecentVisits();
  // 卡片提示：文档级的 scroll / pointerdown / Esc 由它自己管。
  startCardTip();
});

onUnmounted(() => {
  window.removeEventListener('resize', syncWindowWidth);
  stopSyncPresence();
  stopPeek();
  stopRecentPeek();
  stopRecentVisits();
  stopCardTip();
  registerDropHandler(null);
  registerActionHandler(null);
});

/**
 * 顶栏那颗红点显不显（既有约定，2026-10-15 修订）。
 *
 * **只在同步异常时出现**：正常 / 没配 / 从没同步过，顶栏就是三个干净的图标，
 * 一个点都没有。判据在 `lib/sync-alert.ts`（可测），这里只做接线。
 * 既有约定 起第四条判据：**恢复点写入失败（保险断）也挂点** —— 亮点坏的时候
 * 也不能藏；落点按问题类型分流（仅保险断 → 设置页「快照」）。
 *
 * 点本身不带色调了 —— 出现即红，没有"灰点/绿点"这一档。原因说全了在 既有约定 里：
 * 常驻的彩色小点看着温和，实际是每天盯着的噪点。
 */
const showSyncDot = computed(() => syncNeedsAttention(syncStatus.value, restorePointError.value));

const syncTitle = computed(() => {
  const status = syncStatus.value;
  if (!status) return t('home.sync.off');
  if (status.phase === 'conflict') {
    return t('home.sync.conflict', { n: status.conflictCount });
  }
  if (status.phase === 'auth-required') return t('home.sync.auth');
  if (status.phase === 'error') {
    return t('home.sync.error', { reason: status.lastError ?? t('home.sync.errorFallback') });
  }
  // 保险断：phase 正常但恢复点写失败 —— 红点挂着，title 不能还说"正常"，
  // 那是让一个说谎的 tooltip 配一颗说实话的红点。
  if (restorePointError.value !== null) {
    return t('sync.insurance.broken', { error: restorePointError.value });
  }
  return status.lastSuccessAt === null ? t('home.sync.never') : t('home.sync.ok');
});

/**
 * 打开设置页 —— 主页通往它的两个入口共用这一条路。
 *
 * `hash` 决定落在哪个分区：空 = 首页「通用」，`#sync` = 同步分区，
 * `#snapshot` = 快照分区（仅"保险断"时状态点落这，见 openSyncSettings）。
 *
 * ⚠️ 用 `chrome.tabs.create` 而**不是** `chrome.runtime.openOptionsPage()`。
 * 后者在有设置页标签时**不新开**：实测连调两次，`options.html` 的 target 数停在 1
 * （它把已有那个标签切到前面）。用户要的是"点一下 = 新开一个标签"，而且两个入口
 * 得同一种行为 —— 齿轮与状态点现在都走这里，只有 hash 不同。
 *
 * 代价（认下）：连点两次会有两个设置页标签。**做不到"有就切过去、没有才新开"** ——
 * 那要 `chrome.tabs.query({ url })` 读得到 url，而它需要 `tabs` 权限；
 * 本扩展的权限清单只有 bookmarks / favicon / storage / alarms（既有约定 时代定的硬约束），
 * 为这点便利去扩权不划算。`tabs.create` 本身**不需要** `tabs` 权限。
 */
function openOptionsTab(hash: '' | '#sync' | '#snapshot'): void {
  notice.value = '';
  const url =
    typeof chrome === 'undefined' ? '' : `${chrome.runtime.getURL('options.html')}${hash}`;
  if (!url) {
    notice.value = t('home.settingsHint');
    return;
  }
  try {
    void Promise.resolve(chrome.tabs.create({ url })).catch(() => {
      notice.value = t('home.settingsHint');
    });
  } catch {
    notice.value = t('home.settingsHint');
  }
}

/** 齿轮：去改配置，落「通用」。 */
function openSettings(): void {
  openOptionsTab('');
}

/**
 * 状态点落到哪个分区（既有约定 决策四：按问题类型分流）。
 *
 * 冲突 / 上轮失败 / 凭据失效的处置在「同步」；仅"保险断"时落「快照」——
 * 失败原因与整份列表都在那。两者同时存在时落「同步」（冲突更重，且保险断的
 * 同一行错误在同步区也看得见）。判据与分流都是纯函数（`lib/sync-alert.ts`）。
 */
function openSyncSettings(): void {
  openOptionsTab(syncDotHash(syncStatus.value, restorePointError.value));
}

// ---------- 侧边栏：收起 / 浮出 / 钉住 ----------

const sidebarEl = ref<HTMLElement | null>(null);

/**
 * 默认收起之后，"展开侧边栏"是高频动作，顶栏那颗孤钮 therefore 撤掉，换成左缘热区
 * 悬停浮出。状态机（三个延迟、焦点进出、吞点击、窄屏退出）住在 useSidebarPeek 里 ——
 * App.vue 不挂组件测试，抽出来才锁得住（与 useSyncPresence 同一个理由）。
 *
 * DOM 事实：热区武装 = document 上的 pointermove（composable 自己挂，**不挂 .shell** ——
 * 滚动条区域的事件 target 是根元素、不过 shell，见 useSidebarPeek 的 onPointerMove）；
 * `<aside>` 的 mouseenter/leave（钉住/离开）；document 捕获点击（点主区吞击）。
 *
 * 2026-10-16 起它是**两个实例**里的左缘那个：右缘「最近访问」面板
 * 复用同一个 composable，`onOpen` 把两者接成互斥。
 */
const peek = useSidebarPeek({
  collapsed: computed(() => settings.value.sidebarCollapsed),
  panelEl: sidebarEl,
  onPin: () => update({ sidebarCollapsed: false }),
  // 互斥：右缘浮出成立 ⇒ 左缘立刻关。两侧同时浮出会把主区挤成一条缝。
  onOpen: () => recentPeek.close(),
});

const {
  peeking,
  closing,
  narrow,
  effectiveCollapsed,
  onSidebarEnter,
  onSidebarLeave,
  onHandleClick,
  closeOnEscape,
  focusSidebar,
  start: startPeek,
  stop: stopPeek,
} = peek;

// ---------- 右缘「最近访问」：浮出 / 数据 ----------

const recentPanelEl = ref<HTMLElement | null>(null);

/**
 * 右缘面板与左缘侧边栏共用 useSidebarPeek（同一套时序：8px 热区 / 120ms 开 /
 * 2s 离开宽容 / 两段式关闭语义 / Esc / 触屏把手 / ≤900px 整套退出）。
 * 按 `side` 分叉的只有三处：热区判右缘、面板元素（焦点管理）、`onOpen`（互斥）。
 *
 * 闸门是 `recentPanel` 开关**而不是"收起"** —— 右面板没有持久展开态，
 * 它永远是纯浮出（不写偏好），所以也就没有钉住 / 收起那一对钮。
 */
const recentPeek = useSidebarPeek({
  side: 'right',
  collapsed: computed(() => settings.value.recentPanel),
  panelEl: recentPanelEl,
  onOpen: () => peek.close(),
});

const {
  peeking: recentPeeking,
  closing: recentClosing,
  narrow: recentNarrow,
  effectiveCollapsed: recentEnabled,
  onSidebarEnter: onRecentEnter,
  onSidebarLeave: onRecentLeave,
  onHandleClick: onRecentHandleClick,
  closeOnEscape: closeRecentOnEscape,
  close: closeRecentPanel,
  start: startRecentPeek,
  stop: stopRecentPeek,
} = recentPeek;

/**
 * 右缘面板的数据层（懒加载 / 开着时 onVisited 追新 / 三态）。active = 浮出可见中。
 */
const {
  visits: recentVisits,
  loading: recentLoading,
  error: recentError,
  reload: reloadRecentVisits,
  start: startRecentVisits,
  stop: stopRecentVisits,
} = useRecentVisits(recentPeeking);

/** 右缘面板宽度与侧边栏同一个偏好（一个宽度管两侧，不新增字段）。窄屏整套退出。 */
const recentPanelStyle = computed(() =>
  recentNarrow.value ? {} : { width: `${renderSidebarWidth.value}px` },
);

/** 面板底部「查看全部历史」：浏览器自己的历史页（`chrome://` 走 tabs.create，与书签卡同路）。 */
function openFullHistory(): void {
  void openLinkInNewTab('chrome://history').catch(() => {
    notice.value = t('home.recent.noTabApi');
  });
}

/** `]` 键：切换右缘面板浮出。与 `[` 的差别是天然的 —— 右面板没有持久态可切。 */
function toggleRecentByKeyboard(): void {
  if (recentNarrow.value) return;
  onRecentHandleClick({ detail: 0 } as MouseEvent);
}

/**
 * 卡片提示：全页共用一个自绘气泡，卡片只带 `data-tip`。
 * 事件在 `.shell` 上**委托**（模板里的 pointerover / focusin…），
 * 这里只负责把 composable 自己的文档级监听（scroll / pointerdown / Esc…）接上。
 */
const {
  tip: cardTip,
  tipEl: cardTipEl,
  onTipPointerOver,
  onTipPointerOut,
  onTipFocusIn,
  onTipFocusOut,
  start: startCardTip,
  stop: stopCardTip,
} = useCardTip();

/**
 * 布局上的收起态。**浮出期间它必须是 false**：`data-collapsed` 一挂上，
 * `[data-collapsed] > *` 的内容淡出规则会把浮层内容也藏掉，内联宽度归 0 会让
 * 面板消失 —— 浮出靠 `data-peek='on'` 另一套规则（fixed），不走收起那套。
 *
 * 而**滑出期间（closing）它必须是 true**（2026-10-15 用户报修"关闭时主内容
 * 整体左右移动"的第二半）：width 要从滑出第一帧就向 0 过渡（在 fixed 状态下，
 * 不占流），滑完摘 data-peek 时 width 已经是 0 —— 摘除那一下零回流、零闪板。
 * 若滑出期间保持 false，摘除时 width 216→0 会在回流内过渡，面板闪回 + 主内容
 * 滑 216px（旧 bug 只是被推迟了 160ms）。
 */
const layoutCollapsed = computed(() => effectiveCollapsed.value && !peeking.value);

const isResizing = ref(false);

/** 拖动过程中的本地宽度，松手才写入存储，避免每帧写一次。 */
const sidebarWidth = ref(settings.value.sidebarWidth);

/**
 * 窗口宽度。只用来把侧边栏的宽度夹到这台屏幕撑得住的范围（既有约定 决策五）。
 */
const windowWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth);

function syncWindowWidth(): void {
  windowWidth.value = window.innerWidth;
}

/**
 * 真正画出来的侧边栏宽度。
 *
 * 云端同步的是"**想要的**宽度"，不是"这台屏幕上的像素"：27 寸上拖满的 460px
 * 到 1366px 的笔记本上展开会吃掉三分之一屏。所以这里按窗口宽的三成封顶，
 * 但不低于侧边栏自己的下限（168px 是它还能显示目录树的最小宽度）。
 *
 * ⚠️ **夹紧只发生在渲染时，绝不能改写存储**：写回去等于小屏机器渲染一次就把
 * 同步值永久改小了，那是本机反向篡改云端——上传之后别人的宽屏也被拖窄。
 * 与 既有约定 给「每行卡片数」定的"上限"语义是同一个思路：同步口味，不是像素。
 */
const renderSidebarWidth = computed(() => {
  const ceiling = Math.max(SIDEBAR_MIN_WIDTH, Math.round(windowWidth.value * 0.3));
  return Math.min(sidebarWidth.value, ceiling);
});

watch(
  () => settings.value.sidebarWidth,
  (width) => {
    if (!isResizing.value) sidebarWidth.value = width;
  },
);

function collapseSidebar(): void {
  void update({ sidebarCollapsed: true });
}

/** 钉住：把这次浮出转成持久展开（偏好写 false，浮出随之退场）。 */
function pinSidebar(): void {
  void update({ sidebarCollapsed: false });
}

/** `[` 键：切换持久展开态（既有约定 决策二）。窄屏恒显，无态可切。 */
function toggleSidebarByKeyboard(): void {
  if (narrow.value) return;
  if (effectiveCollapsed.value) {
    void update({ sidebarCollapsed: false }).then(focusSidebar);
  } else {
    void update({ sidebarCollapsed: true });
  }
}

/**
 * 左缘一次性提示已在 2026-10-15 撤掉（既有约定 修订二）：它把"看过"定义成
 * "做过"——`sidebarHintSeen` 只在 hover 成功或点了 ✕ 时才写。用户既不碰左缘
 * （要教的正是这个动作）也没注意到那颗小 ✕，标记就永远是 false，
 * 于是**每开一个新标签页都弹一次**。移除详见 既有约定。
 *
 * 现在左缘浮出的发现通道剩两条：触屏把手（coarse pointer 下可见）与 `[` 键，
 * 设置页「显示侧边栏」那条说明也照旧写着（`home.sidebarHint`）。
 */

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function startResize(event: PointerEvent): void {
  event.preventDefault();
  isResizing.value = true;
  document.body.classList.add('is-resizing');

  const onMove = (moveEvent: PointerEvent) => {
    sidebarWidth.value = clampWidth(moveEvent.clientX);
  };
  const onEnd = () => {
    isResizing.value = false;
    document.body.classList.remove('is-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    void update({ sidebarWidth: sidebarWidth.value });
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
}

function resetSidebarWidth(): void {
  sidebarWidth.value = SIDEBAR_DEFAULT_WIDTH;
  void update({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
}

// 只写宽与基准宽：收起时的 padding / 边框清零走 CSS（.sidebar[data-collapsed]），
// 这样它们能和 width 一起被过渡。
// ⚠️ 窄屏一个像素都不写：内联 width 会压过 900px 断点里 `.sidebar { width: 100% }`
// （今天"窄屏 + 展开态"就中过这招 —— 顶部横条被钉成 216px）。横条布局整个归 CSS，
// JS 只负责让有效收起态在窄屏恒为 false（既有约定 决策三）。
const sidebarStyle = computed(() => {
  if (narrow.value) return {};
  return layoutCollapsed.value
    ? { width: '0px', flexBasis: '0px' }
    : { width: `${renderSidebarWidth.value}px`, flexBasis: `${renderSidebarWidth.value}px` };
});

/** 太窄时品牌文字挤不下，自动隐藏。 */
const isNarrowSidebar = computed(() => renderSidebarWidth.value < 196);

const flatFolders = computed(() => flattenFolders(roots.value));

/**
 * 目录选择器的可选项（新建弹窗用）。
 *
 * 只排除「未归类」：它是**合成出来**的根级，建进去等于让这条书签**悄悄退出同步范围**
 * （与 既有约定 拒绝"拖进未归类"同一条理由）。
 *
 * ⚠️ 三个逻辑根（书签栏 / 其他书签 / 移动设备书签）**不排除** —— 第一版排除过，
 * 判断依据还写错了：拿同步层的 `LOGICAL_ROOT_IDS`（'bar'/'other'/'mobile' 这些
 * **逻辑哨兵**）去比树里的文件夹 id，可树里的根是**原生 id**，一个都匹配不上，
 * 于是三个根照样列出来（真机逮到）。而且排除本身也不对：用户完全可以把书签
 * 直接建在书签栏里，浏览器自己的管理器也允许。
 */
const pickerFolders = computed(() =>
  flatFolders.value.filter((folder) => folder.id !== UNFILED_FOLDER),
);
const folderIds = computed(() => flatFolders.value.map((folder) => folder.id));

/**
 * 上次选中的分类可能已被删除，或从没选过。
 * 这两种情况自动落在第一个非空的目录上，保证打开就能看到书签。
 */
const selectedFolderId = computed(() => {
  const resolved = resolveSelectedFolder(settings.value.selectedFolderId, folderIds.value);
  if (resolved !== ALL_FOLDERS) return resolved;
  const firstNonEmpty = flatFolders.value.find((folder) => folder.count > 0);
  return (firstNonEmpty ?? flatFolders.value[0])?.id ?? ALL_FOLDERS;
});

const activeFolder = computed(() => findFolderNode(roots.value, selectedFolderId.value));
const activePath = computed(() => folderPathOf(roots.value, selectedFolderId.value));

/**
 * 侧边栏目录树的展开态：一级目录默认铺开、点行开合、
 * 选中的深层目录自动展开祖先。
 */
const { isExpanded, toggleExpand } = useSidebarTree(roots, selectedFolderId);

/**
 * 分组浏览时只展示有内容的子目录；空目录不占一屏标题。
 * 想看空目录可以在浏览器书签管理器里整理。
 */
const groupedChildren = computed(() =>
  (activeFolder.value?.children ?? []).filter((child) => child.count > 0),
);

function selectFolder(id: string): void {
  // 点目录就是"我要看书签了" —— 从回收站切回去，否则点了像没反应。
  activeView.value = 'browse';
  searchText.value = '';
  void update({ selectedFolderId: id });
  viewSwitchKey.value = viewIdentityKey('browse', id, false);
}

function clearSearch(): void {
  searchText.value = '';
  searchInput.value?.focus();
}

// 一开始搜索就切回浏览屏：搜索框在主区顶栏，在回收站那一屏打字却什么都搜不到最费解。
watch(searchText, (text) => {
  const searching = text.trim() !== '';
  if (searching) activeView.value = 'browse';
  // 只在"进出搜索态"那一刻换视图身份；同一个搜索态里继续打字不换 —— 否则每敲一字整页闪。
  // 仍在回收站屏时不动键：清搜索不该把"回收站"误判成一次视图切换。
  if (activeView.value === 'browse') {
    viewSwitchKey.value = viewIdentityKey('browse', selectedFolderId.value, searching);
  }
});

const isSearching = computed(() => searchText.value.trim() !== '');

/**
 * 界面上没有"全部"视图，搜索因此始终覆盖全部书签；
 * 清空关键词后回到当前目录的直接内容。
 */
const visibleItems = computed(() =>
  isSearching.value
    ? filterBookmarks(items.value, ALL_FOLDERS, searchText.value)
    : (activeFolder.value?.bookmarks ?? []),
);

const isDark = computed(() => resolvedMode.value === 'dark');
/**
 * 按钮只看明暗（既有约定 决策四；2026-10-15 修订成两站）：它只说一件事，配色去设置页选。
 * 第三档"跟随系统"按钮够不到了（只能在设置页选），但**存着这一档时图标照旧说实话**——
 * 显示器图标 + title 里的"跟随系统"，点一下按眼下生效的那一档翻、也就退出了跟随。
 */
const themeIcon = computed(() =>
  settings.value.themeMode === 'system' ? 'auto' : settings.value.themeMode,
);
const paletteLabel = computed(() =>
  settings.value.themePalette === 'youth'
    ? t('appearance.palette.youth')
    : t('appearance.palette.warm'),
);
const modeLabel = computed(() => {
  if (settings.value.themeMode === 'system') return t('appearance.mode.system');
  return isDark.value ? t('appearance.mode.dark') : t('appearance.mode.light');
});

/** title 与 aria-label 用同一句合句："主题：青柠夏夜 · 浅色" —— 按钮只管明暗，
    但用户永远看得到自己选的是哪套配色，不会忘了它的存在。 */
const themeTitle = computed(() =>
  t('home.theme.summary', { palette: paletteLabel.value, mode: modeLabel.value }),
);

function submitSearch(): void {
  const term = searchText.value.trim();
  if (term === '') return;
  window.open(buildSearchUrl(settings.value.searchEngine, term), '_blank', 'noopener');
}

/**
 * 改搜索引擎 = 写偏好，**不立刻搜**：此刻输入框里的词是用户正在斟酌的，
 * 顺手跳走等于替他决定。真正的查询只在回车时发生（`submitSearch` 读同一个偏好）。
 *
 * 名字与下拉都由 `EnginePicker` 自己管（它握着 i18n 与键盘状态机），这里只负责
 * 落盘。仍然保留合法性校验：`update()` 是设置层唯一的写入口，联合类型在运行时
 * 只是 string，脏值不能写进 storage。
 */
function selectEngine(engine: string): void {
  if (!SEARCH_ENGINE_IDS.includes(engine as SearchEngineId)) return;
  void update({ searchEngine: engine as SearchEngineId });
}

/**
 * 打开浏览器自带的书签管理器。chrome.tabs.create() 不需要 tabs 权限，
 * 权限清单因此仍只有 bookmarks/favicon/storage。
 */
function openBookmarkManager(): void {
  notice.value = '';
  const api = typeof chrome === 'undefined' ? undefined : chrome.tabs;
  if (!api?.create) {
    notice.value = t('home.managerHint');
    return;
  }
  try {
    void Promise.resolve(api.create({ url: 'chrome://bookmarks' })).catch(() => {
      notice.value = t('home.managerHint');
    });
  } catch {
    notice.value = t('home.managerHint');
  }
}

// ---------- 拖拽整理 ----------

/**
 * 拖拽整理有没有开。
 *
 * 只受设置项与"当前是不是浏览屏"管辖 —— **不像删除那样再加一道"配没配同步"的闸门**：
 * 那个闸门 既有约定 已经撤销过一次，别再退回去。关掉这个开关是给怕手滑的人留的出口。
 */
const dragEnabled = computed(
  () => settings.value.dragToArrange && activeView.value === 'browse',
);

const { dragging, hintZone, begin, cancel, over, drop, registerDropHandler } = useDragArrange();

/**
 * 新建 / 改名有没有开。
 *
 * 与 `dragToArrange` 分开：拖拽已经上线并调好了手感，别把它跟新功能捆在一起改。
 */
const editEnabled = computed(
  () => settings.value.editBookmarks && activeView.value === 'browse',
);

/**
 * 「上一次改动」的来处（既有约定 提出、既有约定 泛化）。
 *
 * 移动 / 新建 / 改名都不丢数据 —— 书签还在，只是位置或名字变了 —— 所以它们的可逆性
 * 不需要墓碑那么重的东西：记下来处、做一次反向操作就够了。这份记录**持久化**到本机
 * 存储，刷新之后撤销仍然在，直到下一次改动把它顶掉。
 *
 * **删除不进来**：它已经有更强、更持久的找回（墓碑 30 天 + 回收站），
 * 再给一条"只记一次"的弱路径只会让人分不清该点哪个。
 */
const lastEdit = ref<LastEdit | null>(null);

/** 书签卡片：只能插到别人前/后（它没有"里面"可进）。 */
/**
 * 拖拽判定要的两个索引，一次遍历树建好（别在每张卡片上现算 —— 网格里是 O(n²)）：
 * - `childrenOf`：目录 id → 直接子节点 id（先文件夹后书签，界面顺序）
 * - `parentOf`  ：目录 id → 它的父目录 id
 *
 * 同父排序的"往前往后"只比**相对次序**，所以混排另一类节点不影响结论
 * （`resolveReorderZone` 比的是同一个列表里的两个下标）。
 */
const dragIndex = computed(() => {
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const stack = [...roots.value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    childrenOf.set(node.id, [
      ...node.children.map((child) => child.id),
      ...node.bookmarks.map((bookmark) => bookmark.id),
    ]);
    for (const child of node.children) {
      parentOf.set(child.id, node.id);
      stack.push(child);
    }
  }
  return { childrenOf, parentOf };
});

/** 书签卡片的兄弟（同一父目录下的界面顺序）。 */
function siblingsOfBookmark(item: BookmarkViewItem): string[] {
  // parentId 在类型上是可选的（"未归类"里的散落书签没有能排序的父）—— 给空数组 = 只按几何判。
  if (item.parentId === undefined) return [];
  return dragIndex.value.childrenOf.get(item.parentId) ?? [];
}

/** 文件夹块的兄弟；一级目录没有父，返回空 = 只按几何判（它本来也只接受"放进去"）。 */
function siblingsOfFolder(node: BookmarkFolderNode): string[] {
  const parentId = dragIndex.value.parentOf.get(node.id);
  return parentId === undefined ? [] : (dragIndex.value.childrenOf.get(parentId) ?? []);
}

function cardDragProps(item: BookmarkViewItem) {
  if (!dragEnabled.value) return {};
  const zone = hintZone(item.id);
  return {
    draggable: true,
    class: {
      'is-dragging': dragging.value?.id === item.id,
      'drop-before': zone === 'before',
      'drop-after': zone === 'after',
    },
    onDragstart: (event: DragEvent) =>
      begin(
        { id: item.id, kind: 'bookmark', title: item.title, siblingIds: siblingsOfBookmark(item) },
        event,
      ),
    onDragend: () => cancel(),
    // 卡片是横排网格 ⇒ 轴是 x（插入线也是左右竖条，与判定同一套几何）。
    onDragover: (event: DragEvent) => over(event, item.id, 'edge', true, 'x'),
    onDrop: (event: DragEvent) => drop(event, item.id, 'edge', true, 'x'),
  };
}

/** 文件夹块：既是拖动把手也是落点，三段判定 —— 左右缘插到它旁边，中间放进去。 */
function folderDragProps(node: BookmarkFolderNode) {
  if (!dragEnabled.value) return {};
  const zone = hintZone(node.id);
  return {
    draggable: true,
    'data-drop-label': zone === 'inside' ? t('home.drag.into', { title: node.title }) : null,
    class: {
      'is-dragging': dragging.value?.id === node.id,
      'drop-before': zone === 'before',
      'drop-after': zone === 'after',
      'drop-inside': zone === 'inside',
    },
    onDragstart: (event: DragEvent) =>
      begin(
        { id: node.id, kind: 'folder', title: node.title, siblingIds: siblingsOfFolder(node) },
        event,
      ),
    onDragend: () => cancel(),
    // 文件夹块与卡片同处横排网格 ⇒ 同样走 x 轴。
    onDragover: (event: DragEvent) => over(event, node.id, 'folder', true, 'x'),
    onDrop: (event: DragEvent) => drop(event, node.id, 'folder', true, 'x'),
  };
}

/** 分组标题：只是**拖动把手**（它代表那个子目录），不做落点判定 —— 见 groupDropProps。 */
function groupDragProps(node: BookmarkFolderNode) {
  if (!dragEnabled.value) return {};
  return {
    draggable: true,
    class: { 'is-dragging': dragging.value?.id === node.id },
    onDragstart: (event: DragEvent) =>
      begin(
        { id: node.id, kind: 'folder', title: node.title, siblingIds: siblingsOfFolder(node) },
        event,
      ),
    onDragend: () => cancel(),
  };
}

/**
 * 分组的落点判定挂在**整节**上，不是标题上。
 *
 * 为什么不放标题：标题只有一行高（约 20px），按 25% 切出来的边带只有 5px，
 * 人点不中 —— 文件夹排序就成了"功能做了、其实做不到"。
 *
 * 挂到整节之后的语义反而更清楚：
 * - **标题那一段（上缘）= 插到这一节前面**，下缘 = 插到它后面 ⇒ 排序；
 * - **内容区（中间）= 放进去** ⇒ 改归属。
 *
 * 节里的卡片与文件夹块有各自的落点判定，而且会 `stopPropagation`，所以它们优先。
 */
function groupDropProps(node: BookmarkFolderNode) {
  if (!dragEnabled.value) return {};
  const zone = hintZone(node.id);
  return {
    'data-drop-label': zone === 'inside' ? t('home.drag.into', { title: node.title }) : null,
    class: {
      'drop-before': zone === 'before',
      'drop-after': zone === 'after',
      'drop-inside': zone === 'inside',
    },
    onDragover: (event: DragEvent) => over(event, node.id, 'folder'),
    onDrop: (event: DragEvent) => drop(event, node.id, 'folder'),
  };
}

/** 落点被拒时说的话。服务给的是码，文案在这里查（既有约定 同一套做法）。 */
const DROP_REJECT_KEY: Record<Exclude<DropRejectCode, 'same-position'>, MessageKey> = {
  'unknown-dragged': 'home.drag.reject.unknownDragged',
  'unknown-target': 'home.drag.reject.unknownTarget',
  'into-self': 'home.drag.reject.intoSelf',
  'virtual-target': 'home.drag.reject.virtualTarget',
  'root-parent': 'home.drag.reject.rootParent',
};

function dragErrorText(error: unknown): string {
  if (error instanceof EditError) {
    if (error.code === 'api-unavailable') return t('home.edit.error.apiUnavailable');
    if (error.code === 'node-missing') return t('home.edit.error.nodeMissing');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 真正执行一次拖放。
 *
 * 落点的**含义**（换父还是换次序、插到第几位）全部由 `lib/drag` 的纯函数算，
 * 这里只负责把它交给写通道、并把结果说清楚。刷新不用做 —— `onMoved` 会触发整树重读。
 */
async function handleDrop(request: DropRequest): Promise<void> {
  const outcome = resolveDrop({ roots: roots.value, items: items.value, request });
  if (!outcome.ok) {
    // 原地松手不是失败，什么都不说就是最合适的反馈。
    if (outcome.code !== 'same-position') notice.value = t(DROP_REJECT_KEY[outcome.code]);
    return;
  }

  try {
    const result = await moveBookmarkNode(outcome.resolution);
    lastEdit.value = result.record;
    const title = result.record?.nodeTitle ?? '';
    const parent = result.record?.toParentTitle ?? '';
    notice.value = !result.undoSaved
      ? t('home.drag.movedNoUndo', { title, parent })
      : result.adjusted
        ? t('home.drag.movedAdjusted', { title, parent })
        : t('home.drag.moved', { title, parent });
  } catch (error) {
    notice.value = t('home.drag.failed', { reason: dragErrorText(error) });
  }
}

registerDropHandler((request) => void handleDrop(request));

// ---------- 新建 / 改名：表单弹窗（既有约定 定交互，既有约定 换成公共壳） ----------

/**
 * 编辑卡的两种形态。新建与改名共用一张卡、同一套校验 —— 对写通道来说它们
 * 只是参数不同（`createBookmarkNode` / `renameBookmarkNode`）。
 */
type EditorState =
  | { kind: 'create'; type: 'bookmark' | 'folder'; parentId: string; folderTitle: string }
  | { kind: 'rename'; type: 'bookmark' | 'folder'; id: string; title: string; url: string };

const editor = ref<EditorState | null>(null);

/**
 * 新建落在哪个目录：**当前目录**。
 *
 * 三处不给建：
 * - 搜索态 —— 结果是一个跨文件夹的扁平列表，没有"当前目录"可言；
 * - 「未归类」—— 它是根级，建进去等于让这条书签**悄悄退出同步范围**
 *   （与 既有约定 拒绝"拖进未归类"同一条理由）；
 * - 回收站那一屏（由 `editEnabled` 里的 `activeView` 挡掉）。
 */
const createTargetId = computed(() => {
  if (!editEnabled.value || isSearching.value) return null;
  const folder = activeFolder.value;
  if (!folder || folder.id === UNFILED_FOLDER) return null;
  return folder.id;
});

/**
 * 顶栏 `+` 的说明文字：能用时说"新建到哪"，不能用时说**为什么不能**。
 *
 * 不静默禁用 —— 按钮灰着却不告诉人理由，用户只会以为扩展坏了。
 * （与删除确认那行"说不说得清找不找得回"是同一条规矩：状态要诚实。）
 */
const createTitle = computed(() => {
  if (createTargetId.value) return t('home.create.in', { folder: activeFolder.value?.title ?? '' });
  if (!editEnabled.value) return t('home.create.off');
  if (isSearching.value) return t('home.create.searching');
  if (activeView.value === 'trash') return t('home.create.trash');
  return t('home.create.unfiled');
});

/** 顶栏 `+`：新建到当前目录（弹窗里还能换）。 */
function openCreateDialog(): void {
  const parentId = createTargetId.value;
  if (!parentId) return;
  startCreate('bookmark', parentId);
}

function startCreate(type: 'bookmark' | 'folder', parentId: string): void {
  const parent = findFolderNode(roots.value, parentId);
  editor.value = { kind: 'create', type, parentId, folderTitle: parent?.title ?? '' };
}

/**
 * 某个目录能不能当新建的落点。
 *
 * 与 `createTargetId` 同一个判据，只是问的是**任意一个目录**而不是"当前目录" ——
 * 分组小节末尾那张新建卡要建进那个小节自己的文件夹里，建进当前目录会让人对不上号。
 *
 * 「未归类」依旧不给建：它是根级，建进去等于让这条书签**悄悄退出同步范围**
 * （与 既有约定 拒绝"拖进未归类"同一条理由）。
 */
function createTargetFor(folderId: string | null | undefined): string | null {
  if (!editEnabled.value) return null;
  if (!folderId || folderId === UNFILED_FOLDER) return null;
  return folderId;
}

/** 新建卡与固定入口共用这一个入口点：先问落点合法不合法，再开编辑器。 */
function startCreateIn(folderId: string | null | undefined, type: 'bookmark' | 'folder'): void {
  const parentId = createTargetFor(folderId);
  if (!parentId) return;
  startCreate(type, parentId);
}

function startRename(target: MenuTarget): void {
  editor.value =
    target.kind === 'bookmark'
      ? { kind: 'rename', type: 'bookmark', id: target.id, title: target.title, url: target.url }
      : { kind: 'rename', type: 'folder', id: target.id, title: target.title, url: '' };
}

function closeEditor(): void {
  editor.value = null;
}

function switchEditorType(type: 'bookmark' | 'folder'): void {
  const current = editor.value;
  if (current?.kind === 'create') editor.value = { ...current, type };
}

async function submitEditor(value: {
  type: 'bookmark' | 'folder';
  title: string;
  /** 文件夹没有网址，弹窗发 undefined。 */
  url?: string;
  /** 只有新建会带；弹窗里允许换目录（内联卡时代只能建在当前目录）。 */
  parentId?: string;
}): Promise<void> {
  const state = editor.value;
  if (!state) return;

  try {
    const result =
      state.kind === 'create'
        ? await createBookmarkNode({
            parentId: value.parentId ?? state.parentId,
            type: value.type,
            title: value.title,
            url: value.url,
          })
        : await renameBookmarkNode({
            nodeId: state.id,
            title: value.title,
            url: value.type === 'bookmark' ? value.url : undefined,
          });

    closeEditor();
    if (!result.changed || !result.record) {
      notice.value = t('home.edit.noChange');
      return;
    }

    lastEdit.value = result.record;
    const record = result.record;

    if (record.kind === 'create') {
      notice.value = result.undoSaved
        ? t('home.edit.created', { title: value.title, parent: record.parentTitle })
        : t('home.edit.createdNoUndo', { title: value.title, parent: record.parentTitle });
      // **建完就进去看它。** 空文件夹在主页是看不见的（分组按 count>0 过滤），
      // 不跳进去用户会以为没建成 —— 那是最坏的一类反馈。
      if (value.type === 'folder') selectFolder(record.nodeId);
      return;
    }

    notice.value = result.undoSaved
      ? t('home.edit.updated', { before: record.beforeTitle, title: value.title })
      : t('home.edit.updatedNoUndo', { before: record.beforeTitle, title: value.title });
  } catch (error) {
    notice.value = t('home.edit.failed', { reason: dragErrorText(error) });
  }
}

// ---------- 右键菜单（既有约定 + 既有约定） ----------

const {
  request: menuRequest,
  open: openMenuAt,
  close: closeMenu,
  registerActionHandler,
} = useItemMenu();

function openItemMenuFor(target: MenuTarget, event: MouseEvent): void {
  openMenuAt(target, event);
  // 顺手把菜单要用的几个事实刷新一遍（见 refreshMenuCapabilities 的说明）。
  void refreshMenuCapabilities();
}

/** 卡片右键：目标是这条书签（打开 / 复制类动作要用它的网址）。 */
function openBookmarkMenu(item: BookmarkViewItem, event: MouseEvent): void {
  openItemMenuFor({ kind: 'bookmark', id: item.id, title: item.title, url: item.url }, event);
}

/** 文件夹块 / 分组标题右键：目标是这个文件夹（侧边栏行在 SidebarNode 里自己开）。 */
function openFolderMenu(node: BookmarkFolderNode, event: MouseEvent): void {
  // 文件夹菜单里只有新建、重命名与删除 —— 关掉设置项它就什么都不剩，那种空菜单不如不开。
  if (!editEnabled.value) return;
  openItemMenuFor(
    {
      kind: 'folder',
      id: node.id,
      title: node.title,
      // 直接子节点数：0 = 空文件夹，免删除预览、菜单内两下点击就够。
      descendants: node.children.length + node.bookmarks.length,
      // 文件夹块与分组标题渲染的都是**当前目录的子目录**，永远不可能是浏览器根目录。
      isTopLevel: false,
    },
    event,
  );
}

/** 打开 / 复制类动作失败时说的话。服务给的是码，文案在这里查（既有约定 同一套做法）。 */
const TAB_ACTION_KEY: Record<TabActionFailure, MessageKey> = {
  'no-tab-api': 'home.tabAction.noTabApi',
  'no-window-api': 'home.tabAction.noWindowApi',
  'incognito-not-allowed': 'home.tabAction.incognito',
  'split-unsupported': 'home.tabAction.split',
  'copy-failed': 'home.tabAction.copyFailed',
};

function tabActionNotice(error: unknown): string {
  if (error instanceof TabActionError) {
    return t(TAB_ACTION_KEY[error.code], { url: error.detail ?? '' });
  }
  // 非预期错误没有码可用，只能整句原文（与 SyncSection 里的异常提示同理）。
  return error instanceof Error ? error.message : String(error);
}

/**
 * 菜单里的动作。
 *
 * 打开 / 复制：一律**先做再关**，失败就把原因写进顶栏提示 —— 尤其是无痕与分屏那两项，
 * 它们有前置条件，"点了没反应"是最不该出现的结果。
 *
 * 新建 / 改名：不直接写，而是打开那张内联编辑卡 —— 先让你把名字和网址看清楚。
 */
async function handleMenuAction(action: ContextMenuAction): Promise<void> {
  const target = menuRequest.value?.target;
  if (!target) return;

  if (action === 'remove') {
    await handleMenuRemove();
    return;
  }
  if (action === 'rename') {
    startRename(target);
    closeMenu();
    return;
  }
  if (action === 'delete-folder') {
    // 空文件夹的两下点击在菜单里已经完成（BookmarkContextMenu 的确认态），直接删；
    // 非空的开删除预览模态 —— 那串数量才是这个量级的确认。
    if (target.kind === 'folder' && target.descendants === 0) {
      void executeFolderDelete({
        id: target.id,
        title: target.title,
        parentId: findFolderParentId(roots.value, target.id),
      });
      closeMenu();
    } else {
      startFolderDelete(target);
    }
    return;
  }
  if (action === 'new-bookmark' || action === 'new-folder') {
    // 建在**右键的那个文件夹里** —— 菜单是右键它弹出来的，这就是最明确的落点。
    startCreate(action === 'new-folder' ? 'folder' : 'bookmark', target.id);
    closeMenu();
    return;
  }

  if (target.kind !== 'bookmark') return;
  const url = target.url;
  try {
    if (action === 'open-tab') await openLinkInNewTab(url);
    else if (action === 'open-window') await openLinkInNewWindow(url);
    else if (action === 'open-incognito') await openLinkInIncognitoWindow(url);
    else if (action === 'open-split') await openLinkInSplitView(url);
    else if (action === 'copy-link') await copyLink(url);
    closeMenu();
    if (action === 'copy-link') notice.value = t('home.copyDone');
  } catch (error) {
    closeMenu();
    notice.value = tabActionNotice(error);
  }
}

registerActionHandler((action) => void handleMenuAction(action as ContextMenuAction));

/**
 * 非网页协议的书签（`chrome://` / `file://` / `javascript:` / `mailto:` …）点了怎么办。
 *
 * 为什么不由卡片自己开：卡片对网页协议是 `<a target="_blank">`，可**链接路径走不通**这些地址
 * —— 实测点 `<a href="chrome://bookmarks">` 会被浏览器静默拦掉（不开标签页、也不报错）。
 * 所以这些卡片渲染成按钮，由这里走 `chrome.tabs.create`（它能开 `chrome://` 与 `file://`），
 * 失败时**明确说清**而不是静默。
 */
async function openNonWebBookmark(item: BookmarkViewItem): Promise<void> {
  try {
    await openLinkInNewTab(item.url);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // `javascript:` 是扩展**明确不许**打开的一类（Chrome 原话：JavaScript URLs are not
    // allowed in API based extension navigations）—— 这不是偶发失败，给专门措辞，
    // 别把英文原文甩给用户。其余（`data:` 等被浏览器拒的）用通用那句。
    notice.value = /javascript url/i.test(raw)
      ? t('home.open.scriptlet')
      : t('home.open.blocked', { protocol: item.protocol });
  }
}

/**
 * 删除。**不做任何自创的删除语义** —— 就是调用浏览器 API 把节点删掉，
 * 与用户在书签管理器里按删除键完全等价。同步侧会在下一轮对账时发现它少了，
 * 照常生成删除操作、照常传播、照常留下墓碑进回收站（见 既有约定）。
 *
 * 删除成功后不主动刷新：`onRemoved` 会被触发，`useBookmarks` 整树重读，卡片自己消失。
 * 也不强制立刻同步 —— 那是 `autoSync` 开关与请求预算的事。
 */
async function handleMenuRemove(): Promise<void> {
  const target = menuRequest.value?.target;
  if (!target || target.kind !== 'bookmark') return;
  try {
    await removeBookmarkNode(target.id);
    closeMenu();
    // **删完立刻同步**，不等后台那条 30 秒的防抖 alarm —— 见 `earlySync` 的说明。
    requestEarlySync();
    notice.value =
      recoveryMode.value === 'manual'
        ? t('home.delete.doneManualSync', { title: target.title })
        : t('home.delete.done', { title: target.title });
  } catch (error) {
    closeMenu();
    const reason = error instanceof Error ? error.message : String(error);
    notice.value = t('home.delete.failed', { reason });
  }
}

// ---------- 删除文件夹 ----------

/**
 * 待确认的文件夹删除。null = 模态关着。
 *
 * `parentId` 在**打开模态的瞬间**从当前书签树里取：删除之后这棵树就重读，
 * 被删的文件夹从树上消失，那时候再问"它原来挂在哪儿"已经问不到了。
 */
const folderDelete = ref<{ id: string; title: string; parentId: string | null } | null>(null);

/** 菜单放行后的落点：空文件夹在上面已经两下点击过了，非空的来这里过模态。 */
function startFolderDelete(target: MenuTarget): void {
  if (target.kind !== 'folder') return;
  folderDelete.value = {
    id: target.id,
    title: target.title,
    parentId: findFolderParentId(roots.value, target.id),
  };
  closeMenu();
}

/**
 * 真正删。模态确认与空文件夹的菜单内两下点击最后都汇到这儿 ——
 * 确认方式可以不同，删除本身只有一条路。
 */
async function executeFolderDelete(input: {
  id: string;
  title: string;
  parentId: string | null;
}): Promise<void> {
  try {
    const result = await deleteFolder(input.id);
    // **删完立刻同步**，与书签删除同一条理由：可找回的窗口依赖它。
    requestEarlySync();
    const count = result.bookmarkCount + result.folderCount;
    notice.value =
      recoveryMode.value === 'manual'
        ? t('home.folderDelete.doneManualSync', { title: input.title, n: count })
        : t('home.folderDelete.done', { title: input.title, n: count });
    // 删掉的正是当前所在目录（或它的某个祖先）⇒ 跳到删除点的父目录。
    // 既有的"文件夹没了退回全部"兜底仍然留着，但主动导航比让兜底擦屁股好。
    if (activePath.value.some((segment) => segment.id === input.id) && input.parentId) {
      selectFolder(input.parentId);
    }
  } catch (error) {
    if (error instanceof FolderDeleteError && error.code === 'root-folder') {
      notice.value = t('home.folderDelete.rootRejected');
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    notice.value = t('home.folderDelete.failed', { reason });
  }
}

function cancelFolderDelete(): void {
  folderDelete.value = null;
}

async function confirmFolderDelete(): Promise<void> {
  const pending = folderDelete.value;
  if (!pending) return;
  folderDelete.value = null;
  await executeFolderDelete(pending);
}

/**
 * 同步跑完之后的期望核对。
 *
 * 被并发编辑挡下的节点不会成为墓碑 —— 不核对，用户删了 300 项却只看到 299 项消失，
 * 第 300 项悄悄挂在根目录，那就是静默。
 */
async function checkFolderDeleteOutcome(): Promise<void> {
  try {
    const outcome = await consumeFolderDeleteExpectation();
    if (outcome && outcome.blockedCount > 0) {
      notice.value = t('home.folderDelete.blocked', {
        root: outcome.rootTitle,
        n: outcome.blockedCount,
      });
    }
  } catch {
    // 核对是附加功能：它自己失败不该把"同步完成了"这条通知弄丢。
  }
}

// ---------- 撤销「上一次改动」（既有约定 提出、既有约定 泛化） ----------

async function undoLastChange(): Promise<void> {
  try {
    const record = await undoLastEdit();
    lastEdit.value = null;
    notice.value =
      record.kind === 'create'
        ? t('home.edit.undoDone.create', { title: record.nodeTitle })
        : record.kind === 'update'
          ? t('home.edit.undoDone.update', { before: record.beforeTitle })
          : t('home.edit.undoDone.move', { title: record.nodeTitle });
  } catch (error) {
    // 失败时**不清记录**：撤销还能再试一次，条子留着比悄悄消失诚实。
    notice.value = t('home.edit.undoFailed', { reason: dragErrorText(error) });
  }
}

function dismissLastEdit(): void {
  lastEdit.value = null;
  void clearLastEdit();
}

/**
 * 撤销条的目标还在不在树里。
 *
 * 删除之后"指着被删节点"的界面要素要**主动失效**：不等用户去点一个注定失败的操作。
 * 刷新循环本来就会因原生事件重读整树（debounce 120ms），顺手判一次存在性，成本近零。
 */
const undoTargetMissing = ref(false);

watch([items, roots], () => {
  const record = lastEdit.value;
  if (!record) {
    undoTargetMissing.value = false;
    return;
  }
  undoTargetMissing.value = !nodeExistsInTree(roots.value, items.value, record.nodeId);

  // 正开着的编辑器，其目标节点没了 ⇒ 就地关闭，不提交。
  // 提交到已删节点只会 create / update 失败 —— 虽不静默，但白费一次交互还伴随一次写失败。
  const state = editor.value;
  if (state?.kind === 'rename' && !nodeExistsInTree(roots.value, items.value, state.id)) {
    closeEditor();
  }
});

/** 撤销条那句话，按改动种类各不相同 —— 说不清"上一次到底做了什么"的条子没有价值。 */
const undoBarText = computed(() => {
  const record = lastEdit.value;
  if (!record) return '';
  if (record.kind === 'create') {
    return t('home.edit.undoBar.create', { title: record.nodeTitle });
  }
  if (record.kind === 'update') {
    return t('home.edit.undoBar.update', { before: record.beforeTitle, title: record.nodeTitle });
  }
  return t('home.edit.undoBar.move', {
    title: record.nodeTitle,
    parent: record.toParentTitle,
  });
});

function handleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.value?.focus();
    searchInput.value?.select();
    return;
  }
  const tag = (event.target as HTMLElement | null)?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchInput.value?.focus();
    return;
  }
  // 浮出开着时 Esc = 关面板（既有约定 / 既有约定：两缘各一个实例，
  // 没开着的那个 closeOnEscape 自然空转）。焦点在搜索框里那一回让给原来的
  // "清空搜索词"—— 两者实际不会撞上：点搜索框的第一下已经被浮出吞掉了。
  if (
    event.key === 'Escape' &&
    (peeking.value || recentPeeking.value) &&
    document.activeElement !== searchInput.value
  ) {
    closeOnEscape();
    closeRecentOnEscape();
    return;
  }
  if (event.key === '[' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    toggleSidebarByKeyboard();
    return;
  }
  // `]`：右缘「最近访问」浮出。与 `[` 对称，但切的是纯浮出 ——
  // 右面板没有持久展开态，所以不存在"切完写偏好"那一手。
  if (event.key === ']' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    toggleRecentByKeyboard();
    return;
  }
  if (event.key === 'Escape' && document.activeElement === searchInput.value) {
    searchText.value = '';
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown));
onUnmounted(() => window.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <!-- data-drag 只用来给 CSS 划范围：拖拽开着时，拖动把手上要关掉文字选择（见 style.css）。
       热区武装**不在这里挂**：pointermove 由 useSidebarPeek 自己挂在 document 上
       （滚动条区域的事件 target 是根元素、不经过 .shell，挂元素上会整条带失灵，
       2026-10-16 真机逮到）—— 模板上只留卡片提示的四个委托。 -->
  <div
    class="shell"
    :data-drag="dragEnabled ? 'on' : 'off'"
    :data-boot="ready ? 'done' : 'pending'"
    @pointerover="onTipPointerOver"
    @pointerout="onTipPointerOut"
    @focusin="onTipFocusIn"
    @focusout="onTipFocusOut"
  >
    <!-- 触屏把手：悬停对手指不可能命中，coarse pointer 下才显示
         （见 style.css 的 @media (pointer: coarse)）。指针设备里它 display:none，
         也不占 Tab 顺序 —— 键盘用户的通道是 `[`。 -->
    <button
      v-if="effectiveCollapsed && !peeking && !closing && !narrow"
      type="button"
      class="peek-handle"
      :title="t('home.expandSidebar')"
      :aria-label="t('home.expandSidebar')"
      @click="onHandleClick"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="m9 7 4 5-4 5" />
      </svg>
    </button>

    <aside
      ref="sidebarEl"
      class="sidebar"
      :style="sidebarStyle"
      :data-collapsed="layoutCollapsed"
      :data-peek="peeking ? 'on' : closing ? 'out' : null"
      @mouseenter="onSidebarEnter"
      @mouseleave="onSidebarLeave"
    >
      <div class="brand" :data-narrow="isNarrowSidebar">
        <div class="brand-mark" aria-hidden="true">
          <!-- 定稿标识「旗星合一」：书签旗 + 星形镂空，与工具栏图标、
               设置页左栏、README 同一个符号。真洞用 fill-rule="evenodd"，
               单一 currentColor —— 颜色由 --brand-mark-color 给，不在这里写死。
               viewBox 收到内容 bbox（40,36 起 176 见方，水平中心 128、垂直恰为
               36-212）：母版 256 画布里内容中心在 y=124（光学偏上），那是给独立
               标识的呼吸边距；放进 place-items:center 的 tile 会把「画布居中」
               变成「内容偏上」，所以这里裁到内容本身。 -->
          <svg viewBox="40 36 176 176" aria-hidden="true">
            <path
              fill="currentColor"
              fill-rule="evenodd"
              d="M48 36 H208 V212 L128 160 L48 212 Z M128 56 L139.8 85.8 L171.8 87.8 L147 108.2 L155 139.2 L128 122 L101 139.2 L109 108.2 L84.2 87.8 L117.2 85.8 Z"
            />
          </svg>
        </div>
        <div class="brand-text">
          <div class="brand-name">师兄起页</div>
          <div class="brand-note">{{ t('home.brandNote') }}</div>
        </div>
        <!-- 钉住 ↔ 收起一对（既有约定 决策二）：浮出态显示「钉住」（转持久展开），
             展开态显示「收起」（回收起态）。收起且未浮出时整个面板不可见，没有按钮。 -->
        <button
          v-if="peeking"
          type="button"
          class="rail-btn"
          :title="t('home.pinSidebar')"
          :aria-label="t('home.pinSidebar')"
          @click="pinSidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 17v5" />
            <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </button>
        <button
          v-else-if="!effectiveCollapsed && !narrow"
          type="button"
          class="rail-btn"
          :title="t('home.collapseSidebar')"
          :aria-label="t('home.collapseSidebar')"
          @click="collapseSidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="m11 7-4 5 4 5" />
            <path d="m18 7-4 5 4 5" />
          </svg>
        </button>
      </div>

      <SidebarNav
        v-if="status === 'ready' && roots.length > 0"
        :roots="roots"
        :selected-id="selectedFolderId"
        :is-expanded="isExpanded"
        :drag-enabled="dragEnabled"
        :menu-enabled="editEnabled"
        @select="selectFolder"
        @toggle="toggleExpand"
      />

      <div class="sidebar-bottom">
        <!-- 回收站：删掉的东西的落点，就在删除动作的旁边。 -->
        <button
          v-if="syncConfigured"
          type="button"
          class="nav-item trash-entry"
          :class="{ active: activeView === 'trash' }"
          @click="openTrash"
        >
          <svg
            class="nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 6h18" />
            <path d="M8 6V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1" />
            <path d="M18.5 6 17.6 19.1A2 2 0 0 1 15.6 21H8.4a2 2 0 0 1-2-1.9L5.5 6" />
            <path d="M10 10.5v6M14 10.5v6" />
          </svg>
          <span class="nav-title">{{ t('trash.title') }}</span>
          <span v-if="trashCount > 0" class="nav-count">{{ trashCount }}</span>
        </button>

        <div class="sidebar-foot">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span>{{ t('home.sidebarFoot') }}</span>
        </div>
      </div>

      <div
        v-if="!layoutCollapsed && !peeking && !closing"
        class="sidebar-resize"
        :class="{ dragging: isResizing }"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('home.resizeSidebar')"
        :title="t('home.resizeSidebar')"
        @pointerdown="startResize"
        @dblclick="resetSidebarWidth"
      ></div>
    </aside>

    <!-- 右缘触屏把手：与左缘把手同一条规则 —— coarse pointer 才显示，
         指针设备里 display:none（键盘用户的通道是 ]）。class 与左缘**共用**
         `.peek-handle`：两缘实例的文档级吞击都豁免这个类，右把手的点击才放行得过去。 -->
    <button
      v-if="recentEnabled && !recentPeeking && !recentClosing && !recentNarrow"
      type="button"
      class="peek-handle peek-handle--right"
      :title="t('home.recent.handle')"
      :aria-label="t('home.recent.handle')"
      @click="onRecentHandleClick"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="m15 7-4 5 4 5" />
      </svg>
    </button>

    <!-- 右缘「最近访问」浮出面版。它**永不占流**（纯 fixed 浮层），
         所以左栏那套两段式关闭的回流防护在这里没有对应物 —— 单段滑出即零回流，
         用户看到的滑出手感与左栏一致。data-peek 三态与左栏逐字同构；
         宽度跟侧边栏同一个偏好（recentPanelStyle）。 -->
    <aside
      ref="recentPanelEl"
      class="recent-panel"
      :style="recentPanelStyle"
      :data-peek="recentPeeking ? 'on' : recentClosing ? 'out' : null"
      @mouseenter="onRecentEnter"
      @mouseleave="onRecentLeave"
    >
      <RecentPanel
        :visits="recentVisits"
        :loading="recentLoading"
        :error="recentError"
        @close="closeRecentPanel"
        @retry="reloadRecentVisits"
        @open-all="openFullHistory"
      />
    </aside>

    <main class="main">
      <div class="main-inner">
        <header class="topbar">
          <div class="search-area">
            <form class="search-box" role="search" @submit.prevent="submitSearch">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <circle cx="10.8" cy="10.8" r="6.8" />
                <path d="m16 16 4.3 4.3" />
              </svg>
              <input
                ref="searchInput"
                v-model="searchText"
                class="search-input"
                type="search"
                autocomplete="off"
                :placeholder="t('home.searchPlaceholder')"
                :aria-label="t('home.searchAria')"
              />
              <!-- 尾部：打字时是清除按钮，最右端是**搜索引擎选择器**。
                   引擎选择器曾经被撤掉过（理由是"设置页已有同一份控件，是重复控件"）——
                   那次判断错了：设置页那份是"配好它"，这颗是"这一次用谁"，
                   撤掉之后用户每次换引擎都要先离开当前上下文。
                   `/` 快捷键提示 chip 已摘（2026-10-15，既有约定 修订）：它占着输入框
                   尾部却只是装饰，快捷键本身照旧（见 handleKeydown），设置页「快捷键」里也写着。 -->
              <button
                v-if="searchText"
                type="button"
                class="search-clear"
                :aria-label="t('home.noResults.clear')"
                @click="clearSearch"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
              <EnginePicker :value="settings.searchEngine" @change="selectEngine" />
            </form>
          </div>

          <div class="top-actions">
            <!-- 新建：弹窗不会自己出现（内联卡是就地长出来的，才不需要显眼入口），
                 所以给它一颗常显按钮。放在主题之前：它是这里唯一的"做一件事"，
                 主题/设置/同步/管理器都是"去看或去配"。
                 落点非法时（搜索态、未归类、回收站屏、编辑没开）按钮禁用并说明原因。 -->
            <button
              type="button"
              class="icon-btn"
              :disabled="!createTargetId"
              :title="createTitle"
              :aria-label="createTitle"
              @click="openCreateDialog"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              class="icon-btn"
              :title="themeTitle"
              :aria-label="themeTitle"
              @click="toggleMode"
            >
              <svg v-if="themeIcon === 'auto'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="13" rx="2.5" />
                <path d="M8 20h8M12 17v3" />
                <path d="M12 4v13" opacity=".45" />
              </svg>
              <svg v-else-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
              </svg>
            </button>
            <!-- 齿轮是设置页的入口，不是同步状态的落点 —— 那条仍然是状态点。
                 放在主题与同步之间：三者都属于"关于这个页面本身"的动作。 -->
            <button
              type="button"
              class="icon-btn"
              :title="t('home.settings')"
              :aria-label="t('home.settings')"
              @click="openSettings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3.1" />
                <path
                  d="M19.4 15a1.6 1.6 0 0 0 .33 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.33 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.11A1.6 1.6 0 0 0 9.1 19.3a1.6 1.6 0 0 0-1.76.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 5.3 15a1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.11A1.6 1.6 0 0 0 4.7 9.1a1.6 1.6 0 0 0-.33-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.7a1.6 1.6 0 0 0 .97-1.47V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.76-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 18.7 9.1V9a1.6 1.6 0 0 0 1.47.97H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.47.97Z"
                />
              </svg>
            </button>
            <button
              type="button"
              class="icon-btn sync-btn"
              :title="syncTitle"
              :aria-label="syncTitle"
              @click="openSyncSettings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9M3.5 12a8.5 8.5 0 0 1 14.6-5.9" />
                <path d="M18 3v4h-4M6 21v-4h4" />
              </svg>
              <span v-if="showSyncDot" class="sync-dot" aria-hidden="true"></span>
            </button>
            <button
              type="button"
              class="icon-btn"
              :title="t('home.manager')"
              :aria-label="t('home.manager')"
              @click="openBookmarkManager"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />
                <path d="M10 8h4" />
              </svg>
            </button>
          </div>
        </header>

        <!-- 视图切换过渡：键 = 视图身份（视图 + 目录 id + 搜索态），
             只在用户动作里更新（viewSwitchKey）—— 同目录内的数据刷新不换键、不播。
             交叉淡入：新旧两层同时 --dur-base 淡入淡出（纯透明度、不带上浮），叠在
             .main-inner 网格同一行；首屏 appear = --dur-slow。进入层由 onViewSwitchEnter
             拆掉卡片错峰（差序入场会在"还没到的卡"处露旧卡 = 花斑）；离开层由
             onViewSwitchLeave 上 inert/aria-hidden、CSS 上 pointer-events ——
             消失中的旧目录不该被 Tab/读屏/鼠标摸到。 -->
        <Transition
          name="view-switch"
          appear
          @before-appear="onViewSwitchAppear"
          @before-enter="onViewSwitchEnter"
          @leave="onViewSwitchLeave"
        >
          <div :key="viewSwitchKey" class="view-host">
            <!-- 回收站是**另一屏**，不是主区里的一块：与 ShiTab 的 既有约定 同一条取向 ——
                 切过去时它应当像"另一档"，而不是"列表下面多了一段"。 -->
            <TrashPanel
              v-if="activeView === 'trash'"
              ref="trashPanel"
              class="trash-view"
              @changed="refreshTrashCount"
            />

            <section v-else class="content" aria-labelledby="bookmarkHeading">
              <div class="section-head">
                <div class="title-line">
                  <template v-if="isSearching">
                    <h1 id="bookmarkHeading" class="crumb-current">{{ t('home.searchResults') }}</h1>
                    <span class="count">{{ visibleItems.length }} / {{ items.length }}</span>
                  </template>
                  <template v-else-if="activePath.length > 0">
                    <nav class="crumbs" :aria-label="t('home.title')">
                      <template v-for="(segment, index) in activePath" :key="segment.id">
                        <button
                          v-if="index < activePath.length - 1"
                          type="button"
                          class="crumb"
                          @click="selectFolder(segment.id)"
                        >
                          {{ segment.title }}
                        </button>
                        <h1 v-else id="bookmarkHeading" class="crumb-current">{{ segment.title }}</h1>
                        <span v-if="index < activePath.length - 1" class="crumb-sep" aria-hidden="true">/</span>
                      </template>
                    </nav>
                  </template>
                </div>
                <!-- 「＋新建」入口：指针设备上悬停标题行才显现；
                     键盘聚焦与无 hover 设备由 CSS 兜底常显，不会有人因此没有新建功能。 -->
                <button
                  v-if="createTargetId"
                  type="button"
                  class="ghost-btn new-entry"
                  :title="t('home.edit.newHint', { folder: activeFolder?.title ?? '' })"
                  @click="startCreateIn(createTargetId, 'bookmark')"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span>{{ t('home.edit.new') }}</span>
                </button>
                <span v-if="notice" class="hint">{{ notice }}</span>
              </div>

              <!-- 新建 / 改名的表单弹窗。它 teleport 到 body，
                   所以放在哪个渲染分支里都无所谓 —— 这里只是给它一个挂点。 -->
              <BookmarkFormDialog
                v-if="editor"
                :mode="editor.kind"
                :type="editor.type"
                :title="editor.kind === 'rename' ? editor.title : ''"
                :url="editor.kind === 'rename' ? editor.url : ''"
                :allow-type-switch="editor.kind === 'create'"
                :parent-id="editor.kind === 'create' ? editor.parentId : ''"
                :parent-title="editor.kind === 'create' ? editor.folderTitle : ''"
                :folders="pickerFolders"
                @submit="submitEditor"
                @cancel="closeEditor"
                @update:type="switchEditorType"
              />

              <!-- 撤销「上一次改动」（既有约定 提出、既有约定 泛化）。
                   它是持久的：刷新之后还在，直到下一次改动顶掉它。
                   目标节点被删掉时按钮禁用并说明原因 —— 不让用户点一个注定失败的操作。 -->
              <div v-if="lastEdit" class="drag-undo">
                <span class="drag-undo-text">{{ undoBarText }}</span>
                <button type="button" class="ghost-btn" :disabled="undoTargetMissing" @click="undoLastChange">
                  {{ t('home.drag.undo') }}
                </button>
                <button type="button" class="ghost-btn" @click="dismissLastEdit">
                  {{ t('home.drag.dismiss') }}
                </button>
                <span v-if="undoTargetMissing" class="drag-undo-gone">{{ t('home.edit.undoTargetGone') }}</span>
              </div>

              <template v-if="status === 'loading'">
                <div class="skeleton-grid" aria-hidden="true">
                  <div v-for="n in 16" :key="n" class="skeleton-card"></div>
                </div>
                <p class="loading-text" role="status">{{ t('home.loading') }}</p>
              </template>

              <StatePanel
                v-else-if="status === 'error'"
                tone="error"
                :title="t('home.error.title')"
                :description="errorMessage"
              >
                <template #icon>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 9v5M12 17h.01" />
                    <path d="M10.3 3.9 2.4 17.4A2 2 0 0 0 4.1 20.4h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                  </svg>
                </template>
                <template #actions>
                  <button type="button" class="ghost-btn" @click="refresh">{{ t('home.error.retry') }}</button>
                  <button type="button" class="ghost-btn" @click="openBookmarkManager">
                    {{ t('home.error.manager') }}
                  </button>
                </template>
              </StatePanel>

              <StatePanel
                v-else-if="items.length === 0"
                :title="t('home.empty.title')"
                :description="t('home.empty.description')"
              >
                <template #icon>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />
                  </svg>
                </template>
              </StatePanel>

              <template v-else-if="isSearching">
                <div v-if="visibleItems.length > 0" class="bookmark-grid">
                  <BookmarkCard
                    v-for="item in visibleItems"
                    :key="item.id"
                    :item="item"
                    v-bind="cardDragProps(item)"
                    @contextmenu.prevent="openBookmarkMenu(item, $event)"
                    @open="openNonWebBookmark(item)"
                  />
                </div>
                <StatePanel v-else :title="t('home.noResults.title')" :description="t('home.noResults.description')">
                  <template #actions>
                    <button type="button" class="ghost-btn" @click="clearSearch">{{ t('home.noResults.clear') }}</button>
                  </template>
                </StatePanel>
              </template>

              <template v-else-if="activeFolder">
                <!-- 叶子目录：没有子文件夹，直接平铺书签 -->
                <template v-if="activeFolder.children.length === 0">
                  <div v-if="activeFolder.bookmarks.length > 0" class="bookmark-grid">
                    <BookmarkCard
                      v-for="item in activeFolder.bookmarks"
                      :key="item.id"
                      :item="item"
                      v-bind="cardDragProps(item)"
                      @contextmenu.prevent="openBookmarkMenu(item, $event)"
                      @open="openNonWebBookmark(item)"
                    />
                    <!-- 鼠标移到网格末尾才出现的「新建」卡。固定入口在标题行，
                         这张是"顺手就点在末尾"的快捷方式；触屏与键盘没有 hover，
                         对它们不显示 —— 所以它永远不是唯一入口。 -->
                    <button
                      v-if="createTargetId"
                      type="button"
                      class="new-tile"
                      :title="t('home.edit.newHint', { folder: activeFolder?.title ?? '' })"
                      @click="startCreateIn(createTargetId, 'bookmark')"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      <span>{{ t('home.edit.new') }}</span>
                    </button>
                  </div>
                  <StatePanel
                    v-else
                    :title="t('home.folderEmpty.title')"
                    :description="t('home.folderEmpty.description')"
                  >
                    <!-- 空文件夹最该给的就是新建：第一条书签总得有个地方落下。 -->
                    <template #actions>
                      <button
                        v-if="createTargetId"
                        type="button"
                        class="ghost-btn"
                        @click="startCreateIn(createTargetId, 'bookmark')"
                      >
                        {{ t('home.edit.new') }}
                      </button>
                    </template>
                  </StatePanel>
                </template>

                <!-- 有子目录：每个子文件夹一个分组，分组里更深的内容用文件夹块表示 -->
                <template v-else>
                  <div v-if="activeFolder.bookmarks.length > 0" class="bookmark-grid group-lead">
                    <BookmarkCard
                      v-for="item in activeFolder.bookmarks"
                      :key="item.id"
                      :item="item"
                      v-bind="cardDragProps(item)"
                      @contextmenu.prevent="openBookmarkMenu(item, $event)"
                      @open="openNonWebBookmark(item)"
                    />
                    <button
                      v-if="createTargetId"
                      type="button"
                      class="new-tile"
                      :title="t('home.edit.newHint', { folder: activeFolder?.title ?? '' })"
                      @click="startCreateIn(createTargetId, 'bookmark')"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      <span>{{ t('home.edit.new') }}</span>
                    </button>
                  </div>

                  <section
                    v-for="child in groupedChildren"
                    :key="child.id"
                    class="group"
                    v-bind="groupDropProps(child)"
                    :aria-label="`${child.title}，${t('home.countBookmarks', { n: child.count })}`"
                  >
                    <!-- 标题 = 那个子目录的拖动把手；落点判定在这一节上（见 groupDropProps）。
                         右键它 = 右键这个子文件夹。 -->
                    <h2
                      class="group-title"
                      v-bind="groupDragProps(child)"
                      @contextmenu.prevent="openFolderMenu(child, $event)"
                    >
                      {{ child.title }}
                    </h2>
                    <div v-if="child.children.length > 0" class="folder-grid">
                      <FolderTile
                        v-for="grandChild in child.children"
                        :key="grandChild.id"
                        :node="grandChild"
                        v-bind="folderDragProps(grandChild)"
                        @open="selectFolder"
                        @contextmenu.prevent="openFolderMenu(grandChild, $event)"
                      />
                      <!-- 末尾的悬停新建卡建进**这一节自己的文件夹** —— 卡片与文件夹块
                           都是它的内容，落在它们旁边的那张卡理应也是。 -->
                      <button
                        v-if="createTargetFor(child.id)"
                        type="button"
                        class="new-tile is-folder"
                        :title="t('home.edit.newHint', { folder: child.title })"
                        @click="startCreateIn(child.id, 'folder')"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>{{ t('home.edit.new') }}</span>
                      </button>
                    </div>
                    <div v-if="child.bookmarks.length > 0" class="bookmark-grid">
                      <BookmarkCard
                        v-for="item in child.bookmarks"
                        :key="item.id"
                        :item="item"
                        v-bind="cardDragProps(item)"
                        @contextmenu.prevent="openBookmarkMenu(item, $event)"
                        @open="openNonWebBookmark(item)"
                      />
                      <button
                        v-if="createTargetFor(child.id)"
                        type="button"
                        class="new-tile"
                        :title="t('home.edit.newHint', { folder: child.title })"
                        @click="startCreateIn(child.id, 'bookmark')"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>{{ t('home.edit.new') }}</span>
                      </button>
                    </div>
                  </section>
                </template>
              </template>
            </section>
          </div>
        </Transition>
      </div>
    </main>

    <BookmarkContextMenu
      v-if="menuRequest"
      :target="menuRequest.target"
      :x="menuRequest.x"
      :y="menuRequest.y"
      :edit-enabled="editEnabled"
      :recovery="recoveryMode"
      :incognito-ready="incognitoReady"
      :split-ready="splitReady"
      @close="closeMenu"
      @action="handleMenuAction"
    />

    <!-- 删除文件夹的预览模态。主页的第一个模态 —— 一次文件夹删除
         动辄几百条，菜单内两下点击在这个量级上太轻。 -->
    <DeleteFolderDialog
      v-if="folderDelete"
      :folder-id="folderDelete.id"
      :recovery="recoveryMode"
      @confirm="confirmFolderDelete"
      @cancel="cancelFolderDelete"
    />

    <!-- 卡片提示：**全页只有这一个**气泡，卡片只带 data-tip。
         fixed 定位 + pointer-events:none —— 它不占布局，也不会被当成"鼠标离开了卡片"。
         位置由 lib/tooltip-place.ts 算（翻面 + 边界夹紧 + 箭头对齐），
         --tip-arrow 是箭头中心在气泡里的 x，进场只动透明度与 2px 位移。 -->
    <Transition name="card-tip">
      <div
        v-if="cardTip"
        ref="cardTipEl"
        class="card-tip"
        :data-placement="cardTip.placement"
        :style="{
          left: `${cardTip.left}px`,
          top: `${cardTip.top}px`,
          '--tip-arrow': `${cardTip.arrowLeft}px`,
        }"
        aria-hidden="true"
      >
        {{ cardTip.text }}
      </div>
    </Transition>
  </div>
</template>
