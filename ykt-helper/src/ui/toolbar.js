// src/ui/toolbar.js
// 精简版工具栏：主面板开关 + 提醒/自动作答快捷开关（其余功能全部收进主面板 tab）
import { ui } from './ui-api.js';

export function installToolbar() {
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

  // 主面板
  bar.querySelector('#ykt-btn-shell')?.addEventListener('click', () => {
    const btn = bar.querySelector('#ykt-btn-shell');
    const isActive = btn.classList.contains('active');
    ui.showShellPanel?.(!isActive);
    btn.classList.toggle('active', !isActive);
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
