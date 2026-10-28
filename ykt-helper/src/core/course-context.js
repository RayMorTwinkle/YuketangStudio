// src/core/course-context.js
// 课程上下文：把桌面版 / 移动版 / 新版作业页的 URL 统一解析成课程坐标。
// UI 只依赖这里的结果，不要在面板里各写一套正则。
//
// 设计原则：
// - “当前 URL 里的课程”优先；
// - 用户手动切课后，在本页/本课程上下文内保留，不被刷新/轮询覆盖；
// - 路由真正切到另一门课（classId 变化）时，手动选择自动失效；
// - 解析不出来时返回空字段，由调用方决定是否回退“上次选择”。

import { log } from './log.js';

const MANUAL_KEY = 'ykt.course.manual';
let routeHooked = false;
let memoryManual = null;
const listeners = new Set();

function safeSessionGet(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}

function safeSessionSet(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode / blocked storage */ }
}

function readManual() {
  const v = memoryManual || safeSessionGet(MANUAL_KEY);
  if (!v || typeof v !== 'object' || !v.cid) return null;
  return v;
}

function writeManual(v) {
  memoryManual = v || null;
  safeSessionSet(MANUAL_KEY, v);
}

function clean(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * 解析当前 URL 的课程坐标。
 * @param {string} [pathname]
 * @param {string} [search]
 * @returns {{classId:string,courseId:string,lessonId:string,newId:string,oldQuizId:string,kind:string,routeKey:string}}
 */
export function parseCourseContext(pathname = location.pathname, search = location.search) {
  const path = String(pathname || '');
  const q = new URLSearchParams(String(search || ''));
  let classId = clean(q.get('classroom_id') || q.get('classroomId'));
  let courseId = clean(q.get('course_id') || q.get('courseId'));
  let lessonId = clean(q.get('lesson_id') || q.get('lessonId'));
  let newId = '';
  let oldQuizId = '';
  let kind = '';
  let m;

  // 桌面版课程日志 / 报告 / 课堂 / 班级课件
  if (!classId && (m = path.match(/\/v2\/web\/studentLog\/(\d+)/))) classId = m[1];
  if (!classId && (m = path.match(/\/v2\/web\/student-lesson-report\/(\d+)/))) classId = m[1];
  if (!classId && (m = path.match(/\/v2\/web\/student-v3\/(\d+)/))) classId = m[1];
  if (!classId && (m = path.match(/\/v2\/web\/studentCards\/(\d+)/))) classId = m[1];

  // 新版作业/考试：/ai-workspace/lms-graph/{classId}/exercise|quiz/{id}
  if ((m = path.match(/\/ai-workspace\/lms-graph\/(\d+)\/(exercise|quiz)\/([^/?#]+)/))) {
    classId = classId || m[1];
    kind = m[2] === 'quiz' ? 'exam' : 'homework';
    newId = decodeURIComponent(m[3]);
  }

  // 老版作业/试卷：/v/quiz/quiz_info/{quizId}
  if (!oldQuizId && (m = path.match(/\/v\/quiz\/quiz_info\/(\d+)/))) {
    oldQuizId = m[1];
    kind = 'homework';
  }

  // 移动版课程日志：/m/v2/course/{courseId}/logs/{courseId}/{classId}
  if ((m = path.match(/\/m\/v\d+\/course\/([^/]+)\/logs\/(\d+)\/(\d+)/))) {
    courseId = courseId || m[1];
    classId = classId || m[3];
  }

  // 移动版课堂：/m/v2/lesson/{lessonId}
  if (!lessonId && (m = path.match(/\/m\/v\d+\/lesson\/([^/?#]+)/))) lessonId = m[1];

  return {
    classId,
    courseId,
    lessonId,
    newId,
    oldQuizId,
    kind,
    routeKey: `${path}${search || ''}`,
  };
}

export function getCourseContext() {
  return parseCourseContext();
}

/** 当前课程 id（兼容旧调用；只返回 classId）。 */
export function currentClassId() {
  return getCourseContext().classId || null;
}

/** 用户手动切课：记录选择，并绑定到当前 classId，避免影响另一门课。 */
export function rememberCourseSelection(cid, context = getCourseContext()) {
  const id = clean(cid);
  if (!id) return;
  writeManual({ cid: id, classId: clean(context.classId), at: Date.now() });
}

export function clearCourseSelection() {
  writeManual(null);
}

/** 当前手动选择是否仍适用于这个课程上下文。 */
export function manualCourseId(context = getCourseContext()) {
  const v = readManual();
  if (!v?.cid) return '';
  // 有 classId 时只允许同一 classId 下沿用；没有 classId 的全局页沿用上次选择。
  if (context.classId && v.classId && String(v.classId) !== String(context.classId)) return '';
  return String(v.cid);
}

function findCourse(courses, id) {
  if (!id) return null;
  return (courses || []).find((c) => String(c?.id) === String(id)) || null;
}

/**
 * 从课程列表中选择当前课程。
 * 优先：当前 URL 的 classId → 手动选择 → URL 的 courseId → 第一门课。
 */
export function preferredCourse(courses, context = getCourseContext()) {
  const list = Array.isArray(courses) ? courses : [];
  if (!list.length) return null;
  // 用户手动切课优先于 URL（但只在同一 classId 上下文内有效）。
  const manual = findCourse(list, manualCourseId(context));
  if (manual) return manual;
  const byClass = findCourse(list, context.classId);
  if (byClass) return byClass;
  if (context.courseId) {
    const byCourse = list.find((c) => String(c?.courseId) === String(context.courseId));
    if (byCourse) return byCourse;
  }
  return list[0] || null;
}

/** 该课程是否由 URL 直接确定（用于 UI 显示“跟随当前课程”而不是“上次选择”）。 */
export function isCourseFromRoute(cid, context = getCourseContext()) {
  return !!cid && !!context.classId && String(cid) === String(context.classId);
}

/** 监听 SPA 路由变化；只在顶层安装一次。 */
export function subscribeCourseRoute(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  if (routeHooked || typeof window === 'undefined') return () => listeners.delete(fn);
  routeHooked = true;

  const emit = () => {
    const ctx = getCourseContext();
    for (const cb of [...listeners]) {
      try { cb(ctx); } catch (e) { log.warn('[course-context] route listener failed', e); }
    }
  };

  try {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function patchedPush(...args) {
      const r = origPush.apply(this, args);
      setTimeout(emit, 0);
      return r;
    };
    history.replaceState = function patchedReplace(...args) {
      const r = origReplace.apply(this, args);
      setTimeout(emit, 0);
      return r;
    };
  } catch (e) {
    log.warn('[course-context] history patch failed', e);
  }
  window.addEventListener('popstate', () => setTimeout(emit, 0));
  window.addEventListener('hashchange', () => setTimeout(emit, 0));

  // Vue SPA 有时用 replaceState 但路由值在 microtask 后才可读：补一次低频检查。
  setInterval(() => {
    const ctx = getCourseContext();
    if (ctx.routeKey !== subscribeCourseRoute._lastKey) {
      subscribeCourseRoute._lastKey = ctx.routeKey;
      emit();
    }
  }, 1500);

  return () => listeners.delete(fn);
}
