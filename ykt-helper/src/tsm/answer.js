import { ui } from '../ui/ui-api.js';
import { log } from '../core/log.js';
import { repo } from '../state/repo.js';

function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms|0))); }
function calcAutoWaitMs() {
  const base = Math.max(0, (ui?.config?.autoAnswerDelay ?? 0));
  const rand = Math.max(0, (ui?.config?.autoAnswerRandomDelay ?? 0));
  return base + (rand ? Math.floor(Math.random() * rand) : 0);
}
function shouldAutoAnswerForLesson_(lessonId) {
  if (ui?.config?.autoAnswer) return true;
  if (!lessonId) return false;
  if (repo?.autoJoinedLessons?.has(lessonId) && ui?.config?.autoAnswerOnAutoJoin) return true;
  if (repo?.forceAutoAnswerLessons?.has(lessonId)) return true;
  return false;
}


const DEFAULT_HEADERS = () => ({
  'Content-Type': 'application/json',
  'xtbz': 'ykt',
  'X-Client': 'h5',
  'Authorization': 'Bearer ' + (typeof localStorage !== 'undefined' ? localStorage.getItem('Authorization') : ''),
});

/**
 * Low-level POST helper using XMLHttpRequest to align with site requirements.
 * @param {string} url
 * @param {object} data
 * @param {Record<string,string>} headers
 * @returns {Promise<any>}
 */
function xhrPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
      // 必须给所有终止态一个 rejection——超时不设回调会让 Promise 永远挂起
      // （外层 answering 标志随之卡死，题目再也答不了）
      xhr.timeout = 20000;
      xhr.ontimeout = () => reject(new Error('提交超时（20s）'));
      xhr.onabort = () => reject(new Error('请求被中止'));
      xhr.onload = () => {
        try {
          const resp = JSON.parse(xhr.responseText);
          if (resp && typeof resp === 'object') {
            resolve(resp);
          } else {
            reject(new Error('解析响应失败'));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      };
      xhr.onerror = () => reject(new Error('网络请求失败'));
      xhr.send(JSON.stringify(data));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * POST /api/v3/lesson/problem/answer
 * Mirrors the 1.16.1 logic (no UI). Returns {code, data, msg, ...} on success code===0.
 * @param {{problemId:number, problemType:number}} problem
 * @param {any} result
 * @param {{headers?:Record<string,string>, dt?:number}} [options]
 */
export async function answerProblem(problem, result, options = {}) {
  const url = '/api/v3/lesson/problem/answer';
  const headers = { ...DEFAULT_HEADERS(), ...(options.headers || {}) };
  const payload = {
    problemId: problem.problemId,
    problemType: problem.problemType,
    dt: options.dt ?? Date.now(),
    result,
  };

  const resp = await xhrPost(url, payload, headers);
  if (resp.code === 0) return resp;
  throw new Error(`${resp?.msg || '服务器返回错误'} (${resp?.code})`);
}

/**
 * POST /api/v3/lesson/problem/retry
 * Expects server to echo success ids in data.success (as in v1.16.1).
 * @param {{problemId:number, problemType:number}} problem
 * @param {any} result
 * @param {number} dt - simulated answer time (epoch ms)
 * @param {{headers?:Record<string,string>}} [options]
 */
export async function retryAnswer(problem, result, dt, options = {}) {
  const url = '/api/v3/lesson/problem/retry';
  const headers = { ...DEFAULT_HEADERS(), ...(options.headers || {}) };
  const payload = {
    problems: [{
      problemId: problem.problemId,
      problemType: problem.problemType,
      dt,
      result,
    }],
  };

  const resp = await xhrPost(url, payload, headers);
  if (resp.code !== 0) {
    throw new Error(`${resp?.msg || '服务器返回错误'} (${resp?.code})`);
  }
  const okList = resp?.data?.success || [];
  // 服务端可能返回数字 id——统一字符串比较，避免类型不一致误判失败
  if (!Array.isArray(okList) || !okList.map(String).includes(String(problem.problemId))) {
    throw new Error('服务器未返回成功信息');
  }
  return resp;
}

/**
 * High-level orchestrator: answer first; if deadline has passed, optionally retry.
 * This is the module adaptation of the 1.16.1 userscript submit flow.
 *
 * @param {{problemId:number, problemType:number}} problem
 * @param {any} result
 * @param {Object} submitOptions
 * @param {number} [submitOptions.startTime] - unlock time (epoch ms). Required for retry path.
 * @param {number} [submitOptions.endTime]   - deadline (epoch ms). If now >= endTime -> retry path.
 * @param {boolean} [submitOptions.forceRetry=false] - when past deadline, directly use retry without prompting.
 * @param {number} [submitOptions.retryDtOffsetMs=2000] - dt = startTime + offset when retrying.
 * @param {Record<string,string>} [submitOptions.headers] - extra/override headers.
 * @returns {Promise<{'route':'answer'|'retry', resp:any}>}
 * @param {number|string} [submitOptions.lessonId] - 所属课堂；缺省时将使用 repo.currentLessonId
 * @param {boolean} [submitOptions.autoGate=true]  - 是否启用“自动进入课堂/默认自动答题”的判定（向后兼容，默认开启）
 * @param {number} [submitOptions.waitMs]          - 覆盖自动等待时间；未提供时按设置计算
 */
export async function submitAnswer(problem, result, submitOptions = {}) {
  const startTime = submitOptions?.startTime;
  const endTime = submitOptions?.endTime;
  const forceRetry = submitOptions?.forceRetry ?? false;
  const retryDtOffsetMs = submitOptions?.retryDtOffsetMs ?? 2000;
  const headers = submitOptions?.headers;
  const autoGate = submitOptions?.autoGate ?? true;
  const waitMs = submitOptions?.waitMs;
  const lessonIdFromOpts = submitOptions && 'lessonId' in submitOptions ? submitOptions.lessonId : undefined;

   // 统一拿 lessonId
   const lessonId = (lessonIdFromOpts ?? repo?.currentLessonId ?? null);
  // endTime 是服务端时钟（unlock 时记了 clockOffset）——判过期/限时都要换算回服务端时间轴
  const psEarly = repo?.problemStatus?.get?.(String(problem.problemId));
  const clockOffset = Number.isFinite(psEarly?.clockOffset) ? psEarly.clockOffset : 0;
  const serverNow = () => Date.now() + clockOffset;

  if (autoGate && shouldAutoAnswerForLesson_(lessonId)) {
    const ms = typeof waitMs === 'number' ? Math.max(0, waitMs) : calcAutoWaitMs();
    if (ms > 0) {
      const guard = (typeof endTime === 'number') ? Math.max(0, endTime - serverNow() - 80) : ms;
      await sleep(Math.min(ms, guard));
    }
  }

  const now = serverNow();
  const pastDeadline = typeof endTime === 'number' && Number.isFinite(endTime) && now >= endTime;

  if (pastDeadline || forceRetry) {

    log.dbg('[雨课堂助手][DEBUG][answer] >>> 进入补交分支判断');
    log.dbg('problemId:', problem.problemId);
    log.dbg('pastDeadline:', pastDeadline, '(now=', now, ', endTime=', endTime, ')');
    log.dbg('forceRetry:', forceRetry);
    log.dbg('传入 startTime:', startTime, '传入 endTime:', endTime);

    const ps = repo?.problemStatus?.get?.(String(problem.problemId));
    log.dbg('从 repo.problemStatus 获取:', ps);

    const st = Number.isFinite(startTime) ? startTime : (ps?.startTime);
    const et = Number.isFinite(endTime)   ? endTime   : (ps?.endTime);
    log.dbg('最终用于 retry 的 st=', st, ' et=', et);

    // 计算 dt
    const off  = Math.max(0, retryDtOffsetMs);
    let dt;

    if (Number.isFinite(st)) {
      dt = st + off;
      log.dbg('补交 dt = startTime + offset =', dt);
    } else if (Number.isFinite(et)) {
      dt = Math.max(0, et - Math.max(off, 5000));
      log.dbg('补交 dt = near endTime window =', dt);
    } else {
      dt = Date.now() - off;
      log.dbg('补交 dt = fallback =', dt);
    }

    log.dbg('>>> 即将调用 retryAnswer()');

    try {
      const resp = await retryAnswer(problem, result, dt, { headers });
      log.dbg('[雨课堂助手][INFO][answer] 补交成功 (/retry)', { problemId: problem.problemId, dt, pastDeadline, forceRetry });
      return { route: 'retry', resp };
    } catch (e) {
      log.err('[雨课堂助手][ERR][answer] 补交失败 (/retry)：', e);
      log.err('[雨课堂助手][ERR][answer] 失败参数：', { st, et, dt, pastDeadline, forceRetry });
      throw e;
    }
  }

  const resp = await answerProblem(problem, result, { headers, dt: now });
  return { route: 'answer', resp };
}
