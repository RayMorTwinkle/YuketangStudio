// src/ui/toolbar.js
// 精简版工具栏：主面板开关 + 提醒/自动作答快捷开关（其余功能全部收进主面板 tab）
import { ui } from './ui-api.js';

/**
 * 是否处于雨课堂移动版（功能受限，需引导用户切桌面版）。
 * 判据：路径为 /m/...，或服务端重定向时把 next 写成移动入口（/web/?next=/m/v2）
 */
export function isMobileVersionPage() {
  const path = window.location.pathname;
  if (/\/m\/v\d|\/m\/?($|\?)/.test(path)) return true;
  try {
    const next = new URLSearchParams(window.location.search).get('next') || '';
    if (/^\/m\//.test(next)) return true;
  } catch {}
  return false;
}

/** 移动端（窄屏或触屏）判定 */
export function isNarrowDevice() {
  try {
    if (window.matchMedia?.('(max-width: 560px)').matches) return true;
    if (navigator.maxTouchPoints > 0 && window.innerWidth <= 820) return true;
  } catch {}
  return false;
}

export function installToolbar() {
  if (document.getElementById('ykt-helper-toolbar')) return;   // 防重复挂载（二次调用不再加第二根）
  const bar = document.createElement('div');
  bar.id = 'ykt-helper-toolbar';
  bar.innerHTML = `
    <span id="ykt-btn-shell" class="btn" title="YuketangStudio 主面板"><i class="fas fa-briefcase"></i></span>
    <span id="ykt-btn-bell" class="btn" title="习题提醒"><i class="fas fa-bell"></i></span>
    <span id="ykt-btn-auto-answer" class="btn" title="自动作答"><i class="fas fa-magic-wand-sparkles"></i></span>
  `;
  document.body.appendChild(bar);

  // 初始激活态
  if (ui.config.notifyProblems) bar.querySelector('#ykt-btn-bell')?.classList.add('active');
  ui.updateAutoAnswerBtn();

  // 主面板——读 shell 真实可见性（按钮态由 showShell 统一同步，避免两处状态漂移）
  bar.querySelector('#ykt-btn-shell')?.addEventListener('click', () => {
    const shellVisible = !!document.getElementById('ykt-shell-panel')?.classList.contains('visible');
    ui.showShellPanel?.(!shellVisible);
  });

  // 习题提醒开关
  bar.querySelector('#ykt-btn-bell')?.addEventListener('click', () => {
    ui.config.notifyProblems = !ui.config.notifyProblems;
    ui.saveConfig();
    ui.toast(`习题提醒：${ui.config.notifyProblems ? '开' : '关'}`);
    bar.querySelector('#ykt-btn-bell')?.classList.toggle('active', ui.config.notifyProblems);
  });

  // 自动作答开关
  bar.querySelector('#ykt-btn-auto-answer')?.addEventListener('click', () => {
    ui.config.autoAnswer = !ui.config.autoAnswer;
    ui.saveConfig();
    ui.toast(`自动作答：${ui.config.autoAnswer ? '开' : '关'}`);
    ui.updateAutoAnswerBtn();
  });
}
