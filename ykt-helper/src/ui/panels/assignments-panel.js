// src/ui/panels/assignments-panel.js
// 工具箱「作业」tab：本课作业列表 + 当前试卷题目 + 批量下载/批量 AI + 单题 AI（复用 AI 解答面板）
import { ui } from '../ui-api.js';
import { confirmDialog } from '../confirm.js';
import { askAnswer, getOverride } from './ai.js';
import { log } from '../../core/log.js';
import {
  getCourseContext, preferredCourse, rememberCourseSelection, subscribeCourseRoute,
} from '../../core/course-context.js';
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
import { buildExerciseTask, stripTags } from '../../answer/adapters/exercise.js';
import { collectExamQuestions, fillExamAnswers } from '../../quiz/exam-fill.js';
import { ensureExamConsent } from '../../core/exam-consent.js';
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
let lastFocusedRoute = '';
let autoOpening = false;

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
  ['#ykt-ap-zip', '#ykt-ap-ai', '#ykt-ap-refresh', '#ykt-ap-exam-fill'].forEach((s) => {
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

/**
 * 新版作业/考试题目的整题截图。
 * 不再只对加密字体截图：普通题目也可能只有图片/公式，文本不足以让 AI 作答。
 */
async function captureProblemCard(q) {
  if (!q) return '';
  try {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-99999px;top:0;width:760px;background:#fff;padding:14px;font:13px/1.65 system-ui,sans-serif;color:#111;';
    const body = document.createElement('div');
    body.innerHTML = sanitizeHtml(q.bodyHtml || '');
    box.appendChild(body);
    for (const o of (q.options || [])) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-top:8px;';
      row.textContent = `${o.label}. `;
      const opt = document.createElement('span');
      opt.innerHTML = sanitizeHtml(o.html || '');
      row.appendChild(opt);
      box.appendChild(row);
    }
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
    log.warn('[assign] problem capture failed', e);
    return '';
  }
}

async function captureActiveProblem(index) {
  const q = viewData?.problems?.[index];
  if (!q) return '';
  return captureProblemCard(q);
}

/** 考试页 DOM 题目截图（图片题/公式题/加密字体）。 */
async function captureExamElement(el) {
  if (!el) return '';
  try {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-99999px;top:0;width:760px;background:#fff;padding:14px;font:13px/1.65 system-ui,sans-serif;color:#111;';
    box.appendChild(el.cloneNode(true));
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
    log.warn('[assign] exam capture failed', e);
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
    // 只保留一个主入口：有新版入口走新版，只有老版时才走老版。
    let openBtn = '';
    if (a.type === 20 && a.canReview && a.leafTypeId) {
      openBtn = `<button type="button" data-act="review" data-id="${escapeHtml(a.id)}">回顾</button>`;
    } else if (a.type === 19 && a.leafTypeId) {
      openBtn = `<button type="button" data-act="detail" data-id="${escapeHtml(a.id)}">详情</button>`;
    } else if (a.type === 4 && a.oldId) {
      openBtn = `<button type="button" data-q="${escapeHtml(a.id)}">打开</button>`;
    } else if (newU) {
      openBtn = `<button type="button" data-link="${escapeHtml(newU)}">打开新界面</button>`;
    } else if (oldU) {
      openBtn = `<button type="button" data-link="${escapeHtml(oldU)}">打开老界面</button>`;
    }
    return `<div class="ap-row" data-id="${escapeHtml(a.id)}">
      <input type="checkbox" class="ap-check" data-id="${escapeHtml(a.id)}" ${selected.has(a.id) ? 'checked' : ''}>
      <div class="ap-main">
        <div class="ap-title">${escapeHtml(a.title)}</div>
        <div class="ap-meta">${rowMetaParts(a)}</div>
      </div>
      <div class="ap-links">${openBtn}</div>
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
  syncExamFillButton();
}

function routeKey(ctx) {
  return `${ctx.classId || ''}|${ctx.newId || ''}|${ctx.oldQuizId || ''}`;
}

/** 找到当前 URL 指向的作业/考试行。 */
function findRouteTarget(ctx = getCourseContext()) {
  if (!ctx.newId && !ctx.oldQuizId) return null;
  return list.find((a) => (
    (ctx.newId && (String(a.newId) === String(ctx.newId) || String(a.leafTypeId) === String(ctx.newId)))
    || (ctx.oldQuizId && String(a.oldId) === String(ctx.oldQuizId))
  )) || null;
}

/**
 * 当前页面是作业/考试时：选中对应行，并按需展开详情。
 * 只对“直接路由”生效；普通课程页只选课程，不自动展开题目。
 */
async function focusRouteTarget({ open = true } = {}) {
  const ctx = getCourseContext();
  if (!ctx.newId && !ctx.oldQuizId) return false;
  const key = routeKey(ctx);
  const target = findRouteTarget(ctx);
  if (!target) {
    setStatus('没有在列表中定位到当前作业/考试，请刷新或回到课程页重试。');
    return false;
  }
  selected.clear();
  selected.add(target.id);
  renderList();
  const row = [...root.querySelectorAll('.ap-row')].find((r) => String(r.dataset.id) === String(target.id));
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (!open || key === lastFocusedRoute) return true;
  lastFocusedRoute = key;

  // 直接路由：自动展开，用户不需要再找一次。
  if (target.type === 20) {
    if (target.canReview) await openActiveDetail(target);
    else setStatus(target.statusMessage || '该考试暂不可回顾；进行中考试可打开考试页使用 AI 参考。');
  } else if (target.type === 19) {
    await openActiveDetail(target);
  } else if (target.oldId) {
    await openAssignmentQuestions(target);
  }
  return true;
}

async function loadCourses() {
  if (autoOpening) return;
  autoOpening = true;
  setStatus('正在读取课程列表…');
  try {
    courses = await fetchCourses();
    const sel = $('#ykt-ap-course');
    if (sel) {
      sel.innerHTML = courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    }
    if (!courses.length) { setStatus('没有读取到课程'); return; }

    const ctx = getCourseContext();
    const oldQuizId = String(ctx.oldQuizId || window.quizID || '');
    if (oldQuizId) {
      const scanSeq = loadSeq;
      setStatus('正在定位当前作业所属课程…');
      const found = await findCourseByQuiz(courses, oldQuizId);
      if (found && scanSeq === loadSeq) {   // 扫描期间用户没切课程
        const seq = ++loadSeq;
        if (sel) sel.value = found.cid;
        list = found.list;
        cid = found.cid;
        selected.clear();
        renderList();
        setStatus(`共 ${list.length} 项`);
        await enrichIfNeeded(seq);
        await focusRouteTarget();
        return;
      }
    }

    const prefer = preferredCourse(courses, ctx) || courses[0];
    if (sel) sel.value = prefer.id;
    await loadList(prefer.id);
    await focusRouteTarget();
  } catch (e) {
    log.warn('[assign] courses failed', e);
    setStatus('读取课程失败：' + (e?.message || e));
  } finally {
    autoOpening = false;
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

function activeProblemPrompt(q) {
  const opts = (q.options || []).map((o) => `${o.label}. ${stripTags(o.html || '')}`).join('\n');
  return [
    `第 ${q.index ?? '?'} 题（${q.typeText || ''}，${q.score ?? ''} 分）`,
    stripTags(q.bodyHtml || ''),
    opts,
    (q.attachments || []).length ? `附件：${q.attachments.map((x) => x.name).join('、')}` : '',
  ].filter(Boolean).join('\n');
}

async function answerOneProblem({ prompt, imageDataUrl, override }) {
  const content = [{ type: 'text', text: prompt }];
  if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  const res = await agnesChat({
    messages: [
      { role: 'system', content: '你是学习助手。请根据题目文字和图片给出答案和简要步骤。填空题/选择题请明确写出答案。' },
      { role: 'user', content },
    ],
    stream: false,
    thinking: true,
    override,
    traceKind: 'assignment',
    traceMode: 'none',
  });
  return res.content || '（空回复）';
}

function currentExamContext() {
  const ctx = getCourseContext();
  const target = list.find((a) => Number(a.type) === 20 && (
    (ctx.newId && String(a.newId) === String(ctx.newId))
    || (ctx.oldQuizId && String(a.oldId) === String(ctx.oldQuizId))
  )) || null;
  const byTitle = /考试|exam/i.test(String(document.title || ''));
  const isExam = ctx.kind === 'exam' || !!target || (!!ctx.oldQuizId && byTitle);
  return {
    isExam,
    examId: ctx.newId || ctx.oldQuizId || target?.newId || target?.oldId || '',
    courseId: ctx.classId || cid,
    target,
  };
}

function syncExamFillButton() {
  const btn = $('#ykt-ap-exam-fill');
  if (!btn) return;
  btn.style.display = currentExamContext().isExam ? '' : 'none';
}

/**
 * 进行中考试：AI 逐题生成答案并写入当前页控件，不点击提交。
 * 第一次使用前弹免责确认；同意后永久记住。
 */
async function fillCurrentExam({ fromBatch = false } = {}) {
  const ctx = currentExamContext();
  if (!ctx.isExam) { ui.toast?.('当前页面不是考试页', 2200); return null; }
  const questions = collectExamQuestions(document);
  if (!questions.length) {
    ui.toast?.('未识别到考试题目控件；请确认考试页已加载，或使用「AI 解答」复制答案', 4000);
    return null;
  }
  const override = getOverride();
  if (!override) { ui.toast?.('请先在设置里配置 AI', 2500); return null; }
  const ok = await ensureExamConsent({
    mode: fromBatch ? 'batch' : 'single',
    examId: ctx.examId,
    courseId: ctx.courseId,
    source: 'exam-fill',
  });
  if (!ok) { ui.toast?.('已取消自动填入；不会生成或提交答案', 3000); return null; }

  if (!fromBatch) setBusy(true);
  const answers = [];
  try {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      setStatus(`考试 AI 填入：第 ${i + 1}/${questions.length} 题…`);
      const prompt = [
        '这是一道正在进行的考试题。请给出最终答案。',
        '选择题只返回选项字母（多选用逗号分隔）；填空题只返回填空内容；不要解释，不要重复题目。',
        q.text,
      ].join('\n');
      try {
        const imageDataUrl = await captureExamElement(q.element);
        const userContent = [{ type: 'text', text: prompt }];
        if (imageDataUrl) userContent.push({ type: 'image_url', image_url: { url: imageDataUrl } });
        const res = await agnesChat({
          messages: [
            { role: 'system', content: '你只输出考试题的最终答案，不输出过程或解释。选择题输出 A/B/C/D 字母，多选用逗号分隔。' },
            { role: 'user', content: userContent },
          ],
          stream: false,
          thinking: true,
          override,
          traceKind: 'exam',
          traceMode: 'none',
        });
        answers.push(String(res.content || '').trim());
      } catch (e) {
        answers.push('');
        log.warn('[assign] exam fill answer failed', i, e?.message || e);
      }
    }
    const result = fillExamAnswers(answers, { questions });
    setStatus(`考试填入完成：${result.filled} 题已填，${result.skipped} 题跳过；未提交，请逐题核对。`);
    ui.toast?.(`已填入 ${result.filled} 题，未提交；请核对后再手动交卷`, 4500);
    return result;
  } catch (e) {
    setStatus('考试填入失败：' + (e?.message || e));
    return null;
  } finally {
    if (!fromBatch) setBusy(false);
  }
}

async function examFillCurrent() {
  if (busy) return;
  await fillCurrentExam();
}

async function batchAI() {
  if (busy) return;
  const items = selectedItems().filter((a) => [4, 19, 20].includes(Number(a.type)));
  if (!items.length) { ui.toast?.('请先勾选作业或考试', 2500); return; }
  const override = getOverride();
  if (!override) { ui.toast?.('请先在设置里配置 AI', 2500); return; }
  const examCount = items.filter((a) => Number(a.type) === 20).length;
  const inProgressCount = items.filter((a) => Number(a.type) === 20 && !a.canReview).length;
  const detail = [
    `将依次对 ${items.length} 份作业/考试调用 AI 解答，题目较多时耗时和费用都会增加。`,
    examCount ? `其中 ${examCount} 份是考试；AI 只生成参考，不自动提交。` : '',
    inProgressCount ? `有 ${inProgressCount} 份进行中/不可回顾考试：只有当前打开的考试页能自动填入，其余会被跳过。` : '',
    '考试规则风险请自行承担。确定继续吗？',
  ].filter(Boolean).join('\n');
  const ok = await confirmDialog(detail, { okText: '开始解答', danger: true });
  if (!ok) return;

  setBusy(true);
  const md = [];
  let done = 0;
  try {
    for (const a of items) {
      md.push(`# ${a.title}\n`);
      setStatus(`正在读取「${a.title}」…`);
      try {
        if (Number(a.type) === 4) {
          if (!a.oldId) { md.push('> 缺少老版作业入口，已跳过。\n'); continue; }
          const data = await fetchQuizDataById(a.oldId);
          const slides = data.Slides || [];
          for (let i = 0; i < slides.length; i++) {
            if (!slides[i]?.Problem) continue;
            done++;
            setStatus(`正在解答「${a.title}」第 ${i + 1} 题（已完成 ${done} 题）…`);
            try {
              const imageDataUrl = await quizQuestionDataUrl(data, i, 2);
              const p = slides[i].Problem;
              const answer = await answerOneProblem({
                prompt: `第 ${i + 1} 题（${p.Type || ''}，${p.Score ?? ''} 分）`,
                imageDataUrl,
                override,
              });
              md.push(`## 第 ${i + 1} 题\n\n${answer}\n`);
            } catch (e) {
              md.push(`## 第 ${i + 1} 题\n\n> 解答失败：${e?.message || e}\n`);
            }
          }
        } else if (Number(a.type) === 19) {
          const detail = await fetchExerciseDetail({
            leafTypeId: a.leafTypeId,
            classroomId: a.classroomId,
            uvId: uvIdFromCookie(document.cookie),
          });
          await injectActiveFont(detail.fontUrl);
          for (const q of (detail.problems || [])) {
            done++;
            setStatus(`正在解答「${a.title}」第 ${q.index ?? done} 题（已完成 ${done} 题）…`);
            try {
              const imageDataUrl = await captureProblemCard(q);
              const answer = await answerOneProblem({
                prompt: activeProblemPrompt(q),
                imageDataUrl,
                override,
              });
              md.push(`## 第 ${q.index ?? done} 题\n\n${answer}\n`);
            } catch (e) {
              md.push(`## 第 ${q.index ?? done} 题\n\n> 解答失败：${e?.message || e}\n`);
            }
          }
        } else if (Number(a.type) === 20) {
          if (!a.canReview) {
            const current = currentExamContext();
            const samePage = current.isExam && current.examId && (
              (a.newId && String(current.examId) === String(a.newId))
              || (a.oldId && String(current.examId) === String(a.oldId))
            );
            if (samePage) {
              // 进行中考试只能在当前打开的考试页读取并填入；不后台抓题、不提交。
              const r = await fillCurrentExam({ fromBatch: true });
              if (r) {
                done += r.filled;
                md.push(`> 已在当前考试页自动填入 ${r.filled} 题，跳过 ${r.skipped} 题；未提交，请核对后手动交卷。\n`);
              } else {
                md.push('> 当前考试页自动填入已取消或失败；未提交。\n');
              }
            } else {
              md.push('> 进行中或不可回顾的考试需要先打开考试页；本工具不后台抓题、不自动提交。\n');
            }
            continue;
          }
          const detail = await fetchExamReview(a);
          if (detail.mode !== 'exam-review') {
            md.push(`> 暂不可回顾：${detail.progress?.statusMessage || '未出分或未公布'}\n`);
            continue;
          }
          await injectActiveFont(detail.fontUrl);
          for (const q of (detail.problems || [])) {
            done++;
            setStatus(`正在解答「${a.title}」第 ${q.index ?? done} 题（已完成 ${done} 题）…`);
            try {
              const imageDataUrl = await captureProblemCard(q);
              const answer = await answerOneProblem({
                prompt: activeProblemPrompt(q),
                imageDataUrl,
                override,
              });
              md.push(`## 第 ${q.index ?? done} 题\n\n${answer}\n`);
            } catch (e) {
              md.push(`## 第 ${q.index ?? done} 题\n\n> 解答失败：${e?.message || e}\n`);
            }
          }
        }
      } catch (e) {
        md.push(`> 读取失败：${e?.message || e}\n`);
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
    <div class="panel-header"><h3>作业/考试</h3></div>
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
        <button type="button" id="ykt-ap-exam-fill" style="display:none;border-color:#f59e0b;color:#92400e;">考试 AI 自动填入（不提交）</button>
      </div>
      <div id="ykt-ap-status" class="ap-status"></div>
      <div id="ykt-ap-list" class="ap-list"></div>
      <div id="ykt-ap-questions" class="ap-questions" style="display:none"></div>
    </div>`;

  $('#ykt-ap-course')?.addEventListener('change', (e) => {
    rememberCourseSelection(e.target.value);
    showListView();
    loadList(e.target.value);
  });
  $('#ykt-ap-refresh')?.addEventListener('click', () => loadList(cid));
  $('#ykt-ap-all')?.addEventListener('change', (e) => {
    if (e.target.checked) list.forEach((a) => selected.add(a.id));
    else selected.clear();
    renderList();
  });
  $('#ykt-ap-zip')?.addEventListener('click', batchZip);
  $('#ykt-ap-ai')?.addEventListener('click', batchAI);
  $('#ykt-ap-exam-fill')?.addEventListener('click', examFillCurrent);

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
    const ctx = getCourseContext();
    syncExamFillButton();
    if (!loaded) {
      loaded = true;
      loadCourses();
      return;
    }
    if (ctx.newId || ctx.oldQuizId) void focusRouteTarget();
    else renderCurrentCard();
  };
  subscribeCourseRoute(() => {
    const ctx = getCourseContext();
    if (!ctx.newId && !ctx.oldQuizId) return;
    // 直接进入新版/老版作业或考试页：自动切到「作业/考试」。
    setTimeout(() => {
      try { ui.showAssignmentsPanel?.(true); } catch { /* ignore */ }
    }, 350);
  });
  renderCurrentCard();
  const initialCtx = getCourseContext();
  if (initialCtx.newId || initialCtx.oldQuizId) {
    setTimeout(() => {
      try { ui.showAssignmentsPanel?.(true); } catch { /* ignore */ }
    }, 900);
  }
  return root;
}
