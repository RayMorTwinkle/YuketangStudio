// src/ui/panels/assign-panel.js
// 本课作业列表：老版/新版入口 + 批量下载 + 批量 AI 解答
import { ui } from '../ui-api.js';
import { confirmDialog } from '../confirm.js';
import { agnesChat } from '../../ai/agnes.js';
import { getOverride } from './ai.js';
import { log } from '../../core/log.js';
import {
  fetchCourses, fetchAssignments, findCourseByQuiz, fetchQuizDataById,
  oldUrl, newUrl,
} from '../../quiz/assignments.js';
import { composeSlide, canvasBlob, saveBlob, zipStore, quizQuestionDataUrl } from '../../quiz/quiz-paper.js';

let mounted = false;
let root = null;
let courses = [];
let cid = '';
let list = [];
let selected = new Set();
let busy = false;
let pendingQuizId = '';

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

function status(text) {
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
        ${oldU ? `<button data-link="${escapeHtml(oldU)}">老界面</button>` : ''}
        ${newU ? `<button data-link="${escapeHtml(newU)}">新界面</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function loadList(courseId) {
  cid = courseId;
  selected.clear();
  status('正在读取作业列表…');
  try {
    list = await fetchAssignments(cid);
    renderList();
    status(list.length ? `共 ${list.length} 项` : '没有找到作业');
  } catch (e) {
    log.warn('[assign] load failed', e);
    list = [];
    renderList();
    status('读取失败：' + (e?.message || e));
  }
}

async function loadCourses() {
  status('正在读取课程列表…');
  try {
    courses = await fetchCourses();
    const sel = $('#ykt-ap-course');
    if (sel) {
      sel.innerHTML = courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    }
    if (!courses.length) { status('没有读取到课程'); return; }
    if (pendingQuizId) {
      status('正在定位当前作业所属课程…');
      const found = await findCourseByQuiz(courses, pendingQuizId);
      if (found) {
        if (sel) sel.value = found.cid;
        list = found.list;
        cid = found.cid;
        selected.clear();
        renderList();
        status(`共 ${list.length} 项`);
        pendingQuizId = '';
        return;
      }
      pendingQuizId = '';
    }
    const urlCid = new URLSearchParams(location.search).get('classroom_id');
    const prefer = courses.find((c) => c.id === urlCid) || courses[0];
    if (sel) sel.value = prefer.id;
    await loadList(prefer.id);
  } catch (e) {
    log.warn('[assign] courses failed', e);
    status('读取课程失败：' + (e?.message || e));
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
      status(`正在导出「${a.title}」…`);
      const data = await fetchQuizDataById(a.oldId);
      for (let i = 0; i < (data.Slides || []).length; i++) {
        if (!data.Slides[i]?.Problem) continue;
        const canvas = await composeSlide(data.Slides[i], data, 2);
        const blob = await canvasBlob(canvas);
        files.push({
          name: `${safeName(a.title)}/第${i + 1}题.jpg`,
          data: new Uint8Array(await blob.arrayBuffer()),
        });
        status(`正在导出「${a.title}」… 已 ${files.length} 张`);
      }
    }
    if (!files.length) throw new Error('没有可导出的题目');
    status(`正在打包 ${files.length} 张图片…`);
    await saveBlob(zipStore(files), `作业图片_${stamp()}.zip`);
    status(`已导出 ${files.length} 张图片`);
  } catch (e) {
    status('批量下载失败：' + (e?.message || e));
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
      const count = (data.Slides || []).filter((s) => s?.Problem).length;
      total += count;
      datasets.push({ a, data });
    }
    for (const { a, data } of datasets) {
      md.push(`# ${a.title}\n`);
      for (let i = 0; i < (data.Slides || []).length; i++) {
        if (!data.Slides[i]?.Problem) continue;
        status(`正在解答「${a.title}」第 ${i + 1} 题（${done + 1}/${total}）…`);
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
    status(`已完成 ${done} 题，解答已保存为 Markdown`);
  } catch (e) {
    status('批量解答中断：' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

export function mountAssignPanel() {
  if (mounted) return root;
  const existing = document.getElementById('ykt-assign-panel');
  if (existing) { mounted = true; root = existing; return root; }
  mounted = true;

  root = document.createElement('div');
  root.id = 'ykt-assign-panel';
  root.className = 'ykt-panel';
  root.innerHTML = `
    <div class="panel-header">
      <h3>本课作业</h3>
      <span class="ap-close" title="关闭">×</span>
    </div>
    <div class="panel-body">
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
    </div>`;
  document.body.appendChild(root);

  root.querySelector('.ap-close')?.addEventListener('click', () => root.classList.remove('visible'));
  $('#ykt-ap-course')?.addEventListener('change', (e) => loadList(e.target.value));
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
    if (link) {
      location.href = link.dataset.link;
      return;
    }
  });
  $('#ykt-ap-list')?.addEventListener('change', (e) => {
    const cb = e.target.closest('.ap-check');
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.id);
    else selected.delete(cb.dataset.id);
  });

  window.addEventListener('ykt:open-assign', (ev) => {
    const quizId = ev?.detail?.quizId ? String(ev.detail.quizId) : '';
    showAssignPanel(quizId);
  });

  if (!pendingQuizId) loadCourses();
  return root;
}

export function showAssignPanel(quizId = '') {
  if (quizId) pendingQuizId = quizId;
  const p = mountAssignPanel();
  if (!p) return;
  document.getElementById('ykt-quiz-panel')?.classList.remove('visible');
  p.classList.add('visible');
  if (quizId) loadCourses();
}

export function toggleAssignPanel() {
  const p = mountAssignPanel();
  if (!p) return;
  p.classList.toggle('visible');
}
