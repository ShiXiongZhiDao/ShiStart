import { defineConfig } from 'vitest/config';

// 覆盖纯函数层（书签树映射、搜索过滤、偏好归一化）与**不依赖 DOM 的 composable**。
// composable 里只有响应式状态与 `chrome.*` 调用，假一个 chrome 就能在 node 里跑 ——
// 主页那几个"跟着同步走"的事实（配没配同步、回收站角标）因此锁得住。
// 真正需要挂载的组件仍然不测，交给手工安装测试。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'services/**/*.test.ts', 'composables/**/*.test.ts'],
  },
});
