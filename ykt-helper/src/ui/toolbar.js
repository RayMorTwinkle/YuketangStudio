// src/ui/toolbar.js
// 精简版工具栏：主面板开关 + 提醒/自动作答快捷开关（其余功能全部收进主面板 tab）
import { ui } from './ui-api.js';
import { log } from '../core/log.js';

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

function showSwitchToDesktopGuide() {
  if (document.getElementById('ykt-desktop-guide')) return;
  // 用户点过「直接前往桌面版」但又被弹回移动版 → 浏览器桌面模式不彻底（UA-CH 泄露）
  const retried = (() => { try { return sessionStorage.getItem('yktDesktopRetry') === '1'; } catch { return false; } })();
  const tip = document.createElement('div');
  tip.id = 'ykt-desktop-guide';
  tip.style.cssText = [
    'position:fixed', 'left:8px', 'right:8px', 'bottom:8px',
    'z-index:10000002', 'background:#fff8e1', 'color:#7a4f01',
    'border:1px solid #f0c36d', 'border-radius:8px', 'padding:10px 12px',
    'font-size:12px', 'line-height:1.5', 'box-shadow:0 4px 16px rgba(0,0,0,.12)',
  ].join(';');

  if (!retried) {
    tip.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">⚠️ 当前是雨课堂「移动版」，功能受限</div>
      <div>请点浏览器菜单（<b>···</b>）→ 勾选 <b>请求桌面网站</b> → 然后访问 <b>changjiang.yuketang.cn/v2/web/index</b> 登录使用。</div>
      <div style="margin-top:6px;display:flex;gap:8px">
        <button id="ykt-guide-goto" style="flex:1;padding:6px;border:none;border-radius:6px;background:#1d63df;color:#fff;font-size:12px">直接前往桌面版</button>
        <button id="ykt-guide-close" style="padding:6px 10px;border:1px solid #e2c98b;border-radius:6px;background:transparent;color:#7a4f01;font-size:12px">知道了</button>
      </div>`;
  } else {
    // 二次引导：此浏览器的桌面模式不彻底，推荐 Firefox
    tip.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">⚠️ 此浏览器的「桌面模式」不彻底，雨课堂仍识别为手机</div>
      <div>原因：Edge 安卓的桌面模式不会修改 <code>Sec-CH-UA-Mobile</code> 请求头，雨课堂服务端据此强制跳回移动版。<b>推荐改用 Firefox 安卓版</b>（它的桌面模式会连同请求头一起切换，已验证可行）：</div>
      <div style="margin:6px 0">1. 应用商店安装 <b>Firefox</b><br/>2. Firefox 内安装 <b>篡改猴</b> 扩展（addons.mozilla.org 搜 Tampermonkey）<br/>3. 安装本脚本 → 菜单勾选 <b>桌面版网站</b> → 访问雨课堂</div>
      <div style="margin-top:6px;display:flex;gap:8px">
        <button id="ykt-guide-firefox" style="flex:1;padding:6px;border:none;border-radius:6px;background:#ff7139;color:#fff;font-size:12px">获取 Firefox</button>
        <button id="ykt-guide-copy" style="padding:6px 10px;border:1px solid #e2c98b;border-radius:6px;background:transparent;color:#7a4f01;font-size:12px">复制桌面版网址</button>
        <button id="ykt-guide-close" style="padding:6px 10px;border:1px solid #e2c98b;border-radius:6px;background:transparent;color:#7a4f01;font-size:12px">关闭</button>
      </div>`;
  }
  document.body.appendChild(tip);
  tip.querySelector('#ykt-guide-goto')?.addEventListener('click', () => {
    try { sessionStorage.setItem('yktDesktopRetry', '1'); } catch {}
    window.location.href = '/v2/web/index';
  });
  tip.querySelector('#ykt-guide-firefox')?.addEventListener('click', () => {
    window.open('https://www.mozilla.org/firefox/android/', '_blank');
  });
  tip.querySelector('#ykt-guide-copy')?.addEventListener('click', (e) => {
    const btn = e.target;
    navigator.clipboard?.writeText('https://changjiang.yuketang.cn/v2/web/index')
      .then(() => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制桌面版网址'; }, 1500); })
      .catch(() => { ui.toast?.('复制失败，请手动输入 changjiang.yuketang.cn/v2/web/index'); });
  });
  tip.querySelector('#ykt-guide-close')?.addEventListener('click', () => tip.remove());
}

export function installToolbar() {
  const bar = document.createElement('div');
  bar.id = 'ykt-helper-toolbar';
  bar.innerHTML = `
    <span id="ykt-btn-shell" class="btn" title="YuketangStudio 主面板"><i class="fas fa-briefcase"></i></span>
    <span id="ykt-btn-bell" class="btn" title="习题提醒"><i class="fas fa-bell"></i></span>
    <span id="ykt-btn-auto-answer" class="btn" title="自动作答"><i class="fas fa-magic-wand-sparkles"></i></span>
  `;
  document.body.appendChild(bar);

  // 移动版页面：给出「切桌面版」引导（脚本虽已注入，但页面本身功能受限）
  if (isMobileVersionPage()) {
    log.warn('[toolbar] 检测到雨课堂移动版，已显示桌面版引导');
    showSwitchToDesktopGuide();
  }

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
