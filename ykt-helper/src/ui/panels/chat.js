// src/ui/panels/chat.js
// PPT 多轮对话面板：截取/读取当前 PPT 页 + 连续追问，思考链折叠显示，流式输出
import tpl from './chat.html';
import { ui } from '../ui-api.js';
import { repo } from '../../state/repo.js';
import { gm, ensureHtml2Canvas, fetchAsDataURL } from '../../core/env.js';
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
  } catch (e) { console.warn('[Chat] findCurrentSlide', e); }
  return null;
}

function slideImageUrl(slide) {
  return slide?.coverAlt || slide?.cover || slide?.image || slide?.thumbnail || '';
}

/** html2canvas 兜底截图 */
async function captureFallback() {
  const html2canvas = await ensureHtml2Canvas();
  const el = document.querySelector('.ppt-inner')
    || document.querySelector('.ppt-courseware-inner')
    || document.querySelector('.problem-body')
    || document.body;
  const canvas = await html2canvas(el, { scale: 1.5, useCORS: true, logging: false });
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** 获取当前 PPT 页 dataURL；失败返回 null 并 toast */
async function getCurrentSlideDataURL() {
  const slide = findCurrentSlide();
  const url = slideImageUrl(slide);
  if (url) {
    try { return await fetchAsDataURL(url); }
    catch (e) { console.warn('[Chat] slide 图下载失败，降级截图:', e?.message); }
  }
  try { return await captureFallback(); }
  catch (e) { console.warn('[Chat] 截图也失败:', e?.message); return null; }
}

async function refreshCtxThumb() {
  const span = $sel('#ykt-chat-ctx-thumb');
  span.textContent = '⏳';
  const dataUrl = await getCurrentSlideDataURL();
  if (dataUrl) {
    span.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl; img.title = '当前 PPT 页';
    span.appendChild(img);
  } else {
    span.textContent = '（未获取到 PPT，将仅用文字回答）';
  }
}

// ---------------- 渲染 ----------------

function addBubble(kind, htmlOrNode) {
  const log = $sel('#ykt-chat-log');
  const div = document.createElement('div');
  div.className = `ykt-chat-msg ${kind}`;
  if (typeof htmlOrNode === 'string') div.innerHTML = htmlOrNode;
  else div.appendChild(htmlOrNode);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function renderHistory() {
  const log = $sel('#ykt-chat-log');
  log.innerHTML = '';
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
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
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
    if (attach) {
      addBubble('user', '⏳ 正在获取当前 PPT…');
      const log = $sel('#ykt-chat-log');
      const dataUrl = await getCurrentSlideDataURL();
      log.lastChild?.remove();
      if (dataUrl) content.push({ type: 'image_url', image_url: { url: dataUrl } });
    }

    history.push({ role: 'user', content });
    trimOldImages(1);
    addBubble('user', text);
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
        const log = $sel('#ykt-chat-log');
        log.scrollTop = log.scrollHeight;
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
    addBubble('ai', `<span class="err">出错了：${escapeHtml(e?.message || String(e))}</span><br/><small>提示：到设置里检查开发者模式是否已解锁。</small>`);
  } finally {
    streaming = false;
    abortCtrl = null;
    $sel('#ykt-chat-send').disabled = false;
    $sel('#ykt-chat-log').scrollTop = $sel('#ykt-chat-log').scrollHeight;
  }
}

function getDevCfg() {
  // 优先开发者配置；留 override 接口给未来 UI 选择其他 profile
  try { return null; } catch { return null; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
