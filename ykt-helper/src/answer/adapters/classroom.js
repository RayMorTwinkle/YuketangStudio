// src/answer/adapters/classroom.js
// 课堂实时题（PPT 答题） → AnswerTask
import {
  normalizeType, normalizeOptions, toClassroomCode, isSupportedType, safeId, typeLabel,
} from '../model.js';

function blankCount(problem) {
  if (Array.isArray(problem?.blanks)) return problem.blanks.length;
  const n = Number(problem?.blanks ?? problem?.blankCount ?? problem?.Blanks);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object} args
 * @param {object} args.problem 课堂题目对象（problemId/problemType/body/options/...）
 * @param {object} [args.slide] 题目所在 slide（用于 slideId/presentationId）
 * @param {object} [args.status] repo.problemStatus 里的状态
 * @param {string|number} [args.lessonId]
 * @param {string} [args.imageDataUrl] 已解析好的题图
 * @param {'classroom'|'problem-list'} [args.source]
 * @returns {object|null} AnswerTask
 */
export function buildClassroomTask({
  problem,
  slide = null,
  status = null,
  lessonId = null,
  imageDataUrl = '',
  source = 'classroom',
} = {}) {
  if (!problem || problem.problemId == null) return null;

  const options = normalizeOptions(problem.options);
  const rawType = problem.problemType ?? problem.type ?? problem.questionType;
  const type = normalizeType(rawType, { source: 'classroom', options });
  const answered = !!(problem.result || status?.done);
  const supported = isSupportedType(type);
  // 只有拿到真实 unlock 状态、未作答、题型受支持时才允许提交
  const allowSubmit = !!status && !answered && supported;
  const submitLabel = allowSubmit ? '提交' : (answered ? '已作答' : '仅解答');

  return {
    id: `${source}:${safeId(problem.problemId)}`,
    source,
    question: {
      type,
      typeLabel: typeLabel(type),
      body: String(problem.body ?? problem.title ?? '').trim(),
      options,
      optionLabels: options.map((o) => o.key),
      blanks: blankCount(problem),
      image: imageDataUrl
        ? { dataUrl: imageDataUrl, slideId: slide?.id != null ? String(slide.id) : (status?.slideId || null) }
        : { slideId: slide?.id != null ? String(slide.id) : (status?.slideId || null) },
      rawType,
    },
    target: {
      kind: allowSubmit ? 'classroom' : 'display',
      problemId: problem.problemId,
      problemType: toClassroomCode(type),
      slideId: slide?.id != null ? String(slide.id) : (status?.slideId || null),
      lessonId: lessonId ?? null,
      startTime: status?.startTime,
      endTime: status?.endTime,
      clockOffset: status?.clockOffset || 0,
      answered,
      allowSubmit,
      submitLabel,
      // 课堂题永远不走作业缓存
      cacheText: false,
    },
    meta: {
      presentationId: slide?.presentationId ? String(slide.presentationId) : null,
      index: slide?.index ?? null,
      title: slide?.title || '',
      statusKnown: !!status,
    },
  };
}
