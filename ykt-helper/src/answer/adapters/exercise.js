// src/answer/adapters/exercise.js
// 新版作业（type 19）/考试回顾（type 20）题目 → AnswerTask
// 入参 problem 为 active-core parseProblem/joinExamPaper 的输出；
// 仅展示：新版暂存接口未接入（预留 target.kind='exercise'），先只做 AI 解答。
import {
  normalizeType, normalizeOptions, safeId, typeLabel,
} from '../model.js';

/** HTML → 纯文本（正则实现，node 单测可直接导入；不解码加密字体，原字符保留）。 */
export function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&hellip;/gi, '…')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {object} args
 * @param {object} args.problem parseProblem/joinExamPaper 输出（id/index/type/bodyHtml/options/...）
 * @param {object} [args.assignment] 作业列表行（id/leafTypeId/title/type）
 * @returns {object|null} AnswerTask（display-only）
 */
export function buildExerciseTask({ problem, assignment = null, imageDataUrl = '' } = {}) {
  if (!problem || !problem.id) return null;
  const options = normalizeOptions(
    (Array.isArray(problem.options) ? problem.options : [])
      .map((o) => ({ key: o?.label, text: stripTags(o?.html) })),
  );
  const rawType = problem.type;
  const type = normalizeType(rawType, { source: 'assignment', options });
  const body = stripTags(problem.bodyHtml);
  return {
    id: `exercise:${safeId(assignment?.leafTypeId || assignment?.id)}:${safeId(problem.id)}`,
    source: 'exercise',
    question: {
      type,
      typeLabel: typeLabel(type),
      body: [
        `第 ${problem.index ?? '?'} 题（${problem.typeText || typeLabel(type)}，${problem.score ?? ''} 分）`,
        body,
      ].filter(Boolean).join('\n'),
      options,
      optionLabels: options.map((o) => o.key),
      // 新版填空无显式空位结构，无法强校验空数（AI 按题面作答）
      blanks: 0,
      image: imageDataUrl ? { dataUrl: imageDataUrl } : {},
      rawType,
    },
    target: {
      kind: 'display',
      allowSubmit: false,
      submitLabel: '仅展示',
      answered: ['answered', 'submitted', 'graded'].includes(problem.status),
    },
    meta: {
      assignmentId: assignment?.id != null ? String(assignment.id) : null,
      title: assignment?.title || '',
      index: problem.index ?? null,
      score: problem.score ?? null,
    },
  };
}
