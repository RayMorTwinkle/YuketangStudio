// src/ui/panels/assignments-panel.js
// 工具箱「作业」tab：本课作业列表 + 当前试卷题目 + 批量下载/批量 AI + 单题 AI（复用 AI 解答面板）
import { ui } from '../ui-api.js';
import { confirmDialog } from '../confirm.js';
import { askAIForProblem, getOverride } from './ai.js';
import { log } from '../../core/log.js';
import {
  fetchCourses, fetchAssignments, findCourseByQuiz, fetchQuizDataById, oldUrl, newUrl,
} from '../../quiz/assignments.js';
import {
  isQuizPage, readQuizData, quizMeta, composeSlide, canvasBlob, saveBlob, zipStore, quizQuestionDataUrl,
} from '../../quiz/quiz-paper.js';
import { agnesChat } from '../../ai/agnes.js';

let mounted = false;
let root = null;
let courses = [];
let cid = '';
let list = [];
let selected = new Set();
let busy = false;
let loaded = false;
let viewData = null;
let viewTitle = '';
let viewAssignment = null;

function $(sel) { return root?.querySelector(sel); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeName(s) {
  return String(s || '作业').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
}

function deadlineText(ms) {
  if (!ms) return '不限时';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function typeText(t) {
  const map = {
    FillBlank: '填空题', SingleChoice: '单选题', MultipleChoice: '多选题',
    Judgement: '判断题', Subjective: '主观题', Poll: '投票', Exam: '试卷', Link: '外链题',
  };
  return map[t] || t || '题目';
}

function setStatus(text) {
  const el = $('#ykt-ap-status');
  if (el) el.textContent = text || '';
}

function setBusy(on) {
  busy = on;
  ['#ykt-ap-zip', '#ykt-ap-ai', '#ykt-ap-refresh'].forEach((s) => {
    const b = $(s);
    if (b) b.disabled = on;
  });
}

function selectedItems() {
  return list.filter((a) => selected.has(a.id));
}

function showListView() {
  viewData = null;
  viewAssignment = null;
  $('#ykt-ap-questions').style.display = 'none';
  $('#ykt-ap-list').style.display = '';
  $('.ap-toolbar').style.display = '';
  $('.ap-actions').style.display = '';
  $('#ykt-ap-status').style.display = '';
  renderList();
}

function showQuestionsView(data, title, assignment) {
  viewData = data;
  viewTitle = title;
  viewAssignment = assignment;
  $('#ykt-ap-list').style.display = 'none';
  $('.ap-toolbar').style.display = 'none';
  $('.ap-actions').style.display = 'none';
  $('#ykt-ap-status').style.display = 'none';
  $('#ykt-ap-questions').style.display = '';
  renderQuestions();
}

function renderQuestions() {
  const box = $('#ykt-ap-questions');
  if (!box) return;
  const slides = (viewData?.Slides || []);
  const rows = slides.map((s, i) => {
    if (!s?.Problem) return '';
    const p = s.Problem;
    return `<div class="quiz-item">
      <div class="quiz-idx">${i + 1}</div>
      <div class="quiz-info"><b>${typeText(p.Type)}</b> · ${p.Score ?? 0} 分</div>
      <button type="button" data-qact="dl" data-i="${i}">下载</button>
      <button type="button" data-qact="ai" data-i="${i}">AI 解答</button>
    </div>`;
  }).filter(Boolean).join('');
  box.innerHTML = `
    <div class="ap-qhead">
      <button type="button" id="ykt-ap-back">← 返回作业列表</button>
      <b>${escapeHtml(viewTitle || '当前试卷')}</b>
    </div>
    <div class="quiz-list">${rows || '<div class="ap-empty">没有识别到题目</div>'}</div>`;
  $('#ykt-ap-back')?.addEventListener('click', showListView);
}

function renderCurrentCard() {
  const box = $('#ykt-ap-current');
  if (!box) return;
  if (!isQuizPage()) { box.style.display = 'none'; return; }
  const data = readQuizData();
  if (!data) { box.style.display = 'none'; return; }
  const m = quizMeta(data);
  box.style.display = '';
  box.innerHTML = `<div class="ap-current-card">
    <div class="ap-current-title">当前试卷：${escapeHtml(m.title)}</div>
    <div class="ap-current-sub">${m.count} 题 · ${m.width}×${m.height}</div>
    <button type="button" id="ykt-ap-current-open">查看题目</button>
  </div>`;
  $('#ykt-ap-current-open')?.addEventListener('click', () => showQuestionsView(data, m.title, null));
}

function renderList() {
  const box = $('#ykt-ap-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="ap-empty">这个课程没有作业/考试（或日志接口未返回）</div>';
    return;
  }
  box.innerHTML = list.map((a) => {
    const oldU = oldUrl(a);
    const newU = newUrl(a, cid);
    const kind = a.type === 20 ? '考试' : a.type === 4 ? '作业（老版）' : '作业';
    return `<div class="ap-row" data-id="${escapeHtml(a.id)}">
      <input type="checkbox" class="ap-check" data-id="${escapeHtml(a.id)}" ${selected.has(a.id) ? 'checked' : ''}>
      <div class="ap-main">
        <div class="ap-title">${escapeHtml(a.title)}</div>
        <div class="ap-meta">${kind} · 截止 ${deadlineText(a.deadline)}${a.problemCount != null ? ` · ${a.problemCount} 题` : ''}${a.totalScore != null ? ` · ${a.totalScore} 分` : ''}</div>
      </div>
      <div class="ap-links">
        ${a.oldId ? `<button type="button" data-q="${escapeHtml(a.id)}">题目</button>` : ''}
        ${oldU ? `<button type="button" data-link="${escapeHtml(oldU)}">老界面</button>` : ''}
        ${newU ? `<button type="button" data-link="${escapeHtml(newU)}">新界面</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function loadList(courseId) {
  cid = courseId;
  selected.clear();
  setStatus('正在读取作业列表…');
  try {
    list = await fetchAssignments(cid);
    renderList();
    setStatus(list.length ? `共 ${list.length} 项` : '没有找到作业');
  } catch (e) {
    log.warn('[assign] load failed', e);
    list = [];
    renderList();
    setStatus('读取失败：' + (e?.message || e));
  }
}

async function loadCourses() {
  setStatus('正在读取课程列表…');
  try {
    courses = await fetchCourses();
    const sel = $('#ykt-ap-course');
    if (sel) {
      sel.innerHTML = courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    }
    if (!courses.length) { setStatus('没有读取到课程'); return; }
    const quizId = String(window.quizID || '');
    if (quizId) {
      setStatus('正在定位当前作业所属课程…');
      const found = await findCourseByQuiz(courses, quizId);
      if (found) {
        if (sel) sel.value = found.cid;
        list = found.list;
        cid = found.cid;
        selected.clear();
        renderList();
        setStatus(`共 ${list.length} 项`);
        return;
      }
    }
    const urlCid = new URLSearchParams(location.search).get('classroom_id');
    const prefer = courses.find((c) => c.id === urlCid) || courses[0];
    if (sel) sel.value = prefer.id;
    await loadList(prefer.id);
  } catch (e) {
    log.warn('[assign] courses failed', e);
    setStatus('读取课程失败：' + (e?.message || e));
  }
}

async function openAssignmentQuestions(a) {
  if (!a.oldId) { ui.toast?.('该作业只有新版界面，请点「新界面」', 2500); return; }
  setStatus(`正在读取「${a.title}」…`);
  try {
    const data = await fetchQuizDataById(a.oldId);
    showQuestionsView(data, a.title, a);
  } catch (e) {
    setStatus('读取失败：' + (e?.message || e));
  }
}

async function downloadQuestion(index) {
  if (busy) return;
  setBusy(true);
  try {
    const canvas = await composeSlide(viewData.Slides[index], viewData, 2);
    const blob = await canvasBlob(canvas);
    await saveBlob(blob, `${safeName(viewTitle)}_第${index + 1}题.jpg`);
    setStatus(`已导出第 ${index + 1} 题`);
  } catch (e) {
    setStatus('导出失败：' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

async function aiForQuestion(index) {
  try {
    setStatus(`正在准备第 ${index + 1} 题的题图…`);
    const dataUrl = await quizQuestionDataUrl(viewData, index, 2);
    const p = viewData.Slides[index].Problem || {};
    ui.showAIPanel?.(true);
    await askAIForProblem({
      problemId: `quiz_${viewAssignment?.oldId || window.quizID || 'x'}_${index}`,
      problemType: 4,
      body: `第 ${index + 1} 题（${typeText(p.Type)}，${p.Score ?? ''} 分）`,
      options: [],
      __imageDataUrl: dataUrl,
      __noSubmit: true,
    });
    setStatus('');
  } catch (e) {
    setStatus('AI 解答失败：' + (e?.message || e));
  }
}

async function batchZip() {
  if (busy) return;
  const items = selectedItems().filter((a) => a.oldId);
  if (!items.length) { ui.toast?.('请先勾选带老版界面的作业', 2500); return; }
  setBusy(true);
  const files = [];
  try {
    for (const a of items) {
      setStatus(`正在导出「${a.title}」…`);
      const data = await fetchQuizDataById(a.oldId);
      for (let i = 0; i < (data.Slides || []).length; i++) {
        if (!data.Slides[i]?.Problem) continue;
        const canvas = await composeSlide(data.Slides[i], data, 2);
        const blob = await canvasBlob(canvas);
        files.push({
          name: `${safeName(a.title)}/第${i + 1}题.jpg`,
          data: new Uint8Array(await blob.arrayBuffer()),
        });
        setStatus(`正在导出「${a.title}」… 已 ${files.length} 张`);
      }
    }
    if (!files.length) throw new Error('没有可导出的题目');
    setStatus(`正在打包 ${files.length} 张图片…`);
    await saveBlob(zipStore(files), `作业图片_${stamp()}.zip`);
    setStatus(`已导出 ${files.length} 张图片`);
  } catch (e) {
    setStatus('批量下载失败：' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

async function batchAI() {
  if (busy) return;
  const items = selectedItems().filter((a) => a.oldId);
  if (!items.length) { ui.toast?.('请先勾选带老版界面的作业', 2500); return; }
  const override = getOverride();
  if (!override) { ui.toast?.('请先在设置里配置 AI', 2500); return; }
  const ok = await confirmDialog(
    `将依次对 ${items.length} 份作业调用 AI 解答，题目较多时耗时和费用都会增加。确定继续吗？`,
    { okText: '开始解答', danger: true },
  );
  if (!ok) return;

  setBusy(true);
  const md = [];
  let done = 0;
  let total = 0;
  try {
    const datasets = [];
    for (const a of items) {
      const data = await fetchQuizDataById(a.oldId);
      total += (data.Slides || []).filter((s) => s?.Problem).length;
      datasets.push({ a, data });
    }
    for (const { a, data } of datasets) {
      md.push(`# ${a.title}\n`);
      for (let i = 0; i < (data.Slides || []).length; i++) {
        if (!data.Slides[i]?.Problem) continue;
        setStatus(`正在解答「${a.title}」第 ${i + 1} 题（${done + 1}/${total}）…`);
        const dataUrl = await quizQuestionDataUrl(data, i, 2);
        const p = data.Slides[i].Problem;
        const res = await agnesChat({
          messages: [
            { role: 'system', content: '你是学习助手。请根据题目图片给出答案和简要步骤。填空题/选择题请明确写出答案。' },
            {
              role: 'user',
              content: [
                { type: 'text', text: `第 ${i + 1} 题（${p.Type || ''}，${p.Score ?? ''} 分）` },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          stream: false,
          thinking: true,
          override,
        });
        md.push(`## 第 ${i + 1} 题\n\n${res.content || '（空回复）'}\n`);
        done++;
      }
    }
    await saveBlob(new Blob([md.join('\n')], { type: 'text/markdown;charset=utf-8' }), `作业解答_${stamp()}.md`);
    setStatus(`已完成 ${done} 题，解答已保存为 Markdown`);
  } catch (e) {
    setStatus('批量解答中断：' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

export function mountAssignmentsPanel() {
  if (mounted) return root;
  mounted = true;

  root = document.createElement('div');
  root.id = 'ykt-assign-tab';
  root.className = 'ykt-panel';
  root.innerHTML = `
    <div class="panel-header"><h3>作业</h3></div>
    <div class="panel-body">
      <div id="ykt-ap-current" style="display:none"></div>
      <div class="ap-toolbar">
        <select id="ykt-ap-course"></select>
        <button type="button" id="ykt-ap-refresh">刷新</button>
      </div>
      <div class="ap-actions">
        <label class="ap-all"><input type="checkbox" id="ykt-ap-all"> 全选</label>
        <button type="button" id="ykt-ap-zip">批量下载（ZIP）</button>
        <button type="button" id="ykt-ap-ai">批量 AI 解答</button>
      </div>
      <div id="ykt-ap-status" class="ap-status"></div>
      <div id="ykt-ap-list" class="ap-list"></div>
      <div id="ykt-ap-questions" class="ap-questions" style="display:none"></div>
    </div>`;

  $('#ykt-ap-course')?.addEventListener('change', (e) => { showListView(); loadList(e.target.value); });
  $('#ykt-ap-refresh')?.addEventListener('click', () => loadList(cid));
  $('#ykt-ap-all')?.addEventListener('change', (e) => {
    if (e.target.checked) list.forEach((a) => selected.add(a.id));
    else selected.clear();
    renderList();
  });
  $('#ykt-ap-zip')?.addEventListener('click', batchZip);
  $('#ykt-ap-ai')?.addEventListener('click', batchAI);

  $('#ykt-ap-list')?.addEventListener('click', (e) => {
    const link = e.target.closest('button[data-link]');
    if (link) { location.href = link.dataset.link; return; }
    const q = e.target.closest('button[data-q]');
    if (q) {
      const a = list.find((x) => x.id === q.dataset.q);
      if (a) openAssignmentQuestions(a);
    }
  });
  $('#ykt-ap-list')?.addEventListener('change', (e) => {
    const cb = e.target.closest('.ap-check');
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.id);
    else selected.delete(cb.dataset.id);
  });

  $('#ykt-ap-questions')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-qact]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.qact === 'dl') downloadQuestion(i);
    else if (btn.dataset.qact === 'ai') aiForQuestion(i);
  });

  document.body.appendChild(root);

  root.__yksOnShow = () => {
    renderCurrentCard();
    if (!loaded) { loaded = true; loadCourses(); }
  };
  renderCurrentCard();
  return root;
}
