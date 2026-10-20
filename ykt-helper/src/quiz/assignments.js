// src/quiz/assignments.js
// 本课作业列表：courses/list + logs/learn；兼容老版(type=4)与新版(type=19/20)
import { log } from '../core/log.js';

const enc = encodeURIComponent;

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

export async function fetchCourses() {
  const j = await getJson('/v2/api/web/courses/list?identity=2');
  const list = j?.data?.list || j?.list || [];
  return list
    .map((c) => ({
      id: String(c.classroom_id || ''),
      name: c.name || c.course?.name || '课程',
      role: c.role,
    }))
    .filter((c) => c.id);
}

export async function fetchAssignments(cid) {
  const j = await getJson(`/v2/api/web/logs/learn/${enc(cid)}?page=0&offset=200&sort=0&actype=-1`);
  const acts = j?.data?.activities || j?.activities || [];
  return acts
    .filter((a) => a && (a.type === 4 || a.type === 19 || a.type === 20))
    .map((a) => {
      const c = a.content || {};
      const oldId = a.type === 4
        ? String(a.courseware_id || '')
        : String(c.leaf_type_id || '');
      const newId = a.type === 4
        ? String(a.courseware_id || '')
        : String(c.leaf_id || '');
      return {
        id: String(a.id || oldId || newId),
        type: a.type,
        kind: a.type === 20 ? 'exam' : 'homework',
        title: a.title || (a.type === 20 ? '考试' : '作业'),
        deadline: Number(a.deadline || c.score_d || 0) || 0,
        totalScore: a.total_score ?? null,
        problemCount: a.problem_count ?? null,
        status: a.status ?? null,
        oldId,
        newId,
      };
    })
    .sort((a, b) => (b.deadline || 0) - (a.deadline || 0));
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
