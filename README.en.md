<p align="center"><img src="public/icon/128.png" alt="ShiStart" width="88"></p>

<h1 align="center">ShiStart</h1>

<p align="center"><em>Every open, a new discovery.</em></p>

<p align="center"><strong>English</strong> · <a href="./README.md">简体中文</a></p>

<p align="center"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT licensed"> <img src="https://img.shields.io/badge/browsers-Chrome%20%C2%B7%20Edge-blue" alt="Chrome and Edge"> <img src="https://img.shields.io/badge/manifest-MV3-lightgrey" alt="Manifest V3"> <img src="https://img.shields.io/badge/data-local_only-yellowgreen" alt="Local only"> <img src="https://img.shields.io/badge/store-not_published-orange" alt="Not on any store yet"></p>

<p align="center"><img src="assets/screenshots/en/home.png" alt="The home page: folders laid out as groups and bookmark cards" width="920"></p>

---

## What it does

- **A new tab *is* your bookmarks.** Nothing to import, nothing to rebuild, no second copy: the page lays out the tree your browser already has, re-read on every open.
- **The left side is that tree, unchanged.** Expand it level by level, jump back out through the breadcrumb; the sidebar starts collapsed, slides out when the pointer touches the left edge, and can be dragged wider.
- **Folders with children open as groups.** One header per folder with its count, holding folder tiles or bookmark cards; a leaf folder is just a run of cards — one big folder fits on one screen.
- **Search covers the whole library.** A bookmark outside the current folder still turns up. `Ctrl / Cmd + K` or `/` focuses the box, `Esc` clears it, and an unmatched query goes straight to your search engine.
- **Tidy up right on the page.** New folder, rename, drag to reorder, drag to another folder, delete — all written back to the browser's own bookmarks, so there is no "which copy is right".
- **Deleted things come back.** They wait in the trash for 30 days and restore to where they were; restoring a folder brings its bookmarks with it.
- **Work in batches.** Select several bookmarks or folders and open, move or delete them at once — batch delete asks first.
- **Hover the right edge** and *Recently visited* slides out. It reads the browser's own history: read-only, no copy kept, nothing uploaded.
- **The context menu has the other ways to open.** New window, incognito window, Edge split view — or just copy the link.
- **The interface follows you.** Two palettes × light/dark, three background patterns, 4–12 cards per row, Chinese and English — all remembered as preferences.
- **Bring your own WebDAV for cross-device.** Nutstore, Nextcloud, a Synology box. Leave the address empty and it stays local, with no requests at all.

## What it is not

- **Not a replacement for the bookmark manager.** Duplicate hunting, dead-link checking, bulk import/export — that is filing work, and the built-in manager or a dedicated tool does it better. This one is about looking and using.
- **No "Import bookmarks".** There is exactly one copy of your bookmarks: the browser's tree. A second write path would only create a second source of truth.
- **No server of the author's.** No account, no telemetry. Sync means your own WebDAV.
- **Not a speed dial.** It does not invent icons and it does not touch your bookmarks; what you see is what you saved.
- **It does not read the sites you visit.** The only permission that touches user data is browsing history, and only to list *Recently visited*.

## Why I built this

The browser's bookmark manager is a place to **file** things: open a dedicated page, then
click down through the levels. The bookmarks bar is always there, but it is one row — once
you have a dozen folders, it is a line of identical little icons.

So saving a bookmark almost never leads to opening it again. You file it because it might be
useful later, and later never comes.

That is why this lives on the **new tab page**. It is the one place the browser puts in front
of you dozens of times a day without being asked: open a tab, see your bookmarks, click one.

The cost is honest: it takes over your new tab page. On first load Chrome or Edge asks
whether to keep the change — you must click **Keep changes**, or new tabs keep using the
browser's default page.

## Why there is only one copy

Most bookmark extensions build a library of their own: you import once, and from then on they
own that copy. Every later action has to answer "which one wins".

This goes the other way: **the browser's native bookmark tree is the only source**, and the
page only displays it and edits it in place. The trade-offs are explicit:

- no copy to fall out of step — editing on the page *is* editing the browser's bookmarks;
- but **no bookmark import**, and no storing bookmarks elsewhere — that would be a second write path;
- deletes do not vanish: they land in the trash for 30 days, and restoring writes back into the native tree, not into a copy.

When you want the same tree on a second machine, that is what sync copies — the tree plus UI
preferences — over a server you provide.

## Compared with the three usual options

| | Built-in manager | Bookmarks bar | ShiStart |
| --- | --- | --- | --- |
| When you see it | Open a dedicated page | Always there, but one row | Every new tab |
| Hierarchy | A tree, click down | One level only | Tree + grouped layout + breadcrumb |
| Search | Whole library | None | Whole library; in the trash, the current screen |
| Deletes | No trash | No trash | Restorable for 30 days |
| Where the data lives | In the browser | In the browser | In the browser; optional sync to your own WebDAV |
| Account required | No | No | No |

## Screenshots

### The home page

With the folder tree collapsed you get this: a folder with children becomes a **group** with
a header, a leaf folder a plain run of cards — one big folder fits on one screen. The search
box at the top matches the **whole library** — a bookmark outside the current folder still
turns up.

<p align="center"><img src="assets/screenshots/en/home.png" alt="The home page: groups and bookmark cards" width="880"></p>

### Light and dark

Same layout, two palettes. The palette button in the top-right corner switches theme and
background pattern; card columns follow the window width, so a wider window simply holds
more.

| Light | Dark |
|---|---|
| <img src="assets/screenshots/en/home.png" alt="Light theme, folder tree collapsed" width="420"> | <img src="assets/screenshots/en/dark.png" alt="Dark theme with the folder tree pinned open" width="420"> |

### The trash

Deleted bookmarks land here first and wait **30 days** — each entry says which folder it
came from and when it was deleted, and *Restore* puts it back where it was: back into the
browser's native tree, not into a copy of it.

<p align="center"><img src="assets/screenshots/en/trash.png" alt="The trash: every entry names its source folder and deletion time" width="880"></p>

### Snapshots

With sync on, every successful sync leaves a **full snapshot** in the cloud: time, size,
and a *Roll back to this snapshot* button. Sync and snapshots are two different jobs —
sync keeps "now" consistent, snapshots take you back to "then".

Retention: anything from the last 30 days is kept, and older ones are kept up to the most
recent 20. Unchanged content is not stored twice (one copy serves the whole sync space,
distinct content gets one each). Rolling back is **forward-only**: the current state is
saved as a new snapshot first.

<p align="center"><img src="assets/screenshots/en/snapshots.png" alt="Snapshots: one full snapshot per successful sync, rollable back as a whole" width="700"></p>

### Sync

Point it at the WebDAV folder you already own (Nutstore, Nextcloud, a Synology box) with
your username and an app password. Three sections fold up underneath: sync scope, automatic
sync, and interface preferences — exactly what would be uploaded, and how often, is written
there; turn it off whenever you like. Leave the address empty and everything stays local.

<p align="center"><img src="assets/screenshots/en/sync.png" alt="Sync: WebDAV address, username and app password" width="700"></p>

## Permissions: five, and only five

| Permission | Why it is needed |
| --- | --- |
| `bookmarks` | Read the bookmark tree for display, folder filtering and local search; edits made on the page (create/rename/drag/delete) are written back through the same permission |
| `favicon` | Show site icons through the browser's own mechanism; falls back to a letter when unavailable |
| `storage` | Store UI preferences (palette, light/dark, background pattern, language, search engine, cards per row, sidebar width, …) |
| `alarms` | Polling for optional sync (every 30 minutes by default) |
| `history` | **Read-only** browsing history, solely for the right-edge "Recently visited" panel: read live, no copy kept, nothing uploaded |

It does **not** request `tabs`, `cookies`, `webRequest`, `<all_urls>`, or any host
permission. No external CDN, no remote fonts, no analytics SDK.

`history` is the only permission that touches user data, so the browser will warn
"read your browsing history" at install time. It is used **only** to list pages you
recently opened; it touches no website's data. You will still see "can't read or
change site data" in the extension menu — that is the expected state.

The WebDAV address is **one you type yourself**; the extension requests permission
for that origin at runtime, and asks for nothing if you never fill it in.

## How to install

The store release is still in preparation. Until then:

1. Download `shistart-<version>-chrome.zip` from this repository's Releases and unzip it
   into a directory **you intend to keep** — the extension reads that directory
   permanently, and deleting it breaks the install.
2. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome) and enable
   **Developer mode**.
3. Click **Load unpacked** and select the unzipped directory.
4. When Chrome asks "Keep this change?" about the new tab, **click Keep changes** —
   otherwise new tabs keep using the browser's default page.

> Chrome will occasionally show "Please disable extensions running in developer mode".
> That is the browser's standing behaviour for any extension that is not on the store,
> not a fault of this one — it goes away once the store listing is live.

## FAQ

**What is the "ShiStart / Customize Chrome" bar at the bottom?**

Since Chrome 138, when an extension owns the new tab, Chrome injects a **footer of its
own** at the bottom of the page. It is browser UI, not part of our page: the extension
can neither remove it nor restyle it.

To hide it: **right-click** that footer → "Hide footer on new tab"; or go to
Customize Chrome → Footer → toggle it off. (Managed browsers may have this set by an
administrator.)

**New tabs didn't change after installing?**

You must have clicked **Keep changes** on the first-load prompt. Also check that no
other new-tab extension is fighting for the same slot.

**How do I turn sync on?**

Settings → Sync → fill in your WebDAV address and account. It is off by default;
leave it empty and everything stays local. That page lists exactly what would be
uploaded (bookmarks plus 12 UI preferences), and you can turn it off at any time.

**Can I turn off "Recently visited"?**

Yes — Settings → General. It reads your browser's own history and keeps no copy.

**Will snapshots pile up forever?**

No, they converge on their own: everything from the last 30 days stays, older ones are
kept up to the most recent 20 and the rest are cleaned up. Snapshots only exist with sync
on; without it the page is empty. Deleting one is **shared** — delete it here and the other
devices lose it too, so think twice before removing what might be the only safety net
elsewhere.

**Can I export my bookmarks and settings?**

Yes — Settings → Data exports bookmarks (HTML / JSON) and a settings backup.

## Build from source

```bash
pnpm install     # install dependencies (pnpm 11)
pnpm build       # build into .output/chrome-mv3
pnpm zip         # package a zip for store upload
```

Then follow step 2 of "How to install" above, loading `.output/chrome-mv3` as the
unpacked directory. `pnpm compile` runs the type check and `pnpm test` the pure-function
unit tests.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Privacy policy: [PRIVACY.md](./PRIVACY.md).

## ☕ Support the author

If ShiStart has saved you an afternoon, you can buy the author a coffee — thank you,
it keeps the project going.

| Alipay | WeChat Pay |
|---|---|
| <img src="assets/qr/alipay.png" width="150" alt="Alipay QR code"> | <img src="assets/qr/wechat-pay.png" width="150" alt="WeChat Pay QR code"> |

## License & notes

ShiStart is open source under the **MIT license** — see [LICENSE](./LICENSE).

## 📮 Contact

- Website: [shixiongzhidao.cn](https://shixiongzhidao.cn)
- GitHub & Gitee: [GitHub](https://github.com/ShiXiongZhiDao/ShiStart) ·
  [Gitee](https://gitee.com/ShiXiongZhiDao/ShiStart)
- WeChat channel: **师兄知道** (ShiXiongZhiDao) — the same one shown on the
  extension's About page

<img src="assets/qr/wechat-official.png" width="560" alt="WeChat channel QR code">
