// src/ui/rich.js
// Markdown / Mermaid / 公式 / 流式增量渲染（从 ai.js 抽出，chat 与 AI 解答共用）
import { log } from '../core/log.js';
import { ui } from './ui-api.js';
import { ensureMermaid, ensureMarked, ensureDOMPurify, ensureKaTeX, gm } from '../core/env.js';
import { escapeHtml } from '../core/dom.js';

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

/** MathJax 默认不认单 $ 行内公式（防价格文本误匹配）。 */
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

/** KaTeX 兜底：MathJax 不在（壳内无 @require）时用它逐节点渲染 */
async function typesetWithKaTeX(el) {
  try {
    const katex = await ensureKaTeX();
    dollarToParen(el);
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
  return new Promise((resolve) => {
    try {
      pick.mj.Hub.Queue(['Typeset', pick.mj.Hub, el], function () { resolve(true); });
    } catch { resolve(false); }
  });
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
    const schemeOf = (value) => Array.from(String(value || ''))
      .filter((ch) => ch.charCodeAt(0) > 32)
      .join('')
      .toLowerCase();
    const isDangerous = (value, { allowDataImage = false } = {}) => {
      const s = schemeOf(value);
      if (/^(javascript|vbscript):/.test(s)) return true;
      if (/^data:/.test(s)) return !(allowDataImage && /^data:image\//.test(s));
      return false;
    };
    doc.querySelectorAll('*').forEach((n) => {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        const value = String(a.value || '');
        if (name.startsWith('on') || name === 'srcdoc') {
          n.removeAttribute(a.name);
          continue;
        }
        if (name === 'style' && /(?:url\s*\(|expression\s*\(|behavior\s*:)/i.test(value)) {
          n.removeAttribute(a.name);
          continue;
        }
        if (['href', 'xlink:href', 'action', 'formaction'].includes(name) && isDangerous(value)) {
          n.removeAttribute(a.name);
        } else if (['src', 'poster', 'background'].includes(name) && isDangerous(value, { allowDataImage: true })) {
          n.removeAttribute(a.name);
        } else if (name === 'srcset' && /(?:javascript|vbscript|data:text\/html)/i.test(schemeOf(value))) {
          n.removeAttribute(a.name);
        }
      }
      if (n.tagName === 'A' && n.getAttribute('target') === '_blank') {
        const rel = String(n.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
        for (const token of ['noopener', 'noreferrer']) if (!rel.includes(token)) rel.push(token);
        n.setAttribute('rel', rel.join(' '));
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
