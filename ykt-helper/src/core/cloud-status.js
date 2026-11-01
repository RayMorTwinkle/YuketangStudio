// src/core/cloud-status.js
// 云端模型上游状态：只查 svc 的 /status，不下发/记录解锁码。
import { gm } from './env.js';
import { isCloudProfile } from './telemetry.js';

const STATUS_URL = 'https://api.raymor.top/yuketangstudio/status';
const CACHE_MS = 15_000;
const cache = new Map();

/** 从当前 AI 配置里取云端 profile；不是云端模型时返回 null。 */
export function getCloudProfile(config) {
  const ai = config?.ai;
  const profiles = Array.isArray(ai?.profiles) ? ai.profiles : [];
  const p = profiles.find((x) => x.id === ai?.activeProfileId) || profiles[0];
  if (!p || !p.apiKey || !isCloudProfile(p.baseUrl)) return null;
  return { id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model || '' };
}

function requestStatus(code, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const url = `${STATUS_URL}?code=${encodeURIComponent(code)}`;
    const onload = (status, text) => {
      let data = null;
      try { data = JSON.parse(text || '{}'); } catch { /* ignore */ }
      if (status >= 200 && status < 300 && data) resolve(data);
      else reject(new Error(data?.error || `HTTP ${status}`));
    };
    try {
      gm.xhr({
        method: 'GET',
        url,
        timeout,
        onload: (r) => onload(r.status, r.responseText),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('状态查询超时')),
      });
    } catch {
      fetch(url, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout?.(timeout) })
        .then(async (r) => onload(r.status, await r.text()))
        .catch(reject);
    }
  });
}

/** 查询指定解锁码的云端上游状态；15 秒内缓存，force=true 强制刷新。 */
export async function fetchCloudStatus(code, { force = false, timeout = 6000 } = {}) {
  const key = String(code || '');
  if (!key) return { ok: false, error: '没有云端解锁码' };
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const data = await requestStatus(key, timeout);
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    const data = { ok: false, error: String(e?.message || e || '状态查询失败') };
    cache.set(key, { at: Date.now(), data });
    return data;
  }
}

/** 给 UI 用的简短结论。 */
export function cloudStatusSummary(status, { needVision = false, includeDegraded = false } = {}) {
  if (!status) return { kind: 'unknown', title: '状态未知', detail: '尚未查询云端状态' };
  if (status.ok === false) return { kind: 'error', title: '状态查询失败', detail: status.error || '未知错误' };
  const textOk = !!status.textOk;
  const visionOk = !!status.visionOk;
  if (status.status === 'down') {
    return { kind: 'error', title: '异常', detail: '云端上游当前不可用' };
  }
  if (status.status === 'degraded' && includeDegraded) {
    return { kind: 'warn', title: '部分可用', detail: textOk ? '文本可用，但图片能力异常' : '仅图片能力可用' };
  }
  if (textOk && (!needVision || visionOk)) {
    return { kind: 'ok', title: '正常', detail: needVision ? '文本与图片能力正常' : '文本能力正常' };
  }
  if (textOk && needVision && !visionOk) {
    return { kind: 'warn', title: '图片能力异常', detail: '文本可用，但云端视觉模型暂时不可用' };
  }
  if (!textOk && visionOk) {
    return { kind: 'warn', title: '文本能力异常', detail: '仅图片能力可用' };
  }
  return { kind: 'error', title: '异常', detail: '云端上游当前不可用' };
}
