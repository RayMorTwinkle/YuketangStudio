// src/ui/panels/shell.js
// 主面板壳：把原先各自独立的功能面板统一迁入 tab 化布局
// 面板 DOM 迁移（appendChild 移动）保留其内部事件与逻辑，只重置外观样式
import tpl from './shell.html';
import { log } from '../../core/log.js';
import * as ChatPanel from './chat.js';
import * as AIPanel from './ai.js';
import * as PresPanel from './presentation.js';
import * as SettingsPanel from './settings.js';
import * as AboutPanel from './about.js';
import * as ProblemListPanel from './problem-list.js';
import * as AssignmentsPanel from './assignments-panel.js';
import * as BrushPanel from './brush.js';

let mounted = false;
let root;
let activeTab = 'chat';

const TABS = [
  { id: 'chat',      icon: 'fa-comments',       label: 'PPT对话',  panelId: 'ykt-chat-panel',          mount: () => ChatPanel.mountChatPanel() },
  { id: 'ai',        icon: 'fa-robot',          label: 'AI解答',   panelId: 'ykt-ai-answer-panel',     mount: () => AIPanel.mountAIPanel() },
  { id: 'pres',      icon: 'fa-file-powerpoint',label: '课件',     panelId: 'ykt-presentation-panel',  mount: () => PresPanel.mountPresentationPanel() },
  { id: 'problems',  icon: 'fa-list-check',     label: '题目',     panelId: 'ykt-problem-list-panel',  mount: () => ProblemListPanel.mountProblemListPanel() },
  { id: 'assign',    icon: 'fa-file-lines',     label: '作业/考试', panelId: 'ykt-assign-tab',          mount: () => AssignmentsPanel.mountAssignmentsPanel() },
  { id: 'brush',     icon: 'fa-forward',       label: '刷课',     panelId: 'ykt-brush-panel',         mount: () => BrushPanel.mountBrushPanel() },
  { id: 'settings',  icon: 'fa-gear',           label: '设置',     panelId: 'ykt-settings-panel',      mount: () => SettingsPanel.mountSettingsPanel() },
  { id: 'about',     icon: 'fa-circle-info',    label: '关于',     panelId: 'ykt-about-panel',        mount: () => AboutPanel.mountAboutPanel() },
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
  // 子面板内部关闭按钮统一广播这个事件（面板不知道自己嵌在 shell 里）
  window.addEventListener('ykt:close-shell', () => showShell(false));
  mounted = true;
  return root;
}

/** 当前激活的面板元素（用于生命周期钩子） */
function currentPanel() {
  return root?.querySelector('#ykt-shell-content > .ykt-panel.active-tab') || null;
}

/** 打开/关闭主面板 */
export function showShell(visible = true, tabId = null) {
  if (!mounted) mountShell();
  root.classList.toggle('visible', visible);
  // 窄屏下悬浮工具栏会压住面板左下角（输入框/＋按钮），面板打开时隐藏它
  document.body.classList.toggle('ykt-shell-open', !!visible);
  // 工具栏按钮态跟着真实可见性走
  document.getElementById('ykt-btn-shell')?.classList.toggle('active', !!visible);
  if (visible) switchTo(tabId || activeTab);
  else currentPanel()?.__yksOnHide?.('shell-close');   // 收起时给激活面板一次清理机会（中止流式等）
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
    if (!isActive && panel.classList.contains('active-tab')) {
      panel.__yksOnHide?.('tab-switch');   // 切走之前激活的面板（仅通知切走，流式由面板决定是否中断）
    }
    panel.classList.toggle('active-tab', isActive);
    panel.classList.toggle('visible', isActive);
  }
  // 面板被激活时允许它从 config 重新同步（设置面板刷新表单、AI 面板刷新页面状态）
  const activePanel = content.querySelector(`:scope > #${t.panelId}`);
  activePanel?.__yksOnShow?.();
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
