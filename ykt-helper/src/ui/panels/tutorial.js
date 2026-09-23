// src/ui/panels/tutorial.js
import tpl from './tutorial.html';

let mounted = false;
let root;

function $(sel) { return document.querySelector(sel); }

export function mountTutorialPanel() {
  if (mounted) return root;
  const host = document.createElement('div');
  // 注入构建版本号（__BUILD_VERSION__ 由 rollup 从 package.json 替换，单一来源）
  host.innerHTML = tpl.replace('class="ykt-tutorial-version">…<', `class="ykt-tutorial-version">${__BUILD_VERSION__}<`);
  document.body.appendChild(host.firstElementChild);
  root = document.getElementById('ykt-tutorial-panel');

  // 面板嵌在 shell 里——关闭=通知 shell 收起
  $('#ykt-tutorial-close')?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ykt:close-shell')));
  mounted = true;
  return root;
}

export function showTutorialPanel(visible = true) {
  mountTutorialPanel();
  root.classList.toggle('visible', !!visible);
}

export function toggleTutorialPanel() {
  mountTutorialPanel();
  const vis = root.classList.contains('visible');
  showTutorialPanel(!vis);
}
