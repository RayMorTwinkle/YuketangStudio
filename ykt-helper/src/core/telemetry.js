// src/core/telemetry.js
// 匿名使用统计：installId（首启生成 UUID）+ 平台 + 版本 + 是否用码 +
// 当日调用次数 + 首字时间/总时长聚合 → POST /yuketangstudio/telemetry
// 开关存 storage['telemetry.enabled']（默认关）；「开」时立即 ping 一次
import { storage } from './storage.js';
import { gm } from './env.js';

const ENDPOINT = 'https://api.raymor.top/yuketangstudio/telemetry';
const K_ENABLED = 'telemetry.enabled';
const K_ID = 'telemetry.installId';
const K_DAY = 'telemetry.day';     // { date, calls, ttft:{sum,max,n}, dur:{sum,max,n}, pinged }

export function enabled() {
  return storage.get(K_ENABLED) === true;
}
export function setEnabled(v) {
  storage.set(K_ENABLED, !!v);
  if (v) ping(hasCloudUnlock()).catch(() => {});
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
  try { return (typeof GM_info !== 'undefined' && GM_info.script.version) || 'dev'; }
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
