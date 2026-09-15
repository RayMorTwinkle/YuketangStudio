// src/ai/agnes.js
// Agnes（OpenAI 兼容）LLM 封装：对话 / 图片 / 思考 / 流式 / 工具调用
// 默认配置来自开发者模式解锁的内置配置（core/devmode.js），也可传参覆盖
import { gm } from '../core/env.js';
import { log } from '../core/log.js';
import { getDevConfig } from '../core/devmode.js';

/** 本模块日志前缀 */
const dlog = (...args) => log.dbg('[Agnes]', ...args);

/** 与 openai.js 的 makeChatUrl 相同的自适应拼接逻辑 */
export function makeChatUrl(baseUrl) {
  let base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) base = 'https://api.agnes-ai.cn/v1';
  if (base.includes('/chat/completions')) return base;
  if (base.includes('/v1')) return base + '/chat/completions';
  if (base.includes('/openai')) return base + '/v1/chat/completions';
  return base + '/v1/chat/completions';
}

/** 解析 SSE data 行的缓冲器 */
function sseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') { if (data === '[DONE]') onEvent(null); continue; }
      try { onEvent(JSON.parse(data)); } catch (e) { dlog('sse parse fail', e); }
    }
  };
}

/**
 * 调用 Agnes chat completions
 * @param {Object} opts
 * @param {Array}  opts.messages        OpenAI 格式消息（content 可含 image_url）
 * @param {boolean} [opts.stream]       流式（默认 false）
 * @param {(delta:string)=>void} [opts.onDelta]        流式正文增量
 * @param {(delta:string)=>void} [opts.onReasoning]    流式思考增量
 * @param {boolean} [opts.thinking]     是否开启思考（默认 true，reasoning_effort 取配置）
 * @param {Array}  [opts.tools]         工具定义
 * @param {Object} [opts.override]      { baseUrl, apiKey, model, reasoningEffort } 覆盖内置配置
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{content:string, reasoning:string, toolCalls?:Array, usage?:Object}>}
 */
export async function agnesChat(opts) {
  const dev = getDevConfig() || {};
  const ov = opts.override || {};
  const baseUrl = ov.baseUrl || dev.baseUrl;
  const apiKey = ov.apiKey || dev.apiKey;
  const model = ov.model || dev.model;
  if (!baseUrl || !apiKey) throw new Error('开发者模式未解锁：请到设置中解锁内置配置');

  const thinking = opts.thinking !== false;
  const effort = ov.reasoningEffort || dev.reasoningEffort || 'medium';

  const body = { model, messages: opts.messages };
  if (thinking && effort && effort !== 'off') body.reasoning_effort = effort;
  if (opts.tools && opts.tools.length) { body.tools = opts.tools; body.tool_choice = 'auto'; }
  const stream = !!opts.stream;
  if (stream) body.stream = true;

  const url = makeChatUrl(baseUrl);
  const timeoutMs = opts.timeoutMs || 120000;
  dlog('request', { url, model, stream, thinking });

  if (stream) {
    // 先试 fetch 真流式；CORS 失败自动降级 GM_xmlhttpRequest 伪流式
    try {
      return await fetchStream(url, apiKey, body, opts, timeoutMs);
    } catch (e) {
      dlog('fetch stream failed, fallback to GM_xhr:', e?.message || e);
      if (e?.name === 'AbortError') throw e;
      return await gmXhrStream(url, apiKey, body, opts, timeoutMs);
    }
  }
  // 非流式同样 fetch 优先，GM_xhr 兜底
  try {
    return await fetchStream(url, apiKey, body, opts, timeoutMs);
  } catch (e) {
    dlog('fetch failed, fallback to GM_xhr:', e?.message || e);
    return gmXhrOnce(url, apiKey, body, timeoutMs);
  }
}

function pickDelta(obj, opts, acc) {
  const d = obj?.choices?.[0]?.delta || {};
  if (d.reasoning_content) { acc.reasoning += d.reasoning_content; opts.onReasoning?.(d.reasoning_content); }
  if (d.content) { acc.content += d.content; opts.onDelta?.(d.content); }
  const tc = d.tool_calls;
  if (tc) {
    for (const t of tc) {
      const i = t.index ?? 0;
      acc.toolCalls[i] = acc.toolCalls[i] || { id: t.id || '', type: 'function', function: { name: '', arguments: '' } };
      if (t.id) acc.toolCalls[i].id = t.id;
      if (t.function?.name) acc.toolCalls[i].function.name += t.function.name;
      if (t.function?.arguments) acc.toolCalls[i].function.arguments += t.function.arguments;
    }
  }
}

async function fetchStream(url, apiKey, body, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('aborted'));
  if (opts.signal) {
    if (opts.signal.aborted) { clearTimeout(timer); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!body.stream) {
      const data = await res.json();
      const m = data?.choices?.[0]?.message || {};
      return { content: m.content || '', reasoning: m.reasoning_content || '', toolCalls: m.tool_calls, usage: data.usage };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const acc = { content: '', reasoning: '', toolCalls: [] };
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') break;
        try { pickDelta(JSON.parse(data), opts, acc); } catch (e) { dlog('parse', e); }
      }
    }
    return acc;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function gmXhrStream(url, apiKey, body, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const acc = { content: '', reasoning: '', toolCalls: [] };
    let seen = 0;
    gm.xhr({
      method: 'POST',
      url,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      data: JSON.stringify(body),
      onprogress: (res) => {
        const text = res.responseText || '';
        const chunk = text.slice(seen);
        seen = text.length;
        const feed = sseParser((obj) => { if (obj) pickDelta(obj, opts, acc); });
        feed(chunk);
      },
      onload: (res) => {
        if (res.status !== 200) return reject(new Error(`HTTP ${res.status}: ${(res.responseText || '').slice(0, 200)}`));
        // 兜底：progress 可能漏最后一段
        const text = res.responseText || '';
        sseParser((obj) => { if (obj) pickDelta(obj, opts, acc); })(text.slice(seen) + '\n');
        resolve(acc);
      },
      onerror: () => reject(new Error('网络错误（GM_xhr）')),
      ontimeout: () => reject(new Error('请求超时（GM_xhr）')),
    });
  });
}

function gmXhrOnce(url, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    gm.xhr({
      method: 'POST',
      url,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      data: JSON.stringify(body),
      onload: (res) => {
        if (res.status !== 200) return reject(new Error(`HTTP ${res.status}: ${(res.responseText || '').slice(0, 200)}`));
        try {
          const data = JSON.parse(res.responseText);
          const m = data?.choices?.[0]?.message || {};
          resolve({ content: m.content || '', reasoning: m.reasoning_content || '', toolCalls: m.tool_calls, usage: data.usage });
        } catch (e) { reject(new Error('响应解析失败: ' + e.message)); }
      },
      onerror: () => reject(new Error('网络错误')),
      ontimeout: () => reject(new Error('请求超时')),
    });
  });
}

/** 便捷方法：单轮提问（可选图片 dataURL 数组），返回 {content, reasoning} */
export async function agnesAsk(prompt, { images = [], thinking = true, override, onDelta, onReasoning } = {}) {
  const content = [{ type: 'text', text: prompt }];
  for (const dataUrl of images) content.push({ type: 'image_url', image_url: { url: dataUrl } });
  return agnesChat({
    messages: [{ role: 'user', content }],
    thinking,
    override,
    onDelta,
    onReasoning,
  });
}
