// src/quiz/exercise.js
// EP3：新版作业（type 19）题目与状态读取。
// GET /mooc-api/v1/lms/exercise/get_exercise_list/{leafTypeId}/?classroom_id=&term=latest&uv_id=
// 纯 I/O 壳：解析逻辑全部在 active-core（parseProblem/parseProgress），便于复用与单测。
import { proGet } from './active-http.js';
import {
  dataOf, parseProblem, parseProgress, text, httpsUrl, number,
} from './active-core.js';

function unknownProgress() {
  return {
    status: 'unknown',
    graded: null,
    score: null,
    totalScore: null,
    answeredCount: null,
    totalCount: null,
    questions: [],
    statusMessage: null,
  };
}

/** EP3 路径（enrichAssignments 复用）。 */
export function exerciseListPath({ leafTypeId, classroomId, uvId }) {
  const query = new URLSearchParams({
    classroom_id: String(classroomId || ''),
    term: 'latest',
    uv_id: String(uvId || ''),
  });
  return `/mooc-api/v1/lms/exercise/get_exercise_list/${encodeURIComponent(leafTypeId)}/?${query}`;
}

/**
 * 读取新版作业详情（题目 + 状态汇总）。
 * 题目列表与聚合作答数都缺失时状态未知（未知≠未答），不抛错。
 */
export async function fetchExerciseDetail({ leafTypeId, classroomId, uvId }) {
  const data = dataOf(await proGet(exerciseListPath({ leafTypeId, classroomId, uvId })));
  const problems = (Array.isArray(data.problems) ? data.problems : [])
    .map((raw, i) => parseProblem(raw, i));
  const hasStatus = problems.length > 0 || number(data.answer_count) !== null;
  let progress = unknownProgress();
  if (hasStatus) {
    try {
      progress = parseProgress(data);
    } catch {
      progress = unknownProgress();
    }
  }
  const late = number(data.late_submission);
  return {
    mode: 'exercise',
    problems,
    progress,
    title: text(data.name) || null,
    descriptionHtml: text(data.description),
    fontUrl: httpsUrl(data.font),
    maxRetry: number(data.max_retry) ?? 0,
    lateAllowed: data.is_allowed_late_submission === true,
    lateDeadline: late !== null && late > 0 ? late : null,
  };
}
