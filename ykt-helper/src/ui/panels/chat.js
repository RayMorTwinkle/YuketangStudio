// src/ui/panels/chat.js
// PPT 多轮对话面板：截取/读取当前 PPT 页 + 连续追问，思考链折叠显示，流式输出
import tpl from './chat.html';
import { ui } from '../ui-api.js';
import { agnesChat } from '../../ai/agnes.js';
import { mdToHtml, renderRich } from './ai.js';
import { resolveCurrentSlideImage } from '../slide-image.js';
import { DEFAULT_SYSTEM_PROMPT_CHAT } from '../../core/types.js';

let mounted = false;
let root;

let history = [];           // OpenAI 格式消息
let streaming = false;      // 防并发发送
let abortCtrl = null;

const systemPrompt = () => String(ui?.config?.systemPromptChat || '').trim() || DEFAULT_SYSTEM_PROMPT_CHAT;

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

// ---------------- 当前 PPT 页获取（共享模块 slide-image.js） ----------------

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
    // 把附带的 PPT 截图也画进气泡（AI 实际收到了，之前只显示文本）
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
      warn.textContent = `⚠️ ${attachFailed}——本条为纯文本提问`;
      userBubble.appendChild(warn);
    }
    $input.value = '';

    // AI 气泡（流式）
    const aiBubble = addBubble('ai', '<em>思考中…</em>');
    const acc = { content: '', reasoning: '' };
    let raf = 0;
    let phase = 'waiting';          // waiting → thinking → answering
    const paint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // 阶段推进：thinking = 有思考无正文；answering = 正文开始
        if (phase !== 'answering' && acc.content) phase = 'answering';
        else if (phase === 'waiting' && acc.reasoning) phase = 'thinking';
        const thinking = phase === 'thinking';
        // 思考阶段自动展开流式滚动；正文开始自动折叠展示正文
        aiBubble.innerHTML =
          (acc.reasoning
            ? `<details ${thinking ? 'open' : ''}><summary>💭 思考过程${thinking ? '（进行中…）' : '（点击展开）'}</summary><div class="reasoning-body"></div></details>`
            : '')
          + (acc.content ? mdToHtml(acc.content) : (thinking ? '' : '<em>…</em>'));
        const rBody = aiBubble.querySelector('.reasoning-body');
        if (rBody) { rBody.textContent = acc.reasoning; rBody.scrollTop = rBody.scrollHeight; }
        const $log = $sel('#ykt-chat-log');
        $log.scrollTop = $log.scrollHeight;
      });
    };

    abortCtrl = new AbortController();
    const res = await agnesChat({
      messages: [{ role: "system", content: systemPrompt() }, ...history],
      stream: true,
      thinking: true,
      signal: abortCtrl.signal,
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
