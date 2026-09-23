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
import { getCurrentMainPageSlideId, waitForVueReady, watchMainPageChange } from '../../core/vuex-helper.js';
import { agnesChat } from '../../ai/agnes.js';
import { resolveCurrentSlideImage } from '../slide-image.js';
import { ensureMermaid, ensureMarked, ensureDOMPurify, gm } from '../../core/env.js';
import { escapeHtml } from '../../core/dom.js';
import { PROBLEM_TYPE_MAP, DEFAULT_SYSTEM_PROMPT_AI } from '../../core/types.js';

const L = (...a) => log.dbg('[ai]', ...a);
const W = (...a) => log.warn('[ai]', ...a);

let mounted = false;
let root;
let preferredSlideFromPresentation = null; // 来自课件面板/事件的指定页

let history = [];           // OpenAI 格式消息
let streaming = false;      // 防并发发送
let abortCtrl = null;

const systemPrompt = () => String(ui?.config?.systemPromptAI || '').trim() || DEFAULT_SYSTEM_PROMPT_AI;

const DEFAULT_ANALYZE_PROMPT = '请解答此页的题目：先给答案，再给简要解题过程。若页面不是题目页，请概述页面内容。';

function ensureMathJax() {
  const mj = window.MathJax;
  const ok = !!(mj && mj.typesetPromise);
  if (!ok) log.warn('[ai] MathJax 未就绪（未通过 @require 预置？）');
  return Promise.resolve(ok);
}

function typesetTexIn(el) {
  const mj = window.MathJax;
  if (!el || !mj || typeof mj.typesetPromise !== 'function') return Promise.resolve(false);
  const ready = mj.startup && mj.startup.promise ? mj.startup.promise : Promise.resolve();
  return ready.then(() => mj.typesetPromise([el]).then(() => true).catch(() => false));
}

function $sel(sel) { return root.querySelector(sel); }

export function mountAIPanel() {
  if (mounted) return root;

  const host = document.createElement('div');
  host.innerHTML = tpl;
  document.body.appendChild(host.firstElementChild);
  root = document.getElementById('ykt-ai-answer-panel');

  // 面板嵌在 shell 里——关闭=通知 shell 收起（并触发 __yksOnHide 中止流式）
  $sel('#ykt-ai-close').addEventListener('click', () => window.dispatchEvent(new CustomEvent('ykt:close-shell')));
  $sel('#ykt-ai-clear').addEventListener('click', () => {
    abortStreaming('清空会话');
    history = [];
    renderHistory();
    addBubble('ai', mdToHtml('会话已清空。点击「发送」（输入留空）可解答当前页题目。'));
  });

  const $input = $sel('#ykt-ai-input');
  const $send = $sel('#ykt-ai-send');
  $send.addEventListener('click', () => sendCurrent());
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });

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
  root.__yksOnHide = () => abortStreaming('面板已隐藏');
  return root;
}

export function showAIPanel(v = true) {
  if (!mounted) mountAIPanel();
  if (!v) abortStreaming('面板已关闭');
  root.classList.toggle('visible', !!v);
  if (v) {
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

/** 页面识别状态行（面板底部小字） */
function renderCtxStatus() {
  if (!mounted) return;
  const statusEl = $sel('#ykt-ai-text-status');
  if (!statusEl) return;
  const { slide, source } = pickCurrentSlide();
  if (slide) {
    const hasProblem = !!slide.problem;
    statusEl.textContent = `✓ ${source}${hasProblem ? ' · 含题目' : ''}`;
    statusEl.style.color = '';
  } else {
    statusEl.textContent = '⚠ 未检测到课件页（可先在课堂里翻页）';
    statusEl.style.color = '#b42318';
  }
  renderCtxThumb();
}

async function renderCtxThumb() {
  const span = $sel('#ykt-ai-ctx-thumb');
  if (!span) return;
  span.textContent = '⏳';
  const { dataUrl } = await resolveCurrentSlideImage();
  if (dataUrl) {
    span.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.title = '当前 PPT 页';
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
  };
}

async function sendCurrent({ auto = false } = {}) {
  if (streaming) return;
  const $input = $sel('#ykt-ai-input');
  const text = ($input?.value || '').trim();
  const isAnalyze = !text;                       // 空输入 = 解答此页
  if (!text && !auto) { /* 空输入也允许：解答此页 */ }
  const customPrompt = ($sel('#ykt-ai-custom-prompt')?.value || '').trim();
  const attach = $sel('#ykt-ai-attach')?.checked ?? true;

  streaming = true;
  $sel('#ykt-ai-send').disabled = true;
  try {
    const content = [{ type: 'text', text: text || DEFAULT_ANALYZE_PROMPT }];
    let attachFailed = '';
    if (attach || isAnalyze) {
      const pending = addBubble('user', `⏳ 正在获取当前 PPT…${text ? '' : '（解答此页）'}`);
      const { dataUrl, reason } = await resolveCurrentSlideImage();
      pending.remove();
      if (dataUrl) {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      } else if (isAnalyze) {
        attachFailed = reason || '未取到当前 PPT 页';
      }
    }

    const userText = buildUserText(pickCurrentSlide().slide?.problem, customPrompt, isAnalyze);
    // 题干文本注入：首轮整段作为文本；追问时只追加用户输入（题干已在历史里）
    if (isAnalyze) content[0].text = userText || DEFAULT_ANALYZE_PROMPT;
    else if (text) content[0].text = text + (customPrompt ? `\n【用户自定义要求】\n${customPrompt}` : '');

    history.push({ role: 'user', content });
    trimOldImages(1);
    const userBubble = addBubble('user', escapeHtml(text || DEFAULT_ANALYZE_PROMPT));
    for (const c of content) {
      if (c.type === 'image_url') {
        const img = document.createElement('img');
        img.src = c.image_url.url;
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
    const acc = { content: '', reasoning: '' };
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
          + (acc.content ? mdToHtml(acc.content) : (thinking ? '' : '<em>…</em>'));
        const rBody = aiBubble.querySelector('.reasoning-body');
        if (rBody) { rBody.textContent = acc.reasoning; rBody.scrollTop = rBody.scrollHeight; }
        const $log = $sel('#ykt-ai-log');
        $log.scrollTop = $log.scrollHeight;
      });
    };

    abortCtrl = new AbortController();
    const res = await agnesChat({
      messages: [{ role: "system", content: systemPrompt() }, ...history],
      stream: true,
      thinking: true,
      signal: abortCtrl.signal,
      override: getOverride() || undefined,
      onDelta: (d) => { acc.content += d; paint(); },
      onReasoning: (d) => { acc.reasoning += d; paint(); },
    });

    acc.content = res.content || acc.content;
    acc.reasoning = res.reasoning || acc.reasoning;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }   // 防止挂起的 paint 覆盖 renderRich 成果
    aiBubble.innerHTML =
      (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : '')
      + (acc.content ? mdToHtml(acc.content) : '<span class="err">（空回复）</span>');
    renderRich(aiBubble);

    history.push({ role: 'assistant', content: acc.content || '（无内容）' });
  } catch (e) {
    const emsg = String(e?.message || '');
    const isTimeout = /timeout|超时/i.test(emsg);
    const aborted = (e?.name === 'AbortError' && !isTimeout) || /abort|cancel/i.test(emsg);
    if (aborted) {
      addBubble('ai', '<span class="muted">（已取消）</span>');
    } else {
      addBubble('ai', `<span class="err">出错了：${escapeHtml(e?.message || String(e))}</span><br/><small>提示：到设置里检查 AI 配置的 API Key。</small>`);
    }
  } finally {
    streaming = false;
    abortCtrl = null;
    $sel('#ykt-ai-send').disabled = false;
    $sel('#ykt-ai-log').scrollTop = $sel('#ykt-ai-log').scrollHeight;
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
  if (purify?.sanitize) return purify.sanitize(md, { ADD_ATTR: ['target', 'data-raw'] });
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
  const raw = preprocessRaw(String(mdRaw ?? ''));
  const blocks = [];   // 代码块暂存（占位符 → 原文），每次调用独立——模块级共享会串号
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
    if (looksMermaid) return `<div class="ykt-mermaid" data-raw="${escapeHtml(b.code).replace(/"/g, '&quot;')}"></div>`;
    if (b.lang === 'svg' || b.lang === 'html') {
      return `<div class="ykt-embed" data-raw="${escapeHtml(b.code).replace(/"/g, '&quot;')}"></div>`;
    }
    return `<pre class="ykt-md-code"><code${b.lang ? ` data-lang="${b.lang}"` : ''}>${escapeHtml(b.code)}</code></pre>`;
  });

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
      div.setAttribute('data-raw', text);
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
      div.setAttribute('data-raw', codeEl.textContent || '');
      codeEl.parentElement.replaceWith(div);
    }
    rescueLooseMermaid(el);
    // 1) mermaid → SVG
    const mermaidEls = [...el.querySelectorAll('.ykt-mermaid[data-raw]')];
    if (mermaidEls.length) {
      try {
        const mermaid = await ensureMermaid();
        for (const node of mermaidEls) {
          // AI 偶尔在 mermaid 源码里混入 <p>/<br/> 等标签导致解析失败——渲染前剥掉
          const src = stripHtmlWrappers(node.getAttribute('data-raw') || '');
          try {
            const { svg } = await mermaid.render(`ykmmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, src);
            const wrap = document.createElement('div');
            wrap.className = 'ykt-mermaid-render';
            wrap.innerHTML = svg;
            node.replaceWith(wrap);
          } catch (e) {
            log.warn('[Rich] mermaid 渲染失败，显示源码:', e?.message);
            const pre = document.createElement('pre');
            pre.className = 'ykt-md-code';
            pre.textContent = src;
            node.replaceWith(pre);
          }
        }
      } catch (e) {
        log.warn('[Rich] mermaid 加载失败:', e?.message);
        mermaidEls.forEach(node => {
          const pre = document.createElement('pre');
          pre.className = 'ykt-md-code';
          pre.textContent = node.getAttribute('data-raw') || '';
          node.replaceWith(pre);
        });
      }
    }
    // 2) svg/html 嵌入 → DOMPurify 清洗后渲染
    for (const node of [...el.querySelectorAll('.ykt-embed[data-raw]')]) {
      const rawHtml = node.getAttribute('data-raw') || '';
      try {
        const purify = await ensureDOMPurify();
        node.innerHTML = purify.sanitize(rawHtml, { ADD_ATTR: ['target'] });
      } catch {
        node.innerHTML = sanitizeHtml(rawHtml);
      }
      node.removeAttribute('data-raw');
    }
    // 3) MathJax 公式
    if (ui?.config?.iftex) {
      const ok = await ensureMathJax();
      if (ok) { el.classList.add('tex-enabled'); await typesetTexIn(el); }
    }
  } catch (e) {
    log.warn('[Rich] renderRich 失败:', e);
  }
}

/** 预热富媒体依赖（面板挂载时后台拉 CDN） */
export function warmupRichAssets() {
  ensureMarked().then(m => { try { m.setOptions({ breaks: true, gfm: true }); } catch {} }).catch(e => log.warn('[Rich] marked 预热失败', e?.message));
  ensureDOMPurify().catch(e => log.warn('[Rich] DOMPurify 预热失败', e?.message));
}
