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
import { ensureMermaid } from '../../core/env.js';
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

  $sel('#ykt-ai-close').addEventListener('click', () => showAIPanel(false));
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

  window.addEventListener('ykt:open-ai', () => {
    showAIPanel(true);
  });

  mounted = true;
  renderCtxStatus();
  // shell 切到本 tab 时刷新（数据晚于挂载到达的场景：WS 课件、页面切换）
  root.__yksOnShow = () => {
    renderCtxStatus();
    if (history.length === 0 && !$sel('#ykt-ai-log').children.length) {
      addBubble('ai', mdToHtml('点击「发送」（输入留空）即可解答当前页题目；也可以直接输入问题针对页面内容追问。'));
    }
  };
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
  const aiBtn = document.getElementById('ykt-btn-ai');
  if (aiBtn) aiBtn.classList.toggle('active', !!v);
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
  const prio = !(ui?.config?.aiSlidePickPriority === 'presentation');
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
      const sid = repo.problemStatus.get(latest.problemId)?.slideId ? String(repo.problemStatus.get(latest.problemId).slideId) : null;
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 发送 ----------------

/** 当前激活 Profile → agnesChat override（保留任意 OpenAI 兼容端点能力） */
function getOverride() {
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

    const userText = buildUserText(pickCurrentSlide().slide, customPrompt, isAnalyze);
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
    aiBubble.innerHTML =
      (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : '')
      + (acc.content ? mdToHtml(acc.content) : '<span class="err">（空回复）</span>');
    renderRich(aiBubble);

    history.push({ role: 'assistant', content: acc.content || '（无内容）' });
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /abort|cancel/i.test(String(e?.message || ''));
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

function safeLink(url = '') {
  try {
    const u = new URL(url, location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (_) {}
  return null;
}

/** 清洗 AI 产出的 HTML/SVG：去除脚本、事件属性与 javascript: 协议 */
export function sanitizeHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(n => {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        const val = String(a.value || '');
        if (name.startsWith('on')) { n.removeAttribute(a.name); continue; }
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(val)) {
          n.removeAttribute(a.name);
        }
      }
    });
    return doc.body.innerHTML;
  } catch {
    return '';
  }
}

/**
 * Markdown → HTML。
 * fenced 代码块先提取占位（```mermaid / ```svg / ```html 会渲染为可视化元素，
 * 其余保持普通代码块），避免整体转义把可视化内容变成纯文本。
 */
export function mdToHtml(mdRaw = '') {
  const blocks = [];
  const raw = String(mdRaw ?? '');
  const withPlaceholders = raw.replace(/```([a-zA-Z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: String(lang || '').toLowerCase(), code: code.replace(/\n$/, '') });
    return `\uE000B${blocks.length - 1}\uE001`;
  });

  let md = escapeHtml(withPlaceholders).replace(/\r\n?/g, '\n');

  md = md.replace(/`([^`]+?)`/g, (_, code) => `<code class="ykt-md-inline">${code}</code>`);

  md = md
    .replace(/^######\s+(.*)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

  md = md.replace(/^(?:&gt;\s?.+(\n(?!\n).+)*)/gm, (block) => {
    const inner = block.replace(/^&gt;\s?/gm, '');
    return `<blockquote>${inner}</blockquote>`;
  });

  md = md.replace(
    /(^(-|\*|\+)\s+.+(\n(?!\n).+)*)/gm,
    (block) => {
      const items = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(-|\*|\+)\s+/.test(l))
        .map((l) => `<li>${l.replace(/^(-|\*|\+)\s+/, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }
  );

  md = md.replace(
    /(^\d+\.\s+.+(\n(?!\n).+)*)/gm,
    (block) => {
      const items = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\d+\.\s+/.test(l))
        .map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    }
  );

  md = md.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  md = md.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  md = md.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  md = md.replace(/(^|[^\\])_([^_]+?)_/g, '$1<em>$2</em>');
  md = md.replace(/^\s*([-*_]){3,}\s*$/gm, '<hr/>');

  md = md.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_, text, url) => {
    const safe = safeLink(url);
    if (!safe) return text;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // 还原代码块占位符
  md = md.replace(/\uE000B(\d+)\uE000/g, (_, i) => {
    const b = blocks[Number(i)];
    if (!b) return '';
    const esc = escapeHtml(b.code);
    if (b.lang === 'mermaid') return `<div class="ykt-mermaid" data-raw="${escapeHtml(b.code).replace(/"/g, '&quot;')}"></div>`;
    if (b.lang === 'svg' || b.lang === 'html') {
      return `<div class="ykt-embed" data-raw="${escapeHtml(b.code).replace(/"/g, '&quot;')}"></div>`;
    }
    return `<pre class="ykt-md-code"><code${b.lang ? ` data-lang="${b.lang}"` : ''}>${esc}</code></pre>`;
  });

  // 段落包裹（占位符块按块级处理）
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

/**
 * 富媒体后处理：把 mdToHtml 产出的可视化占位渲染出来 + MathJax 公式。
 * - .ykt-mermaid → mermaid 图（按需加载 CDN，失败回退显示源码）
 * - .ykt-embed   → sanitize 后的 HTML/SVG
 * - $...$ 公式   → MathJax（ui.config.iftex 开启时）
 */
export async function renderRich(el) {
  if (!el) return;
  try {
    // 1) mermaid
    const mermaidEls = [...el.querySelectorAll('.ykt-mermaid[data-raw]')];
    if (mermaidEls.length) {
      try {
        const mermaid = await ensureMermaid();
        for (const node of mermaidEls) {
          const src = node.getAttribute('data-raw') || '';
          try {
            const { svg } = await mermaid.render(`ykmmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, src);
            const wrap = document.createElement('div');
            wrap.className = 'ykt-mermaid-render';
            wrap.innerHTML = sanitizeHtml(svg);
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
    // 2) svg/html 嵌入
    for (const node of [...el.querySelectorAll('.ykt-embed[data-raw]')]) {
      const raw = node.getAttribute('data-raw') || '';
      node.innerHTML = sanitizeHtml(raw);
      node.removeAttribute('data-raw');
    }
    // 3) mermaid 容器清理 data-raw（已渲染）
    el.querySelectorAll('.ykt-mermaid[data-raw]').forEach(n => n.removeAttribute('data-raw'));
    // 4) MathJax
    if (ui?.config?.iftex) {
      const ok = await ensureMathJax();
      if (ok) { el.classList.add('tex-enabled'); await typesetTexIn(el); }
    }
  } catch (e) {
    log.warn('[Rich] renderRich 失败:', e);
  }
}
