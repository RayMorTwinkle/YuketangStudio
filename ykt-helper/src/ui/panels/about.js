// src/ui/panels/about.js
// 关于页：版本信息 + 手动检查更新（对比 svc /latest 元数据）
import tpl from './about.html';
import { fetchLatest } from '../../core/update-check.js';
import { gm } from '../../core/env.js';
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

  let checking = false;

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

  $btn.addEventListener('click', runCheck);
  $dl.addEventListener('click', () => {
    try { gm.uw.open('https://app.raymor.top/yuketangstudio/', '_blank'); }
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
