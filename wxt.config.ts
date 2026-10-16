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
    name: '师兄起页 ShiStart - 轻量书签主页',
    description: '在新标签页中快速查看和搜索浏览器书签，可选通过 WebDAV 在多浏览器间同步。',
    // 同步需要新增两项：alarms（定时同步）、optional_host_permissions（用户填了服务器地址后
    // 按**最小来源**在运行时申请）。仍然不申请 tabs / cookies / webRequest / <all_urls>。
    // `history` 是 2026-10-16 加的**唯一**一个"读用户数据"的新权限：
    // 右缘「最近访问」面板读浏览器自己的浏览历史来显示，实时读、不另存副本、
    // 不上传、不做任何写操作（不 addUrl / deleteUrl / deleteAll）。安装时会多一条
    // 「读取您的浏览历史」警告 —— 这是明知代价换的功能，README 的权限段已如实改写。
    permissions: ['bookmarks', 'favicon', 'storage', 'alarms', 'history'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // 固定扩展 id。未打包加载时，Chrome/Edge 默认用"目录绝对路径"派生 id，
    // 一旦仓库换了路径（换目录、换机器、换 worktree）id 就会变，IndexedDB 的 origin
    // 随之改变 —— 同步状态（映射/基线/游标）会读不到，被当成"首次同步"处理。
    // 这个 key 是 SPKI 公钥的 base64（无换行），只影响 id，不是私钥，可公开。
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0ZDq+PzOtWCsOXeHL1uBAUHDHLDlkfY8TMKTCx7L9/LEORpp5bFm2UpbSQ02htqlswaeVbJEAHIFdQzwudK/kxBNrUimNamLiz8W5jt5QHFPtm78VsQmWQ7bdem4WZMiCwXJ+Kk/s04NqIl8avwcPmQhXEP1SIA7D6Z3dlAhbd1yCqzTg+zcbT5EMVYdzhsIf/AA69Ns5KCtZHUnaf2luDyXbu+B2zmp6h+tjCMsyHYhFAN1LpMuJWSiDN7E34uAR3/IjqF1Oksq4kEEO4aArIazmCLfIFFJi2YlM8+k1zVUfdPO2WavQjDX9qO6Ua4jEDt4UEqanOXvPk9t2CWsHQIDAQAB',
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
      default_title: '打开师兄起页书签主页',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
  },
});
