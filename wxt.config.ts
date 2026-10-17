import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // ⚠️ 这一键改成 true 会让流水线红，那是故意的（既有约定 决策三）。
  // WXT 在部分场景下默认把**真源码 + 既有约定 里 89 条内部决策记录**一起打进 sources 包。
  // 公开 Release 上挂的那份 zip 里若带着它，等于把 既有约定（源码不公开）反着做一遍，
  // 而且是**静默的** —— 流水线全绿，东西已经出去了，事后收不回来。
  // 这里显式关掉；CI 里还有一道「.output 里出现 sources 包就红」的闸门钉住它。
  zip: {
    zipSources: false,
  },
  manifest: {
    // ★ 这三处**不许写回中文**。
    //
    // 扩展有两层"中英"，Chrome 只认这一层：
    // - 商店里的名字、chrome://extensions 的卡片、工具栏悬停提示 —— 由 Chrome 自己渲染，
    //   它只读 `default_locale` + `_locales/<语言>/messages.json` + 这里的 `__MSG_xxx__`。
    //   应用内那套 `lib/i18n`（zh-CN.ts / en.ts）它一个字都读不到。
    // - 新标签页和设置页里的按钮与提示 —— 那一层归 `lib/i18n` 管，不进这两个文件。
    //
    // 硬约束：**写了 default_locale，Chrome 就强制要求 `_locales/<它>/messages.json` 存在**，
    // 缺了不是告警、是直接装不上 ⇒ 那两份文件和这一行必须一起进包，不能分两次发。
    // 目录名是**下划线** `zh_CN`（Chrome 的规范），跟应用内的 `zh-CN`（连字符）是两套命名，
    // 别互相"顺手统一"。
    //
    // 占位符拼错或 messages.json 里缺 key，Chrome **不报错**：实测把 zh_CN 的
    // `extensionName` 改错名后，中文 UI 下照样显示**英文名**（静默回落到这儿那份），
    // 构建全绿、安装成功、没有任何提示 —— 所以 `lib/manifest-i18n.test.ts` 钉住它（含负例）。
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    // 默认英文：英文浏览器的用户看到的不是一串中文。中文浏览器的用户走 zh_CN 那份。
    default_locale: 'en',
    // 同步需要新增两项：alarms（定时同步）、optional_host_permissions（用户填了服务器地址后
    // 按**最小来源**在运行时申请）。仍然不申请 tabs / cookies / webRequest / <all_urls>。
    // `history` 是 2026-10-16 加的**唯一**一个"读用户数据"的新权限：
    // 右缘「最近访问」面板读浏览器自己的浏览历史来显示，实时读、不另存副本、
    // 不上传、不做任何写操作（不 addUrl / deleteUrl / deleteAll）。安装时会多一条
    // 「读取您的浏览历史」警告 —— 这是明知代价换的功能，README 的权限段已如实改写。
    permissions: ['bookmarks', 'favicon', 'storage', 'alarms', 'history'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // **清单里不放 `key`**（2026-10-17 移除；既有约定 修订、既有约定 修订）。
    //
    // 这里曾经放着一个 SPKI 公钥来固定扩展 ID —— 未打包加载时 Chrome 用"目录绝对路径"
    // 派生 id，换目录 / 换机器 id 就变，IndexedDB 的 origin 跟着变，同步状态
    // （映射 / 基线 / 游标）读不到（既有约定 记的就是那次事故）。代价是
    // **Chrome 应用商店拒收带 `key` 的清单**（上传报"清单文件中不得包含『key』字段"），
    // 只能出两份包、上传时容易拿错。
    //
    // 现在选"不带 key"：`pnpm zip` 的产物可以直接传商店。随之而来的规矩是
    // **别移动加载目录**：id 会变，本地状态（设置 + 同步基线）读不到，需要重新配一次
    // WebDAV。云端不受影响 —— 重配后的第一次同步会采纳远端（墓碑也在里面），不会重复。
    // 详见 既有约定 的修订一节。
    chrome_url_overrides: {
      newtab: 'newtab.html',
    },
    // ⚠️ 设置页"开成整页标签页还是嵌进小窗"**不在这里配**。
    // WXT 见到 `entrypoints/options/` 会自己往 manifest 写
    // `options_ui: { page, open_in_tab: false }`，并且**覆盖掉本文件里的 options_ui**——
    // 试过，构建产物里仍是 false（静默不生效，所以这里不留一段看着管用的死配置）。
    // 真正的口子在入口 HTML：`<meta name="manifest.open_in_tab" content="true">`
    // （WXT 把 html 里的 meta 解析成入口 options，manifest.mjs 读的正是
    // `options.options.openInTab`）。改那条 meta，不是改这里。
    // 点击工具栏图标 = 打开书签主页（行为在 entrypoints/background.ts 里定义）。
    // 这里声明 default_title，让图标 hover 有说明；不需要任何权限。
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
  },
});
