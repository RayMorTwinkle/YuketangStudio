// src/ui/panels/chat.js
// PPT 多轮对话面板：截取/读取当前 PPT 页 + 连续追问，思考链折叠显示，流式输出
import tpl from './chat.html';
import { log } from '../../core/log.js';
import { ui } from '../ui-api.js';
import { fetchAsDataURL } from '../../core/env.js';
import { agnesChat } from '../../ai/agnes.js';
import { repo } from '../../state/repo.js';
import { mdToHtml, renderRich } from './ai.js';
import { resolveCurrentSlideImage, slideImageUrl } from '../slide-image.js';
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

  // ── 加号菜单：选 PPT 页面 / 上传图片 ──
  const $plus = $sel('#ykt-chat-plus');
  const $menu = $sel('#ykt-chat-plus-menu');
  const $file = $sel('#ykt-chat-file');
  const hideMenu = () => { if ($menu) $menu.style.display = 'none'; };
  $plus?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!$menu) return;
    const on = $menu.style.display === 'flex';
    $menu.style.display = on ? 'none' : 'flex';
    if (!on) {
      const r = $plus.getBoundingClientRect();
      $menu.style.left = `${r.left}px`;
      $menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
      $menu.style.top = 'auto';
    }
  });
  document.addEventListener('click', (e) => {
    if ($menu && !$menu.contains(e.target) && e.target !== $plus) hideMenu();
  });
  $sel('#ykt-chat-plus-upload')?.addEventListener('click', () => { hideMenu(); $file?.click(); });
  $file?.addEventListener('change', (e) => {
    for (const f of e.target.files || []) {
      const reader = new FileReader();
      reader.onload = () => { addAttachment(reader.result); };
      reader.readAsDataURL(f);
    }
    $file.value = '';
  });
  $sel('#ykt-chat-plus-slides')?.addEventListener('click', () => { hideMenu(); openSlidePicker(); });

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

// ---------------- 附件（手动添加的 PPT 页 / 上传图片） ----------------

let attachments = [];   // dataURL 列表

function addAttachment(dataUrl) {
  if (!dataUrl) return;
  attachments.push(dataUrl);
  renderAttachments();
}

function removeAttachment(i) {
  attachments.splice(i, 1);
  renderAttachments();
}

function renderAttachments() {
  const box = $sel('#ykt-chat-atts');
  if (!box) return;
  box.innerHTML = '';
  box.style.display = attachments.length ? 'flex' : 'none';
  attachments.forEach((src, i) => {
    const d = document.createElement('div');
    d.className = 'att';
    const img = document.createElement('img');
    img.src = src;
    const rm = document.createElement('span');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = '移除';
    rm.addEventListener('click', () => removeAttachment(i));
    d.appendChild(img);
    d.appendChild(rm);
    box.appendChild(d);
  });
}

/** PPT 页面多选浮层：从所有已收集课件里挑页，确认后加入附件 */
function openSlidePicker() {
  const slides = [];
  for (const [, pres] of repo.presentations) {
    for (const s of pres?.slides || []) {
      const url = slideImageUrl(s);
      if (url) slides.push({ slide: s, url, presTitle: pres.title || '' });
    }
  }
  if (!slides.length) return ui.toast?.('暂无可选的 PPT 页面（先在课堂里翻页收集）', 2500);

  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:10px;max-width:640px;max-height:76vh;overflow:auto;padding:14px 16px;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.25);';
  box.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px">📑 选择 PPT 页面（点击多选）</div>`;
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;';
  const picked = new Set();
  for (const { slide, url } of slides) {
    const cell = document.createElement('div');
    cell.style.cssText = 'border:2px solid #e5e7eb;border-radius:6px;overflow:hidden;cursor:pointer;position:relative;';
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;height:80px;object-fit:cover;display:block;';
    const idx = document.createElement('span');
    idx.textContent = slide.index ?? '';
    idx.style.cssText = 'position:absolute;top:2px;left:2px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:1px 5px;border-radius:3px;';
    cell.appendChild(img);
    cell.appendChild(idx);
    cell.addEventListener('click', () => {
      if (picked.has(cell)) {
        picked.delete(cell);
        cell.style.borderColor = '#e5e7eb';
      } else {
        picked.add(cell);
        cell.style.borderColor = '#1d63df';
      }
      confirmBtn.textContent = picked.size ? `✓ 添加 ${picked.size} 张` : '✓ 添加';
    });
    grid.appendChild(cell);
    cell.__url = url;
  }
  box.appendChild(grid);
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '✓ 添加';
  confirmBtn.style.cssText = 'width:100%;margin-top:10px;padding:8px;border:none;border-radius:8px;background:#1d63df;color:#fff;font-weight:600;cursor:pointer;';
  confirmBtn.addEventListener('click', async () => {
    mask.remove();
    const cells = [...grid.children].filter(c => picked.has(c));
    ui.toast?.(`正在获取 ${cells.length} 张页面图片…`, 2000);
    for (const c of cells) {
      try {
        const dataUrl = await fetchAsDataURL(c.__url);
        if (dataUrl) addAttachment(dataUrl);
      } catch (e) {
        log.warn('[Chat] 附件图片获取失败:', e?.message);
      }
    }
    ui.toast?.('已加入附件，发送时一并传给 AI', 2000);
  });
  box.appendChild(confirmBtn);
  const cancel = document.createElement('div');
  cancel.textContent = '取消';
  cancel.style.cssText = 'text-align:center;color:#607190;cursor:pointer;padding:8px 0 2px;';
  cancel.addEventListener('click', () => mask.remove());
  box.appendChild(cancel);
  mask.appendChild(box);
  document.body.appendChild(mask);
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
    // 手动附件（加号添加的 PPT 页 / 上传图片）
    for (const att of attachments) {
      content.push({ type: 'image_url', image_url: { url: att } });
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
    attachments = [];          // 附件随消息发出，清空待下次添加
    renderAttachments();

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
