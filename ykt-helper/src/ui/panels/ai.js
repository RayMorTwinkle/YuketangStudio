// src/ui/panels/ai.js
// AI 解答面板：只负责 UI / 流式渲染 / 触发 AnswerEngine。
// 答题上下文、解析、提交全部在 src/answer/ 下，面板不再判断 __submitTarget 之类字段。
import tpl from './ai.html';
import { log } from '../../core/log.js';
import { ui } from '../ui-api.js';
import { repo } from '../../state/repo.js';
import { escapeHtml, ensureImageUrl } from '../../core/dom.js';
import { DEFAULT_SYSTEM_PROMPT_AI } from '../../core/types.js';
import { agnesChat } from '../../ai/agnes.js';
import { resolveCurrentSlideImage } from '../slide-image.js';
import { captureSlideImage } from '../../capture/screenshoot.js';
import { getCurrentMainPageMeta } from '../../core/vuex-helper.js';
import { buildClassroomTask } from '../../answer/adapters/classroom.js';
import { resolveCurrentTask, pickCurrentSlide, resolveActiveProblemTask } from '../../answer/context.js';
import { runAnswer } from '../../answer/engine.js';
import { submitAnswerTask } from '../../answer/submit.js';
import { buildUserContent } from '../../answer/prompt.js';
import { stripRegexAnswer } from '../../answer/parse.js';
import { answerLog, getAnswerLog } from '../../answer/debug.js';
import * as telemetry from '../../core/telemetry.js';
import { renderAnswerCard } from './answer-card.js';
import { mdToHtml, renderRich, StreamRenderer, warmupRichAssets } from '../rich.js';

export { mdToHtml, renderRich, StreamRenderer, warmupRichAssets };

const L = (...a) => log.dbg('[ai]', ...a);

let mounted = false;
let root;
let history = [];           // 手动问答历史（作业/自动作答绝不写入）
let streaming = false;
let abortCtrl = null;
let lastTask = null;        // 显式任务（作业/题目列表/自动作答）
let lastRequest = null;     // { task, userText, history } 供重试
let lastRunResult = null;   // 最近一次答题结果（诊断报告用）
let lastThumbKey = '';
let ctxPollTimer = null;

const systemPrompt = () => String(ui?.config?.systemPromptAI || '').trim() || DEFAULT_SYSTEM_PROMPT_AI;

function $(sel) { return root?.querySelector(sel); }

function setStreamingFlag(on) {
  try {
    if (on) document.body.dataset.yksStreaming = '1';
    else delete document.body.dataset.yksStreaming;
  } catch {}
}

function traceUiError(task, runId, e, stage) {
  telemetry.trace({
    event: 'answer_ui_error',
    taskId: task?.id || '',
    runId: runId || '',
    source: task?.source || '',
    type: task?.question?.type || '',
    target: task?.target?.kind || '',
    stage: stage || 'ui',
    ok: false,
    error: { name: e?.name || 'Error', code: e?.code || 'UI_ERROR', message: String(e?.message || e) },
  });
}

// ---------------- 面板 ----------------

export function mountAIPanel() {
  if (mounted) return root;
  const host = document.createElement('div');
  host.innerHTML = tpl;
  document.body.appendChild(host.firstElementChild);
  root = document.getElementById('ykt-ai-answer-panel');

  $('#ykt-ai-report')?.addEventListener('click', () => uploadDiagnosticReport());

  $('#ykt-ai-clear').addEventListener('click', () => {
    abortStreaming('清空会话');
    history = [];
    lastTask = null;
    lastRequest = null;
    renderHistory();
    renderCtxStatus();
    addBubble('ai', mdToHtml('会话已清空。点击「发送」（输入留空）可解答当前页题目。'));
  });

  const $input = $('#ykt-ai-input');
  const $send = $('#ykt-ai-send');
  $send.addEventListener('click', () => sendCurrent());
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });

  const statusEl = $('#ykt-ai-text-status');
  if (statusEl) {
    statusEl.setAttribute('role', 'button');
    statusEl.setAttribute('tabindex', '0');
    statusEl.addEventListener('click', () => renderCtxStatus({ force: true }));
    statusEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderCtxStatus({ force: true }); }
    });
  }
  function syncSlideSourceButtons() {
    const current = ui.config.aiSlideSource || 'teacher';
    root.querySelectorAll('#ykt-ai-ctx [data-slide-source]').forEach((b) => {
      b.classList.toggle('active', b.dataset.slideSource === current);
    });
  }
  root.querySelectorAll('#ykt-ai-ctx [data-slide-source]').forEach((b) => {
    b.addEventListener('click', () => {
      ui.config.aiSlideSource = b.dataset.slideSource === 'selected' ? 'selected' : 'teacher';
      ui.saveConfig();
      syncSlideSourceButtons();
      renderCtxStatus({ force: true });
    });
  });
  syncSlideSourceButtons();
  window.addEventListener('ykt:problem:parsed', () => renderCtxStatus());
  window.addEventListener('ykt:presentation:slide-selected', () => {
    // 题目列表/课件面板选页：只刷新状态；真正的任务由 askAnswer(task) 显式传入
    renderCtxStatus({ force: true });
  });

  warmupRichAssets();
  mounted = true;
  renderCtxStatus();
  if (!ctxPollTimer) {
    ctxPollTimer = setInterval(() => {
      if (root?.classList.contains('visible')) renderCtxStatus({ light: true });
    }, 2000);
  }
  root.__yksOnShow = () => {
    // 手动打开 AI tab：清掉上一次的显式任务，回到当前页
    lastTask = null;
    renderCtxStatus();
    if (history.length === 0 && !$('#ykt-ai-log').children.length) {
      addBubble('ai', mdToHtml('点击「发送」（输入留空）即可解答当前页题目；也可以直接输入问题针对页面内容追问。'));
    }
    if (ui.config.aiAutoAnalyze && history.length === 0 && !streaming && !lastTask) {
      queueMicrotask(() => sendCurrent());
    }
  };
  root.__yksOnHide = () => {};
  return root;
}

export function showAIPanel(v = true) {
  if (!mounted) mountAIPanel();
  root.classList.toggle('visible', !!v);
  if (v) {
    lastTask = null;
    renderCtxStatus();
    if (history.length === 0) {
      addBubble('ai', mdToHtml('点击「发送」（输入留空）即可解答当前页题目；也可以直接输入问题针对页面内容追问。'));
    }
    if (ui.config.aiAutoAnalyze && history.length === 0 && !streaming) {
      queueMicrotask(() => sendCurrent());
    }
    setTimeout(() => $('#ykt-ai-input')?.focus(), 60);
  }
  L('showAIPanel', { visible: v });
}

function abortStreaming(reason = '已取消') {
  if (abortCtrl) {
    try { abortCtrl.abort(reason); } catch {}
  }
}

// ---------------- 状态 ----------------

function taskForStatus() {
  if (lastTask) return lastTask;
  const { slide } = pickCurrentSlide();
  const problem = slide?.problem;
  if (!problem) return null;
  const status = repo.problemStatus.get(String(problem.problemId)) || null;
  return buildClassroomTask({
    problem, slide, status, lessonId: repo.currentLessonId, imageDataUrl: '', source: 'classroom',
  });
}

function updateCtxPlaceholder(task) {
  const input = $('#ykt-ai-input');
  if (!input) return;
  if (!task) {
    input.placeholder = '当前页无题目，可输入问题提问（Enter 发送）';
    return;
  }
  if (task.target?.kind === 'quiz') {
    input.placeholder = '留空发送 = 解答本题并暂存（Enter 发送）';
  } else if (task.target?.allowSubmit) {
    input.placeholder = '留空发送 = 解答本题并提交（Enter 发送）';
  } else {
    input.placeholder = '留空发送 = 解答本题（仅展示，不提交）';
  }
}

function renderCtxStatus({ light = false, force = false } = {}) {
  if (!mounted) return;
  const statusEl = $('#ykt-ai-text-status');
  if (!statusEl) return;

  const task = taskForStatus();
  const problem = task?.question;
  const label = problem?.typeLabel || '题目';
  const canSubmit = !!task?.target?.allowSubmit;
  const targetKind = task?.target?.kind || 'display';
  const isQuiz = targetKind === 'quiz';
  const meta = (() => { try { return getMetaSafe(); } catch { return null; } })();
  const looksProblem = !!(meta?.problemID || String(meta?.type || '') === 'problem');

  let cls; let text; let title;
  if (task) {
    cls = canSubmit ? (isQuiz ? 'st-info' : 'st-ok') : 'st-warn';
    text = canSubmit
      ? `${label} · ${isQuiz ? '作业暂存' : '可提交'}`
      : `${label} · 仅展示${task.target?.answered ? '（已作答）' : ''}`;
    title = `来源：${task.source === 'assignment' ? '作业' : task.source === 'problem-list' ? '题目列表' : '当前页'}`
      + `\n题型：${label}`;
  } else if (looksProblem) {
    cls = 'st-busy';
    text = '题目页解析中…';
    title = '当前页是题目页，但题目数据还没到；稍等会自动刷新';
  } else {
    cls = 'st-idle';
    text = '当前页无题目 · 仅问答';
    title = '这一页不是题目页，可以输入问题提问';
  }

  statusEl.className = `ctx-status ${cls}`;
  statusEl.textContent = text;
  statusEl.title = `${title}\n（点击重新检测）`;
  updateCtxPlaceholder(task);

  if (!light && root?.classList.contains('visible')) {
    renderCtxThumb({ force, task });
  }
}

function getMetaSafe() {
  try { return getCurrentMainPageMeta(); } catch { return null; }
}

async function renderCtxThumb({ force = false, task = null } = {}) {
  const span = $('#ykt-ai-ctx-thumb');
  if (!span) return;
  const key = task
    ? `task:${task.id}:${task.question?.image?.dataUrl ? 'img' : 'noimg'}`
    : `slide:${pickCurrentSlide().slide?.id || 'none'}`;
  if (!force && key === lastThumbKey) return;
  lastThumbKey = key;
  span.textContent = '⏳';
  let dataUrl = task?.question?.image?.dataUrl || '';
  if (!dataUrl) {
    const taskSlideId = task?.question?.image?.slideId;
    // 作业题没有 slide，不能拿当前 PPT 页冒充；课堂/题目列表才按 slide 取图
    const slideId = taskSlideId || (!task ? pickCurrentSlide().slide?.id : null);
    if (slideId) {
      try { dataUrl = await captureSlideImage(String(slideId)) || ''; } catch { /* ignore */ }
    }
  }
  if (key !== lastThumbKey) return;
  if (dataUrl) {
    span.innerHTML = '';
    const img = document.createElement('img');
    img.src = ensureImageUrl(dataUrl);
    img.title = task ? '指定题目' : '当前 PPT 页';
    span.appendChild(img);
  } else {
    span.textContent = '（无图）';
  }
}

// ---------------- 气泡 / 历史 ----------------

function addBubble(kind, htmlOrNode) {
  const $log = $('#ykt-ai-log');
  const div = document.createElement('div');
  div.className = `ykt-ai-msg ${kind}`;
  if (typeof htmlOrNode === 'string') div.innerHTML = htmlOrNode;
  else div.appendChild(htmlOrNode);
  $log.appendChild(div);
  $log.scrollTop = $log.scrollHeight;
  return div;
}

/** 控制历史图片数量：除最近 N 张外替换为占位文本 */
function trimHistoryImages(keep = 1) {
  const imgMsgs = [];
  for (const m of history) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const idx = m.content.map((c, i) => (c.type === 'image_url' ? i : -1)).filter((i) => i >= 0);
    if (idx.length) imgMsgs.push({ m, idx });
  }
  for (const { m, idx } of imgMsgs.slice(0, Math.max(0, imgMsgs.length - keep))) {
    for (const i of idx) m.content[i] = { type: 'text', text: '[此前的题目图片已省略]' };
  }
}

function renderHistory() {
  const $log = $('#ykt-ai-log');
  $log.innerHTML = '';
  for (const m of history) {
    const text = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }])
      .filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const imgs = (Array.isArray(m.content) ? m.content : [])
      .filter((c) => c.type === 'image_url').map((c) => c.image_url.url);
    const div = document.createElement('div');
    div.className = `ykt-ai-msg ${m.role === 'user' ? 'user' : 'ai'}`;
    if (m.role === 'user') {
      div.textContent = text || '（图片）';
      for (const src of imgs) {
        const img = document.createElement('img'); img.src = src; div.appendChild(img);
      }
    } else {
      div.innerHTML = mdToHtml(text);
    }
    $log.appendChild(div);
  }
  $log.scrollTop = $log.scrollHeight;
}

// ---------------- 流式执行 ----------------

function createBubbleState({ userHtml, userImage = '', aiWaiting = '思考中…' }) {
  const userBubble = addBubble('user', userHtml);
  if (userImage) {
    const img = document.createElement('img');
    img.src = ensureImageUrl(userImage);
    img.alt = '题目截图';
    userBubble.appendChild(img);
  }
  const aiBubble = addBubble('ai', `<em>${aiWaiting}</em>`);
  const waitActions = document.createElement('div');
  waitActions.style.cssText = 'display:flex;gap:8px;align-items:center;margin:-4px 0 8px 2px';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:2px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;cursor:pointer;font-size:12px';
  cancelBtn.addEventListener('click', () => abortStreaming('用户取消'));
  waitActions.appendChild(cancelBtn);
  aiBubble.insertAdjacentElement('afterend', waitActions);
  return { userBubble, aiBubble, waitActions, cancelBtn };
}

function paintStream(aiBubble, renderer, acc, waitText, phaseRef) {
  const phase = phaseRef.value;
  aiBubble.innerHTML =
    (acc.reasoning
      ? `<details ${phase === 'thinking' ? 'open' : ''}><summary>💭 思考过程${phase === 'thinking' ? '（进行中…）' : '（点击展开）'}</summary><div class="reasoning-body"></div></details>`
      : '')
    + '<div class="ykt-sr-content"></div>';
  renderer.attach(aiBubble.querySelector('.ykt-sr-content'));
  renderer.update(acc.content, phase === 'thinking' ? '' : `<em>${waitText}</em>`);
  const rBody = aiBubble.querySelector('.reasoning-body');
  if (rBody) { rBody.textContent = acc.reasoning; rBody.scrollTop = rBody.scrollHeight; }
  const $log = $('#ykt-ai-log');
  if ($log) $log.scrollTop = $log.scrollHeight;
}

/**
 * 执行一个显式任务，渲染流式与答案卡片。
 * @returns {Promise<{ok:boolean, run:object, task:object}>}
 */
async function executeTask(task, {
  userText = '',
  historyMessages = [],
  autoSubmit = false,
  soft = false,
  showUser = true,
} = {}) {
  const ov = getOverride();
  const transport = !task.target?.allowSubmit ? 'text' : (ui.config.regexToolCall ? 'regex' : 'tools');
  const userHtml = escapeHtml(userText || task.question?.body || '请解答本题');
  const { aiBubble, waitActions } = createBubbleState({
    userHtml,
    userImage: task.question?.image?.dataUrl || '',
    aiWaiting: '思考中…',
  });
  if (!showUser) {
    // 自动作答等场景仍希望看到题目气泡；保留默认
  }

  const acc = { content: '', reasoning: '' };
  let renderer = new StreamRenderer();
  let raf = 0;
  let waitText = '思考中…';
  const phaseRef = { value: 'waiting' };
  const paint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (phaseRef.value !== 'answering' && acc.content) phaseRef.value = 'answering';
      else if (phaseRef.value === 'waiting' && acc.reasoning) phaseRef.value = 'thinking';
      paintStream(aiBubble, renderer, acc, waitText, phaseRef);
    });
  };

  abortCtrl = new AbortController();
  const startedAt = Date.now();
  answerLog('run_start', { taskId: task.id, source: task.source, type: task.question?.type, transport, autoSubmit });

  let run;
  try {
    run = await runAnswer(task, {
      transport,
      baseSystem: systemPrompt(),
      history: historyMessages,
      userText,
      autoSubmit,
      soft,
      override: ov || undefined,
      signal: abortCtrl.signal,
      stream: true,
      thinking: ov?.thinking !== false,
      allowLegacyText: !autoSubmit,
      onDelta: (d) => { acc.content += d; paint(); },
      onReasoning: (d) => { acc.reasoning += d; paint(); },
      onWait: (ms) => {
        if (acc.content || acc.reasoning) return;
        waitText = ms >= 20000 ? '等待时间较长，可取消后重试'
          : ms >= 10000 ? '排队时间较长，上游可能繁忙…' : '正在排队…';
        aiBubble.innerHTML = `<em>${waitText}</em>`;
      },
      onAttempt: ({ attempt }) => {
        if (attempt > 1) {
          acc.content = '';
          acc.reasoning = '';
          phaseRef.value = 'waiting';
          waitText = `重试中（第 ${attempt} 次）…`;
          renderer = new StreamRenderer();
          aiBubble.innerHTML = `<em>${waitText}</em>`;
        }
      },
    });
  } catch (e) {
    run = { ok: false, error: e, transport, attempts: 1 };
  } finally {
    waitActions.remove();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  acc.content = run?.res?.content || acc.content;
  acc.reasoning = run?.res?.reasoning || acc.reasoning;
  const displayContent = run?.answer?.source === 'regex' || /<answer[\s>]/i.test(acc.content)
    ? stripRegexAnswer(acc.content)
    : acc.content;

  aiBubble.innerHTML =
    (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : '')
    + '<div class="ykt-sr-content"></div>';
  renderer = new StreamRenderer();
  renderer.attach(aiBubble.querySelector('.ykt-sr-content'));
  if (displayContent) await renderer.finish(displayContent);
  else if (run?.ok) aiBubble.querySelector('.ykt-sr-content').innerHTML = '<span class="muted">✅ 已生成答案</span>';
  else aiBubble.querySelector('.ykt-sr-content').innerHTML = '<span class="err">（空回复）</span>';

  if (run?.ok && run.answer) {
    try {
      const card = renderAnswerCard(aiBubble, {
        task,
        answer: run.answer,
        autoSubmit,
        runId: run?.runId || '',
      });
      // 自动提交时等待卡片内部提交完成
      if (autoSubmit && card?.__submitPromise) await card.__submitPromise;
    } catch (e) {
      traceUiError(task, run?.runId, e, 'render_card');
      addBubble('ai', `<span class="err">答案卡片渲染失败：${escapeHtml(e?.message || e)}</span>`);
    }
  } else if (run && run.ok === false) {
    renderRunError(aiBubble, run, task);
  }

  const elapsed = Date.now() - startedAt;
  lastRunResult = {
    runId: run?.runId || '',
    ok: !!run?.ok,
    code: run?.error?.code || '',
    message: run?.error?.message || '',
    transport: run?.transport || transport,
    attempts: run?.attempts || 0,
    taskId: task.id,
    source: task.source,
    type: task.question?.type,
    autoSubmit: !!autoSubmit,
    elapsedMs: elapsed,
  };
  answerLog('run_done', {
    taskId: task.id,
    source: task.source,
    type: task.question?.type,
    transport: run?.transport,
    attempts: run?.attempts,
    ok: !!run?.ok,
    code: run?.error?.code || '',
    elapsed,
  });
  return { ok: !!run?.ok, run, task, displayContent };
}

function renderRunError(aiBubble, run, task) {
  const code = run?.error?.code || '';
  const msg = String(run?.error?.message || '作答失败');
  let text;
  if (code === 'ABORTED') text = `（已中断：${escapeHtml(msg)}）`;
  else if (code === 'HTTP' && /429/.test(msg)) text = '当前使用人数较多，请稍后重试';
  else if (code === 'TIMEOUT') text = '等待超时，请重试';
  else if (code === 'NO_TOOL') text = '模型没有按格式提交答案';
  else if (code === 'INVALID_ANSWER' || code === 'INVALID_ARGS') text = `答案格式无效：${escapeHtml(msg)}`;
  else text = `出错了：${escapeHtml(msg)}`;

  const warn = document.createElement('div');
  warn.className = 'ykt-chat-warn';
  warn.innerHTML = `<span class="err">${text}</span>`;
  const retry = document.createElement('button');
  retry.className = 'ykt-retry-btn';
  retry.style.cssText = 'margin-left:8px;padding:2px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;cursor:pointer;font-size:12px';
  retry.textContent = '↻ 重试';
  retry.addEventListener('click', () => {
    if (lastRequest?.task?.id !== task?.id) return;
    if (streaming) { ui.toast?.('AI 正在作答，请稍候', 1500); return; }
    streaming = true;
    setStreamingFlag(true);
    const sendBtn = $('#ykt-ai-send');
    if (sendBtn) sendBtn.disabled = true;
    executeTask(lastRequest.task, {
      userText: lastRequest.userText,
      historyMessages: lastRequest.historyMessages,
      autoSubmit: false,
      soft: lastRequest.soft,
    }).finally(() => {
      streaming = false;
      setStreamingFlag(false);
      abortCtrl = null;
      if (sendBtn) sendBtn.disabled = false;
    });
  });
  warn.appendChild(retry);
  aiBubble.appendChild(warn);
}


// ---------------- 诊断报告 ----------------

function redactBaseUrl(u) {
  try { const x = new URL(String(u || '')); return x.origin + x.pathname; }
  catch { return String(u || '').split('?')[0].slice(0, 200); }
}

function taskSnapshot(task) {
  if (!task) return null;
  const q = task.question || {};
  const img = q.image?.dataUrl || '';
  const includeImage = img.length <= 300 * 1024;
  return {
    id: task.id,
    source: task.source,
    question: {
      type: q.type,
      typeLabel: q.typeLabel,
      body: q.body || '',
      options: q.options || [],
      optionLabels: q.optionLabels || [],
      blanks: q.blanks || 0,
      image: {
        bytes: img.length,
        included: includeImage,
        dataUrl: includeImage ? img : '',
        slideId: q.image?.slideId || '',
        quizId: q.image?.quizId || '',
        index: q.image?.index ?? null,
      },
    },
    target: task.target || {},
    meta: task.meta || {},
  };
}

export function buildDiagnosticReport() {
  const task = lastTask || taskForStatus();
  const aiCfg = ui.config.ai || {};
  const profiles = Array.isArray(aiCfg.profiles) ? aiCfg.profiles : [];
  const active = profiles.find((p) => p.id === aiCfg.activeProfileId) || profiles[0] || null;
  const report = {
    kind: 'YuketangStudio diagnostic',
    time: new Date().toISOString(),
    version: telemetry.getVersion(),
    page: location.origin + location.pathname,
    userAgent: navigator.userAgent,
    platform: window.YktBridge ? 'android' : 'pc',
    testMode: (() => { try { return localStorage.getItem('ykt:test-mode') === '1'; } catch { return false; } })(),
    config: {
      regexToolCall: !!ui.config.regexToolCall,
      enhancedTelemetry: telemetry.enhancedEnabled(),
      ai: {
        profile: active ? { id: active.id, name: active.name, baseUrl: redactBaseUrl(active.baseUrl), model: active.visionModel || active.model, hasKey: !!active.apiKey } : null,
        profileCount: profiles.length,
      },
    },
    task: taskSnapshot(task),
    lastRun: lastRunResult,
    lastRequest: lastRequest ? { taskId: lastRequest.task?.id || '', userText: lastRequest.userText || '', historyLen: (lastRequest.historyMessages || []).length } : null,
    history: getAIHistory().slice(-8),
    answerLog: getAnswerLog().slice(-60),
  };
  const json = JSON.stringify(report, null, 2);
  const summary = [
    'YuketangStudio 诊断报告',
    `时间: ${report.time}`,
    `版本: ${report.version} / ${report.platform}`,
    `页面: ${report.page}`,
    `任务: ${task ? `${task.id} (${task.source}, ${task.question?.type})` : '无'}`,
    `最近运行: ${lastRunResult ? `${lastRunResult.ok ? '成功' : '失败'} ${lastRunResult.code || ''} runId=${lastRunResult.runId || ''}` : '无'}`,
    `强化遥测: ${report.config.enhancedTelemetry ? '开' : '关'}`,
  ].join('\n');
  return { json, summary, task };
}

async function copyText(text) {
  let copied = false;
  // Android 原生桥最可靠（WebView 的 clipboard/execCommand 在部分机型会失败）
  try {
    if (window.YktBridge?.copyText) {
      window.YktBridge.copyText(text);
      return true;
    }
  } catch { /* fall through */ }
  if (navigator.clipboard?.writeText) {
    // 某些 WebView/权限状态下 writeText 会一直 pending；最多等 600ms
    copied = await Promise.race([
      navigator.clipboard.writeText(text).then(() => true).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 600)),
    ]);
  }
  if (!copied) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand('copy');
      ta.remove();
    } catch { copied = false; }
  }
  return copied;
}

/**
 * 诊断按钮：上传完整 JSON 到服务器，成功后只复制短 ID；
 * 上传失败才复制完整 JSON 作为兜底。不再保存本地文件。
 */
export async function uploadDiagnosticReport() {
  try {
    const { json, summary, task } = buildDiagnosticReport();
    let report;
    try { report = JSON.parse(json); }
    catch (e) {
      ui.toast?.('诊断报告序列化失败', 3000);
      return { ok: false, error: String(e?.message || e) };
    }

    let uploaded = null;
    let uploadError = '';
    try {
      uploaded = await telemetry.uploadDiagnostic(report);
    } catch (e) {
      uploadError = String(e?.message || e);
    }

    if (uploaded?.id) {
      const short = [
        '诊断已上传',
        `ID: ${uploaded.id}`,
        `时间: ${report.time}`,
        `版本: ${report.version} / ${report.platform}`,
        `任务: ${task?.id || '无'}`,
        `runId: ${lastRunResult?.runId || '无'}`,
      ].join('\n');
      const copied = await copyText(short);
      ui.toast?.(`诊断已上传：${uploaded.id}${copied ? '（ID 已复制）' : ''}`, 4200);
      answerLog('diagnostic_upload', {
        taskId: task?.id || '', diagnosticId: uploaded.id, ok: true, bytes: json.length, copied,
      });
      return { ok: true, id: uploaded.id, date: uploaded.date, json, summary, copied, uploaded: true };
    }

    const copied = await copyText(json);
    ui.toast?.(copied ? '诊断上传失败，已复制 JSON，可直接粘贴给我' : '诊断上传失败，请稍后重试', 5000);
    answerLog('diagnostic_upload', {
      taskId: task?.id || '', ok: false, bytes: json.length, error: uploadError, copied,
    });
    return { ok: false, error: uploadError || 'upload failed', json, summary, copied, uploaded: false };
  } catch (e) {
    ui.toast?.('诊断报告生成失败：' + (e?.message || e), 3000);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 兼容旧调用名 */
export const copyDiagnosticReport = uploadDiagnosticReport;

// ---------------- 对外入口 ----------------

/** 当前 AI Profile */
export function getOverride() {
  const aiCfg = ui.config.ai;
  const profiles = Array.isArray(aiCfg?.profiles) ? aiCfg.profiles : [];
  const p = profiles.find((x) => x.id === aiCfg.activeProfileId) || profiles[0];
  if (!p || !p.apiKey) return null;
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.visionModel || p.model,
    reasoningEffort: p.reasoningEffort,
    thinking: p.thinking !== false,
  };
}

/**
 * 显式任务入口：作业 / 题目列表 / 自动作答 / 测试。
 * 使用独立消息数组，不读写手动 history。
 */
export async function askAnswer(task, { autoSubmit = false, userText = '', soft = false } = {}) {
  if (!mounted) mountAIPanel();
  if (!task) { ui.toast?.('没有题目', 2000); return null; }
  if (streaming) { ui.toast?.('AI 正在作答，请稍候', 1500); return null; }
  streaming = true;
  setStreamingFlag(true);
  const sendBtn = $('#ykt-ai-send');
  if (sendBtn) sendBtn.disabled = true;
  lastTask = task;
  lastRequest = { task, userText, historyMessages: [], soft };
  renderCtxStatus();
  try {
    return await executeTask(task, { userText, historyMessages: [], autoSubmit, soft });
  } catch (e) {
    traceUiError(task, '', e, 'execute');
    throw e;
  } finally {
    streaming = false;
    setStreamingFlag(false);
    abortCtrl = null;
    if (sendBtn) sendBtn.disabled = false;
  }
}

/**
 * 答题提醒卡片 / 通知 → 指定题目解答。
 * 显式带 problemId 构建任务，不依赖当前页，避免和题目页 AI 行为不一致。
 */
export async function askProblem(problemId) {
  const r = await resolveActiveProblemTask(problemId);
  if (!r.task) { ui.toast?.('题目信息不完整，无法解答', 2200); return null; }
  showAIPanel(true);
  try {
    return await askAnswer(r.task);
  } catch (e) {
    log.warn('[ai] askProblem failed', e);
    ui.toast?.('AI 解答失败：' + (e?.message || e), 2600);
    return null;
  }
}

/** 兼容旧调用：指定题目 + 可选自动提交 */
export async function askAIForProblem(problem, { autoSubmit = false } = {}) {
  if (!problem) return null;
  const status = repo.problemStatus.get(String(problem.problemId)) || null;
  let image = problem.__imageDataUrl || '';
  if (!image) {
    try { image = await captureSlideImage(String(status?.slideId || '')) || ''; } catch { /* ignore */ }
  }
  if (!image) {
    try { image = (await resolveCurrentSlideImage())?.dataUrl || ''; } catch { /* ignore */ }
  }
  const task = buildClassroomTask({
    problem,
    slide: status?.slideId ? repo.slides.get(String(status.slideId)) : null,
    status,
    lessonId: repo.currentLessonId,
    imageDataUrl: image,
    source: 'classroom',
  });
  if (!task) return null;
  // 自动作答不打开面板、不写 history
  if (autoSubmit) {
    const ov = getOverride();
    const transport = !task.target.allowSubmit ? 'text' : (ui.config.regexToolCall ? 'regex' : 'tools');
    const r = await runAnswer(task, {
      transport,
      baseSystem: systemPrompt(),
      autoSubmit: true,
      override: ov || undefined,
      stream: false,
      allowLegacyText: false,
    });
    if (!r.ok) return r;
    const submitResult = await submitAnswerTask(task, r.answer, { runId: r.runId });
    return { ...r, submitResult };
  }
  ui.showAIPanel(true);
  return askAnswer(task, { autoSubmit: false });
}

/** 手动发送当前页/追问 */
export async function sendCurrent({ retryText = null } = {}) {
  if (!mounted) mountAIPanel();
  if (streaming) { ui.toast?.('AI 正在作答，请稍候', 1500); return null; }
  const $input = $('#ykt-ai-input');
  const text = retryText !== null ? retryText : String($input?.value || '').trim();

  // 作业/题目列表任务的追问：独立会话，不污染手动 history
  if (lastTask && !retryText) {
    if ($input) $input.value = '';
    return askAnswer(lastTask, { userText: text, soft: !!text });
  }

  // 先上锁再 await，防止双击/回车连发产生两个并发请求
  const sendBtn = $('#ykt-ai-send');
  streaming = true;
  setStreamingFlag(true);
  if (sendBtn) sendBtn.disabled = true;
  try {
    trimHistoryImages(1);
    const ctx = await resolveCurrentTask();
    if (!ctx.task) {
      if (!text) {
        ui.toast?.('当前页没有题目，请输入问题', 2000);
        return null;
      }
      return await runChatOnly(text, { lockHeld: true });
    }

    const task = ctx.task;
    if ($input) $input.value = '';
    lastTask = null;
    lastRequest = { task, userText: text, historyMessages: [...history], soft: !!text };
    let r;
    try {
      r = await executeTask(task, {
        userText: text,
        historyMessages: [...history],
        autoSubmit: false,
        soft: !!text,
      });
    } catch (e) {
      traceUiError(task, '', e, 'send');
      throw e;
    }
    if (r?.ok) {
      history.push({ role: 'user', content: buildUserContent(task, { userText: text, includeTask: true, attachImage: true }) });
      history.push({ role: 'assistant', content: r.displayContent || '' });
    }
    return r;
  } finally {
    streaming = false;
    setStreamingFlag(false);
    abortCtrl = null;
    if (sendBtn) sendBtn.disabled = false;
  }
}

/** 无题目时的纯对话 */
async function runChatOnly(text, { lockHeld = false } = {}) {
  if (!text) return null;
  if (!lockHeld) {
    streaming = true;
    setStreamingFlag(true);
  }
  const sendBtn = $('#ykt-ai-send');
  if (sendBtn) sendBtn.disabled = true;
  const { aiBubble, waitActions } = createBubbleState({ userHtml: escapeHtml(text), aiWaiting: '思考中…' });
  const acc = { content: '', reasoning: '' };
  let renderer = new StreamRenderer();
  let raf = 0;
  let waitText = '思考中…';
  const phase = { value: 'waiting' };
  const paint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (phase.value !== 'answering' && acc.content) phase.value = 'answering';
      else if (phase.value === 'waiting' && acc.reasoning) phase.value = 'thinking';
      paintStream(aiBubble, renderer, acc, waitText, phase);
    });
  };
  abortCtrl = new AbortController();
  const ov = getOverride();
  try {
    const content = [{ type: 'text', text }];
    try {
      const img = await resolveCurrentSlideImage();
      if (img?.dataUrl) content.push({ type: 'image_url', image_url: { url: ensureImageUrl(img.dataUrl) } });
    } catch { /* ignore */ }
    trimHistoryImages(1);
    history.push({ role: 'user', content });
    const res = await agnesChat({
      messages: [{ role: 'system', content: systemPrompt() }, ...history],
      stream: true,
      thinking: ov?.thinking !== false,
      signal: abortCtrl.signal,
      override: ov || undefined,
      traceKind: 'chat',
      traceMode: 'none',
      onDelta: (d) => { acc.content += d; paint(); },
      onReasoning: (d) => { acc.reasoning += d; paint(); },
      onWait: (ms) => {
        waitText = ms >= 20000 ? '等待时间较长，可取消后重试' : ms >= 10000 ? '排队时间较长…' : '正在排队…';
        aiBubble.innerHTML = `<em>${waitText}</em>`;
      },
    });
    acc.content = res.content || acc.content;
    acc.reasoning = res.reasoning || acc.reasoning;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    aiBubble.innerHTML =
      (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : '')
      + '<div class="ykt-sr-content"></div>';
    renderer = new StreamRenderer();
    renderer.attach(aiBubble.querySelector('.ykt-sr-content'));
    if (acc.content) await renderer.finish(acc.content);
    else aiBubble.querySelector('.ykt-sr-content').innerHTML = '<span class="err">（空回复）</span>';
    history.push({ role: 'assistant', content: acc.content || '（无内容）' });
    return { ok: true, content: acc.content };
  } catch (e) {
    renderRunError(aiBubble, { ok: false, error: e, transport: 'text' }, null);
    return { ok: false, error: e };
  } finally {
    waitActions.remove();
    if (!lockHeld) {
      streaming = false;
      setStreamingFlag(false);
      abortCtrl = null;
      if (sendBtn) sendBtn.disabled = false;
    }
  }
}

/** 测试/调试：清空 AI 面板视图与内存状态（不清题目） */
export function resetAIView() {
  abortStreaming('测试重置');
  history = [];
  lastTask = null;
  lastRequest = null;
  const log = $('#ykt-ai-log');
  if (log) log.innerHTML = '';
  renderCtxStatus();
}

/** 测试/调试：只读历史快照 */
export function getAIHistory() {
  return history.map((m) => ({
    role: m.role,
    text: (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }])
      .filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    images: (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'image_url').length,
  }));
}

// ---------------- 兼容旧导出 ----------------
export async function askAIForCurrent() {
  return sendCurrent();
}
export async function askAIVisionForCurrent() {
  return sendCurrent();
}
export async function askAITextOnly() {
  return sendCurrent();
}
