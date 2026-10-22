// src/ui/toolbar.js
// 精简版工具栏：主面板开关 + 提醒/自动作答快捷开关（其余功能全部收进主面板 tab）
// 手机端可收起为左侧窄轨：点 ‹ 收起、点 › 展开；纯 Web，不依赖安卓外壳。
import { ui } from './ui-api.js';

const COLLAPSED_KEY = 'ykt.toolbar.collapsed';
const HINT_KEY = 'ykt.toolbar.collapseHintShown';

function readFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch {}
}

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

/** 收起时提示提醒/自动作答仍开着 */
function syncBadge() {
  const bar = document.getElementById('ykt-helper-toolbar');
  const badge = document.getElementById('ykt-toolbar-badge');
  if (!bar || !badge) return;
  const on = !!(ui.config.notifyProblems || ui.config.autoAnswer);
  bar.classList.toggle('has-active', on);
  const tips = [];
  if (ui.config.notifyProblems) tips.push('提醒开');
  if (ui.config.autoAnswer) tips.push('自动作答开');
  badge.title = tips.join(' / ');
}

/** 同步收起/展开按钮的图标、标题与 aria */
function syncToggle() {
  const bar = document.getElementById('ykt-helper-toolbar');
  const toggle = document.getElementById('ykt-btn-toolbar-toggle');
  if (!bar || !toggle) return;
  const collapsed = bar.classList.contains('collapsed');
  const icon = toggle.querySelector('i');
  if (icon) icon.className = `fas fa-chevron-${collapsed ? 'right' : 'left'}`;
  const active = [];
  if (ui.config.notifyProblems) active.push('提醒开');
  if (ui.config.autoAnswer) active.push('自动作答开');
  toggle.title = `${collapsed ? '展开工具栏' : '收起工具栏'}${active.length ? `（${active.join('，')}）` : ''}`;
  toggle.setAttribute('aria-label', collapsed ? '展开工具栏' : '收起工具栏');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  syncBadge();
}

/** 收起/展开（persist=false 用于初始化恢复，避免写回） */
export function setToolbarCollapsed(collapsed, { persist = true, silent = false } = {}) {
  const bar = document.getElementById('ykt-helper-toolbar');
  if (!bar) return;
  bar.classList.toggle('collapsed', !!collapsed);
  if (persist) writeFlag(COLLAPSED_KEY, !!collapsed);
  syncToggle();
  if (collapsed && !silent && !readFlag(HINT_KEY)) {
    writeFlag(HINT_KEY, true);
    ui.toast?.('工具栏已收起，点左侧箭头可展开', 2400);
  }
}

/** 引导等场景强制展开 */
export function expandToolbar() {
  setToolbarCollapsed(false, { silent: true });
}

function syncNarrow() {
  try { document.body.classList.toggle('ykt-narrow', isNarrowDevice()); } catch {}
}

export function installToolbar() {
  if (document.getElementById('ykt-helper-toolbar')) return;   // 防重复挂载（二次调用不再加第二根）
  const bar = document.createElement('div');
  bar.id = 'ykt-helper-toolbar';
  bar.innerHTML = `
    <span id="ykt-btn-shell" class="btn" title="YuketangStudio 主面板"><i class="fas fa-briefcase"></i></span>
    <span id="ykt-btn-bell" class="btn" title="习题提醒"><i class="fas fa-bell"></i></span>
    <span id="ykt-btn-auto-answer" class="btn" title="自动作答"><i class="fas fa-magic-wand-sparkles"></i></span>
    <span id="ykt-toolbar-badge" aria-hidden="true"></span>
    <span id="ykt-btn-toolbar-toggle" class="btn" role="button" tabindex="0" aria-label="收起工具栏" aria-expanded="true" title="收起工具栏"><i class="fas fa-chevron-left"></i></span>
  `;
  document.body.appendChild(bar);

  // 窄屏判定：启动 + 旋转/缩放时同步（宽屏自动展开，不依赖安卓外壳）
  syncNarrow();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncNarrow, 150);
  });
  window.addEventListener('orientationchange', syncNarrow);

  // 初始激活态
  if (ui.config.notifyProblems) bar.querySelector('#ykt-btn-bell')?.classList.add('active');
  ui.updateAutoAnswerBtn();

  // 恢复上次收起状态（不写回、不提示）
  if (readFlag(COLLAPSED_KEY)) setToolbarCollapsed(true, { persist: false, silent: true });
  else syncToggle();

  // 设置页/其他入口改配置后同步角标
  window.addEventListener('ykt:config:changed', () => syncToggle());

  // 收起/展开
  const toggle = bar.querySelector('#ykt-btn-toolbar-toggle');
  toggle?.addEventListener('click', () => {
    setToolbarCollapsed(!bar.classList.contains('collapsed'));
  });
  toggle?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle.click(); }
  });

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
    syncToggle();
  });

  // 自动作答开关
  bar.querySelector('#ykt-btn-auto-answer')?.addEventListener('click', () => {
    ui.config.autoAnswer = !ui.config.autoAnswer;
    ui.saveConfig();
    ui.toast(`自动作答：${ui.config.autoAnswer ? '开' : '关'}`);
    ui.updateAutoAnswerBtn();
    syncToggle();
  });
}
