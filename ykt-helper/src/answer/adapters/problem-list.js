// src/answer/adapters/problem-list.js
// 题目列表（历史/已收集题目） → AnswerTask
import { buildClassroomTask } from './classroom.js';

/**
 * @param {object} args
 * @param {object} args.entry repo.encounteredProblems 的条目
 * @param {object} [args.problem] 更完整的题目对象（repo.problems）
 * @param {object} [args.slide] slide（entry.slide 或 repo.slides）
 * @param {object} [args.status] repo.problemStatus
 * @param {string|number} [args.lessonId]
 * @param {string} [args.imageDataUrl]
 * @returns {object|null}
 */
export function buildProblemListTask({
  entry,
  problem = null,
  slide = null,
  status = null,
  lessonId = null,
  imageDataUrl = '',
} = {}) {
  const pid = problem?.problemId ?? entry?.problemId;
  if (pid == null) return null;
  const merged = {
    ...(entry || {}),
    ...(problem || {}),
    problemId: pid,
    problemType: problem?.problemType ?? entry?.problemType ?? problem?.type ?? entry?.type,
    body: problem?.body || entry?.body || '',
    options: problem?.options || entry?.options || [],
  };
  const task = buildClassroomTask({
    problem: merged,
    slide: slide || entry?.slide || null,
    status,
    lessonId,
    imageDataUrl,
    source: 'problem-list',
  });
  if (!task) return null;
  // 历史题没有 status/lesson 时只展示，不允许假装可提交
  if (!status) {
    task.target.kind = 'display';
    task.target.allowSubmit = false;
    task.target.submitLabel = task.target.answered ? '已作答' : '仅解答';
  }
  task.meta.presentationId = entry?.presentationId ?? task.meta.presentationId;
  return task;
}
