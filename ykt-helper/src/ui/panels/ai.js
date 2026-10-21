// src/ui/panels/ai.js
// AI 解答面板：题目专注版多轮对话。
// 与 PPT对话(chat) 的区别：自动识别当前页 + 注入课堂系统的题干文本（比截图 OCR 可靠），
// 首轮「解答此页」一键触发，后续追问共享上下文。
// 调用链：agnesChat（OpenAI 兼容流式，支持 reasoning_content 思考链与取消），
//         override 来自当前激活的 AI Profile——任意 OpenAI 兼容端点都能用。
import tpl from './ai.html';
import { log } from '../../core/log.js';
import { ui } from '../ui-api.js';
import { repo } from '../../state/repo.js';
import { cacheQuizAnswer } from '../../quiz/quiz-paper.js';
import { getCurrentMainPageSlideId, getCurrentMainPageMeta, waitForVueReady, watchMainPageChange } from '../../core/vuex-helper.js';
import { agnesChat } from '../../ai/agnes.js';
import { resolveCurrentSlideImage } from '../slide-image.js';
import { ensureMermaid, ensureMarked, ensureDOMPurify, ensureKaTeX, gm } from '../../core/env.js';
import { escapeHtml, ensureImageUrl } from '../../core/dom.js';
import { PROBLEM_TYPE_MAP, DEFAULT_SYSTEM_PROMPT_AI } from '../../core/types.js';
import { SUBMIT_ANSWER_TOOL, toolPromptBlock, normalizeToolArgs, toolReason, isToolUnsupportedError } from '../../ai/tools.js';
import { captureSlideImage } from '../../capture/screenshoot.js';
import { parseAIAnswer } from '../../tsm/ai-format.js';
import { submitProblemAnswer } from '../../tsm/submit-flow.js';
import { confirmDialog } from '../confirm.js';

const L = (...a) => log.dbg('[ai]', ...a);
const W = (...a) => log.warn('[ai]', ...a);

let mounted = false;
let root;
let preferredSlideFromPresentation = null; // 来自课件面板/事件的指定页

let history = [];           // OpenAI 格式消息
let streaming = false;      // 防并发发送
let abortCtrl = null;
let lastSendText = null;    // 上一次发送的用户文本（重试用；空串=解答此页）
let activeOverride = null;  // askAIForProblem 指定的题目（作业/题目列表），请求期间优先展示
let lastThumbKey = '';      // 缩略图缓存键，避免 2s 轮询重复截图
let ctxPollTimer = null;

const systemPrompt = () => String(ui?.config?.systemPromptAI || '').trim() || DEFAULT_SYSTEM_PROMPT_AI;

const DEFAULT_ANALYZE_PROMPT = '请解答此页的题目：先给答案，再给简要解题过程。若页面不是题目页，请概述页面内容。';

/** 取 MathJax：脚本注入的 v3 在沙箱 window；页面自带的 v2 在主世界 gm.uw */
function getMathJax() {
  return window.MathJax?.typesetPromise ? { v: 3, mj: window.MathJax }
    : (window.MathJax?.Hub?.Typeset ? { v: 2, mj: window.MathJax }
    : (gm.uw?.MathJax?.typesetPromise ? { v: 3, mj: gm.uw.MathJax }
    : (gm.uw?.MathJax?.Hub?.Typeset ? { v: 2, mj: gm.uw.MathJax } : null)));
}

function ensureMathJax() {
  const ok = !!getMathJax();
  if (!ok) log.warn('[ai] MathJax 未就绪（v3 未通过 @require 预置，v2 页面也没带？）');
  return Promise.resolve(ok);
}

/** MathJax 默认不认单 $ 行内公式（防价格文本误匹配）。
 *  typeset 前把文本节点里的 $...$ 转成 \(...\)：
 *  pandoc 式规则——开 $ 前不能是 \、后紧跟非空白；闭 $ 前非空白、后不跟数字；内部不含换行/$。
 *  只处理文本节点，跳过代码/公式容器，幂等（已 typeset 的 mjx-container 不再扫）。 */
const MATH_SKIP_SEL = 'pre, code, script, style, textarea, mjx-container, .katex, .ykt-mermaid, .ykt-md-code, .ykt-mermaid-render';
const DOLLAR_MATH_RE = /(?<!\\)\$((?!\s)[^\n$]*?[^\s$])\$(?!\d)/g;
function dollarToParen(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.indexOf('$') === -1) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(MATH_SKIP_SEL)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!DOLLAR_MATH_RE.test(text)) continue;
    DOLLAR_MATH_RE.lastIndex = 0;
    node.nodeValue = text.replace(DOLLAR_MATH_RE, '\\($1\\)');
  }
}

/** KaTeX 兜底：MathJax 不在（壳内无 @require）时用它逐节点渲染 \(...\)/\[...\]/$...$ */
async function typesetWithKaTeX(el) {
  try {
    const katex = await ensureKaTeX();
    dollarToParen(el);   // 先把 $...$ 统一成 \(...\)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !/[\\$]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (n.parentElement?.closest(MATH_SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      // 逐个替换 \(...\) 和 \[...\] 为 <span class="katex">…</span>
      const frag = document.createDocumentFragment();
      let last = 0, matched = false;
      const re = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
      let m;
      while ((m = re.exec(text))) {
        matched = true;
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const src = m[1] ?? m[2];
        const display = m[2] != null;
        const span = document.createElement('span');
        try {
          span.innerHTML = katex.renderToString(src, { displayMode: display, throwOnError: false });
        } catch { span.textContent = m[0]; }
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      if (!matched) continue;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    el.classList.add('tex-enabled');
  } catch (e) {
    log.warn('[ai] KaTeX 兜底渲染失败:', e?.message);
  }
}

function typesetTexIn(el) {
  const pick = getMathJax();
  if (!el || !pick) return Promise.resolve(false);
  if (pick.v === 3) {
    const ready = pick.mj.startup?.promise || Promise.resolve();
    return ready.then(() => pick.mj.typesetPromise([el]).then(() => true).catch(() => false));
  }
  // MathJax v2（页面自带）：Hub.Queue 排版，\(...\) 默认启用
  return new Promise((resolve) => {
    try {
      pick.mj.Hub.Queue(['Typeset', pick.mj.Hub, el], function () { resolve(true); });
    } catch { resolve(false); }
  });
}

function $sel(sel) { return root.querySelector(sel); }

export function mountAIPanel() {
  if (mounted) return root;

  const host = document.createElement('div');
  host.innerHTML = tpl;
  document.body.appendChild(host.firstElementChild);
  root = document.getElementById('ykt-ai-answer-panel');

  // 面板嵌在 shell 里——关闭统一走 shell 右上角 ✕（面板自带 X 已删，见 html）
  $sel('#ykt-ai-clear').addEventListener('click', () => {
    abortStreaming('清空会话');
    history = [];
    activeOverride = null;
    renderHistory();
    renderCtxStatus();
    addBubble('ai', mdToHtml('会话已清空。点击「发送」（输入留空）可解答当前页题目。'));
  });

  const $input = $sel('#ykt-ai-input');
  const $send = $sel('#ykt-ai-send');
  $send.addEventListener('click', () => sendCurrent());
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });

  // 状态条：点击/回车 = 重新检测当前页题目
  const statusEl = $sel('#ykt-ai-text-status');
  if (statusEl) {
    statusEl.setAttribute('role', 'button');
    statusEl.setAttribute('tabindex', '0');
    statusEl.addEventListener('click', () => renderCtxStatus({ force: true }));
    statusEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderCtxStatus({ force: true }); }
    });
  }

  // 课件题目数据晚到：立即刷新状态（无需重开面板）
  window.addEventListener('ykt:problem:parsed', () => renderCtxStatus());

  waitForVueReady().then(() => {
    watchMainPageChange((slideId, slideInfo) => {
      L('主界面页面切换事件', { slideId, slideInfoType: slideInfo?.type, problemID: slideInfo?.problemID, index: slideInfo?.index });
      preferredSlideFromPresentation = null;
      renderCtxStatus();
    });
  }).catch(e => {
    W('Vue 实例初始化失败，将使用备用方案:', e);
  });

  window.addEventListener('ykt:presentation:slide-selected', (ev) => {
    L('收到小窗选页事件', ev?.detail);
    const sid = asIdStr(ev?.detail?.slideId);
    if (sid) preferredSlideFromPresentation = { slideId: sid, imageUrl: ev?.detail?.imageUrl || null };
    renderCtxStatus();
  });

  // ykt:open-ai 统一由 ui-api → Shell.openTab('ai') 处理，走 __yksOnShow
  warmupRichAssets();
  mounted = true;
  renderCtxStatus();
  // 面板可见时轻量轮询（只更新状态文案，不重复截图），兜住移动端数据晚到
  if (!ctxPollTimer) {
    ctxPollTimer = setInterval(() => {
      if (root?.classList.contains('visible')) renderCtxStatus({ light: true });
    }, 2000);
  }
  // shell 切到本 tab 时刷新（数据晚于挂载到达的场景：WS 课件、页面切换）
  root.__yksOnShow = () => {
    renderCtxStatus();
    if (history.length === 0 && !$sel('#ykt-ai-log').children.length) {
      addBubble('ai', mdToHtml('点击「发送」（输入留空）即可解答当前页题目；也可以直接输入问题针对页面内容追问。'));
    }
    // 「打开时自动分析」原来挂在 showAIPanel——改走 shell tab 后挪进 show 钩子
    if (ui.config.aiAutoAnalyze && history.length === 0 && !streaming) {
      queueMicrotask(() => sendCurrent({ auto: true }));
    }
  };
  // 不中断流式：tab 切换/收起壳都继续后台生成，切回来直接看结果；
  // 只有页面刷新（JS 上下文没了）、清空会话、用户主动取消才断
  root.__yksOnHide = () => {};
  return root;
}

export function showAIPanel(v = true) {
  if (!mounted) mountAIPanel();
  root.classList.toggle('visible', !!v);
  if (v) {
    activeOverride = null;
    renderCtxStatus();
    if (history.length === 0) {
      addBubble('ai', mdToHtml('点击「发送」（输入留空）即可解答当前页题目；也可以直接输入问题针对页面内容追问。'));
    }
    if (ui.config.aiAutoAnalyze && history.length === 0 && !streaming) {
      queueMicrotask(() => sendCurrent({ auto: true }));
    }
    setTimeout(() => $sel('#ykt-ai-input')?.focus(), 60);
  }
  L('showAIPanel', { visible: v });
}

/** 中止正在进行的流式请求 */
function abortStreaming(reason = '已取消') {
  if (abortCtrl) {
    try { abortCtrl.abort(reason); } catch {}
  }
}

// ---------------- 当前页与题目上下文 ----------------

function asIdStr(v) { return v == null ? null : String(v); }

/** 当前应分析的 slide（优先：课件面板指定页 > 主界面当前页 > 最近题目关联页） */
function pickCurrentSlide() {
  if (preferredSlideFromPresentation?.slideId) {
    const sid = asIdStr(preferredSlideFromPresentation.slideId);
    const hit = repo.slides.get(sid) || findSlideAcrossPresentations(sid);
    if (hit) return { slide: hit, source: `课件面板指定（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  // 设置页存的是布尔（勾选=主界面优先），不是 'presentation' 字符串
  const prio = ui?.config?.aiSlidePickPriority !== false;
  const mainSid = asIdStr(getCurrentMainPageSlideId());
  if (prio && mainSid) {
    const hit = repo.slides.get(mainSid) || findSlideAcrossPresentations(mainSid);
    if (hit) return { slide: hit, source: `主界面当前页（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  if (repo.currentSlideId != null) {
    const sid = asIdStr(repo.currentSlideId);
    const hit = repo.slides.get(sid) || findSlideAcrossPresentations(sid);
    if (hit) return { slide: hit, source: `课件浏览选中（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  try {
    if (repo.encounteredProblems?.length > 0) {
      const latest = repo.encounteredProblems.at(-1);
      const sid = repo.problemStatus.get(String(latest.problemId))?.slideId ? String(repo.problemStatus.get(String(latest.problemId)).slideId) : null;
      const hit = sid ? (repo.slides.get(sid) || findSlideAcrossPresentations(sid)) : null;
      if (hit) return { slide: hit, source: `最近题目关联页（第 ${hit.index ?? hit.page ?? '?'} 页）` };
    }
  } catch (e) { W('pickCurrentSlide fallback:', e); }
  return { slide: null, source: '' };
}

function findSlideAcrossPresentations(idStr) {
  for (const [, pres] of repo.presentations) {
    const hit = (pres?.slides || []).find(s => String(s.id) === idStr);
    if (hit) return hit;
  }
  return null;
}

/** 组装首轮/追问的用户文本：题干文本注入（来自课堂系统，比截图 OCR 可靠） */
function buildUserText(problem, customPrompt, isAnalyze) {
  const parts = [];
  if (problem) {
    parts.push('【题目信息（来自课堂系统，比截图更可靠）】');
    const typeStr = PROBLEM_TYPE_MAP[problem.problemType] || (problem.problemType != null ? `类型 ${problem.problemType}` : '');
    if (typeStr) parts.push(`题型：${typeStr}`);
    if (problem.body) parts.push(`题干：${problem.body}`);
    if (Array.isArray(problem.options) && problem.options.length) {
      parts.push('选项：');
      for (const o of problem.options) parts.push(`${o.key}. ${o.value}`);
    }
    if (Array.isArray(problem.blanks) && problem.blanks.length) {
      parts.push(`空位：${problem.blanks.join(' | ')}`);
    }
  }
  if (isAnalyze) {
    parts.push(problem
      ? '请结合以上题目文本与页面截图解答此题。'
      : '【页面说明】当前页面可能不是题目页；请根据截图内容概述页面，若有题目请解答。');
  }
  if (customPrompt) parts.push(`【用户自定义要求】\n${customPrompt}`);
  return parts.join('\n');
}

// ---- 当前页题目状态（显式化：已解析/可提交/解析中/无题目） ----

const QUIZ_TYPE_LABEL = {
  SingleChoice: '单选题',
  MultipleChoice: '多选题',
  Judgement: '判断题',
  Judgment: '判断题',
  FillBlank: '填空题',
  Subjective: '主观题',
  Poll: '投票',
  Exam: '试卷',
  Link: '外链题',
};

function problemTypeLabel(problem) {
  const qt = problem?.__quizType;
  if (qt && QUIZ_TYPE_LABEL[qt]) return QUIZ_TYPE_LABEL[qt];
  return PROBLEM_TYPE_MAP[problem?.problemType] || '题目';
}

function canSubmitProblem(problem) {
  if (!problem || problem.__noSubmit) return false;
  const t = Number(problem.problemType);
  return problem.__submitTarget === 'quiz' || (t >= 1 && t <= 5);
}

function notSubmitReason(problem) {
  if (!problem) return '当前页没有题目';
  if (problem.__noSubmit) {
    if (problem.__submitTarget !== 'quiz' && (problem.problemType === 4 || problem.problemType === 5)) {
      return '作业填空/主观题暂未开放';
    }
    return '当前题型暂不支持提交';
  }
  return '该题型不支持提交';
}

/** 更新输入框占位，提示这一轮会做什么 */
function updateCtxPlaceholder(problem, canSubmit, isQuiz) {
  const input = $sel('#ykt-ai-input');
  if (!input) return;
  if (!problem) input.placeholder = '当前页无题目，可输入问题提问（Enter 发送）';
  else if (isQuiz) input.placeholder = '留空发送 = 解答本题并暂存（Enter 发送）';
  else if (canSubmit) input.placeholder = '留空发送 = 解答本题并提交（Enter 发送）';
  else input.placeholder = '留空发送 = 解答本题（暂不自动提交，Enter 发送）';
}

/** 页面识别状态行（面板底部，显式展示题目解析/可提交状态） */
function renderCtxStatus({ light = false, force = false } = {}) {
  if (!mounted) return;
  const statusEl = $sel('#ykt-ai-text-status');
  if (!statusEl) return;

  const { slide, source } = pickCurrentSlide();
  const override = activeOverride;
  const problem = override || slide?.problem || null;
  const isQuiz = problem?.__submitTarget === 'quiz';
  const canSubmit = canSubmitProblem(problem);
  const label = problemTypeLabel(problem);
  const meta = getCurrentMainPageMeta();
  const looksProblem = !!(meta?.problemID || String(meta?.type || '') === 'problem');

  let cls;
  let text;
  let title;

  if (override) {
    cls = canSubmit ? 'st-info' : 'st-warn';
    text = canSubmit
      ? `已指定题目 · ${label} · ${isQuiz ? '作业暂存' : '可提交'}`
      : `已指定题目 · ${label} · 暂不支持提交：${notSubmitReason(override)}`;
    title = `来源：指定题目（作业/题目列表）\n题型：${label}`
      + (override.__problemId != null ? `\n题目ID：${override.__problemId}` : '');
  } else if (!slide) {
    if (looksProblem) {
      cls = 'st-busy';
      text = '题目页解析中…';
      title = '当前页是题目页，但题目数据还没到；稍等会自动刷新';
    } else {
      cls = 'st-err';
      text = '未检测到课件页';
      title = '请先在课堂里翻页，或从题目列表/作业里打开 AI 解答';
    }
  } else if (problem) {
    cls = canSubmit ? 'st-ok' : 'st-warn';
    text = canSubmit
      ? `题目已解析到 · ${label} · ${isQuiz ? '作业暂存' : '可提交'}`
      : `题目已解析到 · ${label} · 暂不支持提交：${notSubmitReason(problem)}`;
    title = `来源：${source || '当前页'}\n题型：${label}`
      + (problem.problemId != null ? `\n题目ID：${problem.problemId}` : '');
  } else if (looksProblem) {
    cls = 'st-busy';
    text = '题目页解析中…';
    title = `来源：${source || '当前页'}\n题目数据还没到，稍等会自动刷新`;
  } else {
    cls = 'st-idle';
    text = '当前页无题目 · 仅问答';
    title = `来源：${source || '当前页'}\n这一页不是题目页，submit_answer 不可用`;
  }

  statusEl.className = `ctx-status ${cls}`;
  statusEl.textContent = text;
  statusEl.title = `${title}\n（点击重新检测）`;
  updateCtxPlaceholder(problem, canSubmit, isQuiz);

  if (!light && root?.classList.contains('visible')) {
    renderCtxThumb({ force, slideId: slide?.id || '', override });
  }
}

async function renderCtxThumb({ force = false, slideId = '', override = null } = {}) {
  const span = $sel('#ykt-ai-ctx-thumb');
  if (!span) return;
  const key = override
    ? `ov:${override.__problemId ?? override.problemId ?? 'x'}:${override.__imageDataUrl ? 'img' : (slideId || 'none')}`
    : (slideId || 'none');
  if (!force && key === lastThumbKey) return;
  lastThumbKey = key;
  span.textContent = '⏳';
  const myKey = key;
  let dataUrl = '';
  if (override?.__imageDataUrl) {
    dataUrl = override.__imageDataUrl;
  } else if (slideId) {
    ({ dataUrl } = await resolveCurrentSlideImage());
  }
  if (myKey !== lastThumbKey) return;   // 截图期间切页了，丢弃旧结果
  if (dataUrl) {
    span.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.title = override ? '指定题目' : '当前 PPT 页';
    span.appendChild(img);
  } else {
    span.textContent = '（无图）';
  }
}

// ---------------- 渲染 ----------------

function addBubble(kind, htmlOrNode) {
  const $log = $sel('#ykt-ai-log');
  const div = document.createElement('div');
  div.className = `ykt-ai-msg ${kind}`;
  if (typeof htmlOrNode === 'string') div.innerHTML = htmlOrNode;
  else div.appendChild(htmlOrNode);
  $log.appendChild(div);
  $log.scrollTop = $log.scrollHeight;
  return div;
}

function renderHistory() {
  const $log = $sel('#ykt-ai-log');
  $log.innerHTML = '';
  for (const m of history) {
    const text = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }])
      .filter(c => c.type === 'text').map(c => c.text).join('\n');
    const imgs = (Array.isArray(m.content) ? m.content : [])
      .filter(c => c.type === 'image_url').map(c => c.image_url.url);
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

/** 把历史中除最近 N 张外的图片替换为占位符，控制 token */
function trimOldImages(keep = 1) {
  const imgMsgs = [];
  for (const m of history) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const imgIdx = m.content.map((c, i) => (c.type === 'image_url' ? i : -1)).filter(i => i >= 0);
    if (imgIdx.length) imgMsgs.push({ m, imgIdx });
  }
  for (const { m, imgIdx } of imgMsgs.slice(0, Math.max(0, imgMsgs.length - keep))) {
    for (const i of imgIdx) {
      m.content[i] = { type: 'text', text: '[此前的 PPT 页图片已省略]' };
    }
  }
}

// ---------------- 发送 ----------------

/** 当前激活 Profile → agnesChat override（保留任意 OpenAI 兼容端点能力） */
export function getOverride() {
  const aiCfg = ui.config.ai;
  const profiles = Array.isArray(aiCfg?.profiles) ? aiCfg.profiles : [];
  const p = profiles.find(x => x.id === aiCfg.activeProfileId) || profiles[0];
  if (!p || !p.apiKey) return null;
  // 带图消息必须走 vision 能力模型；现代多模态模型通常 text/vision 同 ID
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.visionModel || p.model,
    reasoningEffort: p.reasoningEffort,
    thinking: p.thinking !== false,
  };
}

/** 流式进行时在 body 打标——periodic reload / 其他全局逻辑据此避开在途请求 */
function setStreamingFlag(on) {
  try {
    if (on) document.body.dataset.yksStreaming = '1';
    else delete document.body.dataset.yksStreaming;
  } catch {}
}

// ---------------- 工具调用：提交答案 ----------------

/** 取指定题目所在页的图片（自动作答时题目可能已不在当前页） */
async function resolveImageForProblem(problem) {
  // 作业题：调用方直接传入拼好的题图（没有课堂 slide 可截）
  if (problem?.__imageDataUrl) {
    return { dataUrl: ensureImageUrl(problem.__imageDataUrl), source: 'quiz-image' };
  }
  const status = repo.problemStatus.get(String(problem?.problemId));
  const sid = status?.slideId;
  if (sid != null) {
    try {
      const img = await captureSlideImage(sid);
      if (img) return { dataUrl: ensureImageUrl(img), source: 'problem-slide' };
    } catch (e) { W('captureSlideImage fail:', e); }
  }
  return resolveCurrentSlideImage();
}

/** parseAIAnswer 的结果 → 卡片需要的 {content,result,display}（降级路径用） */
function argsFromParsed(problemType, parsed) {
  const pt = Number(problemType);
  if (pt === 1 || pt === 2 || pt === 3) {
    const arr = Array.isArray(parsed) ? parsed.map(String) : [];
    return { content: arr.join(','), result: arr, display: arr.join('、') };
  }
  if (pt === 4) {
    const arr = Array.isArray(parsed) ? parsed.map(String) : [String(parsed ?? '')];
    return { content: arr.join('\n'), result: arr, display: arr.join(' | ') };
  }
  const text = typeof parsed === 'string' ? parsed : String(parsed?.content ?? '');
  return { content: text, result: { content: text, pics: [] }, display: text };
}

/**
 * 在 AI 气泡里渲染「提交答案」卡片。
 * autoSubmit=true（自动作答）时不再二次确认，直接提交。
 * @returns {Promise<{attempted:boolean, route?:'answer'|'retry'|null, pending?:boolean, display:string}>}
 */
async function renderToolCard(aiBubble, { problem, args, reason, autoSubmit, degraded = false }) {
  const card = document.createElement('div');
  card.className = 'ykt-tool-card';

  const isQuiz = problem?.__submitTarget === 'quiz';
  const title = document.createElement('div');
  title.className = 'ykt-tool-title';
  title.textContent = isQuiz
    ? '📥 暂存答案（作业）'
    : (degraded ? '📤 提交答案（文本解析）' : '📤 提交答案');
  card.appendChild(title);

  const ans = document.createElement('div');
  ans.className = 'ykt-tool-answer';
  ans.textContent = args.display;
  card.appendChild(ans);

  if (reason) {
    const r = document.createElement('div');
    r.className = 'ykt-tool-reason';
    r.textContent = reason;
    card.appendChild(r);
  }

  const bar = document.createElement('div');
  bar.className = 'ykt-tool-actions';
  const btn = document.createElement('button');
  btn.className = 'ykt-tool-submit';
  btn.textContent = autoSubmit ? '自动提交中…' : (isQuiz ? '暂存' : '提交');
  bar.appendChild(btn);
  card.appendChild(bar);

  const stEl = document.createElement('div');
  stEl.className = 'ykt-tool-status';
  card.appendChild(stEl);

  aiBubble.appendChild(card);
  const $log = $sel('#ykt-ai-log');
  if ($log) $log.scrollTop = $log.scrollHeight;

  const doSubmit = async () => {
    if (btn.disabled) return null;
    // 作业题：只暂存单题，不交卷、不弹提交确认
    if (isQuiz) {
      btn.disabled = true;
      btn.textContent = '暂存中…';
      stEl.textContent = '';
      try {
        await cacheQuizAnswer({
          quizId: problem.__quizId,
          problemId: problem.__problemId,
          result: args.result,
        });
        card.classList.add('done');
        btn.textContent = '已暂存';
        stEl.textContent = '✅ 已暂存（未交卷）';
        ui.toast?.('✅ 已暂存，未交卷', 2500);
        return 'cache';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '重试暂存';
        stEl.textContent = `❌ 暂存失败：${e?.message || e}`;
        return null;
      }
    }
    const st = repo.problemStatus.get(String(problem.problemId));
    const offset = Number.isFinite(st?.clockOffset) ? st.clockOffset : 0;
    const endTime = Number.isFinite(st?.endTime) ? st.endTime : undefined;
    const past = Number.isFinite(endTime) && (Date.now() + offset) >= endTime;

    // 手动模式：二次确认；过期再单独确认补交
    if (!autoSubmit) {
      const ok = await confirmDialog(`确认提交答案：${args.display}？`, { okText: '提交' });
      if (!ok) return null;
      if (past) {
        const ok2 = await confirmDialog('这道题已超过截止时间，将以补交方式提交。确定继续吗？', { okText: '补交', danger: true });
        if (!ok2) return null;
      }
    }

    btn.disabled = true;
    btn.textContent = '提交中…';
    stEl.textContent = '';
    try {
      const route = await submitProblemAnswer(problem, args.result, {
        startTime: st?.startTime,
        endTime,
        forceRetry: past,
      });
      card.classList.add('done');
      btn.textContent = '已提交';
      stEl.textContent = route === 'retry' ? '✅ 补交成功' : '✅ 提交成功';
      ui.toast?.(route === 'retry' ? '✅ 补交成功' : '✅ 提交成功', 2500);
      return route;
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '重试提交';
      stEl.textContent = `❌ 提交失败：${e?.message || e}`;
      return null;
    }
  };

  btn.addEventListener('click', doSubmit);

  if (autoSubmit) {
    const route = await doSubmit();
    return { attempted: true, route, display: args.display };
  }
  return { attempted: true, pending: true, display: args.display };
}

/** 处理一轮回答里的工具调用 / 降级解析 */
async function handleToolCall({ aiBubble, problem, toolCall, autoSubmit, degraded, content }) {
  const pt = Number(problem?.problemType);
  if (!(pt >= 1 && pt <= 5)) return null;

  if (toolCall) {
    try {
      const args = normalizeToolArgs(toolCall.function?.arguments, pt);
      const reason = toolReason(toolCall.function?.arguments);
      L('tool call:', { problemId: problem.problemId, args, reason });
      try { window.__yktLastToolCall = { args, reason, at: Date.now() }; } catch {}
      return await renderToolCard(aiBubble, { problem, args, reason, autoSubmit });
    } catch (e) {
      W('tool args invalid:', e);
      addBubble('ai', `<span class="err">工具参数无效：${escapeHtml(e?.message || e)}</span>`);
      return null;
    }
  }

  // 模型不支持工具：从正文解析答案，生成同样的卡片
  if (degraded) {
    const parsed = parseAIAnswer(problem, content || '');
    if (!parsed) return null;
    const args = argsFromParsed(pt, parsed);
    if (!args.content) return null;
    return await renderToolCard(aiBubble, { problem, args, reason: '', autoSubmit, degraded: true });
  }

  return null;
}

/** 单轮请求：返回本轮结果，供 sendCurrent 决定是否重试 */
async function runSendInner({
  retryText = null,
  problemOverride = null,
  autoSubmit = false,
  nudge = null,
  useTools = true,
  attempt = 1,
} = {}) {
  const $input = $sel('#ykt-ai-input');
  // retryText 非 null = 手动重试：用上次的文本，并弹出上一条 user 历史避免重复
  const text = nudge ? nudge : (retryText !== null ? retryText : ($input?.value || '').trim());
  if (retryText !== null && !nudge) {
    if (history.length && history[history.length - 1]?.role === 'user') history.pop();
  }
  const isAnalyze = !text;
  const customPrompt = ($sel('#ykt-ai-custom-prompt')?.value || '').trim();
  const attach = $sel('#ykt-ai-attach')?.checked ?? true;

  if (!nudge) lastSendText = text;

  // 题目上下文：自动作答用传入的题目；手动模式用当前页
  const ctxSlide = pickCurrentSlide().slide;
  const problem = problemOverride || ctxSlide?.problem || null;
  const problemType = Number(problem?.problemType);
  const canSubmit = canSubmitProblem(problem);

  // 自动作答使用独立会话：不污染用户聊天，也不会把上一题的上下文带进来
  const conv = autoSubmit ? [] : history;

  const content = [{ type: 'text', text: text || DEFAULT_ANALYZE_PROMPT }];
  let attachFailed = '';
  if (!nudge && (attach || isAnalyze)) {
    const pending = addBubble('user', `⏳ 正在获取当前 PPT…${text ? '' : '（解答此页）'}`);
    let dataUrl;
    let reason;
    if (problemOverride) {
      const r = await resolveImageForProblem(problemOverride);
      dataUrl = r?.dataUrl || '';
      reason = r?.reason || '';
    } else {
      const r = await resolveCurrentSlideImage();
      dataUrl = r?.dataUrl || '';
      reason = r?.reason || '';
    }
    pending.remove();
    if (dataUrl) content.push({ type: 'image_url', image_url: { url: ensureImageUrl(dataUrl) } });
    else if (isAnalyze) attachFailed = reason || '未取到当前 PPT 页';
  }

  if (nudge) {
    content[0].text = nudge;
  } else if (isAnalyze) {
    content[0].text = buildUserText(problem, customPrompt, true) || DEFAULT_ANALYZE_PROMPT;
  } else if (text) {
    content[0].text = text + (customPrompt ? `\n【用户自定义要求】\n${customPrompt}` : '');
  }

  conv.push({ role: 'user', content });
  if (!autoSubmit) trimOldImages(1);
  const userBubble = addBubble('user', escapeHtml(nudge || text || DEFAULT_ANALYZE_PROMPT));
  for (const c of content) {
    if (c.type === 'image_url') {
      const img = document.createElement('img');
      img.src = ensureImageUrl(c.image_url.url);
      img.alt = '当前 PPT 页';
      userBubble.appendChild(img);
    }
  }
  if (attachFailed) {
    const warn = document.createElement('div');
    warn.className = 'ykt-chat-warn';
    warn.textContent = `⚠️ ${attachFailed}——本条无截图，仅依据题目文本作答`;
    userBubble.appendChild(warn);
  }
  if ($input) $input.value = '';

  // AI 气泡（流式，思考中自动展开 → 正文自动折叠）
  const aiBubble = addBubble('ai', '<em>思考中…</em>');
  // 等待期间的「取消」按钮（放在气泡外，避免被 paint 的 innerHTML 冲掉）
  let waitText = '思考中…';
  const waitActions = document.createElement('div');
  waitActions.style.cssText = 'display:flex;gap:8px;align-items:center;margin:-4px 0 8px 2px';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:2px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;cursor:pointer;font-size:12px';
  cancelBtn.addEventListener('click', () => abortStreaming('用户取消'));
  waitActions.appendChild(cancelBtn);
  aiBubble.insertAdjacentElement('afterend', waitActions);
  const acc = { content: '', reasoning: '' };
  const renderer = new StreamRenderer();           // 封板/活跃区增量渲染：公式、mermaid 流中即渲染
  let raf = 0;
  let phase = 'waiting';
  const paint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (phase !== 'answering' && acc.content) phase = 'answering';
      else if (phase === 'waiting' && acc.reasoning) phase = 'thinking';
      const thinking = phase === 'thinking';
      aiBubble.innerHTML =
        (acc.reasoning
          ? `<details ${thinking ? 'open' : ''}><summary>💭 思考过程${thinking ? '（进行中…）' : '（点击展开）'}</summary><div class="reasoning-body"></div></details>`
          : '')
        + '<div class="ykt-sr-content"></div>';
      renderer.attach(aiBubble.querySelector('.ykt-sr-content'));
      renderer.update(acc.content, thinking ? '' : `<em>${waitText}</em>`);
      const rBody = aiBubble.querySelector('.reasoning-body');
      if (rBody) { rBody.textContent = acc.reasoning; rBody.scrollTop = rBody.scrollHeight; }
      const $log = $sel('#ykt-ai-log');
      $log.scrollTop = $log.scrollHeight;
    });
  };

  abortCtrl = new AbortController();
  const ov = getOverride();
  // 工具只在「首轮解答」或「自动作答」时强制；追问不强制，避免反复提交
  // 有题目上下文就带工具说明：空输入/自动作答用强要求，手动追问用软提示
  const toolHint = (useTools && canSubmit)
    ? '\n\n' + toolPromptBlock(problem, { mandatory: autoSubmit, soft: !isAnalyze && !autoSubmit })
    : '';
  const sys = systemPrompt() + toolHint;
  const tools = (useTools && canSubmit) ? [SUBMIT_ANSWER_TOOL] : undefined;

  const call = (toolList) => agnesChat({
    messages: [{ role: 'system', content: sys }, ...conv],
    stream: true,
    thinking: ov?.thinking !== false,   // 跟设置里的「启用思考」开关走
    signal: abortCtrl.signal,
    override: ov || undefined,
    tools: toolList,
    toolChoice: autoSubmit ? 'required' : 'auto',
    onDelta: (d) => { acc.content += d; paint(); },
    onReasoning: (d) => { acc.reasoning += d; paint(); },
    onWait: (ms) => {
      if (acc.content || acc.reasoning) return;
      waitText = ms >= 20000
        ? '等待时间较长，可取消后重试'
        : ms >= 10000
          ? '排队时间较长，上游可能繁忙…'
          : '正在排队…';
      aiBubble.innerHTML = `<em>${waitText}</em>`;
    },
  });

  let res;
  let degraded = false;
  try {
    res = await call(tools);
  } catch (e) {
    // 端点不支持 tool calling：去掉 tools 重发一次（同一轮内降级，不占重试次数）
    if (tools && isToolUnsupportedError(e)) {
      degraded = true;
      W('tool calling unsupported, degrade:', e?.message || e);
      res = await call(undefined);
    } else {
      throw e;
    }
  } finally {
    waitActions.remove();
  }

  acc.content = res.content || acc.content;
  acc.reasoning = res.reasoning || acc.reasoning;
  const toolCall = (res.toolCalls || []).find(t => t?.function?.name === 'submit_answer');
  if (raf) { cancelAnimationFrame(raf); raf = 0; }   // 防止挂起的 paint 覆盖 renderRich 成果
  aiBubble.innerHTML =
    (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : '')
    + '<div class="ykt-sr-content"></div>';
  renderer.attach(aiBubble.querySelector('.ykt-sr-content'));
  if (acc.content) await renderer.finish(acc.content);
  else if (toolCall) aiBubble.querySelector('.ykt-sr-content').innerHTML = '<span class="muted">✅ 已生成答案</span>';
  else aiBubble.querySelector('.ykt-sr-content').innerHTML = '<span class="err">（空回复）</span>';

  if (degraded) {
    const note = document.createElement('div');
    note.className = 'ykt-chat-warn';
    note.textContent = toolCall
      ? '⚠️ 端点不支持 tools 参数，已从模型输出中解析到工具调用。'
      : '⚠️ 当前模型不支持工具调用，已降级为文本作答。';
    aiBubble.appendChild(note);
  }

  // 截断提示（同 chat.js）：流未正常收尾就结束，明确告知而不是静默
  if (res.truncated) {
    const warn = document.createElement('div');
    warn.className = 'ykt-chat-warn';
    warn.textContent = '⚠️ 输出中断：连接被提前关闭（已收到的内容保留）。';
    aiBubble.appendChild(warn);
  }

  let submitInfo = await handleToolCall({
    aiBubble, problem, toolCall, autoSubmit, degraded, content: acc.content,
  });

  // 手动模式最后一次仍未调用工具：把正文解析成答案卡片，至少能一键提交（仍需二次确认）
  if (!submitInfo && !degraded && !toolCall && (isAnalyze || !!nudge) && !autoSubmit && canSubmit && attempt >= 2) {
    const parsed = parseAIAnswer(problem, acc.content || '');
    if (parsed) {
      const args = argsFromParsed(problemType, parsed);
      if (args.content) {
        submitInfo = await renderToolCard(aiBubble, { problem, args, reason: '', autoSubmit: false, degraded: true });
      }
    }
  }

  conv.push({
    role: 'assistant',
    content: acc.content || (submitInfo ? `（已提交答案：${submitInfo.display || ''}）` : '（无内容）'),
  });

  return { res, problem, toolCall, submitInfo, degraded, isAnalyze };
}

/** 单轮请求（带错误兜底）：失败时渲染错误气泡并返回 null */
async function runSend(opts = {}) {
  try {
    return await runSendInner(opts);
  } catch (e) {
    const emsg = String(e?.message || '');
    log.warn('[AI] 请求失败:', emsg || e, e);
    // HTTP 错误体里可能带 "timeout"（如上游 504），不能当成本地等待超时
    const isTimeout = !/^HTTP \d/.test(emsg) && /timeout|超时/i.test(emsg);
    const aborted = (e?.name === 'AbortError' && !isTimeout) || /abort|cancel/i.test(emsg);
    const retryBtn = lastSendText !== null
      ? `<button class="ykt-retry-btn" style="margin-left:8px;padding:2px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;cursor:pointer;font-size:12px">↻ 重试</button>`
      : '';
    if (aborted) {
      addBubble('ai', `<span class="muted">（已中断：${escapeHtml(emsg || '请求被中止')}）</span>${retryBtn}`);
    } else if (/HTTP 429/.test(emsg)) {
      addBubble('ai', `<span class="err">当前使用人数较多，请稍后重试</span>${retryBtn}<br/><small>上游已限流，稍等几秒再点重试。</small>`);
    } else if (isTimeout) {
      addBubble('ai', `<span class="err">等待超时，请重试</span>${retryBtn}<br/><small>30 秒内没有返回首字，可点重试或稍后再试。</small>`);
    } else {
      addBubble('ai', `<span class="err">出错了：${escapeHtml(e?.message || String(e))}</span>${retryBtn}<br/><small>${isTimeout ? '提示：上游响应过慢或网络中断，可点重试。' : '提示：到设置里检查 AI 配置的 API Key。'}</small>`);
    }
    const lastBubble = $sel('#ykt-ai-log')?.lastElementChild;
    lastBubble?.querySelector('.ykt-retry-btn')?.addEventListener('click', () => {
      lastBubble.remove();
      sendCurrent({ retryText: lastSendText });
    });
    return null;
  }
}

/**
 * 发送一轮对话（对外入口）。
 * 模型未调用工具时追加提示重试，总共最多 2 次。
 */
export async function sendCurrent(opts = {}) {
  // 自动作答可能从未打开过 AI tab：先挂载（面板默认隐藏，不打扰用户）
  if (!mounted) mountAIPanel();
  if (streaming) {
    ui.toast?.('AI 正在作答，请稍候', 1500);
    return null;
  }
  if (!opts.problemOverride && activeOverride) {
    activeOverride = null;
    renderCtxStatus();
  }
  streaming = true;
  setStreamingFlag(true);
  const sendBtn = $sel('#ykt-ai-send');
  if (sendBtn) sendBtn.disabled = true;
  try {
    let r = await runSend(opts);
    const attempt = opts.attempt || 1;
    const needRetry = r && !r.submitInfo && r.problem && !r.degraded
      && (r.isAnalyze || opts.autoSubmit) && attempt < 2;
    if (needRetry) {
      L('retry: model did not call submit_answer, attempt', attempt + 1);
      r = await runSend({ ...opts, attempt: attempt + 1, nudge: '继续，记得调用工具提交答案。' });
    }
    return r;
  } finally {
    streaming = false;
    setStreamingFlag(false);
    abortCtrl = null;
    if (sendBtn) sendBtn.disabled = false;
    const $log = $sel('#ykt-ai-log');
    if ($log) $log.scrollTop = $log.scrollHeight;
  }
}

// ---------------- 兼容旧导出（其他模块引用） ----------------
export async function askAIForCurrent() {
  return sendCurrent({ auto: true });
}
export async function askAIVisionForCurrent() {
  return sendCurrent({ auto: true });
}
export async function askAITextOnly() {
  return sendCurrent({ auto: true });
}

/** 自动作答入口：指定题目 + 直接提交 */
export async function askAIForProblem(problem, { autoSubmit = false } = {}) {
  activeOverride = problem || null;
  renderCtxStatus();
  try {
    return await sendCurrent({ auto: true, problemOverride: problem, autoSubmit });
  } finally {
    activeOverride = null;
    renderCtxStatus();
  }
}

// ---------------- Markdown / 富媒体渲染 ----------------


// ---------------- Markdown / 富媒体渲染 ----------------

const MERMAID_LOOSE_RE = /^\s*(graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b|mindmap|timeline|gitGraph)/i;

/** 行级剥离 HTML 包裹标签（AI 偶尔把 mermaid 包在 <p>/<br/> 里输出） */
function stripHtmlWrappers(text) {
  return String(text ?? '')
    .split('\n')
    .map(l => l.replace(/<\/?p[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** marked 实例在页面主世界（ensureMarked 用 script 标签注入），沙箱 window 上读不到 */
const getMarked = () => (gm.uw || window).marked || window.marked;

/** marked 产物进 innerHTML 前的清洗：优先 DOMPurify（已预热则同步可用），否则 sanitizeHtml */
function sanitizeFinal(md) {
  const purify = (gm.uw || window).DOMPurify || window.DOMPurify;
  if (purify?.sanitize) return purify.sanitize(md, { ADD_ATTR: ['target', 'data-raw', 'data-raw-b64'] });
  return sanitizeHtml(md);
}

/** 同步清洗（DOMPurify 未就绪时的回退） */
export function sanitizeHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(n => {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || (['href', 'src', 'xlink:href'].includes(name) && /^\s*javascript:/i.test(String(a.value || '')))) {
          n.removeAttribute(a.name);
        }
      }
    });
    return doc.body.innerHTML;
  } catch {
    return '';
  }
}

/** marked 解析前预处理：AI 偶尔输出「裸 mermaid + HTML 包裹」混合体，剥壳后围栏化 */
function preprocessRaw(raw) {
  if (/```/.test(raw)) return raw;    // 有围栏的交给 marked
  const stripped = stripHtmlWrappers(raw).trim();
  if (
    stripped &&
    MERMAID_LOOSE_RE.test(stripped) &&
    stripped.split('\n').length >= 2 &&
    stripped.length < 5000
  ) {
    return '```mermaid\n' + stripped + '\n```';
  }
  return raw;
}

/**
 * Markdown → HTML（同步，供流式 paint 使用）。
 * 富媒体占位：mermaid/svg/html 代码块转占位 div，真正渲染在 renderRich。
 * marked 未就绪时回退内置简化解析。
 */
export function mdToHtml(mdRaw = '') {
  let raw = preprocessRaw(String(mdRaw ?? ''));
  const blocks = [];   // 代码块暂存（占位符 → 原文），每次调用独立——模块级共享会串号

  // marked 把 \(、\[ 当标点转义吃掉反斜杠（验证：parse('\\(x_0\\)') → '(x_0)'），
  // 公式定界符到 typeset 时已经没了——parse 前把 \(...\)/\[...\] 整段抽成私用区占位符，
  // parse 完统一还原（代码块里的占位符留在 b.code 原样展示，还原发生在下方 B 回调）
  const mathSpans = [];
  raw = raw.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g, (m) => {
    mathSpans.push(m);
    return `\uE000M${mathSpans.length - 1}\uE001`;
  });
  // KaTeX 已就绪 → 占位符直接渲染成 <span class="katex">（流式期间公式即时出图）；
  // 未加载/渲染失败 → 还原裸文本 \(...\)，留给流末 MathJax/KaTeX 扫尾接管
  const katexReady = ((gm.uw || window).katex || window.katex)?.renderToString;
  const restoreMath = (s, render = false) => String(s).replace(/\uE000M(\d+)\uE001/g, (_, i) => {
    const raw2 = mathSpans[Number(i)] ?? '';
    if (!render || !katexReady) return raw2;
    const m = /^\\\[([\s\S]*?)\\\]$/.exec(raw2);
    const display = !!m;
    const src = display ? m[1] : (/^\\\(([\s\S]*?)\\\)$/.exec(raw2) || [])[1] ?? '';
    try {
      return katexReady(src, { displayMode: display, throwOnError: true });
    } catch { return raw2; }
  });
  let md;

  const marked = getMarked();
  if (marked?.parse) {
    try {
      // marked v9：options.renderer 传普通对象会整体替换默认 Renderer（缺方法即崩）——
      // 实例化 Renderer 再覆写 code；Renderer 不可用时才退化为对象字面量
      const onCode = function (code, lang) {
        const l = String(lang || '').toLowerCase().trim();
        blocks.push({ lang: l, code: String(code ?? '') });
        return `\uE000B${blocks.length - 1}\uE001`;
      };
      const renderer = typeof marked.Renderer === 'function'
        ? Object.assign(new marked.Renderer(), { code: onCode })
        : { code: onCode };
      md = marked.parse(raw, { breaks: true, gfm: true, renderer });
    } catch (e) {
      // 自定义 renderer 与 marked 版本不兼容时退回默认解析（代码块变 <pre><code>，embed 失效但不至于全崩）
      log.warn('[mdToHtml] marked renderer 解析失败，退回默认解析:', e?.message);
      try { md = marked.parse(raw, { breaks: true, gfm: true }); }
      catch (e2) { md = escapeHtml(raw); }
    }
  } else {
    md = raw.replace(/```([a-zA-Z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push({ lang: String(lang || '').toLowerCase(), code: code.replace(/\n$/, '') });
      return `\uE000B${blocks.length - 1}\uE001`;
    });
    md = escapeHtml(md).replace(/\r\n?/g, '\n');
    md = md.replace(/`([^`]+?)`/g, (_, code) => `<code class="ykt-md-inline">${code}</code>`);
    md = md
      .replace(/^######\s+(.*)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>')
      .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
      .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
    md = md.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  }

  const MERMAID_START_RE = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie\b|mindmap|timeline|gitGraph)\b/i;
  md = md.replace(/\uE000B(\d+)\uE001/g, (_, i) => {
    const b = blocks[Number(i)];
    if (!b) return '';
    const looksMermaid = b.lang === 'mermaid' || (!b.lang && MERMAID_START_RE.test(b.code));
    // data-raw 存 base64：mermaid 源码里的 --> 会被 HTML parser 当注释结束符吃掉属性，
    // <svg>/<div> 里的 < > " 同理——b64 全程安全（不含这些字符）
    if (looksMermaid) return `<div class="ykt-mermaid" data-raw-b64="${btoa(unescape(encodeURIComponent(b.code)))}"></div>`;
    if (b.lang === 'svg' || b.lang === 'html') {
      return `<div class="ykt-embed" data-raw-b64="${btoa(unescape(encodeURIComponent(b.code)))}"></div>`;
    }
    return `<pre class="ykt-md-code"><code${b.lang ? ` data-lang="${b.lang}"` : ''}>${escapeHtml(restoreMath(b.code))}</code></pre>`;
  });

  // 还原公式占位符：KaTeX 可用则直接渲染成 HTML（流式即时出图），否则还原裸文本给流末 typeset
  md = restoreMath(md, true);

  // marked 透传 markdown 里的原始 HTML——模型输出可能含危险标签，innerHTML 前必须清洗
  if (marked?.parse) return sanitizeFinal(md);

  // 回退路径的段落包裹
  const lines = md.split('\n');
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    out.push(`<p>${buf.join('<br/>')}</p>`);
    buf = [];
  };
  const isBlock = (s) => /^(<h[1-6]|<ul>|<ol>|<pre |<blockquote>|<hr\/>|<p>|<table|<div|\uE000B\d+\uE001$)/.test(s.trim());
  for (const ln of lines) {
    if (!ln.trim()) { flush(); continue; }
    if (isBlock(ln)) { flush(); out.push(ln); }
    else { buf.push(ln); }
  }
  flush();
  return out.join('\n');
}

/** 裸 mermaid 兜底：AI 不守规矩直接输出流程图文本时（含被 <p>/<br/> 包裹的） */
function rescueLooseMermaid(el) {
  for (const p of [...el.querySelectorAll('p')]) {
    const text = stripHtmlWrappers(p.textContent || '');
    if (MERMAID_LOOSE_RE.test(text) && text.split('\n').length >= 2) {
      const div = document.createElement('div');
      div.className = 'ykt-mermaid';
      div.setAttribute('data-raw-b64', btoa(unescape(encodeURIComponent(text))));
      p.replaceWith(div);
    }
  }
}

/**
 * 富媒体后处理（异步）：mermaid 图、HTML/SVG 嵌入、MathJax 公式。
 * 在流式完成的最终 innerHTML 之后调用。
 */
export async function renderRich(el) {
  if (!el) return;
  try {
    // marked 默认解析路径（自定义 renderer 不可用时）把围栏代码块渲染成
    // <pre><code class="language-*">——把 mermaid/html/svg 捞回 embed 占位再走正常管线
    for (const codeEl of [...el.querySelectorAll('pre > code[class*="language-"]')]) {
      const lang = (codeEl.className.match(/language-(\w+)/) || [])[1];
      if (!['mermaid', 'html', 'svg'].includes(lang)) continue;
      const div = document.createElement('div');
      div.className = lang === 'mermaid' ? 'ykt-mermaid' : 'ykt-embed';
      div.setAttribute('data-raw-b64', btoa(unescape(encodeURIComponent(codeEl.textContent || ''))));
      codeEl.parentElement.replaceWith(div);
    }
    rescueLooseMermaid(el);
    // 1) mermaid → SVG：占位符先显示加载态，渲染完成/失败都有明确反馈（不再是空白等干等）
    const decodeRaw = (node) => {
      const b64 = node.getAttribute('data-raw-b64');
      if (b64) try { return decodeURIComponent(escape(atob(b64))); } catch {}
      return node.getAttribute('data-raw') || '';
    };
    const mermaidEls = [...el.querySelectorAll('.ykt-mermaid[data-raw-b64], .ykt-mermaid[data-raw]')];
    if (mermaidEls.length) {
      for (const node of mermaidEls) {
        node.innerHTML = '<div class="ykt-mermaid-loading" style="padding:14px 10px;color:#94a3b8;font-size:12px;text-align:center;background:#f8fafc;border-radius:6px"><i class="fas fa-circle-notch fa-spin"></i> 正在渲染图表…</div>';
      }
      try {
        const mermaid = await ensureMermaid();
        for (const node of mermaidEls) {
          // AI 偶尔在 mermaid 源码里混入 <p>/<br/> 等标签导致解析失败——渲染前剥掉
          const src = stripHtmlWrappers(decodeRaw(node));
          try {
            // 渲染超时兜底：卡住 15s 不再干等
            const { svg } = await Promise.race([
              mermaid.render(`ykmmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, src),
              new Promise((_, rej) => setTimeout(() => rej(new Error('渲染超时（15s）')), 15000)),
            ]);
            const wrap = document.createElement('div');
            wrap.className = 'ykt-mermaid-render';
            wrap.innerHTML = svg;
            node.replaceWith(wrap);
          } catch (e) {
            const reason = String(e?.message || e || '语法错误');
            log.warn('[Rich] mermaid 渲染失败:', reason);
            const pre = document.createElement('pre');
            pre.className = 'ykt-md-code';
            pre.innerHTML = `<div style="color:#dc2626;font-size:12px;padding:6px 8px;background:#fef2f2;border-radius:4px 4px 0 0;border-bottom:1px solid #fecaca">⚠️ Mermaid 渲染失败：${escapeHtml(reason.slice(0, 120))}</div>`;
            const code = document.createElement('div');
            code.style.cssText = 'padding:8px;white-space:pre-wrap;font-size:12px;color:#475569;';
            code.textContent = src;
            pre.appendChild(code);
            node.replaceWith(pre);
          }
        }
      } catch (e) {
        log.warn('[Rich] mermaid 加载失败:', e?.message);
        mermaidEls.forEach(node => {
          const pre = document.createElement('pre');
          pre.className = 'ykt-md-code';
          pre.innerHTML = `<div style="color:#dc2626;font-size:12px;padding:6px 8px;background:#fef2f2;border-radius:4px 4px 0 0">⚠️ Mermaid 库加载失败（CDN 不可达）</div>`;
          const code = document.createElement('div');
          code.style.cssText = 'padding:8px;white-space:pre-wrap;font-size:12px;color:#475569;';
          code.textContent = decodeRaw(node);
          pre.appendChild(code);
          node.replaceWith(pre);
        });
      }
    }
    // 2) svg/html 嵌入 → DOMPurify 清洗后渲染
    for (const node of [...el.querySelectorAll('.ykt-embed[data-raw-b64], .ykt-embed[data-raw]')]) {
      const rawHtml = decodeRaw(node);
      try {
        const purify = await ensureDOMPurify();
        node.innerHTML = purify.sanitize(rawHtml, { ADD_ATTR: ['target'] });
      } catch {
        node.innerHTML = sanitizeHtml(rawHtml);
      }
      node.removeAttribute('data-raw');
      node.removeAttribute('data-raw-b64');
    }
    // 3) 公式渲染：MathJax v3（@require）→ MathJax v2（页面自带）→ KaTeX（壳内 CDN 本地回源）
    if (ui?.config?.iftex) {
      const ok = await ensureMathJax();
      if (ok) {
        dollarToParen(el);
        el.classList.add('tex-enabled');
        await typesetTexIn(el);
      } else {
        await typesetWithKaTeX(el);
      }
    }
  } catch (e) {
    log.warn('[Rich] renderRich 失败:', e);
  }
}

/** 预热富媒体依赖（面板挂载时后台加载）：marked/DOMPurify 给 mdToHtml，
 *  KaTeX 给流式期间的公式即时渲染（越早就绪，首条公式越早出图） */
export function warmupRichAssets() {
  ensureMarked().then(m => { try { m.setOptions({ breaks: true, gfm: true }); } catch {} }).catch(e => log.warn('[Rich] marked 预热失败', e?.message));
  ensureDOMPurify().catch(e => log.warn('[Rich] DOMPurify 预热失败', e?.message));
  ensureKaTeX().catch(e => log.warn('[Rich] KaTeX 预热失败（流末兜底仍可）', e?.message));
}

// ===== 流式增量渲染：封板区 + 活跃区 =====
// 封板边界 = 不在代码围栏、不在公式定界内，且落在 \n\n（段落界）/围栏闭合行/闭合 display math 之后。
// 围栏和 \(...\)/\[...\]/$$...$$ 之外的裸 $...$ 不跟踪（价格误伤风险，归流末 dollarToParen 处理）。
function findSafeBoundary(text, from = 0) {
  const n = text.length;
  let i = from, inFence = false, inParen = false, inBrack = false, inDbl = false, safe = -1;
  while (i < n) {
    const two = text.substr(i, 2);
    if (inFence) {
      if (text.startsWith('```', i) && text[i - 1] === '\n') {
        inFence = false;
        const e = text.indexOf('\n', i + 3);
        i = (e < 0 ? n : e + 1);
        safe = i;                            // 围栏闭合行之后是安全点
        continue;
      }
      i++; continue;
    }
    if (inParen) { if (two === '\\)') { inParen = false; i += 2; } else i++; continue; }
    if (inBrack) { if (two === '\\]') { inBrack = false; i += 2; safe = i; } else i++; continue; }
    if (inDbl)   { if (two === '$$')  { inDbl = false;   i += 2; safe = i; } else i++; continue; }
    if (text.startsWith('```', i) && (i === 0 || text[i - 1] === '\n')) { inFence = true; i += 3; continue; }
    if (two === '\\(') { inParen = true; i += 2; continue; }
    if (two === '\\[') { inBrack = true; i += 2; continue; }
    if (two === '$$')  { inDbl = true;   i += 2; continue; }
    if (text[i] === '\n' && text[i + 1] === '\n') { safe = i + 2; i += 2; continue; }
    i++;
  }
  return safe;
}

/**
 * 流式增量渲染器：把输出切成「已封板」（完整段落/闭合代码块/闭合 display 公式——就地 renderRich）
 * 和「活跃区」（正在输入的尾巴——每帧 mdToHtml 重写，公式占位符走 KaTeX 即时渲染）。
 * 用法：renderer.attach(slot) → paint 里 renderer.update(text) → 流末 renderer.finish(text)。
 * paint 每次重建 slot（innerHTML 整段替换），attach 会把 sealed/live 子树搬回新 slot。
 */
export class StreamRenderer {
  attach(slot) {
    if (!slot) return;
    if (this.sealed && this.slot === slot && this.sealed.isConnected) return;
    this.slot = slot;
    // 关键点：sealed 脱离 DOM（repaint 重建 slot）时 *移动* 而不是重建——
    // 重建会丢掉已封板内容（用户看到“前面段落消失，只剩最后一段”）
    if (!this.sealed) {
      this.sealed = document.createElement('div');
      this.sealed.className = 'ykt-sr-sealed';
      this.live = document.createElement('div');
      this.live.className = 'ykt-sr-live';
      this.sealedSoFar = 0;
    }
    slot.textContent = '';
    slot.append(this.sealed, this.live);
  }
  /** @param {string} text 全量已累积文本 @param {string} emptyHint 空内容时 live 区的提示 */
  update(text, emptyHint = '') {
    if (!this.slot) return;
    const t = String(text ?? '');
    const b = findSafeBoundary(t, this.sealedSoFar || 0);
    if (b > (this.sealedSoFar || 0)) {
      const frag = document.createElement('div');
      frag.innerHTML = mdToHtml(t.slice(this.sealedSoFar || 0, b));
      this.sealed.appendChild(frag);
      renderRich(frag);                      // 异步：mermaid/embed/剩余公式就地渲染
      this.sealedSoFar = b;
    }
    const tail = t.slice(this.sealedSoFar || 0);
    this.live.innerHTML = tail ? mdToHtml(tail) : emptyHint;
  }
  /** 流末收尾：尾部并入封板区做一次 renderRich（跨边界结构兜底），live 清空 */
  async finish(text) {
    if (!this.slot) { return; }
    const t = String(text ?? '');
    const frag = document.createElement('div');
    frag.innerHTML = mdToHtml(t.slice(this.sealedSoFar || 0));
    this.sealed.appendChild(frag);
    this.live.innerHTML = '';
    this.sealedSoFar = t.length;
    await renderRich(frag);
  }
}
