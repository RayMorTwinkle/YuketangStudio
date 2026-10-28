// src/ui/panels/assignments-panel.js
// 工具箱「作业」tab：本课作业列表 + 当前试卷题目 + 批量下载/批量 AI + 单题 AI（复用 AI 解答面板）
import { ui } from '../ui-api.js';
import { confirmDialog } from '../confirm.js';
import { askAnswer, getOverride } from './ai.js';
import { log } from '../../core/log.js';
import {
  fetchCourses, fetchAssignments, findCourseByQuiz, fetchQuizDataById, oldUrl, newUrl,
  enrichAssignments,
} from '../../quiz/assignments.js';
import { fetchExerciseDetail } from '../../quiz/exercise.js';
import { fetchExamReview } from '../../quiz/exam.js';
import { uvIdFromCookie } from '../../quiz/active-core.js';
import { fetchAsDataURL, ensureHtml2Canvas } from '../../core/env.js';
import { sanitizeHtml } from '../rich.js';
import {
  isQuizPage, readQuizData, quizMeta, composeSlide, canvasBlob, saveBlob, zipStore, quizQuestionDataUrl,
} from '../../quiz/quiz-paper.js';
import { agnesChat } from '../../ai/agnes.js';
import { buildAssignmentTask } from '../../answer/adapters/assignment.js';
import { buildExerciseTask } from '../../answer/adapters/exercise.js';
import { normalizeType, typeLabel } from '../../answer/model.js';

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
let loadSeq = 0;   // 课程切换请求序号：旧请求/旧 enrich 返回后直接丢弃

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
  return typeLabel(normalizeType(t, { source: 'assignment' }));
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
  if (viewData?.mode === 'exercise' || viewData?.mode === 'exam-review') {
    renderActiveQuestions();
    return;
  }
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
      ${viewAssignment?.oldId ? '<button type="button" id="ykt-ap-goto-submit">去交卷</button>' : ''}
    </div>
    <div class="quiz-list">${rows || '<div class="ap-empty">没有识别到题目</div>'}</div>`;
  $('#ykt-ap-back')?.addEventListener('click', showListView);
  $('#ykt-ap-goto-submit')?.addEventListener('click', () => {
    if (viewAssignment?.oldId) location.href = oldUrl(viewAssignment);
  });
}

/** 列表行 meta：类型 + 截止 + 题数/分值 + enrich 出的作答状态。 */
function rowMetaParts(a) {
  const parts = [a.type === 20 ? '考试' : a.type === 4 ? '作业（老版）' : '作业'];
  parts.push(`截止 ${deadlineText(a.deadline)}`);
  if (a.problemCount != null) parts.push(`${a.problemCount} 题`);
  if (a.totalScore != null) parts.push(`${a.totalScore} 分`);
  if (a.answeredCount != null) {
    parts.push(`已答 ${a.answeredCount}${a.totalCount != null ? `/${a.totalCount}` : ''}`);
  }
  if (a.score != null) parts.push(`得分 ${a.score}`);
  if (a.type === 20) {
    if (a.examStatus === 'submitted') parts.push('已交卷');
    else if (a.examStatus === 'absent') parts.push('缺考');
    else if (a.examStatus === 'invalid') parts.push('已作废');
  } else if (a.type === 19 && a.graded === false && (a.answeredCount ?? 0) > 0) {
    parts.push('待批改');
  }
  if (a.statusMessage) parts.push(a.statusMessage);
  return parts.map((s) => escapeHtml(String(s))).join(' · ');
}

function activeProblemBadge(q, isExam) {
  if (isExam) {
    if (q.status === 'graded') {
      if (q.correct === true) return '<span class="ap-badge ap-ok">答对</span>';
      if (q.correct === false) return '<span class="ap-badge ap-bad">答错</span>';
      return '<span class="ap-badge">已批改</span>';
    }
    if (q.status === 'unanswered') return '<span class="ap-badge ap-bad">未作答</span>';
    if (q.status === 'submitted') return '<span class="ap-badge">已作答</span>';
    return '';
  }
  if (q.status === 'graded') return '<span class="ap-badge ap-ok">已批改</span>';
  if (q.status === 'submitted') return '<span class="ap-badge">已交待批改</span>';
  if (q.status === 'answered') return '<span class="ap-badge">已作答</span>';
  if (q.status === 'unanswered') return '<span class="ap-badge ap-bad">未作答</span>';
  return '';
}

/** 服务端 HTML 统一走 sanitizeHtml；为空不渲染。 */
function activeAnswerBlock(label, html) {
  const clean = sanitizeHtml(html || '');
  if (!clean.trim()) return '';
  return `<div class="ap-ans"><span class="ap-ans-k">${escapeHtml(label)}</span><div class="ap-ans-v">${clean}</div></div>`;
}

function activeProblemCard(q, i, isExam) {
  const options = (q.options || []).map((o) => `
    <div class="ap-option"><span class="ap-opt-key">${escapeHtml(o.label)}</span><span class="ap-opt-html">${sanitizeHtml(o.html)}</span></div>`).join('');
  const files = (q.attachments || []).map((f) => (f.url
    ? `<div class="ap-attach"><a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(f.name)}</a></div>`
    : `<div class="ap-attach">${escapeHtml(f.name)}</div>`)).join('');
  const comments = (q.comments || []).map((c) => activeAnswerBlock(c.name || '评论', c.html)).join('');
  return `<div class="ap-active-item">
    <div class="ap-active-head">
      <span class="ap-active-idx">${q.index ?? i + 1}</span>
      <b>${escapeHtml(q.typeText || '题目')}</b>
      ${q.score != null ? `<span class="ap-active-score">${q.score} 分</span>` : ''}
      ${activeProblemBadge(q, isExam)}
      ${q.myScore != null ? `<span class="ap-badge">得分 ${q.myScore}</span>` : ''}
      <span class="ap-active-links">
        ${q.externalUrl ? `<a href="${escapeHtml(q.externalUrl)}" target="_blank" rel="noopener noreferrer">打开外链题</a>` : ''}
        <button type="button" data-qact="aai" data-i="${i}">AI 解答</button>
      </span>
    </div>
    <div class="ap-problem-body">${sanitizeHtml(q.bodyHtml)}</div>
    ${options}
    ${activeAnswerBlock('我的作答', q.answerHtml)}
    ${isExam ? activeAnswerBlock('参考答案', q.correctAnswerHtml) : ''}
    ${activeAnswerBlock('解析', q.explanationHtml)}
    ${activeAnswerBlock('评语', q.remarkHtml)}
    ${comments}
    ${files}
  </div>`;
}

/** type 19 详情 / type 20 回顾共用的题目视图（viewData.mode = exercise|exam-review）。 */
function renderActiveQuestions() {
  const box = $('#ykt-ap-questions');
  if (!box) return;
  const d = viewData || {};
  const isExam = d.mode === 'exam-review';
  const p = d.progress || {};
  const head = [];
  if (p.answeredCount != null) {
    head.push(`已答 ${p.answeredCount}${p.totalCount != null ? `/${p.totalCount}` : ''}`);
  }
  if (p.score != null) head.push(`得分 ${p.score}${p.totalScore != null ? `/${p.totalScore}` : ''}`);
  if (isExam) {
    if (p.examStatus === 'submitted') head.push('已交卷');
    else if (p.examStatus === 'absent') head.push('缺考');
    else if (p.examStatus === 'invalid') head.push('已作废');
  } else if (p.graded === false && (p.answeredCount ?? 0) > 0) {
    head.push('待批改');
  }
  if (!isExam && d.lateAllowed) head.push('允许迟交');
  const rows = (d.problems || []).map((q, i) => activeProblemCard(q, i, isExam)).join('');
  const desc = sanitizeHtml(d.descriptionHtml || '');
  box.innerHTML = `
    <div class="ap-qhead">
      <button type="button" id="ykt-ap-back">← 返回作业列表</button>
      <b>${escapeHtml(viewTitle || '详情')}</b>
      <span class="ap-head-meta">${head.map((s) => escapeHtml(String(s))).join(' · ')}</span>
    </div>
    ${desc ? `<div class="ap-desc">${desc}</div>` : ''}
    <div class="ap-active-list">${rows || '<div class="ap-empty">没有识别到题目</div>'}</div>`;
  $('#ykt-ap-back')?.addEventListener('click', showListView);
  injectActiveFont(d.fontUrl);
}

/** 加密字体：GM_xhr 拉 dataURL 注入 @font-face；失败保持原字符（降级）。 */
let activeFontUrl = '';
async function injectActiveFont(fontUrl) {
  if (!fontUrl) {
    // 新详情没有字体：清掉上一份，避免旧字套到新题
    if (activeFontUrl) document.getElementById('ykt-active-font')?.remove();
    activeFontUrl = '';
    return;
  }
  if (fontUrl === activeFontUrl) return;
  activeFontUrl = fontUrl;
  try {
    const dataUrl = (await fetchAsDataURL(fontUrl, 20000)).replace(/'/g, '%27');
    if (activeFontUrl !== fontUrl) return;
    document.getElementById('ykt-active-font')?.remove();
    const style = document.createElement('style');
    style.id = 'ykt-active-font';
    style.textContent = `@font-face{font-family:'ykt-encrypted';src:url('${dataUrl}');}`
      + ` #ykt-assign-tab .xuetangx-com-encrypted-font{font-family:'ykt-encrypted' !important;}`;
    document.head.appendChild(style);
  } catch (e) {
    if (activeFontUrl === fontUrl) activeFontUrl = '';   // 失败后允许下次重试
    log.warn('[assign] font inject failed', e);
  }
}

/** type 19「详情」/ type 20「回顾」入口。 */
async function openActiveDetail(a) {
  if (busy) return;
  if (!a.leafTypeId) { ui.toast?.('缺少作业标识，请先在官网打开一次该作业', 2500); return; }
  setBusy(true);
  try {
    if (a.type === 20) {
      setStatus(`正在读取「${a.title}」回顾…`);
      const detail = await fetchExamReview(a);
      if (detail.mode !== 'exam-review') {
        setStatus(detail.progress?.statusMessage || '该考试暂不可回顾（未出分或未公布），请在官网查看。');
        return;
      }
      showQuestionsView(detail, a.title, a);
    } else {
      setStatus(`正在读取「${a.title}」…`);
      const detail = await fetchExerciseDetail({
        leafTypeId: a.leafTypeId,
        classroomId: a.classroomId,
        uvId: uvIdFromCookie(document.cookie),
      });
      showQuestionsView(detail, detail.title || a.title, a);
    }
  } catch (e) {
    log.warn('[assign] active detail failed', e);
    setStatus('读取失败：' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

/** 加密字体题目：把题干+选项渲染成图，避免 AI 只看到私用区乱码。 */
async function captureActiveProblem(index) {
  try {
    const el = document.querySelectorAll('#ykt-ap-questions .ap-active-item')[index];
    if (!el || !el.querySelector('.xuetangx-com-encrypted-font')) return '';
    const body = el.querySelector('.ap-problem-body');
    if (!body) return '';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-99999px;top:0;width:720px;background:#fff;padding:12px;font-size:13px;line-height:1.6;';
    box.appendChild(body.cloneNode(true));
    for (const option of el.querySelectorAll('.ap-option')) box.appendChild(option.cloneNode(true));
    document.body.appendChild(box);
    try {
      try { await document.fonts?.ready; } catch { /* ignore */ }
      const html2canvas = await ensureHtml2Canvas();
      if (!html2canvas) return '';
      const canvas = await html2canvas(box, { backgroundColor: '#fff', useCORS: true, scale: 2 });
      return canvas.toDataURL('image/jpeg', 0.9);
    } finally {
      box.remove();
    }
  } catch (e) {
    log.warn('[assign] encrypted font capture failed', e);
    return '';
  }
}

/** 新版作业/考试题目的 AI 解答（仅展示，不提交）。 */
async function aiForActiveProblem(index) {
  try {
    const q = viewData?.problems?.[index];
    if (!q) return;
    const imageDataUrl = await captureActiveProblem(index);
    const task = buildExerciseTask({ problem: q, assignment: viewAssignment, imageDataUrl });
    if (!task) throw new Error('题目信息不完整');
    ui.showAIPanel?.(true);
    await askAnswer(task);
  } catch (e) {
    ui.toast?.('AI 解答失败：' + (e?.message || e), 3500);
  }
}

/** 列表里的 19/20 行补作答状态：不阻塞首屏，完成后重渲染。 */
async function enrichIfNeeded(seq = loadSeq) {
  if (!list.some((r) => r.type === 19 || r.type === 20)) return;
  const snapshot = list;
  const myCid = cid;
  setStatus('正在获取新版作业/考试状态…');
  let enriched;
  try {
    enriched = await enrichAssignments(snapshot);
  } catch (e) {
    if (seq !== loadSeq || cid !== myCid || list !== snapshot) return;
    log.warn('[assign] enrich failed', e);
    setStatus('状态获取失败：' + (e?.message || e));
    return;
  }
  // 等待期间用户切了课程：旧的 enrich 结果不能覆盖新列表
  if (seq !== loadSeq || cid !== myCid || list !== snapshot) return;
  list = enriched;
  renderList();
  setStatus(list.length ? `共 ${list.length} 项` : '没有找到作业');
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
    const detailBtn = a.type === 19 && a.leafTypeId
      ? `<button type="button" data-act="detail" data-id="${escapeHtml(a.id)}">详情</button>` : '';
    const reviewBtn = a.type === 20 && a.canReview && a.leafTypeId
      ? `<button type="button" data-act="review" data-id="${escapeHtml(a.id)}">回顾</button>` : '';
    return `<div class="ap-row" data-id="${escapeHtml(a.id)}">
      <input type="checkbox" class="ap-check" data-id="${escapeHtml(a.id)}" ${selected.has(a.id) ? 'checked' : ''}>
      <div class="ap-main">
        <div class="ap-title">${escapeHtml(a.title)}</div>
        <div class="ap-meta">${rowMetaParts(a)}</div>
      </div>
      <div class="ap-links">
        ${detailBtn}
        ${reviewBtn}
        ${a.oldId ? `<button type="button" data-q="${escapeHtml(a.id)}">题目</button>` : ''}
        ${oldU ? `<button type="button" data-link="${escapeHtml(oldU)}">老界面</button>` : ''}
        ${newU ? `<button type="button" data-link="${escapeHtml(newU)}">新界面</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function loadList(courseId) {
  const seq = ++loadSeq;
  cid = courseId;
  selected.clear();
  setStatus('正在读取作业列表…');
  let fetched;
  try {
    fetched = await fetchAssignments(cid);
  } catch (e) {
    if (seq !== loadSeq) return;
    log.warn('[assign] load failed', e);
    list = [];
    renderList();
    setStatus('读取失败：' + (e?.message || e));
    return;
  }
  if (seq !== loadSeq) return;   // 切课程了，丢弃旧响应
  list = fetched;
  renderList();
  setStatus(list.length ? `共 ${list.length} 项` : '没有找到作业');
  await enrichIfNeeded(seq);
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
      const scanSeq = loadSeq;
      setStatus('正在定位当前作业所属课程…');
      const found = await findCourseByQuiz(courses, quizId);
      if (found && scanSeq === loadSeq) {   // 扫描期间用户没切课程
        const seq = ++loadSeq;
        if (sel) sel.value = found.cid;
        list = found.list;
        cid = found.cid;
        selected.clear();
        renderList();
        setStatus(`共 ${list.length} 项`);
        await enrichIfNeeded(seq);
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
    const quizId = String(viewAssignment?.oldId || window.quizID || '');
    const task = buildAssignmentTask({
      quizData: viewData,
      index,
      assignment: viewAssignment,
      quizId,
      imageDataUrl: dataUrl,
    });
    if (!task) throw new Error('题目信息不完整');
    ui.showAIPanel?.(true);
    await askAnswer(task);
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
          traceKind: 'assignment',
          traceMode: 'none',
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
    const act = e.target.closest('button[data-act]');
    if (act) {
      if (act.dataset.act === 'detail' || act.dataset.act === 'review') {
        const a = list.find((x) => x.id === act.dataset.id);
        if (a) openActiveDetail(a);
      }
      return;
    }
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
    else if (btn.dataset.qact === 'aai') aiForActiveProblem(i);
  });

  document.body.appendChild(root);

  root.__yksOnShow = () => {
    renderCurrentCard();
    if (!loaded) { loaded = true; loadCourses(); }
  };
  renderCurrentCard();
  return root;
}
