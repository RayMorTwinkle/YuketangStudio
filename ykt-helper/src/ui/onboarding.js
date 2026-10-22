// src/ui/onboarding.js
// 首次使用引导：只讲 3 个入口（工具栏位置 / 历史课件下载 / PPT 问答），
// 其余功能让用户自行探索。可跳过，跳过后不再出现（按版本号记录）。
import { storage } from '../core/storage.js';
import { expandToolbar } from './toolbar.js';

const KEY = 'onboarding.version';
const VERSION = 1;

export function maybeShowOnboarding() {
  try {
    if ((Number(storage.get(KEY)) || 0) >= VERSION) return;
    if (document.getElementById('ykt-onboarding')) return;
    if (!document.getElementById('ykt-helper-toolbar')) {
      setTimeout(maybeShowOnboarding, 300);   // 工具栏还没挂上，稍后再试
      return;
    }
    show();
  } catch { /* 引导失败不影响主流程 */ }
}

function show() {
  const toolbar = document.getElementById('ykt-helper-toolbar');
  expandToolbar();   // 上次收起过也先展开，避免引导高亮到一条窄轨
  toolbar?.classList.add('ykt-ob-raised');

  const wrap = document.createElement('div');
  wrap.id = 'ykt-onboarding';
  wrap.className = 'ykt-onboarding';
  wrap.innerHTML = `
    <div class="ykt-ob-card">
      <div class="ykt-ob-title">👋 欢迎使用 YuketangStudio</div>
      <div class="ykt-ob-sub">第一次用？30 秒了解 3 个入口；如果你已经会用，完全可以跳过。</div>
      <ul class="ykt-ob-list">
        <li><b>工具栏</b>：左下角（手机端是左侧竖排按钮，点 ‹ 可收起成窄条）</li>
        <li><b>历史课件下载</b>：主面板 →「课件」</li>
        <li><b>PPT 问答</b>：主面板 →「对话」</li>
      </ul>
      <div class="ykt-ob-tip">其余功能（正在上课的 PPT 下载、AI 解答、题目补交等）可以自己探索。</div>
      <div class="ykt-ob-actions">
        <button id="ykt-ob-skip" type="button">跳过，不再显示</button>
        <button id="ykt-ob-ok" type="button">开始使用</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);

  const close = (openPanel) => {
    storage.set(KEY, VERSION);
    toolbar?.classList.remove('ykt-ob-raised');
    wrap.remove();
    if (openPanel) {
      try { document.getElementById('ykt-btn-shell')?.click(); } catch {}
    }
  };

  wrap.querySelector('#ykt-ob-skip')?.addEventListener('click', () => close(false));
  wrap.querySelector('#ykt-ob-ok')?.addEventListener('click', () => close(true));
}
