import { createApp } from 'vue';
import App from './App.vue';
import './tokens.css';
// ⚠️ card-grid.css 必须在 style.css **之前**：style.css 里的窄屏媒体查询要能盖掉它
// 的 --card-min（同特异性时后写的赢）。
import './card-grid.css';
import './style.css';
import './bg-pattern.css';

createApp(App).mount('#app');
