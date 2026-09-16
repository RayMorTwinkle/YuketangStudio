// src/ui/panels/shell.js
// 主面板壳：把原先各自独立的功能面板统一迁入 tab 化布局
// 面板 DOM 迁移（appendChild 移动）保留其内部事件与逻辑，只重置外观样式
import tpl from './shell.html';
import { log } from '../../core/log.js';
import * as ChatPanel from './chat.js';
import * as AIPanel from './ai.js';
import * as PresPanel from './presentation.js';
import * as SettingsPanel from './settings.js';
import * as TutorialPanel from './tutorial.js';

let mounted = false;
let root;
let activeTab = 'chat';

const TABS = [
  { id: 'chat',      icon: 'fa-comments',       label: 'PPT对话',  panelId: 'ykt-chat-panel',          mount: () => ChatPanel.mountChatPanel() },
  { id: 'ai',        icon: 'fa-robot',          label: 'AI解答',   panelId: 'ykt-ai-answer-panel',     mount: () => AIPanel.mountAIPanel() },
  { id: 'pres',      icon: 'fa-file-powerpoint',label: '课件',     panelId: 'ykt-presentation-panel',  mount: () => PresPanel.mountPresentationPanel() },
  { id: 'settings',  icon: 'fa-gear',           label: '设置',     panelId: 'ykt-settings-panel',      mount: () => SettingsPanel.mountSettingsPanel() },
  { id: 'tutorial',  icon: 'fa-question-circle',label: '教程',     panelId: 'ykt-tutorial-panel',      mount: () => TutorialPanel.mountTutorialPanel() },
];

export function mountShell() {
  if (mounted) return root;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = tpl;
  document.body.appendChild(wrapper.firstElementChild);
  root = document.getElementById('ykt-shell-panel');

  // 挂载并迁移各功能面板
  const content = root.querySelector('#ykt-shell-content');
  const tabsEl = root.querySelector('#ykt-shell-tabs');
  for (const t of TABS) {
    try { t.mount(); } catch (e) { log.warn('[Shell] mount fail', t.id, e); }
    const panel = document.getElementById(t.panelId);
    if (panel) content.appendChild(panel); // DOM 移动，事件保留
    const tab = document.createElement('div');
    tab.className = 'ykt-shell-tab';
    tab.dataset.tab = t.id;
    tab.innerHTML = `<i class="fas ${t.icon}"></i><span>${t.label}</span>`;
    tab.addEventListener('click', () => switchTo(t.id));
    tabsEl.appendChild(tab);
  }

  root.querySelector('#ykt-shell-close').addEventListener('click', () => showShell(false));
  mounted = true;
  return root;
}

/** 打开/关闭主面板 */
export function showShell(visible = true, tabId = null) {
  if (!mounted) mountShell();
  root.classList.toggle('visible', visible);
  if (visible) switchTo(tabId || activeTab);
}

export function toggleShell() {
  if (!mounted) mountShell();
  showShell(!root.classList.contains('visible'));
}

/** 切换 tab：面板互斥显示（active 面板补 visible class 以激活自身布局，其余移除） */
export function switchTo(tabId) {
  if (!mounted) mountShell();
  const t = TABS.find(x => x.id === tabId) || TABS[0];
  activeTab = t.id;
  for (const tab of root.querySelectorAll('.ykt-shell-tab')) {
    tab.classList.toggle('active', tab.dataset.tab === t.id);
  }
  const content = root.querySelector('#ykt-shell-content');
  for (const panel of content.querySelectorAll(':scope > .ykt-panel')) {
    const isActive = panel.id === t.panelId;
    panel.classList.toggle('active-tab', isActive);
    panel.classList.toggle('visible', isActive);
  }
  // 面板被激活时允许它从 config 重新同步（设置面板据此刷新表单）
  const activePanel = content.querySelector(`:scope > #${t.panelId}`);
  activePanel?.__yksSyncForm?.();
}

/** ui-api 统一入口：visible=true 打开主面板并切到 tab；false 关闭主面板 */
export function openTab(tabId, visible = true) {
  if (!mounted) mountShell();
  if (visible) showShell(true, tabId);
  else showShell(false);
}

/** 仅在目标 tab 已是当前 tab 时切换开/关，否则打开并切过去 */
export function toggleTab(tabId) {
  if (!mounted) mountShell();
  const isOpen = root.classList.contains('visible');
  if (isOpen && activeTab === tabId) showShell(false);
  else showShell(true, tabId);
}
