// src/ui/panels/about.js
// 关于页：版本信息 + 手动检查更新（对比 svc /latest 元数据）
import tpl from './about.html';
import { fetchLatest, getChannel, setChannel } from '../../core/update-check.js';
import { gm } from '../../core/env.js';
import { ui, copyText } from '../ui-api.js';
import { log } from '../../core/log.js';

let mounted = false;
let root;

export function mountAboutPanel() {
  if (mounted) return root;
  const host = document.createElement('div');
  // __BUILD_VERSION__ 由 rollup 从 package.json 替换（版本号单一来源）
  host.innerHTML = tpl.replace(
    'class="ykt-about-cur">…<',
    `class="ykt-about-cur">当前版本 v${__BUILD_VERSION__}<`
  );
  document.body.appendChild(host.firstElementChild);
  root = document.getElementById('ykt-about-panel');

  const $btn = root.querySelector('#ykt-about-check');
  const $status = root.querySelector('#ykt-about-status');
  const $actions = root.querySelector('#ykt-about-actions');
  const $dl = root.querySelector('#ykt-about-download');

  const isShell = !!(window.YktBridge && typeof window.YktBridge.openAboutAndUpdate === 'function');
  let checking = false;
  let lastResult = null;

  const setStatus = (text, kind = 'muted') => {
    $status.textContent = text;
    $status.dataset.kind = kind;
  };

  const runCheck = async () => {
    if (checking) return;
    checking = true;
    $btn.disabled = true;
    $actions.style.display = 'none';
    setStatus('正在检查…', 'muted');
    try {
      const d = await fetchLatest();
      if (!d.ok) {
        setStatus(`检查失败：${d.error || '未知错误'}`, 'error');
        return;
      }
      if (d.hasUpdate) {
        lastResult = d;
        setStatus(`发现新版本 v${d.latest}${d.notes ? ` · ${d.notes}` : ''}`, 'update');
        $actions.style.display = 'flex';
      } else {
        setStatus(`已是最新版本（服务器 v${d.latest}）`, 'ok');
      }
    } catch (e) {
      log.warn('[About] 检查更新异常', e);
      setStatus(`检查失败：${e?.message || e}`, 'error');
    } finally {
      checking = false;
      $btn.disabled = false;
    }
  };

  // 讨论群号 / 官网地址一键复制（WebView 里 clipboard 可能不可用，copyText 已做回退）
  root.querySelector('#ykt-about-qq-copy')?.addEventListener('click', async () => {
    const ok = await copyText('901466023');
    ui.toast?.(ok ? '已复制群号 901466023' : '复制失败，请手动输入 901466023', 2200);
  });
  root.querySelector('#ykt-about-site-copy')?.addEventListener('click', async () => {
    const ok = await copyText('https://app.raymor.top/yuketangstudio/');
    ui.toast?.(ok ? '已复制官网地址，发给朋友吧' : '复制失败，请手动输入官网地址', 2200);
  });

  // 更新渠道（稳定 / 测试）
  const $chLabel = root.querySelector('#ykt-about-channel-label');
  const $chBtn = root.querySelector('#ykt-about-channel-toggle');
  const refreshChannel = () => {
    const ch = getChannel();
    if ($chLabel) $chLabel.textContent = ch === 'beta' ? '测试版' : '稳定版';
    if ($chBtn) $chBtn.textContent = ch === 'beta' ? '切换到稳定版' : '切换到测试版';
  };
  $chBtn?.addEventListener('click', () => {
    setChannel(getChannel() === 'beta' ? 'stable' : 'beta');
    refreshChannel();
    ui.toast?.(getChannel() === 'beta' ? '已切换到测试渠道' : '已切换到稳定渠道', 2200);
    runCheck();
  });
  refreshChannel();

  if (isShell) {
    // 手机壳自带原生更新流程；脚本不再展示会误导的 Web 更新渠道。
    root.querySelector('#ykt-about-channel')?.style.setProperty('display', 'none');
    $btn.textContent = '打开手机端关于与更新';
    $btn.addEventListener('click', () => {
      try { window.YktBridge.openAboutAndUpdate(); }
      catch (e) { ui.toast?.('打开手机端关于失败：' + (e?.message || e), 2500); }
    });
    setStatus('手机端更新由 YuketangStudio App 负责；这里只展示注入脚本版本。', 'muted');
    $actions.style.display = 'none';
  } else {
    $btn.addEventListener('click', runCheck);
  }
  $dl.addEventListener('click', () => {
    // 直接导向当前渠道的脚本下载链接（测试渠道不会再跳到只有稳定版的官网）
    const url = lastResult?.userscript || 'https://app.raymor.top/yuketangstudio/';
    try { gm.uw.open(url, '_blank'); }
    catch { /* 打不开就静默：页面上已有 GitHub 链接 */ }
  });

  mounted = true;
  return root;
}

export function showAboutPanel(visible = true) {
  mountAboutPanel();
  root.classList.toggle('visible', !!visible);
}

export function toggleAboutPanel() {
  mountAboutPanel();
  showAboutPanel(!root.classList.contains('visible'));
}
