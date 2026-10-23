// src/ui/panels/problem-list.js
// 题目列表：汇聚所有已收集课件内的题目页，支持查看/AI解答/手动作答/过期补交。
// 数据以 repo.presentations 内的 slide.problem 为准（XHR 拦截到达最全），
// repo.problems / problemStatus / encounteredProblems 做状态补充。
import tpl from './problem-list.html';
import { log } from '../../core/log.js';
import { escapeHtml } from '../../core/dom.js';
import { PROBLEM_TYPE_MAP } from '../../core/types.js';
import { repo } from '../../state/repo.js';
import { actions } from '../../state/actions.js';
import { ui } from '../ui-api.js';
import { askAnswer } from './ai.js';
import { resolveProblemListTask } from '../../answer/context.js';
import { normalizeTimestamp, isDeadlineReached } from '../../core/problem-timing.js';

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

/** 题目状态：'done' 已作答 / 'expired' 已过期 / 'active' 进行中（含不限时）/ 'todo' 未到 */
function problemState(pidStr, prob) {
  const status = repo.problemStatus.get(pidStr);
  const answered = !!(prob?.result || prob?.status?.myAnswer || status?.done);
  if (answered) return 'done';
  const endTime = normalizeTimestamp(status?.endTime ?? prob?.endTime ?? prob?.status?.endTime);
  if (endTime != null) {
    if (isDeadlineReached(endTime, status?.clockOffset)) return 'expired';
    return 'active';
  }
  return status ? 'active' : 'todo';
}

function endTimeText(pidStr, prob) {
  const status = repo.problemStatus.get(pidStr);
  const endTime = normalizeTimestamp(status?.endTime ?? prob?.endTime ?? prob?.status?.endTime);
  if (endTime == null) return '不限时';
  const d = new Date(endTime);
  return `截止 ${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 二次确认弹窗（Promise<boolean>） */
function confirmBox(text) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'pl-confirm-mask';
    const box = document.createElement('div');
    box.className = 'pl-confirm-box';
    box.innerHTML = `<div>${escapeHtml(text)}</div>`;
    const bar = document.createElement('div');
    bar.className = 'pl-confirm-actions';
    const no = document.createElement('button');
    no.className = 'btn-no'; no.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'btn-ok'; ok.textContent = '确认补交';
    const done = v => { mask.remove(); resolve(v); };
    no.onclick = () => done(false);
    ok.onclick = () => done(true);
    mask.addEventListener('click', e => { if (e.target === mask) done(false); });
    bar.appendChild(no); bar.appendChild(ok);
    box.appendChild(bar); mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

/** 各题型的输入提示 */
const INPUT_HINTS = {
  1: '填写单个大写字母，如 A',
  2: '填写多个字母，逗号/空格/顿号分隔均可，如 A、B、C 或 ABC',
  3: '填写单个大写字母，如 A',
  4: '每空一行，或同一行用逗号分隔多个填空',
  5: '直接输入答案正文',
};

const PLACEHOLDERS = {
  1: 'A', 2: 'A、B、C', 3: 'A', 4: '第一空\n第二空', 5: '输入答案…',
};

function buildEditor(rowEl, e, prob, state) {
  const editor = document.createElement('div');
  editor.className = 'pl-editor';
  const ptype = Number(prob?.problemType ?? e.problemType);

  const hint = document.createElement('div');
  hint.className = 'pl-hint';
  hint.textContent = `格式提示：${INPUT_HINTS[ptype] || '直接输入答案'}`;
  editor.appendChild(hint);

  // 已作答的答案回显
  const existing = prob?.result ?? prob?.status?.myAnswer;
  const existingText = existing == null ? '' :
    (typeof existing === 'object' && existing.content != null ? String(existing.content) :
     Array.isArray(existing) ? existing.join(', ') : JSON.stringify(existing));

  let input;
  if (ptype === 4 || ptype === 5) {
    input = document.createElement('textarea');
    input.rows = ptype === 5 ? 4 : 3;
    if (ptype === 5 && existing && typeof existing === 'object' && existing.content != null) input.value = existing.content;
    else input.value = existingText;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = existingText;
  }
  input.placeholder = PLACEHOLDERS[ptype] || '';
  editor.appendChild(input);

  const bar = document.createElement('div');
  bar.className = 'pl-submitbar';

  const doSubmit = async (forceRetry) => {
    const content = input.value;
    if (!content.trim()) return ui.toast('请先输入答案', 1500);
    const status = repo.problemStatus.get(String(e.problemId));
    try {
      rowEl.classList.add('loading');
      const route = await actions.submit(
        { problemId: e.problemId, problemType: ptype },
        content,
        { startTime: status?.startTime, endTime: status?.endTime, forceRetry },
      );
      if (route) ui.toast(route === 'retry' ? '✅ 补交成功' : '✅ 提交成功', 2500);
      updateProblemList();
    } catch (err) {
      ui.toast('提交失败：' + (err?.message || err), 3000);
    } finally {
      rowEl.classList.remove('loading');
    }
  };

  if (state !== 'expired') {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '提交答案';
    btn.onclick = () => doSubmit(false);
    bar.appendChild(btn);
    if (existingText) {
      const tag = document.createElement('span');
      tag.className = 'pl-answered';
      tag.textContent = `已作答：${existingText.slice(0, 30)}`;
      bar.appendChild(tag);
    }
  }
  // 补交按钮常态显示（过期/未过期都能走补交通道；提交前二次确认）
  const btnRetry = document.createElement('button');
  btnRetry.className = 'danger';
  btnRetry.textContent = '⏰ 补交';
  btnRetry.onclick = async () => {
    const ok = await confirmBox('将以补交方式提交（服务端会记录补交标记）。确定继续吗？');
    if (ok) doSubmit(true);
  };
  bar.appendChild(btnRetry);
  if (state === 'expired') {
    const tag = document.createElement('span');
    tag.style.cssText = 'font-size:11px;color:#b91c1c;';
    tag.textContent = '已过期';
    bar.appendChild(tag);
  }
  editor.appendChild(bar);
  return editor;
}

function buildRow(e, prob) {
  const pidStr = String(e.problemId);
  const ptype = Number(prob?.problemType ?? e.problemType);
  const state = problemState(pidStr, prob);

  const row = document.createElement('div');
  row.className = 'pl-row' + (state === 'done' ? ' done' : '') + (state === 'expired' ? ' expired' : '');

  const title = document.createElement('div');
  title.className = 'pl-title';
  title.textContent = (prob?.body || e.body || `题目 ${pidStr}`).slice(0, 120) || `题目 ${pidStr}`;
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  const badge = document.createElement('span');
  badge.className = `pl-badge ${state === 'done' ? 'done' : state === 'expired' ? 'expired' : 'todo'}`;
  badge.textContent = { done: '已作答', expired: '已过期', active: '进行中', todo: '未开始' }[state];
  meta.appendChild(badge);
  const info = document.createElement('span');
  info.textContent = `${PROBLEM_TYPE_MAP[ptype] || `类型${ptype}`} · ${endTimeText(pidStr, prob)}`;
  meta.appendChild(info);
  row.appendChild(meta);

  const bar = document.createElement('div');
  bar.className = 'pl-actions';

  const mk = (text, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };

  const presId = e.presentationId || prob?.presentationId;
  const slideId = e.slide?.id || e.slideId || prob?.slideId;
  mk('查看', '', () => {
    if (presId && slideId) actions.navigateTo(String(presId), String(slideId));
    else ui.toast('缺少跳转信息', 1500);
  });
  mk('AI解答', '', async () => {
    try {
      const r = await resolveProblemListTask(e);
      if (!r.task) { ui.toast('题目信息不完整，无法解答', 2000); return; }
      ui.showAIPanel?.(true);
      await askAnswer(r.task);
    } catch (err) {
      ui.toast('AI 解答失败：' + (err?.message || err), 3000);
    }
  });
  mk('刷新', '', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const resp = await fetchProblemDetail(pidStr);
      const detail = resp.data?.problem || resp.data || resp.result || {};
      repo.problems.set(pidStr, { ...(prob || {}), ...detail, problemId: e.problemId, problemType: ptype });
      ui.toast('已刷新题目', 1500);
      updateProblemList();
    } catch (err) {
      ui.toast('刷新失败：' + (err?.message || err), 2000);
      btn.disabled = false;
    }
  });
  mk(expandedEditors.has(pidStr) ? '收起作答' : '作答', expandedEditors.has(pidStr) ? '' : 'primary', () => {
    if (expandedEditors.has(pidStr)) expandedEditors.delete(pidStr);
    else expandedEditors.add(pidStr);
    updateProblemList();
  });

  row.appendChild(bar);
  if (expandedEditors.has(pidStr)) row.appendChild(buildEditor(row, e, prob, state));
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
