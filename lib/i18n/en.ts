/**
 * 英文文案。
 *
 * 类型约束是 `Record<MessageKey, string>` —— 少一个 key 编译就过不去，
 * 多一个 key 也不行（拼错的会立刻暴露），两边因此永远同步。
 * `MessageKey` 由 `zh-CN.ts` 导出，中文表是唯一来源。
 *
 * 翻译时要原样保留的占位符：`{n} {size} {id} {message} {head} {probeNote}
 * {pushed} {pulled} {applied} {devices} {ops} {base} {summary} {reason}
 * {version} {bookmarks} {folders} {x}`。`i18n.test.ts` 会逐个对着扫。
 *
 * `<strong>` / `<code>` / `<br />` 也要保留：这些串是用 `v-html` 渲染的，
 * 字符串本身是仓库内的常量（见 既有约定）。
 */
import type { MessageKey } from './zh-CN';

export const en: Record<MessageKey, string> = {
  'app.title': 'ShiStart · Settings',
  // The bare app name for the left column's brand block (app.title carries
  // "Settings" and is used as the nav's aria-label).
  'app.name': 'ShiStart',

  'nav.general': 'General',
  'nav.appearance': 'Appearance',
  'nav.sync': 'Sync',
  'nav.snapshot': 'Snapshots',
  'nav.data': 'Data',
  'nav.about': 'About',
  'nav.bookmarks': 'Bookmarks',
  'folder.childOf': '{title} subfolders',

  'common.expand': 'Show',
  'common.collapse': 'Hide',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.confirmDelete': 'Click again to confirm deletion',
  'common.loading': 'Loading…',
  'common.unknownTime': 'Time unknown',
  'common.never': 'Never synced',
  'common.from': 'from {x}',
  'common.thisDevice': 'This device',
  'common.copied': 'Copied',
  'common.cancel': 'Cancel',

  'general.title': 'General',
  'general.searchEngine': 'Search engine',
  'general.searchEngine.hint': 'Used when you press Enter; typing is never sent anywhere.',
  'general.sidebar': 'Sidebar',
  'general.sidebar.show': 'Show the sidebar',
  'general.sidebar.hint': 'Move to the left edge (or press [) to peek; drag to resize.',
  'general.sidebar.resetWidth': 'Reset to default width',
  'general.shortcuts': 'Keyboard shortcuts',
  'general.shortcuts.focus': 'Ctrl / Cmd + K, or /: focus the search box',
  'general.shortcuts.clear': 'Esc: clear the search',
  'general.shortcuts.sidebar': '[: show / collapse the sidebar',
  'general.shortcuts.recent': ']: show / collapse the recent visits panel',
  'general.drag': 'Drag to arrange',
  'general.drag.toggle': 'Allow dragging bookmarks to arrange them',
  'general.drag.hint': 'Drag bookmarks or folders to reorder or reparent; applies on drop.',
  'general.drag.detail': 'When enabled you can drag a bookmark or folder to change its order, or drop it into another folder to move it there — it takes effect the moment you let go, with no confirmation step. The most recent move keeps an <strong>Undo</strong> until the next one. Dragging uses the browser\u2019s native drag and drop, which does <strong>not work on touch screens or with the keyboard</strong> — use the browser bookmark manager for that.',
  'general.editBookmarks': 'Create & rename',
  'general.editBookmarks.toggle': 'Allow creating bookmarks, creating folders and renaming on the home page',
  'general.editBookmarks.hint': 'Enables create and rename entry points; undo bar can revert.',
  'general.editBookmarks.detail': 'When enabled, a fixed “+ New” button sits next to the title, and moving the pointer to the end of the bookmark grid reveals a new-item card; right-clicking a folder also lets you create inside it, or rename the folder itself.<br />Every change records a “last change” that the undo bar above the content can take back, until the next change replaces it. The delete entry for bookmarks lives in the right-click menu either way and is not affected by this switch.',
  'general.recentPanel': 'Recent visits',
  'general.recentPanel.toggle': 'Show the recent visits panel at the right edge of the home page',
  'general.recentPanel.hint': 'Move the cursor to the right edge (or press ]) for recent visits.',
  'general.recentPanel.detail': 'Move the pointer to the right edge of the page (or press ]) to peek at the pages you visited recently; click one to open it in a new tab. It reads your browser’s own history — no copy is kept and nothing is uploaded; only this switch itself travels with sync. Not shown when the window is narrower than 900px.',

  'appearance.title': 'Appearance',
  'appearance.palette': 'Palette',
  'appearance.palette.hint': 'Two palettes, each in light and dark.',
  'appearance.palette.warm': 'Warm clay morning',
  'appearance.palette.youth': 'Lime summer night',
  'appearance.mode': 'Appearance',
  'appearance.mode.hint': '"Follow system" tracks the OS light/dark setting.',
  'appearance.mode.light': 'Light',
  'appearance.mode.dark': 'Dark',
  'appearance.mode.system': 'Follow system',
  'appearance.pattern': 'Background pattern',
  'appearance.pattern.hint': 'Paper texture on the new tab; follows the accent color.',
  'appearance.pattern.none': 'None',
  'appearance.pattern.dots': 'Dot grid',
  'appearance.pattern.checker': 'Checkerboard',
  'appearance.pattern.grid': 'Fine grid',
  'appearance.language': 'Language',
  'appearance.language.hint': '"Follow browser" picks the interface language automatically.',
  // 语言名保留各自的自称：让用户认得出，是唯一正确的做法。
  'appearance.language.zh': '简体中文',
  'appearance.language.en': 'English',
  'appearance.language.system': 'Follow browser',
  // ---- Cards per row (既有约定; local preference, never synced) ----
  'appearance.cardsPerRow': 'Cards per row',
  'appearance.cardsPerRow.hint': 'Max cards per row; fewer when the window is narrow.',
  'appearance.cardsPerRow.detail': 'At most how many bookmark cards and folder tiles fit in one row. Narrow windows drop columns automatically so cards never get too narrow to read — this is a ceiling, not a fixed count, and the line below tells you what your current window actually fits. Go back to the start page to see it.',
  'appearance.cardsPerRow.value': '{n} per row',
  'appearance.cardsPerRow.actual': 'Your current window actually fits {n} per row',
  'appearance.cardsPerRow.capped': '(the window is not wide enough — cards would get too narrow)',

  'data.title': 'Data',
  'data.export': 'Export bookmarks',
  'data.export.hint': 'Exports browser bookmarks directly; read-only, changes nothing.',
  'data.export.html': 'Export as HTML',
  'data.export.html.hint': 'Universal format that any browser can import.',
  'data.export.json': 'Export as JSON',
  'data.export.json.hint': 'Full structure with folder hierarchy and timestamps, for archival or your own tooling.',
  'data.export.busy': 'Exporting…',
  'data.export.failed': 'Export failed: {reason}',
  'data.import': 'Import',
  'data.import.hint': 'Import via the browser bookmark manager (Ctrl+Shift+O).',
  'data.settings': 'Settings backup',
  'data.settings.hint': 'Interface preferences only; no bookmarks, passwords, or sync credentials.',
  'data.settings.export': 'Export settings',
  'data.settings.import': 'Import settings',
  'data.settings.importDone': 'Settings imported. Reloading.',
  'data.settings.invalid': 'This file is not a ShiStart settings backup, or it is corrupted.',
  // 具体的四种失败原因：给的是机器可读的码，文案在这里对应。
  'data.settings.importError.notJson': 'This file is not valid JSON and cannot be read.',
  'data.settings.importError.notObject': 'The top level of the backup is not an object.',
  'data.settings.importError.kindMismatch': 'This is not a ShiStart settings backup file.',
  'data.settings.importError.versionMismatch':
    'This backup version does not match the current version and cannot be recognised.',
  'data.stats': '{bookmarks} bookmarks across {folders} folders.',

  'about.title': 'About',
  'about.version': 'Version {version}',
  'about.privacy': 'Privacy',
  'about.privacy.body': 'Bookmarks are read locally only: never uploaded, never stored, never counted. Only two outbound requests happen: the WebDAV server you configure (after you enable sync), and the QR images on this page.',
  'about.privacy.more': 'Full privacy policy: ',
  'about.credits': 'About this extension',
  'about.credits.body':
    'ShiStart takes over the new tab page and shows the bookmarks you already have. Creating, renaming, moving and deleting write straight to your browser bookmarks — ' +
    'exactly what the bookmark manager does — and every step keeps a way back (the undo bar, or the trash once sync is on).',
  // ---- What's new : latest release only, history stays in CHANGELOG.md ----
  'about.changelog': "What's new",
  'about.changelog.released': 'Released {date}',
  'about.changelog.fold': 'What changed in this version',
  'about.changelog.empty': 'Release notes are unavailable right now.',
  // ---- Sponsor QR codes + official account (既有约定: GitHub/Gitee mirrors, auto-pick) ----
  'about.sponsor': 'Sponsor the author',
  'about.sponsor.hint': 'Buy the author a coffee if you like it; features stay free.',
  'about.sponsor.alipay': 'Alipay',
  'about.sponsor.wechatPay': 'WeChat Pay',
  'about.sponsor.loading': 'Picking the fastest image source…',
  'about.sponsor.unavailable':
    'The QR codes could not load right now (neither image source was reachable). Check your network and try again.',
  'about.sponsor.retry': 'Retry',
  'about.sponsor.imageError': 'This image could not load',
  'about.official': 'Follow the official account',
  // The account name is a Chinese proper noun — you literally search these three
  // characters inside WeChat, so it stays as-is in every locale.
  'about.official.name': '师兄知道',
  'about.official.body':
    'New versions, usage notes and new features land first on our WeChat official account "师兄知道". Scan the code, or search that name inside WeChat.',
  'about.links': 'Project & author',
  'about.links.github': 'GitHub repo',
  'about.links.gitee': 'Gitee repo',
  'about.links.home': 'Homepage',
  'about.reset': 'Reset all settings',
  'about.reset.confirm': 'Click again to confirm reset',
  'about.reset.done': 'Restored the default settings.',
  'about.reset.hint': 'Resets interface preferences only; bookmarks and sync stay intact.',

  'home.title': 'Current location',
  // Time-of-day greeting: added in 既有约定, removed in 既有约定 per user request.
  'home.searchPlaceholder': 'Search bookmarks, URLs, or folders…',
  'home.searchAria': 'Search bookmarks or the web',
  // aria-label for the engine <select> inside the search box (restored in 既有约定).
  'home.engineAria': 'Search engine',
  'home.theme.summary': 'Theme: {palette} · {mode}',
  'home.manager': 'Open the browser bookmark manager',
  'home.managerHint': 'Press Ctrl+Shift+O (Cmd+Option+B on macOS) to open the browser bookmark manager.',
  'home.delete.done':
    'Deleted “{title}”. Syncing now \u2014 it will show up in the settings trash as soon as that finishes.',
  'home.delete.doneManualSync':
    'Deleted “{title}”. Auto sync is off \u2014 click \u201CSync now\u201D in the settings sync section and it will appear in the trash.',
  'home.delete.failed': 'Delete failed: {reason}. You can delete it from the browser bookmark manager instead.',
  'home.copyDone': 'Link copied to the clipboard.',
  'home.open.scriptlet': 'A bookmarklet has to run on its own page — the homepage cannot open it.',
  'home.open.blocked': 'Cannot open a {protocol} address here. Right-click → Copy link, then open it from the address bar or the browser’s bookmark manager.',
  'home.tabAction.noTabApi':
    'This environment cannot open a new tab; use the browser bookmark manager instead.',
  'home.tabAction.noWindowApi':
    'This environment cannot open a new window; use the browser bookmark manager instead.',
  'home.tabAction.incognito':
    'To open an incognito window, first allow ShiStart to run in incognito mode on the extensions page (chrome://extensions), then reopen this new tab page.',
  'home.tabAction.split':
    'This browser cannot open a split view via an extension yet (needs Chrome 155 or later; Edge has no API for it). You can open it in a new window and arrange the windows side by side instead.',
  'home.tabAction.copyFailed': 'Could not copy to the clipboard. The link is: {url}',
  'menu.aria': 'Actions for {title}',
  'menu.openTab': 'Open in new tab',
  'menu.openWindow': 'Open in new window',
  'menu.openIncognito': 'Open in Incognito window',
  'menu.openIncognitoEdge': 'Open in InPrivate window',
  'menu.incognitoHint': 'Allow ShiStart to run in incognito mode from the extensions page first',
  'menu.openSplit': 'Open in split view',
  'menu.splitHint': 'Requires Chrome 155 or later; Edge has no API for this yet',
  'menu.copyLink': 'Copy link',
  'menu.newBookmark': 'New bookmark',
  'menu.newFolder': 'New folder',
  'menu.rename': 'Rename',
  'menu.delete': 'Delete bookmark',
  'menu.deleteConfirm': 'Confirm delete',
  'menu.deleteNote': 'Once deleted it goes to the <strong>trash</strong> in settings, where you can recover it at any time. Click again to confirm.',
  'menu.deleteNoteManualSync':
    'Once deleted it goes to the <strong>trash</strong> in settings, but auto sync is off \u2014 you will have to sync manually. Click again to confirm.',
  'menu.deleteNoteFinal': 'Sync is off, so once deleted it <strong>cannot be recovered</strong>. Click again to confirm.',
  // Deleting a folder . An empty folder confirms with two clicks in the menu;
  // a non-empty one must go through the delete-preview dialog.
  'menu.deleteFolder': 'Delete folder',
  'menu.deleteFolderConfirm': 'Confirm delete',
  'menu.deleteFolderNote':
    'This will delete the empty folder. Once deleted it goes to the <strong>trash</strong> in settings, where you can recover it at any time. Click again to confirm.',
  'menu.deleteFolderNoteManualSync':
    'This will delete the empty folder. Once deleted it goes to the <strong>trash</strong> in settings, but auto sync is off \u2014 you will have to sync manually. Click again to confirm.',
  'menu.deleteFolderNoteFinal':
    'Sync is off, so once deleted it <strong>cannot be recovered</strong>. Click again to confirm.',
  // Delete preview dialog (既有约定 decision 2)
  'home.select.item': 'Select {title}',
  'home.selection.count': '{n} selected',
  'home.selection.open': 'Open',
  'home.selection.openWindow': 'Open in new window',
  'home.selection.delete': 'Delete',
  'home.selection.cancel': 'Cancel',
  'home.selection.openSkipped': 'Skipped {n} link(s) that cannot be opened directly.',
  'home.selection.deleteTitle': 'Delete {n} item(s)?',
  'home.selection.deleteBody': '{n} of them are folders; their contents go too.',
  'home.selection.deleteBodyPlain': 'All selected items are bookmarks; they can be restored from the trash after sync.',
  'home.selection.deleteDone': 'Deleted {n} item(s). Syncing — you can restore them from the trash.',
  'home.selection.deleteFailed': 'Delete failed: {reason}',
  'home.selection.openNothing': 'Nothing selected can be opened directly.',
  'home.selection.openFailed': 'Open failed: {reason}',
  'home.selection.deletePartial': '{n} item(s) could not be deleted; the rest are gone.',
  'home.selection.clear': 'Clear selection',
  'home.folderDelete.title': 'Delete folder',
  'home.folderDelete.subject':
    'This will delete \u201c{title}\u201d and everything inside it.',
  'home.folderDelete.statLine': 'items will be deleted \u2014 {n} bookmarks, {m} subfolders',
  'home.folderDelete.statLineBookmarks': 'items will be deleted \u2014 {n} bookmarks',
  'home.folderDelete.samples': 'Including:',
  'home.folderDelete.typedNameLabel': 'Type the folder name to confirm:',
  'home.folderDelete.typedNameMismatch': 'The name does not match. Try again.',
  'home.folderDelete.noSync': 'Sync is off — once deleted it <strong>cannot be recovered</strong>.',
  'home.folderDelete.manualSync':
    'Auto sync is off \u2014 after deleting, click \u201cSync now\u201d once in settings for it to reach the trash.',
  'home.folderDelete.confirm': 'Delete {n} items',
  'home.folderDelete.cancel': 'Cancel',
  'home.folderDelete.loading': 'Counting the folder contents\u2026',
  'home.folderDelete.unreadable': 'This folder can no longer be read \u2014 it may have just been deleted.',
  'home.folderDelete.done':
    'Deleted the folder \u201c{title}\u201d and everything inside it ({n} items). Syncing now \u2014 once it finishes you can recover them from the trash in settings.',
  'home.folderDelete.doneManualSync':
    'Deleted the folder \u201c{title}\u201d and everything inside it ({n} items). Auto sync is off \u2014 click \u201cSync now\u201d once in settings before they reach the trash.',
  'home.folderDelete.failed':
    'Could not delete the folder: {reason}. You can also tidy folders in the browser bookmark manager.',
  'home.folderDelete.rootRejected':
    'Bookmarks bar, other bookmarks and mobile bookmarks are browser root folders and cannot be deleted.',
  // Nodes blocked by a concurrent edit (既有约定 decision 5)
  'home.folderDelete.blocked':
    '{n} items in \u201c{root}\u201d could not be deleted: another device edited them, so they were re-attached at the root. See the pending list in settings.',
  'home.settings': 'Open settings',
  'home.settingsHint': 'Could not open the settings page. Enter from the extension\u2019s "Options".',
  'home.brandNote': 'A new discovery with every open.',
  // ⚠️ Never write "never uploaded" here: with sync on, bookmarks and preferences
  //     both end up in the user's own WebDAV space — that line would lie.
  'home.sidebarFoot': 'Bookmarks live on this machine and your own sync space',
  'home.loading': 'Setting out your bookmarks…',
  'home.searchResults': 'Search results',
  'home.countBookmarks': '{n} bookmarks',
  'home.collapseSidebar': 'Collapse the sidebar',
  'home.pinSidebar': 'Pin the sidebar',
  'home.expandSidebar': 'Expand the sidebar',
  'home.resizeSidebar': 'Drag to resize the sidebar',
  // ---- Right-edge "recent visits" peek panel  ----
  'home.recent.title': 'Recent visits',
  'home.recent.handle': 'Show recent visits',
  'home.recent.close': 'Close recent visits',
  'home.recent.empty': 'No pages visited yet',
  'home.recent.error': 'Could not read recent visits',
  'home.recent.retry': 'Try again',
  'home.recent.viewAll': 'View full history',
  'home.recent.noTabApi':
    'This environment cannot open a new tab — press Ctrl+H in your browser to see your history.',
  // Group headers (a flat list of 50 is a wall; group by calendar day like browser history).
  'home.recent.today': 'Today',
  'home.recent.yesterday': 'Yesterday',
  'home.recent.earlier': 'Earlier',
  'home.error.title': 'Could not read this browser\u2019s bookmarks',
  'home.error.retry': 'Try again',
  'home.error.manager': 'Open the bookmark manager',
  'home.empty.title': 'Nothing to show yet',
  'home.empty.description': 'Bookmark a few sites in your browser, then come back.',
  'home.noResults.title': 'No matching bookmarks',
  'home.noResults.description': 'Try a shorter keyword, or switch top-level folders.',
  'home.noResults.clear': 'Clear the search',
  'home.folderEmpty.title': 'This folder is empty',
  'home.folderEmpty.description': 'Expand another category on the left, or use the breadcrumb to go back up.',
  // Card tooltip : one line of the self-drawn bubble — name + how many inside.
  // No browser-internal id: that is an implementation detail users only ask about.
  'home.folderTile.tip': '{name} · {count} bookmarks',
  'home.sync.off': 'Sync settings',
  'home.sync.conflict': 'Sync: {n} conflicts need your attention',
  'home.sync.auth': 'Sync: credentials problem, click to resolve',
  'home.sync.error': 'Sync: {reason}',
  'home.sync.errorFallback': 'Last sync failed',
  'home.sync.never': 'Sync: never synced, click to set up',
  'home.sync.skipped': '{n} too long to sync',
  'home.sync.failed': '{n} could not be written here',
  'sync.status.skipped': 'Too long to sync',
  'sync.status.skippedValue': '{n}',
  'sync.status.failed': 'Could not be written here',
  'sync.status.failedValue': '{n}',
  'label.summary.skipped': '{n} too long to sync',
  'label.summary.failed': '{n} could not be written here',
  'home.sync.ok': 'Sync: healthy, click to configure',
  // Drag to arrange
  'home.drag.into': 'Into “{title}”',
  'home.drag.moved': 'Moved “{title}” into “{parent}”.',
  'home.drag.movedAdjusted':
    'Moved “{title}” into “{parent}”, but one slot earlier than where you dropped it — the browser does not accept appending straight to the end of a different folder.',
  'home.drag.movedNoUndo':
    'Moved “{title}” into “{parent}”, but the step could not be recorded, so undo is unavailable.',
  'home.drag.movedMany': 'Moved {n} item(s) into “{parent}”.',
  'home.drag.movedManyPartial': 'Moved {moved}, {failed} failed.',
  'home.drag.undo': 'Undo',
  'home.drag.dismiss': 'Dismiss',
  'home.drag.failed': 'Move failed: {reason}. You can also arrange bookmarks in the browser bookmark manager.',
  'home.drag.undoFailed': 'Undo failed: {reason}',
  'home.drag.reject.unknownDragged': 'That item is no longer in the bookmark tree. Reload and try again.',
  'home.drag.reject.unknownTarget': 'The drop target is no longer in the bookmark tree. Reload and try again.',
  'home.drag.reject.intoSelf': 'A folder cannot be dropped into itself or into one of its own subfolders.',
  'home.drag.reject.virtualTarget': '“Unfiled” is a view ShiStart composes, not a folder you can drop things into.',
  'home.drag.reject.rootParent':
    'ShiStart does not reorder what sits directly under the browser root — arrange top-level folders and loose root-level bookmarks in the bookmark manager instead.',
  // Create / rename / undo "last change" .
  // The undo bar and the done messages are split by kind — one flat "undone"
  // cannot tell whether the last step was a create, a rename or a move.
  'home.edit.new': 'New',
  'home.edit.newHint': 'New in “{folder}”',
  'home.edit.noChange': 'Neither the name nor the URL changed.',
  'home.edit.created': 'Created “{title}” in “{parent}”.',
  'home.edit.createdNoUndo': 'Created “{title}” in “{parent}”, but the step could not be recorded, so undo is unavailable.',
  'home.edit.updated': 'Renamed “{before}” to “{title}”.',
  'home.edit.updatedNoUndo': 'Renamed “{before}” to “{title}”, but the step could not be recorded, so undo is unavailable.',
  'home.edit.failed': 'The operation failed: {reason}. You can also create or rename in the browser bookmark manager.',
  'home.edit.undoBar.create': 'Last create: “{title}”',
  'home.edit.undoBar.update': 'Last rename: “{before}” to “{title}”',
  'home.edit.undoBar.move': 'Last move: “{title}” into “{parent}”',
  'home.edit.undoDone.create': 'Undone — the new “{title}” has been deleted.',
  'home.edit.undoDone.update': 'Undone — “{title}” is back to “{before}”.',
  'home.edit.undoDone.move': 'Undone — “{title}” is back where it was.',
  'home.edit.undoFailed': 'Undo failed: {reason}',
  'home.edit.error.apiUnavailable': 'This environment cannot write to browser bookmarks.',
  'home.edit.error.nodeMissing': 'The bookmark to change, or the place it should go back to, no longer exists.',
  // UI elements pointing at a deleted node disable themselves (既有约定 decision 8)
  'home.edit.undoTargetGone': 'The target of the last change is no longer in the bookmark tree, so it cannot be undone.',
  'home.editor.createTitle': 'New in “{folder}”',
  'home.create.in': 'New bookmark in “{folder}”',
  'home.create.off': 'Creating is off (Settings → General → Allow add & edit)',
  'home.create.searching': 'No current folder while searching — clear the query first',
  'home.create.trash': 'You cannot create inside the trash',
  'home.create.unfiled': '“Unfiled” is a root; creating there drops it out of sync',
  'home.editor.renameTitle': 'Rename',
  'home.editor.typeBookmark': 'Bookmark',
  'home.editor.typeFolder': 'Folder',
  'home.editor.titleLabel': 'Name',
  'home.editor.urlLabel': 'URL',
  'home.editor.titlePlaceholder': 'Leave empty and the browser will name it',
  'home.editor.urlPlaceholder': 'e.g. example.com',
  'home.editor.urlRequired': 'A bookmark needs a URL.',
  'home.editor.urlRejected': 'The browser refuses this address. Try another one.',
  'home.editor.urlWillBecome': 'Will be saved as {url}',
  'home.editor.urlNotSyncable': 'This kind of address does not take part in ShiStart sync — it exists only on this device (the browser’s own account sync is unaffected).',
  'home.editor.save': 'Save',
  'home.editor.rename': 'Rename',
  'home.editor.typeLabel': 'What to create',
  'home.editor.folderLabel': 'Save to folder',
  'home.editor.folderHint': 'Defaults to the current folder; you can also drag it elsewhere afterwards.',

  'sync.title': 'Sync',
  'sync.phase.ready': 'Ready',
  'sync.phase.unconfigured': 'Not configured',
  'sync.phase.conflict': 'Conflicts to resolve',
  'sync.phase.auth': 'Credentials problem',
  'sync.phase.error': 'Last sync failed',
  'sync.server.title': 'WebDAV server',
  'sync.server.hint': 'Works without it; once enabled it writes to your bookmarks.',
  'sync.server.baseUrl': 'Server address',
  'sync.server.username': 'Username',
  'sync.server.password': 'App password',
  'sync.server.password.placeholder': 'Prefer an app password (such as Nutstore\u2019s) over your login password',
  'sync.server.remotePath': 'Remote subfolder (optional)',
  'sync.server.remotePath.placeholder': 'Leave empty to use the default subfolder ({path})',
  // A different subfolder is a different sync location: the space is re-created there under
  // the same space id, and files at the old location stay where they are.
  'sync.server.remotePath.detail': 'A different subfolder is a different sync location — existing files are not moved for you.',
  // The part of the server card you configure once and never touch again .
  'sync.server.more': 'More settings',
  'sync.server.space':
    'Sync space: <code>{id}</code> — every device pointed at the same remote folder should show this same string. ' +
    'If two devices show different strings, they are connected to different spaces.',
  'sync.scope.title': 'Sync scope',
  'sync.scope.detail':
    'Only bookmarks under the checked roots are synced. Loose root-level bookmarks (shown as "Unfiled" in ShiStart) are excluded.',
  // ---- Summary lines of the collapsed cards  ----
  'sync.scope.summary': 'Syncing: {names}',
  'sync.auto.summary.on': 'On · {interval}',
  'sync.auto.summary.off': 'Off · syncs only when you click "Sync now"',
  'sync.connection.title': 'Connection',
  'sync.connection.test': 'Test connection',
  'sync.connection.testing': 'Testing…',
  'sync.connection.setup': 'Connect and sync',
  'sync.connection.settingUp': 'Connecting…',
  'sync.connection.sync': 'Sync now',
  'sync.connection.syncing': 'Syncing…',
  'sync.connection.hint': 'One step: test, create the space, first sync.',
  'sync.connection.detail': '"Connect and sync" does three things in one go: test connectivity → create the sync space → run the first sync. If another browser has already created a sync space at this address, this device will simply <strong>join</strong> it and share one dataset.<br />The connection test only writes a temporary file and deletes it. The password stays in this extension\u2019s local storage and is never written into an uploaded file; extension storage is not a system keychain, so do not configure sync on a device you do not trust.',
  'sync.auto.title': 'Automatic sync',
  'sync.auto.toggle': 'Sync automatically after bookmark changes and on a schedule',
  'sync.auto.detail':
    'Turned off, sync only runs when you click "Sync now" here. One switch covers two things: ' +
    'syncing about 30 seconds after a local bookmark changes, and the timed sync at the interval below, ' +
    'which picks up changes pushed by other devices.',
  'sync.auto.interval': 'Interval',
  'sync.auto.interval.15': 'Every 15 minutes',
  'sync.auto.interval.30': 'Every 30 minutes',
  'sync.auto.interval.60': 'Every 1 hour',
  'sync.auto.interval.180': 'Every 3 hours',
  // ---- Interface preference sync  ----
  'sync.pref.title': 'Interface preferences',
  'sync.pref.toggle': 'Sync my interface preferences to other browsers too',
  'sync.pref.detail':
    'When on, the preferences listed below travel with your bookmarks to the WebDAV server ' +
    'you entered, and take effect in every browser running ShiStart. Turn it off and this ' +
    'machine stops sending or receiving preferences. The server address and password stay ' +
    'on this machine — they were never uploaded in the first place.',
  'sync.pref.fields.label': 'These 12 items are uploaded',
  'sync.pref.fields':
    'Palette / Light-dark / Background pattern / Language / Search engine / Cards per row / ' +
    'Sidebar width / Sidebar collapsed / Last folder / Drag to arrange / Add and rename / ' +
    'Recent visits panel',
  // The writer token is a data-layer concept (there is no device roster), so this only
  // says "this machine" or "another install" — what the user actually asks is "was it me
  // or the other one", not a UUID.
  'sync.pref.last.local': 'Preferences were last updated from this machine ({time})',
  'sync.pref.last.remote': 'Preferences were last updated from another install ({time})',
  'sync.pref.last.none': 'Preferences have not been synced yet',
  'sync.pref.off': 'Off: preferences stay on this machine',
  'sync.pref.error': 'Preferences did not sync on the last run: {error}',
  // Collapsed state: not saying what it uploads is the same as doing it quietly .
  'sync.pref.summary.on': 'On · uploads these 12 items',
  'sync.pref.summary.off': 'Off · stays on this machine only',
  'sync.pref.who.local': 'from this machine',
  'sync.pref.who.remote': 'from another install',
  // After 既有约定 there is no longer an "auto-resolve conflicts" switch: every field
  // except deletion is resolved field-by-field with last-writer-wins, logged for undo
  // (see "Overridden by sync" below).
  'sync.status.title': 'Sync',
  'sync.status.lastSuccess': 'Last success',
  'sync.status.gates': 'Deletions to decide',
  'sync.status.conflictsValue': '{n} conflicts',
  'sync.gates.title': 'Deletions awaiting your decision',
  'sync.gates.hint': 'You decide when both sides changed; deletes are never auto-resolved.',
  'sync.gates.empty': 'No deletions awaiting a decision.',
  'sync.gates.keep': 'Keep (edit wins)',
  'sync.gates.delete': 'Confirm delete',
  'sync.gates.editInfo': 'Concurrent edit: {field} → {value}',
  'sync.gates.field.title': 'title',
  'sync.gates.field.url': 'URL',
  'sync.gates.field.parentSyncId': 'folder',
  'sync.gates.field.position': 'order',
  'sync.gates.field.logicalRootId': 'root',
  'sync.overrides.title': 'Overridden by sync',
  'sync.overrides.hint': 'Overwritten fields are listed here; undo with one click.',
  'sync.overrides.empty': 'No overridden changes.',
  'sync.overrides.undo': 'Undo (restore my value)',
  'sync.overrides.field.title': 'title',
  'sync.overrides.field.url': 'URL',
  'sync.overrides.field.parentSyncId': 'folder',
  'sync.overrides.field.position': 'order',
  'sync.overrides.field.logicalRootId': 'root',
  'sync.events.title': 'Sync log',
  'sync.events.empty': 'No sync log entries yet.',
  'sync.events.note': 'Last 100 sync results on this device; never uploaded.',
  // ---- Snapshots (既有约定 revision / 既有约定: the UI name for restore points; the data layer still calls them restore points) ----
  'snapshot.title': 'Snapshots',
  'snapshot.lead': 'Every successful sync saves a full snapshot you can roll back to.',
  'snapshot.status.title': 'Safety net status',
  'snapshot.status.lastWrite': 'Last written',
  'snapshot.status.count': 'Snapshots in the cloud',
  'snapshot.status.countValue': '{n} copies',
  // Status pill: the most important cell on the page — colour, not a sentence.
  'snapshot.status.pill.healthy': 'Active',
  'snapshot.status.pill.broken': 'Write failed',
  'snapshot.status.pill.error': 'Read failed',
  'snapshot.status.pill.unconfigured': 'Not set up',
  'snapshot.status.pill.never': 'Waiting for first sync',
  'snapshot.status.pill.loading': 'Reading…',
  // Still reused by the one insurance line inside the Sync section.
  'snapshot.status.unconfigured': 'Sync is not set up yet.',
  'snapshot.retention':
    'Retention: the whole sync space keeps at most the latest 20 snapshots, and anything from the last 30 days is always kept. Older extras are tidied up daily in the background by whichever device runs it — tidying always serves the whole space (turning auto sync off turns this off too). This is the only way data that "once existed" on the cloud converges — "erase permanently" never rewrites old archives, so those copies are retired only by this policy.',
  'snapshot.list.title': 'All snapshots',
  'snapshot.total': '{n} in total',
  'snapshot.current': 'Current',
  'snapshot.rollback': 'Roll back to this snapshot',
  'snapshot.rollingBack': 'Working…',
  'snapshot.confirmRollback': 'Confirm rollback',
  'snapshot.empty.title': 'No snapshots yet',
  'snapshot.empty.unconfigured': 'Sync is not set up',
  'snapshot.empty.text': 'After one successful sync, the first snapshot appears automatically.',
  'snapshot.empty.textUnconfigured': 'Set up sync and complete one successful sync, and the first snapshot will appear.',
  'snapshot.empty.action': 'Set up sync',
  'snapshot.trashHint': 'Only looking for one or two bookmarks? Use the Trash at the bottom of the sidebar on the start page.',
  'snapshot.fold': 'About snapshots and retention',
  'snapshot.detail':
    'Snapshots live on your own WebDAV and <strong>share one history across the whole space</strong>, one copy per distinct state. ' +
    '"Roll back to this snapshot" is <strong>forward-only</strong>: it turns the difference into an ordinary batch of changes and pushes them ' +
    '(it does not rewrite cloud history or rewind sync progress), so other browsers merge it like any normal edit and report conflicts as usual. ' +
    'Before touching anything it <strong>saves the current state as a new snapshot</strong>, so being unable to come back cannot happen. ' +
    '"Reset sync" does not delete them — that is exactly when you need a rollback most.<br />' +
    '<strong>Deletion is shared as well</strong>: a snapshot you delete here disappears for every device — ' +
    'before deleting, ask yourself whether another device relies on it as its only safety net.',
  // Inline rollback preview: counts live in the chips, samples list names only
  // (the number is not repeated a second time).
  'snapshot.preview.title': 'After rolling back to this one',
  'snapshot.preview.note': 'Anything deleted since then comes back with it.',
  'snapshot.preview.created': 'Restored',
  'snapshot.preview.updated': 'Retitled or moved',
  'snapshot.preview.deleted': 'Removed',
  'snapshot.preview.samples': 'Example items (up to 5 per kind)',
  'snapshot.notice.pointDeleted': 'This snapshot has been deleted from the cloud.',
  'snapshot.notice.rollbackNoop': 'This snapshot is identical to the current one — nothing to roll back.',
  'snapshot.notice.rollbackDone':
    'Rolled back: {summary}, {applied} steps applied on this device{conflictNote}. ' +
    'The state from before the rollback has been saved as a new snapshot, so you can always come back.',

  // ---- The one insurance line inside the Sync section (既有约定: management moved to the Snapshots section; only status stays here) ----
  'sync.insurance.label': 'Snapshots',
  'sync.insurance.healthy': 'Safety net active',
  'sync.insurance.broken': 'Safety net write failed: {error}',
  'sync.insurance.open': 'Open snapshots',
  'sync.danger.title': 'Dangerous operations',
  'sync.danger.disconnect': 'Disconnect sync',
  'sync.danger.purge': 'Clear local sync state',
  'sync.danger.purgeConfirm': 'Click again to confirm clearing',
  'sync.danger.reset': 'Reset sync (remote included)',
  'sync.danger.resetting': 'Resetting…',
  'sync.danger.resetConfirm': 'Click again to confirm reset',
  'sync.danger.hint': 'Disconnecting removes only config and password, not bookmarks.',
  'sync.danger.detail': 'Disconnecting removes only the configuration and password; your browser bookmarks are unaffected. Clearing local sync state deletes the ID mapping and log stored on this device, so a future connection has to compare everything again; it likewise never deletes or modifies browser bookmarks.',
  'sync.danger.resetHint':
    '<strong>Resetting sync</strong> additionally wipes the entire sync history in the cloud and starts this device over. ' +
    'It cannot be undone, and is normally used only when sync hits an error it cannot self-heal (duplicate bookmarks being generated repeatedly, for example). ' +
    '<strong>It does not delete browser bookmarks, nor the cloud sync space itself</strong> — ' +
    'so another device does not need reconfiguring. After resetting, clean up duplicates by hand in each device\u2019s bookmark manager before syncing again. ' +
    'Reset every device: resetting just one will pull it straight back into the duplicate state.',
  'sync.notice.permissionAborted': 'Permission to reach this server was not granted, so the connection test was cancelled.',
  'sync.notice.permission': 'Permission to reach this server was not granted.',
  'sync.notice.conditionalWrite': '{message} (this server supports conditional writes)',
  'sync.notice.noConditionalWrite':
    '{message} (this server does not support conditional writes, so path uniqueness will be used to keep files from being overwritten)',
  'sync.notice.joined': 'Joined the sync space that already exists at this address',
  'sync.notice.created': 'Sync space created',
  'sync.notice.probeNote':
    '; this server does not support conditional writes, so path uniqueness is used to prevent overwrites',
  'sync.notice.firstSync':
    '{head}.{probeNote}. First sync: {pushed} uploaded, {pulled} downloaded, {applied} steps applied. Automatic sync is now on.',
  'sync.notice.syncDone': 'Sync complete: {pushed} uploaded, {pulled} downloaded, {applied} steps applied.',
  'sync.notice.disconnected':
    'Disconnected from sync. The local sync state is kept, so reconnecting later can pick up where it left off.',
  'sync.notice.purged': 'Local sync state cleared. Your browser bookmarks themselves were not modified.',
  'sync.notice.noCredential': 'WebDAV credentials are missing. Re-enter the password before resetting.',
  'sync.notice.resetDone':
    'Reset complete: removed {states} device state file(s) and {history} restore point(s) from the cloud. ' +
    'Browser bookmarks were not modified. Clean up duplicate bookmarks by hand, then re-enter your details and connect again.',
  'sync.notice.overrideUndone': 'Your value has been submitted as a change; the next sync carries it to other devices.',

  'label.trigger.manual': 'Manual',
  'label.trigger.interval': 'Scheduled',
  'label.trigger.debounced': 'Bookmark change',
  'label.trigger.setup': 'First connection',
  'label.trigger.trashExpiry': 'Trash expiry',
  'label.event.push': 'Uploaded',
  'label.event.pull': 'Received',
  'label.event.skip': 'Skipped',
  'label.event.error': 'Failed',
  'label.event.failFallback': 'Sync failed',
  'label.event.skipFallback': 'Nothing to sync this round',
  'label.summary.pushed': '{n} uploaded',
  'label.summary.pulled': '{n} received',
  'label.summary.applied': '{n} steps applied',
  'label.summary.none': 'No changes',
  'label.summary.conflicts': '{n} conflicts need attention',
  'label.rollback.created': 'bring back {n}',
  'label.rollback.deleted': 'delete {n}',
  'label.rollback.updated': 'change title or URL of {n}',
  'label.rollback.none': 'no differences at all',

  'sync.root.bar': 'Bookmarks bar',
  'sync.root.other': 'Other bookmarks',
  'sync.root.mobile': 'Mobile bookmarks',

  'trash.title': 'Trash',
  'trash.titleCount': 'Trash ({n} items)',
  'trash.pendingTitle': 'Waiting for sync ({n})',
  'trash.tombsTitle': 'In the trash ({n})',
  'trash.pendingChip': 'pending',
  'trash.pendingNote':
    'These were <strong>deleted on this device and sync has not picked them up yet</strong>. They are already gone from your browser, but the deletion has not left this device either, so <strong>Restore puts them straight back where they were</strong> (no sync, no network requests). Left alone, they become regular trash entries below once a sync round finishes.',
  // Grouped by "one deletion" (既有约定 decision 7); the group root's "N more" chip
  // is the expand toggle .
  'trash.groupExpand': '{n} more',
  'trash.groupCollapse': 'Collapse',
  'trash.timeUnknown': 'time unknown',
  'trash.deviceUnknown': 'an unknown device',
  'trash.deviceLocal': 'this device',
  'trash.deviceOther': 'another device',
  'trash.kindFolder': 'Folder',
  'trash.kindBookmark': 'Bookmark',
  'trash.empty':
    'No deleted items yet. Once sync is on, anything deleted on any device is kept as a tombstone first, and you can restore it here.',
  'trash.deletedBy': 'Deleted by {device}',
  'trash.location': 'Was in: {parent}',
  'trash.restore': 'Restore',
  'trash.restoreConfirm': 'Confirm restore',
  'trash.purge': 'Delete permanently',
  'trash.purgeConfirm': 'Confirm permanent delete',
  'trash.busy': 'Working…',
  'trash.purgeAll': 'Clear all',
  'trash.purgeAllConfirm': 'Confirm clearing {n}',
  'trash.purgeAllNote':
    'This erases <strong>{n}</strong> nodes{orphanPart}. The tombstones go too — they become <strong>unrecoverable on every device</strong>, and later restore points will no longer carry them. Click again to confirm.',
  'trash.purgeAllNote.orphan':
    ' ({records} entries; {n} live children will be re-parented to the root)',
  'trash.restoreNote':
    'This will restore <strong>{n}</strong> nodes{extraPart}. Click once more to actually change your bookmarks.',
  'trash.restoreNote.extra':
    ', {extra} of which are parent folders it needs or items inside it{descPart}',
  'trash.restoreNote.desc': ' ({n} descendants)',
  'trash.pendingRestoreNote':
    'This puts it back <strong>where it was</strong>; no request is sent{extraPart}. Click again to confirm.',
  'trash.pendingRestoreNote.extra':
    ', and the {n} item(s) deleted along with it come back too',
  'trash.purgeNote':
    'This erases <strong>{n}</strong> nodes{extraPart}{orphanPart}. Every device erases them on its next sync, and restore points taken later will no longer carry them. <strong>Older restore points still contain it</strong> — rolling back to that moment will bring it back. Click again to confirm.',
  'trash.purgeNote.extra': ' ({n} tombstoned descendants)',
  'trash.purgeNote.orphan': '; {n} live children will be re-parented to the root',
  'trash.parentDeleted':
    'Its parent folder was deleted too and will come back with it — otherwise the recovered item would be an orphan with no home.',
  // 既有约定: the long bottom explainer moved into a <details>, split into three lines —
  // what is collapsed is reference material, not action information. One sentence per
  // operation (explicit user requirement): colon / comma / dash inside, no second period.
  'trash.noteTitle': 'How restore and permanent delete work',
  'trash.noteRestore':
    'Restore: puts it back <strong>where it was</strong>.',
  'trash.notePurge':
    'Permanent delete: the data is <strong>erased</strong> and <strong>synced to your other devices</strong>.',
  'trash.noteGrace':
    '<strong>Grace period: 30 days</strong> — tombstones that have sat that long are erased automatically in the background, governed by the Auto sync switch.',
  'trash.conflict.restore':
    ', plus {n} conflicts for you to resolve (another device edited it in the meantime)',
  'trash.conflict.purge':
    ', plus {n} conflicts for you to resolve (concurrent edits blocked some of them)',
  'trash.notice.restoreNoop':
    'Nothing left to restore — another device may have already brought it back.',
  'trash.notice.restoreDone':
    'Restored {n} item(s){conflictNote}. It is just an ordinary edit, so other devices merge it as usual and report any conflict.',
  'trash.notice.pendingRestoreDone':
    'Restored {n} item(s) to their original places. This deletion never left this device, so your other devices will see no change at all.',
  'trash.notice.purgeNoop': 'This one is no longer in the sync state; there is nothing to erase.',
  'trash.notice.purgeDone':
    'Erased {n} node(s){conflictNote}. Other devices will erase them on their next sync too.',
  'trash.notice.purgeAllDone': 'Erased {n} node(s){conflictNote}.',
  'trash.toSnapshots':
    'A whole folder gone? Open “Snapshots” in Settings to roll the entire tree back to a moment when it was still there.',

  'engine.bing': 'Bing',
  'engine.baidu': 'Baidu',
  'engine.google': 'Google',
};
