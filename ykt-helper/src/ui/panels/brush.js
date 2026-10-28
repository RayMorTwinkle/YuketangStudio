// src/ui/panels/brush.js
// 刷课页：当前课程内容扫描、成绩概览、班级上传课件逐页阅读。
// 视频/图文后续复用同一队列；当前版本先把最缺的班级课件链路做通。
import tpl from './brush.html';
import { ui } from '../ui-api.js';
import { log } from '../../core/log.js';
import { currentClassId } from '../../core/history-capture.js';
import { fetchCourses } from '../../quiz/assignments.js';
import {
  fetchClassCards, fetchClassCardProgress, fetchCourseScores,
} from '../../quiz/course-cards.js';

let mounted = false;
let root;
let courses = [];
let current = null;
let items = [];
let running = false;
let paused = false;
let stopped = false;
let busy = false;

const TYPE_LABEL = {
  0: '视频', 1: '音频', 2: '直播', 3: '图文', 4: '讨论',
  5: '考试', 6: '作业', 7: '班级课件', 8: '课堂', 9: '试卷',
};
const BRUSHABLE = new Set([0, 1, 3, 7]);

function $(sel) { return root?.querySelector(sel); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmt(v) { return Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : '—'; }

function logLine(text, level = 'info') {
  const box = $('#ykt-brush-log');
  if (!box) return;
  const line = document.createElement('div');
  line.dataset.level = level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.childElementCount > 200) box.firstElementChild?.remove();
}

export function mountBrushPanel() {
  if (mounted) return root;
  const wrap = document.createElement('div');
  wrap.innerHTML = tpl;
  document.body.appendChild(wrap.firstElementChild);
  root = document.getElementById('ykt-brush-panel');

  $('#ykt-brush-scan')?.addEventListener('click', () => scanCourse());
  $('#ykt-brush-start')?.addEventListener('click', () => start());
  $('#ykt-brush-pause')?.addEventListener('click', () => togglePause());
  $('#ykt-brush-stop')?.addEventListener('click', () => stop());
  $('#ykt-brush-only-score')?.addEventListener('change', renderQueue);
  $('#ykt-brush-course')?.addEventListener('change', (e) => {
    current = courses.find((c) => c.id === e.target.value) || null;
    updateScoreView(null);
    items = [];
    renderQueue();
  });

  mounted = true;
  root.__yksOnShow = () => { void refreshCourses(); };
  void refreshCourses();
  return root;
}

async function refreshCourses() {
  try {
    courses = await fetchCourses();
    const sel = $('#ykt-brush-course');
    if (!sel) return;
    const cid = currentClassId();
    const preferred = courses.find((c) => c.id === cid) || (current && courses.find((c) => c.id === current.id)) || courses[0];
    sel.innerHTML = courses.map((c) => `<option value="${c.id}">${escapeText(c.name)}</option>`).join('');
    if (preferred) {
      sel.value = preferred.id;
      current = preferred;
    }
    if (!courses.length) logLine('没有读取到课程列表，请确认已登录雨课堂。', 'warn');
  } catch (e) {
    logLine('读取课程失败：' + (e?.message || e), 'bad');
    log.warn('[brush] refreshCourses failed', e);
  }
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function findOutlineComponent(v, seen = new Set()) {
  if (!v || seen.has(v)) return null;
  seen.add(v);
  try {
    if (v.$data && Array.isArray(v.$data.origin_chapter_list)) return v;
  } catch { /* ignore */ }
  for (const child of v.$children || []) {
    const hit = findOutlineComponent(child, seen);
    if (hit) return hit;
  }
  return null;
}

function outlineFromDocument(doc) {
  if (!doc) return null;
  const roots = [
    doc.querySelector?.('.lesson_student__container'),
    doc.querySelector?.('.study-content__container'),
    doc.querySelector?.('.study-content'),
  ].filter(Boolean);
  for (const el of roots) {
    const hit = findOutlineComponent(el.__vue__);
    if (hit) return hit;
  }
  // 兜底：从任意带 __vue__ 的节点向上找
  for (const el of doc.querySelectorAll?.('[class*="lesson"],[class*="study"],[class*="content"]') || []) {
    const hit = findOutlineComponent(el.__vue__);
    if (hit) return hit;
  }
  return null;
}

function readOutline() {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* cross-origin */ }
  }
  for (const doc of docs) {
    const vm = outlineFromDocument(doc);
    if (vm) {
      const data = vm.$data || {};
      const cls = vm.$props?.yktIframe?.classroomData || {};
      return {
        leaves: (data.origin_chapter_list || []).flatMap((ch) => ch.section_leaf_list || []),
        schedules: data.leaf_schedules || {},
        skuId: String(vm.$props?.skuId || cls.free_sku_id || cls.sku_id || ''),
        courseName: cls.course_name || vm.$props?.classInfo?.course_name || '',
      };
    }
  }
  return null;
}

async function waitOutline(timeout = 9000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const out = readOutline();
    if (out?.leaves?.length) return out;
    await sleep(500);
  }
  return null;
}

function scheduleOf(schedule) {
  if (typeof schedule === 'number') return { done: schedule ? 1 : 0, total: 1 };
  if (schedule && typeof schedule === 'object') {
    return {
      done: Number(schedule.done) || 0,
      total: Number(schedule.total) || 0,
      status: Number(schedule.status) || 0,
      score: Number.isFinite(Number(schedule.score)) ? Number(schedule.score) : null,
    };
  }
  return { done: 0, total: 0 };
}

function makeItems(outline, classCards, score) {
  const evalById = new Map((score?.summary?.evaluation || []).map((e) => [String(e.id), e]));
  const scoreById = new Map((score?.items || []).map((x) => [String(x.id), x]));
  const cardByTitle = new Map();
  for (const c of classCards) {
    if (!cardByTitle.has(c.title)) cardByTitle.set(c.title, c);
  }
  const rows = [];
  const leaves = outline?.leaves || [];
  for (const leaf of leaves) {
    const type = Number(leaf.leaf_type) || 0;
    const schedule = scheduleOf(outline?.schedules?.[String(leaf.id)]);
    const scoreRow = scoreById.get(String(leaf.id));
    const card = type === 7 ? cardByTitle.get(String(leaf.name || '')) || null : null;
    const evalId = scoreRow?.evaluationId;
    const weight = evalId && evalById.has(String(evalId))
      ? evalById.get(String(evalId)).proportion
      : (leaf.is_score ? 1 : 0);
    rows.push({
      id: String(leaf.id),
      title: String(leaf.name || '未命名内容'),
      type,
      typeLabel: TYPE_LABEL[type] || `类型${type}`,
      schedule,
      completed: schedule.total > 0 ? schedule.done >= schedule.total : false,
      brushable: BRUSHABLE.has(type),
      scored: !!leaf.is_score && Number(weight) > 0,
      weight: Number(weight) || 0,
      isScore: !!leaf.is_score,
      cardsId: card?.cardsId || '',
      activityId: card?.activityId || '',
      total: card?.count || schedule.total || 0,
      state: 'idle',
    });
  }
  // 没有 outline 时，至少让班级课件可刷
  if (!rows.length && Array.isArray(classCards)) {
    for (const c of classCards) {
      rows.push({
        id: `classcard:${c.cardsId}`,
        title: c.title,
        type: 7,
        typeLabel: '班级课件',
        schedule: { done: 0, total: Number(c.count) || 0 },
        completed: false,
        brushable: true,
        scored: true,
        weight: 1,
        isScore: true,
        cardsId: c.cardsId,
        activityId: c.activityId,
        total: Number(c.count) || 0,
        state: 'idle',
      });
    }
  }
  return rows;
}

async function scanCourse() {
  if (busy || running) return;
  busy = true;
  const btn = $('#ykt-brush-scan');
  if (btn) btn.disabled = true;
  try {
    const cid = current?.id || currentClassId();
    if (!cid) {
      ui.toast('请先打开一个课程页面', 2500);
      return;
    }
    logLine(`扫描课程 ${cid}…`);
    if (!courses.length) await refreshCourses();
    current = current || courses.find((c) => c.id === cid) || null;
    let classCards = [];
    try { classCards = await fetchClassCards(cid); } catch (e) { logLine('班级课件列表读取失败：' + (e?.message || e), 'warn'); }
    let score = null;
    if (current?.skuId) {
      try {
        score = await fetchCourseScores(cid, current.skuId);
        updateScoreView(score);
      } catch (e) {
        logLine('成绩读取失败：' + (e?.message || e), 'warn');
      }
    } else {
      updateScoreView(null);
    }
    const outline = await waitOutline();
    if (outline?.skuId && current && !current.skuId) current.skuId = outline.skuId;
    if (current?.skuId && !score) {
      try {
        score = await fetchCourseScores(cid, current.skuId);
        updateScoreView(score);
      } catch (e) {
        logLine('成绩读取失败：' + (e?.message || e), 'warn');
      }
    }
    items = makeItems(outline, classCards, score);
    if (!outline) logLine('没有读到课程目录数据；先只加载班级上传课件。', 'warn');
    renderQueue();
    const unfinished = items.filter((x) => x.brushable && !x.completed).length;
    ui.toast(`扫描完成：${items.length} 个内容，${unfinished} 个可刷`, 2800);
    logLine(`扫描完成：总 ${items.length}，可刷未完成 ${unfinished}，班级课件 ${classCards.length}`);
  } finally {
    busy = false;
    if (btn) btn.disabled = false;
  }
}

function updateScoreView(score) {
  const box = $('#ykt-brush-score');
  if (!box) return;
  const s = score?.summary;
  const st = score?.statistic;
  const vals = [
    ['我的总评', s?.finalScore],
    ['班级平均', st?.average],
    ['班级最高', st?.max],
    ['班级最低', st?.min],
  ];
  box.innerHTML = vals.map(([k, v]) => `<span>${k} <b>${fmt(v)}</b></span>`).join('');
}

function visibleItems() {
  const only = !!$('#ykt-brush-only-score')?.checked;
  return items.filter((x) => (only ? x.scored : true));
}

function renderQueue() {
  const box = $('#ykt-brush-queue');
  if (!box) return;
  const list = visibleItems();
  if (!list.length) {
    box.innerHTML = '<div class="brush-empty">没有可显示内容。先打开课程页并点击「扫描内容」。</div>';
    updateButtons();
    return;
  }
  box.innerHTML = '';
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'brush-item';
    row.dataset.id = it.id;
    const title = document.createElement('div');
    title.className = 'bi-title';
    const b = document.createElement('b');
    b.textContent = it.title;
    const meta = document.createElement('div');
    meta.className = 'bi-meta';
    meta.textContent = `${it.typeLabel} · ${it.weight ? `占比 ${Math.round(it.weight * 100)}%` : '不计入总评'} · ${it.total ? `${it.schedule.done}/${it.total}` : (it.completed ? '已完成' : '未开始')}`;
    title.appendChild(b);
    title.appendChild(meta);
    const state = document.createElement('span');
    state.className = 'bi-state';
    state.textContent = stateText(it);
    if (it.completed) state.classList.add('ok');
    if (it.state === 'run') state.classList.add('run');
    if (it.state === 'fail') state.classList.add('bad');
    row.appendChild(title);
    row.appendChild(state);
    box.appendChild(row);
  }
  updateButtons();
}

function stateText(it) {
  if (it.state === 'run') return '进行中…';
  if (it.state === 'ok') return '已完成';
  if (it.state === 'skip') return '跳过';
  if (it.state === 'pending') return '已执行待确认';
  if (it.state === 'fail') return '未确认';
  if (it.completed) return '已完成';
  if (!it.brushable) return '非刷课项';
  return '待处理';
}

function updateItemState(it, state) {
  it.state = state;
  const row = [...root.querySelectorAll('.brush-item')].find((r) => r.dataset.id === it.id);
  const el = row?.querySelector('.bi-state');
  if (el) {
    el.textContent = stateText(it);
    el.className = 'bi-state' + (state === 'ok' ? ' ok' : state === 'fail' ? ' bad' : state === 'run' ? ' run' : '');
  }
}

function updateButtons() {
  const start = $('#ykt-brush-start');
  const pause = $('#ykt-brush-pause');
  const stop = $('#ykt-brush-stop');
  if (start) start.disabled = running || !items.some((x) => x.brushable && !x.completed);
  if (pause) pause.disabled = !running;
  if (stop) stop.disabled = !running;
}

async function start() {
  if (running) return;
  if (!items.length) await scanCourse();
  if (!items.some((x) => x.brushable && !x.completed)) {
    ui.toast('没有可刷的未完成内容', 2000);
    return;
  }
  running = true;
  paused = false;
  stopped = false;
  updateButtons();
  logLine('开始刷课');
  try {
    for (const it of visibleItems()) {
      if (stopped) break;
      while (paused && !stopped) await sleep(500);
      if (stopped) break;
      if (!it.brushable || it.completed) continue;
      if (it.type === 7) {
        await processClassCard(it);
      } else if (it.type === 3 || it.type === 0 || it.type === 1) {
        await processContentLeaf(it);
      } else {
        updateItemState(it, 'skip');
        logLine(`跳过非刷课项 ${it.typeLabel}：「${it.title}」`, 'warn');
        continue;
      }
      await sleep(900);
    }
  } finally {
    running = false;
    paused = false;
    updateButtons();
    logLine(stopped ? '已停止' : '本轮结束');
  }
}

function togglePause() {
  if (!running) return;
  paused = !paused;
  const b = $('#ykt-brush-pause');
  if (b) b.textContent = paused ? '继续' : '暂停';
  logLine(paused ? '已暂停' : '已继续');
}

function stop() {
  stopped = true;
  paused = false;
  logLine('停止请求已发出');
}

function cardUrl(it) {
  const cid = current?.id || currentClassId();
  if (!cid || !it.cardsId || !it.activityId) return '';
  const qs = new URLSearchParams({
    university_id: new URLSearchParams(location.search).get('university_id') || '3195',
    platform_id: '3',
    classroom_id: cid,
  });
  return `${location.origin}/v2/web/studentCards/${encodeURIComponent(cid)}/${encodeURIComponent(it.cardsId)}/${encodeURIComponent(it.activityId)}/ppt?${qs}`;
}

async function waitViewerReady(viewer, timeout = 12000, selector = '.swiper-slide .page') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const d = viewer.contentDocument;
      if (d && d.querySelector(selector)) return d;
    } catch { /* cross-origin during load */ }
    await sleep(400);
  }
  return null;
}

function contentUrl(it) {
  const cid = current?.id || currentClassId();
  if (!cid || !it.id) return '';
  return `${location.origin}/ai-workspace/lms-graph/${encodeURIComponent(cid)}/graph/${encodeURIComponent(it.id)}?is_chapter=1`;
}

/** 图文/视频/音频：在隐藏 iframe 打开 ai-workspace 内容页，做真实阅读/播放。 */
async function processContentLeaf(it) {
  updateItemState(it, 'run');
  const viewer = $('#ykt-brush-viewer');
  const url = contentUrl(it);
  if (!viewer || !url) {
    updateItemState(it, 'pending');
    return false;
  }
  logLine(`打开${it.typeLabel}：${it.title}`);
  viewer.style.display = 'block';
  viewer.src = url;
  const d = await waitViewerReady(viewer, 18000, '.leaf-item,.content-main,.article-content,.rich-text,video,audio');
  if (!d) {
    updateItemState(it, 'pending');
    logLine(`内容页加载未确认：${it.title}`, 'warn');
    viewer.src = 'about:blank';
    viewer.style.display = 'none';
    return false;
  }
  let ended = false;
  try {
    if (it.type === 3) {
      const area = d.querySelector('.content-main,.article-content,.rich-text,.markdown-body') || d.scrollingElement || d.body;
      for (let i = 0; i < 18 && !stopped; i++) {
        try {
          area.scrollBy ? area.scrollBy(0, 260) : (area.scrollTop += 260);
        } catch { /* ignore */ }
        await sleep(450);
      }
      // 有些图文需要点“完成/已读”；只点明确的完成按钮，不碰题目提交
      const btn = d.querySelector('.btn-complete,.finish-btn,.mark-read,button[class*="complete"],button[class*="finish"]');
      if (btn) { try { btn.click(); } catch { /* ignore */ } }
      await sleep(1800);
    } else {
      const media = d.querySelector('video,audio');
      if (!media) {
        updateItemState(it, 'pending');
        logLine(`未找到${it.typeLabel}播放器：${it.title}`, 'warn');
        return false;
      }
      const mute = !!$('#ykt-brush-mute')?.checked;
      const rate = Number($('#ykt-brush-rate')?.value) || 2;
      if (mute) { media.muted = true; media.volume = 0; }
      try { media.playbackRate = rate; } catch { /* ignore */ }
      if ($('#ykt-brush-from-start')?.checked) { try { media.currentTime = 0; } catch { /* ignore */ } }
      media.addEventListener('ended', () => { ended = true; }, { once: true });
      try { await media.play(); } catch { /* autoplay may be blocked */ }
      const maxWait = 30 * 60 * 1000;
      const start = Date.now();
      while (!stopped && !ended && Date.now() - start < maxWait) {
        while (paused && !stopped) await sleep(500);
        if (stopped) break;
        if (media.ended) { ended = true; break; }
        await sleep(1000);
      }
      try { media.pause(); } catch { /* ignore */ }
      logLine(`${it.typeLabel}播放${ended ? '完成' : '已停止'}：${it.title}`);
    }
  } finally {
    viewer.src = 'about:blank';
    viewer.style.display = 'none';
  }
  // 图文/视频没有和 cards/view_depth 等价的单接口进度，先标记“已执行待确认”，
  // 不伪造完成；用户可重新扫描看官方目录状态。
  updateItemState(it, 'pending');
  renderQueue();
  return ended || it.type === 3;
}

async function processClassCard(it) {
  updateItemState(it, 'run');
  const url = cardUrl(it);
  if (!url) {
    updateItemState(it, 'fail');
    logLine(`缺少 cardsId/activityId：「${it.title}」`, 'bad');
    return false;
  }
  const cid = current?.id || currentClassId();
  const viewer = $('#ykt-brush-viewer');
  if (!viewer) return false;
  logLine(`打开班级课件：${it.title}`);
  viewer.style.display = 'block';
  viewer.src = url;
  const d = await waitViewerReady(viewer);
  if (!d) {
    updateItemState(it, 'fail');
    logLine(`课件加载失败：${it.title}`, 'bad');
    viewer.src = 'about:blank';
    viewer.style.display = 'none';
    return false;
  }

  let before = null;
  try { before = await fetchClassCardProgress(cid, it.cardsId); } catch { /* ignore */ }
  const read = new Set((before?.depthDetail || []).map((x) => Number(x)));
  const thumbs = [...d.querySelectorAll('.swiper-slide')]
    .map((el) => {
      const page = Number(el.querySelector('.page')?.textContent?.trim());
      return Number.isFinite(page) && page > 0 ? { el, page } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.page - b.page);
  const total = Math.max(it.total || 0, thumbs.length, before?.depth || 0);
  let processed = 0;
  for (const t of thumbs) {
    if (stopped) break;
    while (paused && !stopped) await sleep(500);
    if (stopped) break;
    if (read.has(t.page - 1)) continue;
    try {
      (t.el.querySelector('.page') || t.el).click();
      processed++;
      await sleep(2200);
    } catch { /* continue */ }
    if (processed % 4 === 0) logLine(`「${it.title}」已翻 ${processed} 页`);
  }
  // 没有缩略图时按下一页/键盘兜底
  if (!thumbs.length) {
    const next = d.querySelector('.swiper-button-next,.ppt-next,.next-page,[class*="next"][class*="page"]');
    for (let i = 0; i < Math.min(200, total || 100); i++) {
      if (stopped) break;
      while (paused && !stopped) await sleep(500);
      if (next) next.click();
      else {
        d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
      }
      await sleep(1800);
    }
  }
  await sleep(1800);
  let after = null;
  try { after = await fetchClassCardProgress(cid, it.cardsId); } catch { /* ignore */ }
  viewer.src = 'about:blank';
  viewer.style.display = 'none';
  const ok = (after?.depth || 0) > (before?.depth || 0);
  it.schedule = { done: after?.depth || 0, total: total || after?.depth || 0 };
  it.total = it.schedule.total;
  it.completed = it.total > 0 && it.schedule.done >= it.total;
  updateItemState(it, ok || it.completed ? 'ok' : 'fail');
  logLine(`${it.completed ? '已完成' : '未确认'}：${it.title}（${it.schedule.done}/${it.total}）`, ok || it.completed ? 'info' : 'warn');
  renderQueue();
  return ok || it.completed;
}
