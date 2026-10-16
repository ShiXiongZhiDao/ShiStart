import { createApp } from 'vue';
import OptionsApp from './OptionsApp.vue';
import '../newtab/tokens.css';
// 卡片网格列公式：设置页要放一把"量尺"（.grid-probe）来算出当前窗口
// 实际能排几列，所以它得跟主页用**同一条**公式 —— 照 bg-pattern.css 的先例两边都引。
import '../newtab/card-grid.css';
import './style.css';
import '../newtab/bg-pattern.css';

createApp(OptionsApp).mount('#app');
