// src/ui/problem-card.js
// 课堂题目的共享组件：课件页、题目列表、答题提醒都复用同一份交互。
// 选择题/填空题用专用控件；主观题保留文本编辑。点击选项绝不提交，必须点「提交答案」。
import { PROBLEM_TYPE_MAP } from '../core/types.js';
import { repo } from '../state/repo.js';
import { actions } from '../state/actions.js';
import { ui } from './ui-api.js';
import { normalizeTimestamp, isDeadlineReached } from '../core/problem-timing.js';

function el(tag, cls, value = '') {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (value) x.textContent = value;
  return x;
}

export function problemState(pidStr, prob) {
  const status = repo.problemStatus.get(String(pidStr));
  const answered = !!(prob?.result || prob?.status?.myAnswer || status?.done);
  if (answered) return 'done';
  const endTime = normalizeTimestamp(status?.endTime ?? prob?.endTime ?? prob?.status?.endTime);
  if (endTime != null) {
    if (isDeadlineReached(endTime, status?.clockOffset)) return 'expired';
    return 'active';
  }
  return status ? 'active' : 'todo';
}

export function endTimeText(pidStr, prob) {
  const status = repo.problemStatus.get(String(pidStr));
  const endTime = normalizeTimestamp(status?.endTime ?? prob?.endTime ?? prob?.status?.endTime);
  if (endTime == null) return '不限时';
  const d = new Date(endTime);
  return `截止 ${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours() + '').padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function normalizeLetters(v) {
  if (Array.isArray(v)) return v.map(String);
  return String(v ?? '').toUpperCase().match(/[A-Z]/g) || [];
}

function existingValues(problem) {
  const r = problem?.result ?? problem?.status?.myAnswer;
  if (r == null) return { letters: [], blanks: [], content: '' };
  if (typeof r === 'string') {
    return { letters: normalizeLetters(r), blanks: r.split(/[\n,，]+/).map(s => s.trim()).filter(Boolean), content: r };
  }
  if (Array.isArray(r)) {
    return { letters: r.map(String), blanks: r.map(String), content: r.join('\n') };
  }
  if (typeof r === 'object') {
    const content = String(r.content ?? '');
    return { letters: normalizeLetters(content), blanks: content.split('\n').map(s => s.trim()).filter(Boolean), content };
  }
  return { letters: [], blanks: [], content: String(r) };
}

function answerText(problem) {
  const ex = existingValues(problem);
  if (ex.content) return ex.content;
  if (ex.letters.length) return ex.letters.join('、');
  if (ex.blanks.length) return ex.blanks.join(' | ');
  return '';
}

function confirmBox(message, okLabel = '确认') {
  return new Promise(resolve => {
    const mask = el('div', 'ykt-problem-confirm-mask');
    const box = el('div', 'ykt-problem-confirm-box');
    box.appendChild(el('div', 'ykt-problem-confirm-text', message));
    const bar = el('div', 'ykt-problem-confirm-actions');
    const no = el('button', 'btn-no', '取消');
    const ok = el('button', 'btn-ok', okLabel);
    const done = (v) => { mask.remove(); resolve(v); };
    no.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    mask.addEventListener('click', e => { if (e.target === mask) done(false); });
    bar.appendChild(no); bar.appendChild(ok);
    box.appendChild(bar); mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

function collectContent(problem, editor) {
  const type = Number(problem.problemType ?? problem.type);
  if (type === 1 || type === 3 || type === 2) {
    return [...editor.querySelectorAll('input:checked')]
      .map(x => x.value)
      .sort()
      .join('、');
  }
  if (type === 4) {
    return [...editor.querySelectorAll('input[data-blank]')].map(x => x.value.trim()).join('\n');
  }
  return String(editor.querySelector('textarea[data-subjective]')?.value || '').trim();
}

async function submitContent(problem, status, content, forceRetry) {
  if (!content) { ui.toast('请先输入答案', 1600); return false; }
  const pid = problem.problemId ?? problem.id;
  const ptype = Number(problem.problemType ?? problem.type);
  if (!pid || !ptype) { ui.toast('题目数据不完整', 2000); return false; }
  try {
    const route = await actions.submit(
      { problemId: pid, problemType: ptype },
      content,
      {
        startTime: status?.startTime,
        endTime: status?.endTime,
        forceRetry,
      },
    );
    if (route) {
      ui.toast(route === 'retry' ? '✅ 补交成功' : '✅ 提交成功', 2200);
      return true;
    }
  } catch (err) {
    ui.toast('提交失败：' + (err?.message || err), 2800);
  }
  return false;
}

function buildEditor(problem, status, showFeedback) {
  const editor = el('div', 'ykt-problem-editor');
  const type = Number(problem.problemType ?? problem.type);
  const options = Array.isArray(problem.options) ? problem.options : [];
  const blanks = Array.isArray(problem.blanks) && problem.blanks.length ? problem.blanks : (type === 4 ? ['第一空', '第二空'] : []);
  const existing = existingValues(problem);

  if (type === 1 || type === 3) {
    options.forEach(o => {
      const label = el('label', 'ykt-problem-choice');
      const input = el('input');
      input.type = 'radio'; input.name = `problem-${problem.problemId || problem.id}`;
      input.value = o.key; if (existing.letters.includes(o.key)) input.checked = true;
      label.appendChild(input); label.appendChild(el('span', 'choice-key', o.key));
      label.appendChild(el('span', 'choice-value', o.value ?? o.text ?? ''));
      editor.appendChild(label);
    });
    editor.appendChild(el('div', 'ykt-problem-hint', '选择答案后必须点「提交答案」，点选项本身不会提交。'));
  } else if (type === 2) {
    options.forEach(o => {
      const label = el('label', 'ykt-problem-choice');
      const input = el('input');
      input.type = 'checkbox'; input.value = o.key;
      if (existing.letters.includes(o.key)) input.checked = true;
      label.appendChild(input); label.appendChild(el('span', 'choice-key', o.key));
      label.appendChild(el('span', 'choice-value', o.value ?? o.text ?? ''));
      editor.appendChild(label);
    });
    editor.appendChild(el('div', 'ykt-problem-hint', '可多选；选择后必须点「提交答案」。'));
  } else if (type === 4) {
    blanks.forEach((b, i) => {
      const row = el('label', 'ykt-problem-blank');
      row.appendChild(el('span', 'blank-label', b || `第 ${i + 1} 空`));
      const input = el('input'); input.type = 'text'; input.dataset.blank = String(i);
      input.value = existing.blanks[i] || '';
      input.placeholder = '填写这一空';
      row.appendChild(input); editor.appendChild(row);
    });
  } else {
    const area = el('textarea');
    area.dataset.subjective = '1'; area.rows = 4;
    area.placeholder = '输入完整作答内容';
    area.value = existing.content || '';
    editor.appendChild(area);
  }

  const bar = el('div', 'ykt-problem-editor-actions');
  const submit = el('button', 'primary', '提交答案');
  const retry = el('button', 'danger', '补交');
  const close = el('button', 'muted', '收起');
  submit.addEventListener('click', async () => {
    submit.disabled = retry.disabled = true;
    const ok = await submitContent(problem, status, collectContent(problem, editor), false);
    submit.disabled = retry.disabled = false;
    if (ok) showFeedback();
  });
  retry.addEventListener('click', async () => {
    const confirmed = await confirmBox('将以补交方式提交（服务端会记录补交标记）。确定继续吗？', '确认补交');
    if (!confirmed) return;
    submit.disabled = retry.disabled = true;
    const ok = await submitContent(problem, status, collectContent(problem, editor), true);
    submit.disabled = retry.disabled = false;
    if (ok) showFeedback();
  });
  close.addEventListener('click', showFeedback);
  bar.appendChild(submit); bar.appendChild(retry); bar.appendChild(close);
  editor.appendChild(bar);
  return editor;
}

/**
 * 渲染一个完整题目卡。
 * @param {{problem:object, slide?:object, presentationId?:string, expanded?:boolean,
 *           onAI?:Function, onRefresh?:Function, onViewSlide?:Function, onChange?:Function}} opts
 */
export function renderProblemCard(opts) {
  const { problem, slide, expanded = false, onAI, onRefresh, onViewSlide, onChange } = opts;
  if (!problem) return el('div');
  const pid = problem.problemId ?? problem.id;
  const status = repo.problemStatus.get(String(pid));
  const state = problemState(String(pid), problem);
  const card = el('div', `ykt-problem-card problem-${state}`);
  card.dataset.problemId = String(pid);

  const head = el('div', 'ykt-problem-head');
  const type = Number(problem.problemType ?? problem.type);
  head.appendChild(el('b', 'ykt-problem-type', PROBLEM_TYPE_MAP[type] || `类型${type}`));
  if (problem.score != null) head.appendChild(el('span', 'ykt-problem-score', `${problem.score} 分`));
  head.appendChild(el('span', 'ykt-problem-state', {
    done: '已作答', expired: '已过期', active: '进行中', todo: '未到',
  }[state]));
  const page = slide?.index ?? slide?.page ?? problem.slideIndex;
  if (page != null) head.appendChild(el('span', 'ykt-problem-page', `PPT 第 ${page} 页`));
  card.appendChild(head);

  card.appendChild(el('div', 'ykt-problem-body', problem.body || `题目 ${pid}`));

  const options = Array.isArray(problem.options) ? problem.options : [];
  if (options.length && !expanded) {
    card.appendChild(el('div', 'ykt-problem-options-static', options.map(o => `${o.key}. ${o.value ?? o.text ?? ''}`).join('\n')));
  }

  const actionsBar = el('div', 'ykt-problem-actions');
  const mk = (label, cls, fn) => {
    const b = el('button', cls, label);
    b.addEventListener('click', fn);
    actionsBar.appendChild(b);
    return b;
  };
  if (onViewSlide) mk('在课件页查看', '', onViewSlide);
  if (onAI) mk('AI 解答', '', () => onAI(problem, slide));
  if (onRefresh) mk('刷新题目', '', () => onRefresh(problem));
  mk(expanded ? '收起作答' : '作答', expanded ? '' : 'primary', () => onChange?.());
  card.appendChild(actionsBar);

  const answered = answerText(problem);
  if (answered && !expanded) {
    const box = el('div', 'ykt-problem-answered', `已有作答：${answered}`);
    card.appendChild(box);
  }
  if (expanded) card.appendChild(buildEditor(problem, status, onChange));
  return card;
}
