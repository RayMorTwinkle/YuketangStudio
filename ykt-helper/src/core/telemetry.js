/* global GM_info */
// src/core/telemetry.js
// 匿名使用统计：installId（首启生成 UUID）+ 平台 + 版本 + 是否用码 +
// 当日调用次数 + 首字时间/总时长聚合 → POST /yuketangstudio/telemetry
// 开关存 storage['telemetry.enabled']（0.6.2 起默认开，可在设置里关闭）；启动时上报一次
import { storage } from './storage.js';
import { gm } from './env.js';

const ENDPOINT = 'https://api.raymor.top/yuketangstudio/telemetry';
const K_ENABLED = 'telemetry.enabled';
const K_ID = 'telemetry.installId';
const K_DAY = 'telemetry.day';     // { date, calls, ttft:{sum,max,n}, dur:{sum,max,n}, pinged }
const K_ENHANCED = 'telemetry.enhanced';
const K_QUEUE = 'telemetry.traceQueue';

export function enabled() {
  // 0.6.2 起默认开启：只有用户明确关掉（存 false）才不上报
  return storage.get(K_ENABLED) !== false;
}

const K_MIGRATED = 'telemetry.defaultOnMigrated';

/**
 * 一次性迁移：旧版本开关默认关，很多用户从未动过 → 本版统一打开。
 * 只跑一次；用户之后仍可在设置里手动关闭（关掉后不会再被强制打开）。
 */
export function migrateDefaultOn() {
  if (storage.get(K_MIGRATED)) return false;
  storage.set(K_MIGRATED, true);
  storage.set(K_ENABLED, true);
  return true;
}

const K_LAST_PING = 'telemetry.lastPingAt';
const K_LAST_PING_DAY = 'telemetry.lastPingDay';
const STARTUP_PING_GAP = 60 * 1000;

/**
 * 启动上报：每次脚本启动（页面加载）都上报一次。
 * 同一页面内的多个 iframe / 60s 内连续刷新合并成一次，避免刷接口。
 */
export function pingOnStartup() {
  if (!enabled()) return;
  const now = Date.now();
  const last = Number(storage.get(K_LAST_PING)) || 0;
  const lastDay = storage.get(K_LAST_PING_DAY) || '';
  const d = today();
  // 跨天必定上报；同一天 60s 内合并
  if (lastDay === d && now - last < STARTUP_PING_GAP) return;
  storage.set(K_LAST_PING, now);
  storage.set(K_LAST_PING_DAY, d);
  ping().catch(() => {});
}
export function setEnabled(v) {
  storage.set(K_ENABLED, !!v);
  if (!v) storage.set(K_ENHANCED, false);   // 基础关了，强化也一起关
  if (v) ping(hasCloudUnlock()).catch(() => {});
}

/** 强化遥测：仅当基础遥测开启时才生效 */
export function enhancedEnabled() {
  return enabled() && storage.get(K_ENHANCED) === true;
}

/** 开关强化遥测；基础遥测关闭时拒绝开启 */
export function setEnhanced(v) {
  if (v && !enabled()) return false;
  storage.set(K_ENHANCED, !!v);
  if (v) scheduleTraceFlush(1000);
  return true;
}

function installId() {
  let id = storage.get(K_ID);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16))
      + '-' + Date.now().toString(36));
    storage.set(K_ID, id);
  }
  return id;
}

function platform() {
  if (typeof window !== 'undefined' && window.YktBridge) return 'android';
  return 'pc';
}
function version() {
  try {
    // 构建时 rollup replace 注入；Android WebView 没有 GM_info 也能拿到真实版本
    if (typeof __BUILD_VERSION__ !== 'undefined' && __BUILD_VERSION__) return String(__BUILD_VERSION__);
  } catch { /* ignore */ }
  try { const gi = typeof GM_info !== 'undefined' ? GM_info : null; return (gi && gi.script && gi.script.version) || 'dev'; }
  catch { return 'dev'; }
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function day() {
  const t = today();
  let d = storage.get(K_DAY);
  if (!d || d.date !== t) {
    d = { date: t, calls: 0, ttft: { sum: 0, max: 0, n: 0 }, dur: { sum: 0, max: 0, n: 0 }, pinged: false };
  }
  return d;
}
function saveDay(d) { storage.set(K_DAY, d); }

/** 记录一次服务端 LLM 调用。ttft/dur 毫秒（可选）。 */
export function recordCall({ ttft, dur } = {}) {
  if (!enabled()) return;
  const d = day();
  d.calls++;
  if (Number.isFinite(ttft) && ttft > 0) {
    d.ttft.n++; d.ttft.sum += ttft; if (ttft > d.ttft.max) d.ttft.max = ttft;
  }
  if (Number.isFinite(dur) && dur > 0) {
    d.dur.n++; d.dur.sum += dur; if (dur > d.dur.max) d.dur.max = dur;
  }
  saveDay(d);
  schedulePing();
}

let pingTimer = 0;
/** 防抖 ping：5s 内多次调用合并成一次上报（当天不限次数，服务端按 installId 覆盖） */
function schedulePing() {
  if (pingTimer) return;
  pingTimer = setTimeout(() => {
    pingTimer = 0;
    ping(true).catch(() => {});
  }, 5000);
}

/** 判断一个 profile 是否走云端（svc 代理） */
export function isCloudProfile(baseUrl) {
  return /api\.raymor\.top\/yuketangstudio/i.test(String(baseUrl || ''));
}

/** 是否已解锁过云端配置（读 devmode 的 storage key，不 import 避免循环依赖） */
function hasCloudUnlock() {
  const cfgs = storage.get('devmode.configs');
  return Array.isArray(cfgs) && cfgs.some(c => isCloudProfile(c?.baseUrl));
}

/** 上报当日聚合（enabled=false 时不发）。useCode 由调用方覆盖（云端调用后必为 true） */
export async function ping(useCode) {
  if (!enabled()) return;
  const d = day();
  const body = {
    installId: installId(),
    platform: platform(),
    version: version(),
    useCode: useCode ?? hasCloudUnlock(),
    calls: d.calls,
    ttft: d.ttft.n ? { avg: d.ttft.sum / d.ttft.n, max: d.ttft.max, n: d.ttft.n } : { avg: 0, max: 0, n: 0 },
    dur:  d.dur.n  ? { avg: d.dur.sum / d.dur.n,  max: d.dur.max,  n: d.dur.n  } : { avg: 0, max: 0, n: 0 },
    date: d.date,
  };
  await new Promise((resolve, reject) => {
    gm.xhr({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      timeout: 8000,
      onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error('HTTP ' + r.status))),
      onerror: reject,
      ontimeout: reject,
    });
  });
}

// ============================================================
// 强化遥测：上报 LLM 请求/响应/解析/提交结果（脱敏 + 截断 + 采样）
// 默认关；基础遥测关闭时强制不传。
// ============================================================
const TRACE_ENDPOINT = 'https://api.raymor.top/yuketangstudio/telemetry/trace';
const TRACE_MAX_EVENTS = 40;
const TRACE_MAX_BYTES = 96 * 1024;
const TRACE_STR_MAX = 8 * 1024;
const TRACE_TOTAL_MAX = 32 * 1024;

function trunc(s, n = TRACE_STR_MAX) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + `…[${str.length}]` : str;
}

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function redactUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.origin + x.pathname;
  } catch {
    return trunc(String(u || '').split('?')[0], 300);
  }
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = messages.slice(0, 20).map((m) => {
    const role = trunc(m?.role, 16);
    let content = m?.content;
    if (typeof content === 'string') content = trunc(content);
    else if (Array.isArray(content)) {
      content = content.slice(0, 8).map((part) => {
        if (part?.type === 'text') return { type: 'text', text: trunc(part.text) };
        if (part?.type === 'image_url') {
          const url = String(part?.image_url?.url || '');
          // 不上传图片原始 base64：只留长度 + 前 64KB 的指纹
          return { type: 'image', bytes: url.length, hash: hash32(url.slice(0, 65536)) };
        }
        return { type: trunc(part?.type, 20) };
      });
    } else content = trunc(String(content ?? ''));
    return { role, content };
  });
  let json = JSON.stringify(out);
  while (json.length > TRACE_TOTAL_MAX && out.length > 1) {
    out.shift();
    json = JSON.stringify(out);
  }
  return out;
}

function sanitizeDeep(v, depth = 0) {
  if (depth > 4) return '[depth]';
  if (v == null) return v;
  if (typeof v === 'string') return trunc(v, 4096);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitizeDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, 30)) {
      if (/authorization|apikey|api_key|token|password/i.test(k)) continue;
      out[trunc(k, 80)] = sanitizeDeep(val, depth + 1);
    }
    return out;
  }
  return trunc(String(v), 200);
}

export function sanitizeTraceEvent(ev) { return sanitizeTrace(ev); }

function sanitizeTrace(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const out = {
    id: ev.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    ts: Number(ev.ts) || Date.now(),
    event: trunc(ev.event, 40),
    kind: trunc(ev.kind, 20),
    mode: trunc(ev.mode, 20),
    ok: ev.ok !== false,
  };
  if (ev.attempt != null) out.attempt = Number(ev.attempt) || 0;
  if (ev.problemType != null) out.problemType = Number(ev.problemType) || 0;
  for (const k of ['taskId', 'runId', 'requestId', 'source', 'type', 'transport', 'target', 'stage', 'route', 'userTextLen', 'historyLen', 'durationMs', 'attempts', 'from', 'to', 'reason', 'autoSubmit', 'mocked']) {
    if (ev[k] != null) out[k] = typeof ev[k] === 'number' || typeof ev[k] === 'boolean' ? ev[k] : trunc(ev[k], 2048);
  }
  if (ev.payload != null) out.payload = sanitizeDeep(ev.payload);
  if (ev.targetInfo) out.targetInfo = sanitizeDeep(ev.targetInfo);
  if (ev.question) {
    const q = ev.question;
    out.question = {
      type: trunc(q.type, 20),
      typeLabel: trunc(q.typeLabel, 20),
      body: trunc(q.body, 4096),
      bodyLen: Number(q.bodyLen) || 0,
      options: Array.isArray(q.options) ? q.options.slice(0, 12).map((o) => ({
        key: trunc(o?.key, 20),
        text: trunc(o?.text, 512),
      })) : undefined,
      optionLabels: Array.isArray(q.optionLabels) ? q.optionLabels.slice(0, 12).map((x) => trunc(x, 20)) : undefined,
      blanks: Number(q.blanks) || 0,
      hasImage: !!q.hasImage,
      imageBytes: Number(q.imageBytes) || 0,
      imageHash: trunc(q.imageHash, 40),
      rawType: trunc(q.rawType, 40),
    };
  }
  if (ev.answer) {
    const a = ev.answer;
    out.answer = {
      kind: trunc(a.kind, 20),
      values: Array.isArray(a.values) ? a.values.slice(0, 20).map((x) => trunc(x, 1000)) : undefined,
      text: trunc(a.text, 4096),
      textLen: Number(a.textLen) || 0,
      display: trunc(a.display, 2048),
      source: trunc(a.source, 20),
    };
  }
  if (ev.tool) {
    out.tool = {
      name: trunc(ev.tool.name, 60),
      arguments: trunc(ev.tool.arguments, 4096),
      reason: trunc(ev.tool.reason, 1024),
    };
  }
  if (ev.submit) {
    out.submit = {
      kind: trunc(ev.submit.kind, 20),
      route: trunc(ev.submit.route, 20),
      ok: ev.submit.ok !== false,
      payload: sanitizeDeep(ev.submit.payload),
      error: ev.submit.error ? { code: trunc(ev.submit.error.code, 40), message: trunc(ev.submit.error.message, 2048) } : undefined,
    };
  }
  if (ev.retry) out.retry = sanitizeDeep(ev.retry);
  if (ev.nudge) out.nudge = trunc(ev.nudge, 2048);
  if (ev.provider) {
    out.provider = {
      url: redactUrl(ev.provider.url),
      model: trunc(ev.provider.model, 120),
      cloud: !!ev.provider.cloud,
      stream: !!ev.provider.stream,
      thinking: !!ev.provider.thinking,
    };
  }
  if (ev.request) {
    out.request = {
      bodyBytes: Number(ev.request.bodyBytes) || 0,
      tools: Number(ev.request.tools) || 0,
      messages: sanitizeMessages(ev.request.messages),
    };
  }
  if (ev.response) {
    out.response = {
      content: trunc(ev.response.content),
      reasoning: trunc(ev.response.reasoning),
      toolCalls: Array.isArray(ev.response.toolCalls)
        ? ev.response.toolCalls.slice(0, 3).map((t) => ({
          name: trunc(t?.function?.name, 60),
          arguments: trunc(t?.function?.arguments),
        }))
        : undefined,
      truncated: !!ev.response.truncated,
    };
  }
  if (ev.parse) {
    out.parse = {
      ok: !!ev.parse.ok,
      path: trunc(ev.parse.path, 20),
      code: trunc(ev.parse.code, 40),
      error: trunc(ev.parse.error, 2048),
      raw: trunc(ev.parse.raw, 4096),
      toolCall: ev.parse.toolCall ? sanitizeDeep(ev.parse.toolCall) : undefined,
    };
  }
  if (ev.problem) {
    out.problem = {
      type: Number(ev.problem.type) || 0,
      options: Number(ev.problem.options) || 0,
      bodyLen: Number(ev.problem.bodyLen) || 0,
    };
  }
  if (ev.image) {
    out.image = {
      count: Number(ev.image.count) || 0,
      bytes: Number(ev.image.bytes) || 0,
      hash: trunc(ev.image.hash, 40),
    };
  }
  if (ev.error) {
    out.error = {
      name: trunc(ev.error.name, 60),
      code: trunc(ev.error.code, 40),
      message: trunc(ev.error.message, 2048),
      status: Number(ev.error.status) || 0,
      detail: sanitizeDeep(ev.error.detail),
    };
  }
  if (ev.route != null) out.route = trunc(ev.route, 20);
  if (ev.regexParsed != null) out.regexParsed = !!ev.regexParsed;
  if (ev.toolCall != null) out.toolCall = !!ev.toolCall;
  if (ev.contentLen != null) out.contentLen = Number(ev.contentLen) || 0;
  if (JSON.stringify(out).length > TRACE_MAX_BYTES) return null;
  return out;
}

/** 记录一条强化遥测；失败全量、成功 10% 采样；入队后批量发送 */
export function trace(event) {
  if (!enhancedEnabled()) return;
  try {
    const ev = sanitizeTrace(event);
    if (!ev) return;
    const name = String(ev.event || '');
    const isAnswer = name.startsWith('answer_');
    const isToolLlm = name === 'llm_call'
      && (Number(ev.request?.tools) > 0 || (ev.response?.toolCalls || []).length > 0);
    // 答题链路事件全量；带 tools/工具调用的 LLM 调用全量；其余成功事件 10% 采样
    if (ev.ok !== false && !isAnswer && !isToolLlm && Math.random() > 0.1) return;
    const q = storage.get(K_QUEUE);
    const queue = Array.isArray(q) ? q : [];
    queue.push(ev);
    while (queue.length > TRACE_MAX_EVENTS) queue.shift();
    let json = JSON.stringify(queue);
    while (json.length > TRACE_MAX_BYTES && queue.length > 1) {
      queue.shift();
      json = JSON.stringify(queue);
    }
    storage.set(K_QUEUE, queue);
    // 错误/答题关键事件尽快发；普通事件批量发
    scheduleTraceFlush(ev.ok === false ? 300 : (isAnswer || isToolLlm ? 1200 : 5000));
  } catch {}
}

let traceTimer = 0;
function scheduleTraceFlush(delay = 5000) {
  if (traceTimer) return;
  traceTimer = setTimeout(() => {
    traceTimer = 0;
    flushTraces().catch(() => {});
  }, delay);
}

/** 发送队列；成功移除已发送项，失败保留并 30s 后重试 */
export async function flushTraces() {
  if (!enhancedEnabled()) return;
  const q = storage.get(K_QUEUE);
  const queue = Array.isArray(q) ? q : [];
  if (!queue.length) return;
  const events = queue.slice(0, TRACE_MAX_EVENTS);
  const body = { installId: installId(), platform: platform(), version: version(), events };
  try {
    await new Promise((resolve, reject) => {
      gm.xhr({
        method: 'POST',
        url: TRACE_ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        timeout: 10000,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error('HTTP ' + r.status))),
        onerror: reject,
        ontimeout: reject,
      });
    });
    const cur = storage.get(K_QUEUE);
    if (Array.isArray(cur)) {
      const sent = new Set(events.map((e) => e.id));
      const rest = cur.filter((e) => !sent.has(e.id));
      storage.set(K_QUEUE, rest);
      if (rest.length) scheduleTraceFlush(2000);
    }
  } catch {
    scheduleTraceFlush(30000);
  }
}

// 页面隐藏/关闭前尽量把队列发出去：错误事件可能正好在用户离开时发生
if (typeof window !== 'undefined') {
  const flushSoon = () => {
    if (!enhancedEnabled()) return;
    try { flushTraces().catch(() => {}); } catch {}
  };
  window.addEventListener('pagehide', flushSoon);
  window.addEventListener('beforeunload', flushSoon);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSoon();
    });
  }
}
