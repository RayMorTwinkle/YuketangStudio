// src/ai/agnes.js
// Agnes（OpenAI 兼容）LLM 封装：对话 / 图片 / 思考 / 流式 / 工具调用
// 默认配置来自开发者模式解锁的内置配置（core/devmode.js），也可传参覆盖
import { gm } from '../core/env.js';
import { log } from '../core/log.js';
import { getDevConfig } from '../core/devmode.js';
import * as telemetry from '../core/telemetry.js';

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
// ============================================================
// 流式平滑：上游 chunk 常是「攒一大坨→停→再一坨」，直接渲染会一卡一卡。
// 把 delta 先进队列，24ms 心跳按比例吐出；backlog 大时自动加速追平。
// 只在 stream 调用生效；reasoning/content 各一条队列互不影响。
// ============================================================
function makeSmoother(opts) {
  const queue = { reasoning: '', content: '' };
  const tick = () => {
    for (const k of ['reasoning', 'content']) {
      const q = queue[k];
      if (!q) continue;
      const n = Math.max(4, Math.ceil(q.length / 8));
      const part = q.slice(0, n);
      queue[k] = q.slice(n);
      if (k === 'reasoning') opts.onReasoning?.(part); else opts.onDelta?.(part);
    }
  };
  const timer = setInterval(tick, 24);
  return {
    feed(kind, s) { queue[kind] += s; },
    /** 流结束：把残余队列一次性吐完（调用方在 resolve 前调） */
    end() {
      clearInterval(timer);
      if (queue.reasoning) { opts.onReasoning?.(queue.reasoning); queue.reasoning = ''; }
      if (queue.content) { opts.onDelta?.(queue.content); queue.content = ''; }
    },
    abort() { clearInterval(timer); queue.reasoning = queue.content = ''; },
  };
}

export async function agnesChat(opts) {
  const dev = getDevConfig() || {};
  const ov = opts.override || {};
  const baseUrl = ov.baseUrl || dev.baseUrl;
  const apiKey = ov.apiKey || dev.apiKey;
  const model = ov.model || dev.model;
  if (!baseUrl || !apiKey) throw new Error('开发者模式未解锁：请到设置中解锁内置配置');

  const isCloud = telemetry.isCloudProfile(baseUrl);
  // 「开遥测才能用解锁码」的第二层：解锁后关掉遥测 → 云端调用直接拦
  if (isCloud && !telemetry.enabled()) {
    throw new Error('请先在设置底部开启「匿名统计使用情况」');
  }

  const thinking = opts.thinking !== false;
  // 思考开启时默认 effort=medium（设置里可调 低/中/高/超高max）；
  // 显式配置的 reasoningEffort 优先，'off' 表示关闭。关闭时不发该字段——
  // 硬编码 effort 会让不支持该参数的端点报 400
  const effort = thinking ? (ov.reasoningEffort || dev.reasoningEffort || 'medium') : null;

  const body = { model, messages: opts.messages };
  if (thinking && effort && effort !== 'off') body.reasoning_effort = effort;
  if (opts.tools && opts.tools.length) { body.tools = opts.tools; body.tool_choice = 'auto'; }
  const stream = !!opts.stream;
  if (stream) body.stream = true;

  const url = makeChatUrl(baseUrl);
  // 流式默认 300s 总预算；非流式 120s。流式真正的「掐」在 fetchStream 的
  // 空闲超时（读 chunk 会重置），长思考流不会再被总超时误杀
  const timeoutMs = opts.timeoutMs || (stream ? 300000 : 120000);
  dlog('request', { url, model, stream, thinking });

  // 遥测计时：t0 请求发出，tFirst 首字节（reasoning 或 content），tEnd 流结束
  const t0 = Date.now();
  let tFirst = 0;
  const smooth = stream ? makeSmoother(opts) : null;
  // 包一层 opts：delta 先进平滑队列；首个 delta 记 TTFB
  const o2 = Object.assign({}, opts, {
    onDelta: (s) => { if (!tFirst) tFirst = Date.now(); smooth ? smooth.feed('content', s) : opts.onDelta?.(s); },
    onReasoning: (s) => { if (!tFirst) tFirst = Date.now(); smooth ? smooth.feed('reasoning', s) : opts.onReasoning?.(s); },
  });
  const recordTele = () => {
    if (isCloud) telemetry.recordCall({
      ttft: tFirst ? tFirst - t0 : 0,
      dur: Date.now() - t0,
    });
  };

  // 只有「网络层失败」（CORS/连接错误）才值得降级 GM_xhr；
  // 中止与明确的 HTTP 错误都意味着请求已到达服务端——重发会造成重复计费/双份回答
  const shouldFallback = (e) =>
    e?.name !== 'AbortError'
    && !opts.signal?.aborted
    && !/^HTTP \d/.test(String(e?.message || ''));

  if (stream) {
    // 先试 fetch 真流式；CORS 失败自动降级 GM_xmlhttpRequest 伪流式
    try {
      const r = await fetchStream(url, apiKey, body, o2, timeoutMs);
      smooth.end(); recordTele();
      return r;
    } catch (e) {
      if (!shouldFallback(e)) { smooth.abort(); throw e; }
      dlog('fetch stream failed, fallback to GM_xhr:', e?.message || e);
      try {
        const r = await gmXhrStream(url, apiKey, body, o2, timeoutMs);
        smooth.end(); recordTele();
        return r;
      } catch (e2) { smooth.abort(); throw e2; }
    }
  }
  // 非流式同样 fetch 优先，GM_xhr 兜底
  try {
    const r = await fetchStream(url, apiKey, body, o2, timeoutMs);
    recordTele();
    return r;
  } catch (e) {
    if (!shouldFallback(e)) throw e;
    dlog('fetch failed, fallback to GM_xhr:', e?.message || e);
    const r = await gmXhrOnce(url, apiKey, body, timeoutMs);
    recordTele();
    return r;
  }
}

function pickDelta(obj, opts, acc) {
  const d = obj?.choices?.[0]?.delta || {};
  // 兼容：OpenAI 标准 reasoning_content / AMD radeon 端点 reasoning
  const rd = d.reasoning_content || d.reasoning;
  if (rd) { acc.reasoning += rd; opts.onReasoning?.(rd); }
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
  // abort 的 reason 必须带 AbortError 名——否则外层 catch 识别不出中止，
  // 会掉进 GM_xhr 兜底再发一次请求
  const mkAbort = (msg) => Object.assign(new Error(msg), { name: 'AbortError' });
  // 流式用「空闲超时」：每读到一个 chunk 重置计时——思考型模型跑几分钟也
  // 不会被总超时误杀（之前 120s 总超时是「请求超时」报错的主因）。
  // 非流式仍走总超时。
  const IDLE_MS = 60000;
  let timer;
  if (body.stream) {
    timer = setTimeout(() => ctrl.abort(mkAbort('响应中断（60s 无数据）')), IDLE_MS);
    var resetIdle = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(mkAbort('响应中断（60s 无数据）')), IDLE_MS); };
  } else {
    timer = setTimeout(() => ctrl.abort(mkAbort('请求超时')), timeoutMs);
  }
  const onAbort = () => ctrl.abort(mkAbort('aborted'));
  if (opts.signal) {
    if (opts.signal.aborted) { clearTimeout(timer); throw mkAbort('aborted'); }
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
      return { content: m.content || '', reasoning: m.reasoning_content || m.reasoning || '', toolCalls: m.tool_calls, usage: data.usage };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const acc = { content: '', reasoning: '', toolCalls: [] };
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle?.();
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
    // sseParser 必须跨 onprogress 复用——每次新建会丢掉跨 chunk 拆开的 data: 行
    const feed = sseParser((obj) => { if (obj) pickDelta(obj, opts, acc); });
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
        feed(chunk);
      },
      onload: (res) => {
        if (res.status !== 200) return reject(new Error(`HTTP ${res.status}: ${(res.responseText || '').slice(0, 200)}`));
        // 兜底：progress 可能漏最后一段（补个 \n 把半行 data: 喂完）
        const text = res.responseText || '';
        feed(text.slice(seen) + '\n');
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
          resolve({ content: m.content || '', reasoning: m.reasoning_content || m.reasoning || '', toolCalls: m.tool_calls, usage: data.usage });
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
