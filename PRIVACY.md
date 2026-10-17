# 隐私政策 / Privacy Policy

> 简体中文在下，English 在后。最后更新：2026-10-17（书签可编辑后的口径）

---

## 简体中文

### 一句话

**师兄起页不收集你的任何数据。** 没有账号、没有遥测、没有统计。

### 你的数据在哪

- **书签**：扩展读的是浏览器自己的书签树，每次打开新标签页实时读取、不另存副本。
  你在主页里整理书签（新建、改名、拖拽、删除）时，改动直接写回浏览器书签；
  删除先进扩展内的回收站，30 天内可恢复。除非你开启同步，书签数据不会离开这台机器。
- **界面偏好**：配色、明暗、背景图案、语言、搜索引擎、每行卡片数、侧边栏宽度等，
  存在浏览器自己的扩展存储里，只在本机。
- **最近访问**：右缘那个面板读的是浏览器自己的浏览历史，实时读取、不留副本、不上传。
  你可以在设置页「通用」里关掉它。

### 唯一的外部网络请求

设置页「关于」里有三张图（公众号与赞助二维码）。它们放在 GitHub 与 Gitee 上，
打开那一页时并发探测、用先连上的那个源。

**这是整个扩展唯一的外部请求**，而且只在用户打开「关于」时发生，其它页面一次都不发。
除此之外，扩展不加载外部 CDN、远程字体、统计 SDK，也不向任何服务器发送数据。

### 可选的同步

同步**默认关闭**。开启时由**你自己**填入 WebDAV 服务器地址与账号 —— 那台服务器是你
选择的第三方，它与你之间的数据处理受该服务商自己的政策约束，不在本政策范围内。

开启同步后，会在你的同步空间里创建 `ShiXiongZhiDao/ShiStart` 目录，其中存放：

- 你的书签（用于跨设备同步）
- 12 项界面偏好

地址与密码只留在这台机器的浏览器存储里。**关掉同步就直接回到纯本机模式。**

### 权限

安装时浏览器会列出五项权限，用途逐个写在仓库 README 的「权限」一节里。
其中只有 `history` 会在安装时弹浏览器警告（「读取您的浏览历史」）—— 它只为右缘那个
面板服务，不碰任何网站的数据。

### 不共享、不出售

没有账号，也就没有可关联的账户数据。我们不与任何第三方共享、交换或出售数据 ——
因为手里没有数据。

### 联系

通过仓库的 Issues 反馈。

---

## English

### In one line

**ShiStart collects nothing about you.** No account, no telemetry, no analytics.

### Where your data lives

- **Bookmarks**: the extension reads the browser's own bookmark tree, live, on every
  new tab; no copy is kept. When you organize bookmarks on the page — create, rename,
  drag, delete — those edits are written back to the browser's own bookmarks;
  deletions go to the in-extension trash first and can be restored within 30 days.
  Unless you turn sync on, bookmark data never leaves this machine.
- **UI preferences**: palette, light/dark, background pattern, language, search
  engine, cards per row, sidebar width and the rest are stored in the browser's
  extension storage, local to this machine.
- **Recently visited**: the right-edge panel reads the browser's own history, live,
  keeping no copy and uploading nothing. You can turn it off under Settings → General.

### The only outbound request

The About page shows three images (a WeChat channel QR and two sponsorship QRs).
They are hosted on GitHub and Gitee, and the page probes both concurrently, using
whichever responds first.

**That is the extension's only outbound request**, and it happens only while the About
page is open — no other page makes a single request. Beyond it, the extension loads no
external CDN, no remote fonts, no analytics SDK, and sends no data to any server.

### Optional sync

Sync is **off by default**. When you enable it, **you** supply the WebDAV server and
credentials — that server is a third party of your choosing, and its handling of your
data is governed by its own policy, not by this one.

With sync on, a `ShiXiongZhiDao/ShiStart` directory is created in your space holding:

- your bookmarks (for cross-device sync)
- 12 UI preferences

The address and password stay in this browser's local storage. **Turn sync off and
you are back to fully local operation.**

### Permissions

The browser lists five permissions at install time; what each one is for is spelled
out in the "Permissions" section of the repository README. Only `history` triggers
an install-time warning ("Read your browsing history"), and it exists solely for the
right-edge panel — it touches no website's data.

### No sharing, no selling

There is no account, so there are no account data to link. Nothing is shared,
exchanged or sold with any third party — there is nothing to share.

### Contact

Open an issue on the repository.
