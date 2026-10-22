// src/answer/adapters/assignment.js
// 老版作业/试卷（quizData.Slides[i].Problem） → AnswerTask
import {
  QTYPE, normalizeType, normalizeOptions, isSupportedType, safeId, typeLabel,
} from '../model.js';

function blankCount(p) {
  if (Array.isArray(p?.Blanks)) return p.Blanks.length;
  const n = Number(p?.Blanks ?? p?.blankCount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object} args
 * @param {object} args.quizData 老版 quizData（Slides[].Problem）
 * @param {number} args.index
 * @param {object} [args.assignment] 作业列表项（id/title/oldId）
 * @param {string} [args.quizId] 作业 ID（通常 assignment.oldId）
 * @param {string} [args.imageDataUrl] 已拼好的题图
 * @returns {object|null} AnswerTask
 */
export function buildAssignmentTask({
  quizData,
  index,
  assignment = null,
  quizId = '',
  imageDataUrl = '',
} = {}) {
  const p = quizData?.Slides?.[index]?.Problem;
  if (!p) return null;

  const rawType = p.Type;
  const type = normalizeType(rawType, { source: 'assignment' });
  const optionLabels = (Array.isArray(p.Bullets) ? p.Bullets : [])
    .map((b) => String(b?.Label ?? b?.label ?? '').trim())
    .filter(Boolean);
  const options = normalizeOptions(optionLabels.map((key) => ({ key, text: '' })));
  const supported = isSupportedType(type);
  const qid = String(quizId || assignment?.oldId || '');

  const allowSubmit = supported && !!qid && p.ProblemID != null;
  const submitLabel = allowSubmit ? '暂存' : '仅展示';

  return {
    id: `assignment:${safeId(qid)}:${safeId(p.ProblemID ?? index)}`,
    source: 'assignment',
    question: {
      type,
      typeLabel: typeLabel(type),
      body: `第 ${index + 1} 题（${typeLabel(type)}，${p.Score ?? ''} 分）`,
      options,
      optionLabels,
      blanks: blankCount(p),
      image: {
        dataUrl: imageDataUrl || '',
        quizId: qid,
        index,
      },
      rawType,
    },
    target: {
      kind: allowSubmit ? 'quiz' : 'display',
      quizId: qid,
      quizProblemId: p.ProblemID,
      allowSubmit,
      submitLabel,
      // 作业暂存不等于交卷；填空/主观也走 cache_each_result（用户已确认）
      cacheText: type === QTYPE.FILL || type === QTYPE.SUBJECTIVE,
      answered: false,
    },
    meta: {
      assignmentId: assignment?.id != null ? String(assignment.id) : null,
      title: assignment?.title || quizData?.Title || '',
      index,
      score: p.Score ?? null,
    },
  };
}
