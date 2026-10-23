import tpl from './active-problems.html';
import { log } from '../../core/log.js';
import { repo } from '../../state/repo.js';
import { actions } from '../../state/actions.js';
import { remainingSeconds } from '../../core/problem-timing.js';
import { askProblem } from './ai.js';

let mounted = false;
let root;

function $(sel) {
  return document.querySelector(sel);
}

export function mountActiveProblemsPanel() {
  if (mounted) return root;
  const wrap = document.createElement('div');
  wrap.innerHTML = tpl;
  document.body.appendChild(wrap.firstElementChild);
  root = document.getElementById('ykt-active-problems-panel');
  mounted = true;

  setInterval(() => updateActiveProblems(), 1000);
  return root;
}

export function updateActiveProblems() {
  mountActiveProblemsPanel();
  const box = $('#ykt-active-problems');
  // 没有任何状态时直接跳过 DOM 重建（每秒重扫问题集，空转不值得）
  if (repo.problemStatus.size === 0) {
    if (root.style.display !== 'none') { box.innerHTML = ''; root.style.display = 'none'; }
    return;
  }

  const now = Date.now();
  const items = [];

  repo.problemStatus.forEach((status, pid) => {
    const p = repo.problems.get(String(pid));
    if (!p || p.result) return;

    // endTime 可能是 null（不限时）或基于服务端时钟（clockOffset 修正）
    const remain = remainingSeconds(status.endTime, status.clockOffset, now);
    const hasDeadline = remain !== null;
    if (hasDeadline && remain <= 0) {
      log.dbg(`[雨课堂助手][INFO][ActiveProblems] 题目 ${pid} 倒计时已结束，移除卡片`);
      return;
    }
    items.push({ status, pid, p, remain, hasDeadline });
  });

  if (!items.length) {
    if (root.style.display !== 'none') { box.innerHTML = ''; root.style.display = 'none'; }
    return;
  }

  box.innerHTML = '';
  for (const { status, pid, p, remain, hasDeadline } of items) {
    const card = document.createElement('div');
    card.className = 'active-problem-card';

    const title = document.createElement('div');
    title.className = 'ap-title';
    title.textContent = (p.body || `题目 ${pid}`).slice(0, 80);
    card.appendChild(title);

    const info = document.createElement('div');
    info.className = 'ap-info';
    info.textContent = hasDeadline ? `剩余 ${remain}s` : '进行中（不限时）';
    card.appendChild(info);

    const bar = document.createElement('div');
    bar.className = 'ap-actions';

    const go = document.createElement('button');
    go.textContent = '查看';
    go.onclick = () => actions.navigateTo(status.presentationId, status.slideId);
    bar.appendChild(go);

    const ai = document.createElement('button');
    ai.textContent = 'AI 解答';
    ai.onclick = () => { askProblem(pid).catch((e) => log.warn('[ActiveProblems] askProblem failed', e)); };
    bar.appendChild(ai);

    card.appendChild(bar);
    box.appendChild(card);
  }

  root.style.display = '';
}
