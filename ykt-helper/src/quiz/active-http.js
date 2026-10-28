// src/quiz/active-http.js
// 新版作业/考试 HTTP 层。
// EP1-EP5（pro 站点）：同源相对路径 fetch（credentials include，登录 Cookie 自动携带）；
// EP6-EP9（考试域 tsinghua-exam.yuketang.cn / examination.xuetangx.com）：跨源走
//   GM_xmlhttpRequest（userscript.meta 已 @connect *；Android 壳内 gm-shim 的 fetch
//   遇跨域 CORS 预检失败会自动回退原生 fetchRequest，无需平台分支）。
// 跨源请求绝不携带 pro 平台凭据：GM 按目标域独立 Cookie jar，headers 只发 x-client/xtbz/referer。
import { gm } from '../core/env.js';
import { AuthError } from './active-core.js';

/** document.cookie 中的 csrftoken（非 HttpOnly；与 quiz-paper.js 暂存、官网前端一致）。 */
export function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 同源 GET（相对路径）。401/403 → AuthError；其余非 2xx → Error。 */
export async function proGet(path) {
  let r;
  try {
    r = await fetch(path, { credentials: 'include' });
  } catch {
    throw new Error(`网络请求失败：${path}`);
  }
  if (r.status === 401 || r.status === 403) throw new AuthError();
  if (!r.ok) throw new Error(`HTTP ${r.status}：${path}`);
  return r.json();
}

/** 同源 POST JSON（相对路径），自动携带 X-CSRFToken；extraHeaders 覆盖默认头。 */
export async function proPost(path, payload, extraHeaders = {}) {
  const token = csrfToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'X-CSRFToken': token } : {}),
    ...extraHeaders,
  };
  let r;
  try {
    r = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload ?? {}),
    });
  } catch {
    throw new Error(`网络请求失败：${path}`);
  }
  if (r.status === 401 || r.status === 403) throw new AuthError();
  if (!r.ok) throw new Error(`HTTP ${r.status}：${path}`);
  return r.json();
}

/**
 * 跨源 GET（GM_xmlhttpRequest）。返回 GM 响应对象（status/responseText/...）。
 * watchdog 兜底：部分 GM 实现 timeout 字段不生效，不能让 Promise 永远 pending。
 */
export function gmGet(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        fn(v);
      }
    };
    const watchdog = setTimeout(
      () => done(reject, new Error(`考试结果请求超时：${hostOf(url)}`)),
      timeoutMs + 5000,
    );
    try {
      gm.xhr({
        method: 'GET',
        url,
        headers,
        timeout: timeoutMs,
        onload: (res) => done(resolve, res),
        onerror: () => done(reject, new Error(`考试结果请求失败：${hostOf(url)}`)),
        ontimeout: () => done(reject, new Error(`考试结果请求超时：${hostOf(url)}`)),
        onabort: () => done(reject, new Error(`考试结果请求中止：${hostOf(url)}`)),
      });
    } catch (e) {
      done(reject, e);
    }
  });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url).slice(0, 60);
  }
}
