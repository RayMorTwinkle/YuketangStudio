// src/ui/panels/problem-list.js
// 题目列表：汇聚所有已收集课件内的题目页，支持课件页查看/AI解答/控件作答/过期补交。
// 数据以 repo.presentations 内的 slide.problem 为准（XHR 拦截到达最全），
// repo.problems / problemStatus / encounteredProblems 做状态补充。
import tpl from './problem-list.html';
import { log } from '../../core/log.js';
import { repo } from '../../state/repo.js';
import { ui } from '../ui-api.js';
import { askAnswer } from './ai.js';
import { resolveProblemListTask } from '../../answer/context.js';
import { renderProblemCard, problemState } from '../problem-card.js';

let mounted = false;
let root;
const expandedEditors = new Set();   // problemId 集合：展开中的作答编辑区

function $(sel) { return root?.querySelector(sel); }

const HEADERS = () => ({
  'Content-Type': 'application/json',
  'xtbz': 'ykt',
  'X-Client': 'h5',
  'Authorization': 'Bearer ' + (typeof localStorage !== 'undefined' ? (localStorage.getItem('Authorization') || '') : ''),
});

function httpGet(url) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      const h = HEADERS();
      for (const k in h) xhr.setRequestHeader(k, h[k]);
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('解析响应失败')); } };
      xhr.onerror = () => reject(new Error('网络请求失败'));
      xhr.send();
    } catch (e) { reject(e); }
  });
}

/** 多端点尝试拉题目详情（不同服务端命名不一致） */
async function fetchProblemDetail(problemId) {
  const candidates = [
    `/api/v3/lesson/problem/detail?problemId=${problemId}`,
    `/api/v3/lesson/problem/get?problemId=${problemId}`,
    `/mooc-api/v1/lms/problem/detail?problem_id=${problemId}`,
  ];
  for (const url of candidates) {
    try {
      const resp = await httpGet(url);
      if (resp && typeof resp === 'object' && (resp.code === 0 || resp.success === true)) return resp;
    } catch { /* try next */ }
  }
  throw new Error('无法获取题目详情');
}

/**
 * 把所有课件里的题目页灌入 repo.problems / repo.encounteredProblems。
 * 兜底 WS/拦截漏题：presentations 是页面数据最全的来源。
 */
function hydrateProblemsFromPresentations() {
  try {
    for (const [, pres] of repo.presentations) {
      for (const s of pres?.slides || []) {
        const p = s?.problem;
        if (!p) continue;
        const pid = p.problemId ?? p.id;
        if (pid == null) continue;
        if (!repo.problems.has(String(pid))) {
          repo.problems.set(String(pid), {
            ...p,
            problemId: pid,
            problemType: p.problemType ?? p.type ?? p.questionType,
            body: p.body || p.title || '',
            options: p.options || [],
          });
        }
        repo.pushEncounteredProblem({ ...p, problemId: pid, problemType: p.problemType ?? p.type }, s, String(pres.id));
      }
    }
  } catch (e) {
    log.warn('[ProblemList] hydrate 失败:', e);
  }
}

// 状态、截止时间与答案编辑器统一来自共享 problem-card。

function goSlide(entry, prob) {
  const presentationId = String(entry.presentationId || prob?.presentationId || '');
  const slideId = String(entry.slide?.id || entry.slideId || prob?.slideId || '');
  if (!presentationId || !slideId) {
    ui.toast?.('缺少课件跳转信息', 1800);
    return false;
  }
  window.dispatchEvent(new CustomEvent('ykt:presentation:go-slide', {
    detail: { presentationId, slideId },
  }));
  return true;
}

function buildRow(entry, prob) {
  const pidStr = String(entry.problemId);
  const expanded = expandedEditors.has(pidStr);
  const card = renderProblemCard({
    problem: prob,
    slide: entry.slide,
    presentationId: entry.presentationId,
    expanded,
    onViewSlide: () => {
      if (goSlide(entry, prob)) ui.showPresentationPanel?.(true);
    },
    onAI: async () => {
      try {
        const r = await resolveProblemListTask(entry);
        if (!r.task) { ui.toast('题目信息不完整，无法解答', 2000); return; }
        ui.showAIPanel?.(true);
        await askAnswer(r.task);
      } catch (err) {
        ui.toast('AI 解答失败：' + (err?.message || err), 3000);
      }
    },
    onRefresh: async (problem) => {
      try {
        const resp = await fetchProblemDetail(pidStr);
        const detail = resp.data?.problem || resp.data || resp.result || {};
        repo.problems.set(pidStr, { ...(problem || prob || {}), ...detail, problemId: entry.problemId });
        ui.toast('已刷新题目', 1500);
        updateProblemList();
      } catch (err) {
        ui.toast('刷新失败：' + (err?.message || err), 2000);
      }
    },
    onChange: () => {
      if (expandedEditors.has(pidStr)) expandedEditors.delete(pidStr);
      else expandedEditors.add(pidStr);
      updateProblemList();
    },
  });
  const row = document.createElement('div');
  row.className = 'pl-row';
  row.appendChild(card);
  return row;
}

export function mountProblemListPanel() {
  if (mounted) return root;
  const wrap = document.createElement('div');
  wrap.innerHTML = tpl;
  document.body.appendChild(wrap.firstElementChild);
  root = document.getElementById('ykt-problem-list-panel');

  // 关闭统一走 shell 右上角 ✕（面板自带 X 已删，见 html）
  $('#ykt-pl-filter')?.addEventListener('change', () => updateProblemList());
  $('#ykt-pl-refresh')?.addEventListener('click', () => updateProblemList());

  // 状态（进行中/已过期）随时间变化：每 10s 重算一次；展开编辑区时不刷新，避免打断输入
  setInterval(() => {
    try {
      if (root && root.offsetParent !== null && expandedEditors.size === 0) updateProblemList();
    } catch { /* ignore */ }
  }, 10000);

  mounted = true;
  hydrateProblemsFromPresentations();
  // shell 切到本 tab 时重灌数据（课件可能晚于面板挂载到达）
  root.__yksOnShow = () => updateProblemList();
  return root;
}

export function updateProblemList() {
  if (!mounted) return;
  hydrateProblemsFromPresentations();
  const container = $('#ykt-problem-list');
  if (!container) return;
  const filter = $('#ykt-pl-filter')?.value || 'all';
  container.innerHTML = '';

  const list = repo.encounteredProblems || [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-empty';
    empty.textContent = '暂无题目（打开课堂或课件后自动收集）';
    container.appendChild(empty);
    return;
  }

  for (const e of list) {
    const pidStr = String(e.problemId);
    const prob = repo.problems.get(pidStr) || e;
    const state = problemState(pidStr, prob);
    if (filter === 'todo' && state === 'done') continue;
    if (filter === 'done' && state !== 'done') continue;
    if (filter === 'expired' && state !== 'expired') continue;
    container.appendChild(buildRow(e, prob));
  }

  if (!container.children.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-empty';
    empty.textContent = '当前筛选下没有题目';
    container.appendChild(empty);
  }
}
