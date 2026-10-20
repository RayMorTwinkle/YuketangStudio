// src/ui/panels/quiz-panel.js
// 作业页工具面板：逐题下载 / ZIP / PDF / 长图 / AI 讲解
import { ui } from '../ui-api.js';
import { agnesChat } from '../../ai/agnes.js';
import { getOverride, mdToHtml } from './ai.js';
import { log } from '../../core/log.js';
import {
  isQuizPage, readQuizData, quizMeta, quizQuestionDataUrl,
  downloadQuestion, downloadAllZip, downloadPdf, downloadLongImage,
} from '../../quiz/quiz-paper.js';

let mounted = false;
let root = null;
let busy = false;
let aiCtrl = null;

function typeText(t) {
  const map = {
    FillBlank: '填空题', SingleChoice: '单选题', MultipleChoice: '多选题',
    Judgement: '判断题', Subjective: '主观题', Poll: '投票', Exam: '试卷', Link: '外链题',
  };
  return map[t] || t || '题目';
}

function renderMeta(data) {
  const m = quizMeta(data);
  const el = root?.querySelector('#ykt-quiz-meta');
  if (!el) return;
  el.innerHTML = `<b>${escapeHtml(m.title)}</b><br><span class="quiz-sub">${m.count} 题 · 图片 ${m.width}×${m.height} · ${m.showAnswer ? '含答案' : '不含答案'}</span>`;
}

function renderList(data) {
  const list = root?.querySelector('#ykt-quiz-list');
  if (!list) return;
  const rows = [];
  (data?.Slides || []).forEach((s, i) => {
    if (!s?.Problem) return;
    const p = s.Problem;
    rows.push(`<div class="quiz-item">
      <div class="quiz-idx">${i + 1}</div>
      <div class="quiz-info"><b>${typeText(p.Type)}</b> · ${p.Score ?? 0} 分</div>
      <button type="button" data-act="dl" data-i="${i}">下载</button>
      <button type="button" data-act="ai" data-i="${i}">AI 讲解</button>
    </div>`);
  });
  list.innerHTML = rows.join('') || '<div class="quiz-empty">没有识别到题目</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function runBusy(label, fn) {
  if (busy) { ui.toast?.('正在处理，请稍候', 1500); return; }
  busy = true;
  ui.toast?.(label, 2000);
  try {
    await fn();
  } catch (e) {
    log.warn('[quiz] action failed', e);
    ui.toast?.(`失败：${e?.message || e}`, 3000);
  } finally {
    busy = false;
  }
}

async function askAI(index) {
  const data = readQuizData();
  if (!data) { ui.toast?.('没有读取到试卷数据', 2500); return; }
  const answerEl = root?.querySelector('#ykt-quiz-answer');
  if (!answerEl) return;
  answerEl.style.display = 'block';
  answerEl.innerHTML = '<div class="quiz-ai-loading">正在生成解答…</div>';
  answerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const dataUrl = await quizQuestionDataUrl(data, index, 2);
    const p = data.Slides?.[index]?.Problem || {};
    let text = '';
    const paint = () => {
      answerEl.innerHTML = text ? mdToHtml(text) : '<div class="quiz-ai-loading">正在生成解答…</div>';
    };
    aiCtrl = new AbortController();
    await agnesChat({
      messages: [
        {
          role: 'system',
          content: '你是学习助手。请根据题目图片给出详细解答：先给出最终答案，再写推导步骤。填空题/选择题请明确写出答案。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `第 ${index + 1} 题（${typeText(p.Type)}，${p.Score ?? ''} 分）` },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      stream: true,
      thinking: true,
      signal: aiCtrl.signal,
      override: getOverride() || undefined,
      onDelta: (d) => { text += d; paint(); },
      onReasoning: () => {},
    });
    paint();
  } catch (e) {
    answerEl.innerHTML = `<div class="quiz-ai-err">解答失败：${escapeHtml(e?.message || e)}</div>`;
  } finally {
    aiCtrl = null;
  }
}

export function mountQuizPanel() {
  if (mounted) return root;
  const existing = document.getElementById('ykt-quiz-panel');
  if (existing) { mounted = true; root = existing; return root; }
  if (!isQuizPage()) return null;
  const data = readQuizData();
  if (!data) return null;
  mounted = true;

  root = document.createElement('div');
  root.id = 'ykt-quiz-panel';
  root.className = 'ykt-panel';
  root.innerHTML = `
    <div class="panel-header">
      <h3>作业工具</h3>
      <span class="quiz-close" title="关闭">×</span>
    </div>
    <div class="panel-body">
      <div class="quiz-meta" id="ykt-quiz-meta"></div>
      <div class="quiz-actions">
        <button type="button" id="ykt-quiz-zip">下载全部 JPG（ZIP）</button>
        <button type="button" id="ykt-quiz-pdf">生成 PDF</button>
        <button type="button" id="ykt-quiz-long">生成长图</button>
      </div>
      <div class="quiz-list" id="ykt-quiz-list"></div>
      <div class="quiz-answer" id="ykt-quiz-answer" style="display:none"></div>
    </div>`;
  document.body.appendChild(root);

  renderMeta(data);
  renderList(data);

  root.querySelector('.quiz-close')?.addEventListener('click', () => root.classList.remove('visible'));
  root.querySelector('#ykt-quiz-zip')?.addEventListener('click', () => runBusy('正在打包 ZIP…', () => downloadAllZip(data)));
  root.querySelector('#ykt-quiz-pdf')?.addEventListener('click', () => runBusy('正在生成 PDF…', () => downloadPdf(data)));
  root.querySelector('#ykt-quiz-long')?.addEventListener('click', () => runBusy('正在生成长图…', () => downloadLongImage(data)));

  root.querySelector('#ykt-quiz-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.act === 'dl') {
      runBusy(`正在导出第 ${i + 1} 题…`, () => downloadQuestion(data, i));
    } else if (btn.dataset.act === 'ai') {
      if (aiCtrl) { try { aiCtrl.abort(); } catch {} }
      askAI(i);
    }
  });

  window.addEventListener('ykt:open-quiz', () => toggleQuizPanel());
  return root;
}

export function showQuizPanel(visible = true) {
  const p = mountQuizPanel();
  if (!p) return;
  p.classList.toggle('visible', !!visible);
}

export function toggleQuizPanel() {
  const p = mountQuizPanel();
  if (!p) { ui.toast?.('当前页面不是作业页', 2000); return; }
  p.classList.toggle('visible');
}
