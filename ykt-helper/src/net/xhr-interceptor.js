// src/net/xhr-interceptor.js
import { gm } from '../core/env.js';
import { log } from '../core/log.js';
import { actions } from '../state/actions.js';

export function installXHRInterceptor() {
  class MyXHR extends XMLHttpRequest {
    static handlers = [];
    static addHandler(h) { this.handlers.push(h); }
    open(method, url, async) {
      const parsed = new URL(url, location.href);
      for (const h of this.constructor.handlers) h(this, method, parsed);
      return super.open(method, url, async ?? true);
    }
    intercept(cb) {
      let payload;
      const rawSend = this.send;
      this.send = (body) => { payload = body; return rawSend.call(this, body); };
      this.addEventListener('load', () => {
        try { cb(JSON.parse(this.responseText), payload); } catch {}
      });
    }
  }

  function detectEnvironmentAndAdaptAPI() {
    const hostname = location.hostname;
    if (hostname === 'www.yuketang.cn') { log.dbg('[xhr] 检测到标准雨课堂环境'); return 'standard'; }
    if (hostname === 'pro.yuketang.cn') { log.dbg('[xhr] 检测到荷塘雨课堂环境'); return 'pro'; }
    if (hostname === 'changjiang.yuketang.cn') { log.dbg('[xhr] 检测到长江雨课堂环境'); return 'changjiang'; }
    log.dbg('[xhr] 未知环境:', hostname); return 'unknown';
  }
  // 环境探测：结果暂未参与分支，仅用于日志标记当前站点
  detectEnvironmentAndAdaptAPI();

  MyXHR.addHandler((xhr, method, url) => {
    const pathname = url.pathname || '';
    log.dbg('[xhr] 请求:', method, pathname, url.search);

    // 课件：精确路径或包含关键字
    if (
      pathname === '/api/v3/lesson/presentation/fetch' ||
      (pathname.includes('presentation') && pathname.includes('fetch'))
    ) {
      log.dbg('[雨课堂助手][INFO] 拦截课件请求');
      xhr.intercept((resp) => {
        const id = url.searchParams.get('presentation_id');
        log.dbg('[雨课堂助手][INFO] 课件响应:', resp);
        if (resp && (resp.code === 0 || resp.success)) {
          actions.onPresentationLoaded(id, resp.data || resp.result);
        }
      });
      return;
    }

    // 答题
    if (
      pathname === '/api/v3/lesson/problem/answer' ||
      (pathname.includes('problem') && pathname.includes('answer'))
    ) {
      log.dbg('[雨课堂助手][INFO] 拦截答题请求');
      xhr.intercept((resp, payload) => {
        try {
          const { problemId, result } = JSON.parse(payload || '{}');
          if (resp && (resp.code === 0 || resp.success)) {
            actions.onAnswerProblem(problemId, result);
          }
        } catch (e) {
          log.err('[雨课堂助手][ERR] 解析答题响应失败:', e);
        }
      });
      return;
    }

    if (url.pathname === '/api/v3/lesson/problem/retry') {
      xhr.intercept((resp, payload) => {
        try {
          // retry 请求体是 { problems: [{ problemId, result, ...}] }
          const body = JSON.parse(payload || '{}');
          const first = Array.isArray(body?.problems) ? body.problems[0] : null;
          if (resp?.code === 0 && first?.problemId) {
            actions.onAnswerProblem(first.problemId, first.result);
          }
        } catch {}
      });
      return;
    }
    if (pathname.includes('/api/')) {
      log.dbg('[雨课堂助手][WARN] 其他API:', method, pathname);
    }
  });

  gm.uw.XMLHttpRequest = MyXHR;

}

// ===== 自动进入课堂所需的最小 API 封装 =====
export async function getOnLesson() {
  const origin = location.origin;
  const same = (p) => new URL(p, origin).toString();
  const candidates = [
    same('/api/v3/classroom/on-lesson'),
    same('/mooc-api/v1/lms/classroom/on-lesson'),
    same('/apiv3/classroom/on-lesson'),
  ];

  const tries = [];
  let finalList = [];
  let lastErr = null;

  for (const url of candidates) {
    const item = { url, ok: false, status: 0, note: '' };
    try {
      const r = await fetch(url, { credentials: 'include' });
      item.status = r.status;
      if (!r.ok) {
        item.note = `HTTP ${r.status}`;
        tries.push(item);
        continue;
      }
      const text = await r.text();
      // 打个缩略，避免把整段 JSON 打爆
      item.bodySnippet = text.slice(0, 300);
      let j = {};
      try { j = JSON.parse(text); } catch (_) { item.note = 'JSON parse failed'; }
      const list = j?.data?.onLessonClassrooms || j?.result || j?.data || [];
      item.parsedLength = Array.isArray(list) ? list.length : -1;
      if (Array.isArray(list) && list.length) {
        item.ok = true;
        tries.push(item);
        finalList = list;
        break;
      } else {
        item.note ||= 'empty list';
        tries.push(item);
      }
    } catch (e) {
      item.note = (e && e.message) || 'fetch error';
      tries.push(item);
      lastErr = e;
    }
  }

  // 调试信息
  try {
    log.dbg(
      `%c[getOnLesson] host=%s  result=%s  candidates=%d`,
      'color:#09f',
      location.hostname,
      finalList.length ? `OK(${finalList.length})` : 'EMPTY',
      candidates.length
    );
      tries.forEach((t, i) => {
      log.dbg(
        `#${i+1}`,
        { url: t.url, ok: t.ok, status: t.status, note: t.note, parsedLength: t.parsedLength, bodySnippet: t.bodySnippet }
      );
    });
    if (!finalList.length && lastErr) log.warn('[getOnLesson] last error:', lastErr);

  } catch {}

  return finalList;
}

// src/net/xhr-interceptor.js
export async function checkinClass(lessonId, opts = {}) {
  const origin = location.origin;
  const same = (p) => new URL(p, origin).toString();
  const classroomId = opts?.classroomId;

  const headers = {
    'content-type': 'application/json',
    'xtbz': 'ykt',
  };

  // 针对不同网关，使用各自的 payload 形态
  const candidates = [
    {
      url: same('/api/v3/lesson/checkin'),
      payload: { lessonId, ...(classroomId ? { classroomId } : {}) }, // v3: 驼峰
      name: 'v3-same',
    },
    {
      url: 'https://pro.yuketang.cn/api/v3/lesson/checkin',
      payload: { lessonId, ...(classroomId ? { classroomId } : {}) },
      name: 'v3-pro',
    },
    {
      url: 'https://www.yuketang.cn/api/v3/lesson/checkin',
      payload: { lessonId, ...(classroomId ? { classroomId } : {}) },
      name: 'v3-www',
    },
    {
      url: same('/mooc-api/v1/lms/lesson/checkin'),
      payload: { lesson_id: lessonId, ...(classroomId ? { classroom_id: classroomId } : {}) }, // 旧网关：蛇形
      name: 'mooc-same',
    },
    {
      url: same('/apiv3/lesson/checkin'),
      payload: { lessonId, ...(classroomId ? { classroomId } : {}) },
      name: 'apiv3-same',
    },
  ];

  const tries = [];
  let lastErr;

  for (const cand of candidates) {
    const item = { url: cand.url, name: cand.name, status: 0, note: '' };
    try {
      const resp = await fetch(cand.url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(cand.payload),
      });
      item.status = resp.status;
      const text = await resp.text().catch(() => '');
      item.bodySnippet = text.slice(0, 300);

      if (!resp.ok) {
        item.note = `HTTP ${resp.status}`;
        // 如果 400/401/403，继续试下一条
        tries.push(item);
        continue;
      }

      let data = {};
      try { data = JSON.parse(text); } catch { item.note = 'JSON parse failed'; }
      const token =
        data?.data?.lessonToken ||
        data?.result?.lessonToken ||
        data?.lessonToken;

      const setAuth = resp.headers.get('Set-Auth') || resp.headers.get('set-auth') || null;
      item.note = token ? 'OK' : 'no token in body';
      tries.push(item);

      if (token) {
        try {
          log.dbg('%c[checkinClass] OK %s', 'color:#0a0', cand.name);
          log.dbg('payload:', cand.payload);
          log.dbg('setAuth:', !!setAuth);

        } catch {}
        return { token, setAuth, raw: data };
      }
    } catch (e) {
      item.note = e.message || 'fetch error';
      tries.push(item);
      lastErr = e;
    }
  }

  try {
    log.dbg('%c[checkinClass] FAILED host=%s', 'color:#f33', location.hostname);
    log.dbg('lessonId:', lessonId, 'classroomId:', classroomId);
    tries.forEach((t, i) => log.dbg(`#${i + 1}`, t));
    if (lastErr) log.warn('lastErr:', lastErr);

  } catch {}
  // 抛给上层，由上层走“直跳 lesson 页”的兜底逻辑；带上各候选的状态方便排查
  const summary = tries.map(t => `${t.name}:${t.status || t.note}`).join(' | ');
  throw new Error(`checkinClass 全部候选失败（${summary || '无响应'}）`);
}

/** 获取当前/最近激活的 presentationId（多候选，自适配不同网关） */
export async function getActivePresentationId(lessonId) {
  const origin = location.origin;
  const same = (p) => new URL(p, origin).toString();
  const qs = (id) => `?lessonId=${encodeURIComponent(id)}`;
  const candidates = [
    same(`/api/v3/lesson/presentation/active${qs(lessonId)}`),
    same(`/api/v3/lesson/presentation/current${qs(lessonId)}`),
    same(`/api/v3/lesson/presentation${qs(lessonId)}`),
    same(`/apiv3/lesson/presentation${qs(lessonId)}`),
    same(`/mooc-api/v1/lms/lesson/presentation${qs(lessonId)}`),
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      // 兼容多种返回结构
      const fromData = j?.data || j?.result || j;
      if (!fromData) continue;
      // 可能直接是对象 {presentationId: xxx}，也可能在列表里
      const pid =
        fromData.presentationId ||
        fromData.presentation_id ||
        (Array.isArray(fromData) && (fromData[0]?.presentationId || fromData[0]?.presentation_id));
      if (pid) {
        log.dbg('[雨课堂助手][DBG][getActivePresentationId] OK', { url, presentationId: pid });
        return String(pid);
      }
    } catch (e) {
      // 忽略，试下一个
    }
  }
  log.warn('[雨课堂助手][WARN][getActivePresentationId] no pid found for lesson', lessonId);
  return null;
}