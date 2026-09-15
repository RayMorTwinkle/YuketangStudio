// src/ui/panels/chat.js
// PPT 多轮对话面板：截取/读取当前 PPT 页 + 连续追问，思考链折叠显示，流式输出
import tpl from './chat.html';
import { log } from '../../core/log.js';
import { ui } from '../ui-api.js';
import { repo } from '../../state/repo.js';
import { fetchAsDataURL } from '../../core/env.js';
import { agnesChat } from '../../ai/agnes.js';
import { mdToHtml } from './ai.js';

let mounted = false;
let root;

let history = [];           // OpenAI 格式消息
let streaming = false;      // 防并发发送
let abortCtrl = null;

const SYSTEM_PROMPT = [
  '你是「YuketangStudio」雨课堂学习助手，帮助学生理解课堂 PPT 与回答课程相关问题。',
  '规则：',
  '1) 用户消息可能附带当前 PPT 页截图，回答时优先结合图片内容；',
  '2) 回答使用简体中文，简洁准确，适当使用 Markdown（列表/粗体/公式用 $...$）；',
  '3) 若是数学/算法题，给出思路与关键步骤，不要只给结论；',
  '4) 图片无法识别时直接说明，不要编造。',
].join('\n');

function $sel(sel) { return root.querySelector(sel); }

export function mountChatPanel() {
  if (mounted) return root;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = tpl;
  document.body.appendChild(wrapper.firstElementChild);
  root = document.getElementById('ykt-chat-panel');

  $sel('#ykt-chat-close').addEventListener('click', () => showChatPanel(false));
  $sel('#ykt-chat-clear').addEventListener('click', () => {
    abortStreaming('清空会话');
    history = [];
    renderHistory();
    addBubble('ai', mdToHtml('会话已清空。可以重新开始提问（如需新 PPT 上下文，直接发送即可）。'));
  });

  const $input = $sel('#ykt-chat-input');
  const $send = $sel('#ykt-chat-send');
  $send.addEventListener('click', () => sendCurrent());
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });

  mounted = true;
  return root;
}

export function showChatPanel(visible = true) {
  if (!mounted) mountChatPanel();
  // 关闭面板时终止仍在进行的流式请求，避免后台继续消耗 token
  if (!visible) abortStreaming('面板已关闭');
  root.classList.toggle('visible', visible);
  if (visible) {
    refreshCtxThumb();
    setTimeout(() => $sel('#ykt-chat-input')?.focus(), 60);
  }
}

export function toggleChatPanel() {
  if (!mounted) mountChatPanel();
  showChatPanel(!root.classList.contains('visible'));
}

// ---------------- 当前 PPT 页获取 ----------------

/** 在 repo 中定位当前 slide（课堂内主路径） */
function findCurrentSlide() {
  try {
    const sid = repo.currentSlideId != null ? String(repo.currentSlideId) : null;
    if (sid && repo.slides.has(sid)) return repo.slides.get(sid);
    for (const [, pres] of repo.presentations) {
      const hit = (pres?.slides || []).find(s => String(s.id) === sid);
      if (hit) return hit;
    }
    // 退化：取 presentation 的第一页
    for (const [, pres] of repo.presentations) {
      if (pres?.slides?.length) return pres.slides[0];
    }
  } catch (e) { log.warn('[Chat] findCurrentSlide', e); }
  return null;
}

function slideImageUrl(slide) {
  return slide?.coverAlt || slide?.cover || slide?.image || slide?.thumbnail || '';
}

/**
 * 解析当前 PPT 页，返回 { dataUrl, source, reason }
 * source: 'repo'        = 命中 repo 里的 slide 图（最可信）
 *         'dom'         = 从页面 DOM 里找到的 slide 图
 *         'failed'      = 拿不到，reason 说明原因
 * 注意：**不再用整页 html2canvas 兜底**——那会悄悄把「整个页面截图」当成 PPT 发给 AI，
 *      导致回答质量崩坏且用户毫不知情。宁可明确失败，也不给假上下文。
 */
async function resolveCurrentSlideImage() {
  // 1) repo 中的 slide（课堂内正常路径）
  const slide = findCurrentSlide();
  const url = slideImageUrl(slide);
  if (url) {
    try {
      const dataUrl = await fetchAsDataURL(url);
      if (dataUrl) return { dataUrl, source: 'repo' };
    } catch (e) {
      log.warn('[Chat] repo slide 图下载失败，尝试 DOM 兜底:', e?.message);
    }
  }

  // 2) DOM 兜底：静态报告页等 repo 为空但页面有 slide 图的场景
  const domUrl = findSlideUrlInDom();
  if (domUrl) {
    try {
      const dataUrl = await fetchAsDataURL(domUrl);
      if (dataUrl) return { dataUrl, source: 'dom' };
    } catch (e) {
      log.warn('[Chat] DOM slide 图下载失败:', e?.message);
    }
  }

  return {
    dataUrl: null,
    source: 'failed',
    reason: slide || url ? 'PPT 图片下载失败（可能是网络或权限问题）' : '当前页面没有可用的 PPT 页',
  };
}

/** 从页面 DOM 里找 slide 图（报告页/静态课件的退化路径） */
function findSlideUrlInDom() {
  try {
    const selectors = [
      '.slide-item.active-slide-item img',
      '.slide-item img',
      '.swiper-slide-active img',
      '.ppt-courseware-inner img',
      '.ppt-inner img',
    ];
    for (const sel of selectors) {
      const img = document.querySelector(sel);
      const src = img?.currentSrc || img?.src || '';
      if (src && /\/slide\/|cover/i.test(src)) return src;
    }
  } catch (e) { log.warn('[Chat] findSlideUrlInDom', e); }
  return '';
}

async function refreshCtxThumb() {
  const span = $sel('#ykt-chat-ctx-thumb');
  span.textContent = '⏳';
  const { dataUrl, source, reason } = await resolveCurrentSlideImage();
  if (dataUrl) {
    span.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.title = source === 'repo' ? '当前 PPT 页（来自课件数据）' : '当前 PPT 页（来自页面）';
    span.appendChild(img);
  } else {
    span.textContent = `（未取到 PPT：${reason || '未知原因'}）`;
  }
}

// ---------------- 渲染 ----------------

function addBubble(kind, htmlOrNode) {
  const $log = $sel('#ykt-chat-log');
  const div = document.createElement('div');
  div.className = `ykt-chat-msg ${kind}`;
  if (typeof htmlOrNode === 'string') div.innerHTML = htmlOrNode;
  else div.appendChild(htmlOrNode);
  $log.appendChild(div);
  $log.scrollTop = $log.scrollHeight;
  return div;
}

function renderHistory() {
  const $log = $sel('#ykt-chat-log');
  $log.innerHTML = '';
  for (const m of history) {
    if (m.role === 'system') continue;
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter(c => c.type === 'text').map(c => c.text).join('\n');
    const imgs = (Array.isArray(m.content) ? m.content : [])
      .filter(c => c.type === 'image_url').map(c => c.image_url.url);
    const div = document.createElement('div');
    div.className = `ykt-chat-msg ${m.role === 'user' ? 'user' : 'ai'}`;
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

/** 中止正在进行的流式请求（清空会话 / 关闭面板 / 发送新消息时调用） */
function abortStreaming(reason = '已取消') {
  if (abortCtrl) {
    try { abortCtrl.abort(reason); } catch { /* 旧浏览器不支持带参 abort */ }
  }
}

async function sendCurrent() {
  if (streaming) return;
  const $input = $sel('#ykt-chat-input');
  const text = $input.value.trim();
  if (!text) { ui.toast?.('先输入问题'); return; }
  const attach = $sel('#ykt-chat-attach')?.checked;

  streaming = true;
  $sel('#ykt-chat-send').disabled = true;
  try {
    const content = [{ type: 'text', text }];
    let attachFailed = '';
    if (attach) {
      const pending = addBubble('user', '⏳ 正在获取当前 PPT…');
      const { dataUrl, reason } = await resolveCurrentSlideImage();
      pending.remove();
      if (dataUrl) {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      } else {
        // 明确告知用户本条没有附图，而不是静默降级
        attachFailed = reason || '未取到当前 PPT 页';
      }
    }

    history.push({ role: 'user', content });
    trimOldImages(1);
    const userBubble = addBubble('user', escapeHtml(text));
    if (attachFailed) {
      const warn = document.createElement('div');
      warn.className = 'ykt-chat-warn';
      warn.textContent = `⚠️ ${attachFailed}——本条为纯文本提问`;
      userBubble.appendChild(warn);
    }
    $input.value = '';

    // AI 气泡（流式）
    const aiBubble = addBubble('ai', '<em>思考中…</em>');
    const acc = { content: '', reasoning: '' };
    let raf = 0;
    const paint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        aiBubble.innerHTML =
          (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body"></div></details>` : '')
          + (acc.content ? mdToHtml(acc.content) : '<em>…</em>');
        const rBody = aiBubble.querySelector('.reasoning-body');
        if (rBody) { rBody.textContent = acc.reasoning; rBody.scrollTop = rBody.scrollHeight; }
        const $log = $sel('#ykt-chat-log');
        $log.scrollTop = $log.scrollHeight;
      });
    };

    abortCtrl = new AbortController();
    const res = await agnesChat({
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      stream: true,
      thinking: true,
      signal: abortCtrl.signal,
      onDelta: (d) => { acc.content += d; paint(); },
      onReasoning: (d) => { acc.reasoning += d; paint(); },
    });

    acc.content = res.content || acc.content;
    acc.reasoning = res.reasoning || acc.reasoning;
    aiBubble.innerHTML =
      (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : '')
      + (acc.content ? mdToHtml(acc.content) : '<span class="err">（空回复）</span>');

    history.push({ role: 'assistant', content: acc.content || '（无内容）' });
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /abort|cancel/i.test(String(e?.message || ''));
    if (aborted) {
      addBubble('ai', '<span class="muted">（已取消）</span>');
    } else {
      addBubble('ai', `<span class="err">出错了：${escapeHtml(e?.message || String(e))}</span><br/><small>提示：到设置里检查 API 配置是否正确。</small>`);
    }
  } finally {
    streaming = false;
    abortCtrl = null;
    $sel('#ykt-chat-send').disabled = false;
    $sel('#ykt-chat-log').scrollTop = $sel('#ykt-chat-log').scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
