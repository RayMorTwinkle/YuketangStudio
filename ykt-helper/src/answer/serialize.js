// src/answer/serialize.js
// Answer → 各提交后端需要的 result 形状。
// 所有编码只在这里做一次，renderToolCard 不再临时判断。
import { QTYPE } from './model.js';

/** 课堂 /api/v3/lesson/problem/answer 的 result */
export function toClassroomResult(task, answer) {
  const type = task?.question?.type;
  if (type === QTYPE.SUBJECTIVE) {
    return { content: answer?.text || '', pics: [] };
  }
  if (type === QTYPE.FILL) {
    return [...(answer?.values || [])];
  }
  return [...(answer?.values || [])];
}

/** 作业 /v/quiz/cache_each_result 的 result 字符串 */
export function toQuizResult(task, answer) {
  const type = task?.question?.type;
  if (type === QTYPE.SUBJECTIVE) return String(answer?.text || '');
  if (type === QTYPE.FILL) return (answer?.values || []).join('\n');
  // 选择/判断：标签连写，如 "AC" / "B"
  return (answer?.values || []).join('');
}

/** 卡片展示文本 */
export function toDisplayAnswer(answer) {
  if (!answer) return '';
  if (answer.kind === 'subjective') return answer.text || '';
  if (answer.kind === 'fill') return (answer.values || []).join(' | ');
  return (answer.values || []).join('、');
}
