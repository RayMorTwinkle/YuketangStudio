// src/quiz/assignments.js
// 本课作业列表：courses/list + logs/learn；兼容老版(type=4)与新版(type=19/20)。
// 新版行结构：leafTypeId/skuId/classroomId + enrichAssignments 填充的状态字段；
// 保留窗口：type 19/20 仅显示近三个月（deadline 缺失时保留），type 4 不限。
import { log } from '../core/log.js';
import { proGet } from './active-http.js';
import { exerciseListPath } from './exercise.js';
import { normalizeCourse } from './course-cards.js';
import { examCoverPath } from './exam.js';
import {
  AuthError, dataOf, parseProgress, parseExamProgress, canReviewExam,
  isAssignmentRetained, uvIdFromCookie,
} from './active-core.js';

const enc = encodeURIComponent;

export async function fetchCourses() {
  const j = await proGet('/v2/api/web/courses/list?identity=2');
  const data = dataOf(j);   // HTTP 200 里的 errcode/code 也要按登录失效处理
  const list = data?.list || j?.list || [];
  return list
    .map(normalizeCourse)
    .filter((c) => c.id);
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

export async function fetchAssignments(cid) {
  const acts = [];
  const seenPages = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = dataOf(await proGet(
      `/v2/api/web/logs/learn/${enc(cid)}?page=${page}&offset=${PAGE_SIZE}&sort=0&actype=-1`,
    ));
    const items = Array.isArray(data.activities) ? data.activities : [];
    // 服务器忽略分页参数时整页重复：指纹去重后停止翻页（上游同款策略）
    const signature = JSON.stringify(items);
    if (seenPages.has(signature)) break;
    seenPages.add(signature);
    acts.push(...items);
    if (items.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) {
      log.warn(`[assign] 学习日志过多，仅显示前 ${MAX_PAGES * PAGE_SIZE} 条活动中的作业`);
    }
  }
  const rows = new Map();
  for (const a of acts) {
    if (!a) continue;
    const type = Number(a.type);
    if (![4, 19, 20].includes(type)) continue;
    const c = a.content || {};
    const oldId = type === 4 ? String(a.courseware_id || '') : '';
    const newId = type === 4
      ? String(a.courseware_id || '')
      : String(c.leaf_id || '');
    const leafTypeId = type === 4 ? '' : String(c.leaf_type_id || '');
    const skuId = type === 4 ? '' : String(c.sku_id || '');
    const id = String(a.id || a.courseware_id || newId || leafTypeId || '');
    if (!id) continue;
    const row = {
      id,
      type,
      kind: type === 20 ? 'exam' : 'homework',
      title: a.title || (type === 20 ? '考试' : '作业'),
      deadline: Number(a.deadline || c.score_d || 0) || 0,
      totalScore: a.total_score ?? null,
      problemCount: a.problem_count ?? null,
      status: a.status ?? null,
      oldId,
      newId,
      leafTypeId,
      skuId,
      classroomId: String(a.classroom_id || cid || ''),
    };
    rows.set(`${type}:${id}`, row);
  }
  return [...rows.values()]
    .filter((r) => r.type === 4 || isAssignmentRetained({ deadline: r.deadline || null }))
    .sort((a, b) => (b.deadline || 0) - (a.deadline || 0));
}

/**
 * 为 type 19/20 行补充作答状态（4 并发；AuthError 中止队列并整体抛出）。
 * 单项失败只降级为 statusMessage，不影响其余行；返回新数组，不改入参。
 */
export async function enrichAssignments(rows) {
  const uvId = uvIdFromCookie(typeof document !== 'undefined' ? document.cookie : '');
  const out = rows.map((r) => ({ ...r }));
  const pending = out.filter((r) => (r.type === 19 || r.type === 20) && r.leafTypeId);
  let cursor = 0;
  let stopped = false;
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!stopped && cursor < pending.length) {
      const row = pending[cursor++];
      try {
        if (row.type === 20) await enrichExamRow(row);
        else await enrichExerciseRow(row, uvId);
      } catch (e) {
        if (e instanceof AuthError) {
          stopped = true;
          failure = e;
          continue;
        }
        row.statusMessage = row.type === 20
          ? '考试状态获取失败，请刷新或在官网查看。'
          : '作答状态获取失败，请刷新或在官网确认。';
      }
    }
  }));
  if (failure) throw failure;
  return out;
}

/** type 19：EP3 读状态（不解析题目，详情按需再拉）。 */
async function enrichExerciseRow(row, uvId) {
  const data = dataOf(await proGet(exerciseListPath({
    leafTypeId: row.leafTypeId,
    classroomId: row.classroomId,
    uvId,
  })));
  let progress;
  try {
    progress = parseProgress(data);
  } catch {
    row.statusMessage = '暂无法获取作答状态，请在官网查看。';
    return;
  }
  Object.assign(row, {
    status: progress.status,
    graded: progress.graded,
    score: progress.score,
    totalScore: progress.totalScore,
    answeredCount: progress.answeredCount,
    totalCount: progress.totalCount,
    statusMessage: progress.statusMessage,
  });
  if (progress.totalCount !== null) row.problemCount = progress.totalCount;
}

/** type 20：EP4 读 cover 状态，并记录 canReview 供列表「回顾」按钮显隐。 */
async function enrichExamRow(row) {
  const cover = dataOf(await proGet(examCoverPath(row)));
  const p = parseExamProgress(cover);
  Object.assign(row, {
    examStatus: p.examStatus,
    status: p.status,
    graded: p.graded,
    score: p.score,
    totalScore: p.totalScore,
    answeredCount: p.answeredCount,
    totalCount: p.totalCount,
    statusMessage: p.statusMessage,
    canReview: canReviewExam(cover, Date.now()),
  });
  if (p.totalCount !== null) row.problemCount = p.totalCount;
}

export function oldUrl(a) {
  if (!a?.oldId) return '';
  return `${location.origin}/v/quiz/quiz_info/${a.oldId}/?pageIndex=1`;
}

export function newUrl(a, cid) {
  if (!a?.newId) return '';
  const kind = a.kind === 'exam' ? 'quiz' : 'exercise';
  return `${location.origin}/ai-workspace/lms-graph/${enc(cid)}/${kind}/${a.newId}?is_chapter=1`;
}

function decodeB64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/** 拉取老版作业页 HTML，解析内嵌 quizData（服务端渲染，不需要打开页面） */
export async function fetchQuizDataById(id) {
  const r = await fetch(`${location.origin}/v/quiz/quiz_info/${id}/?pageIndex=1`, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const m = html.match(/var\s+quizData\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('未找到 quizData（可能不是老版作业）');
  return JSON.parse(decodeB64Utf8(m[1]));
}

/** 在课程列表里找包含指定 quiz 的课程（并发 4） */
export async function findCourseByQuiz(courses, quizId) {
  const queue = [...courses];
  let found = null;
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length && !found) {
      const c = queue.shift();
      try {
        const list = await fetchAssignments(c.id);
        if (list.some((a) => a.oldId === quizId || a.newId === quizId)) {
          found = { cid: c.id, list };
        }
      } catch (e) {
        log.dbg('[assign] scan course failed', c.id, e?.message || e);
      }
    }
  });
  await Promise.all(workers);
  return found;
}
