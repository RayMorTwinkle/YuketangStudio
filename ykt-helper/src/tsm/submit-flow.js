// src/tsm/submit-flow.js
// 统一的「提交答案」流程：解析 → 提交（含过期补交）→ 更新本地状态。
// 供 actions.submit（手动）与 AI 工具调用共用，避免两套逻辑漂移。

import { submitAnswer } from './answer.js';
import { repo } from '../state/repo.js';
import { ui } from '../ui/ui-api.js';
import { getTestSubmitMode } from '../core/test-mode.js';

/** 把用户/AI 的文本答案转成接口需要的 result 结构 */
export function parseManualAnswer(problemType, content) {
  switch (Number(problemType)) {
    case 1: case 2: case 3:
      return (String(content).toUpperCase().match(/[A-Z]/g) || []).sort();
    case 4:
      return String(content).split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
    case 5:
      return { content, pics: [] };
    default:
      return null;
  }
}

/** 提交成功后更新本地状态（题目结果 + 已遇到列表 + 面板刷新） */
export function markAnswered(problemId, result) {
  const p = repo.problems.get(String(problemId));
  if (p) p.result = result;
  const i = repo.encounteredProblems.findIndex((e) => String(e.problemId) === String(problemId));
  if (i !== -1) repo.encounteredProblems[i].result = result;
  ui.updateProblemList?.();
}

/**
 * 提交结构化答案。
 * @param {{problemId:number, problemType:number}} problem
 * @param {any} result
 * @param {{startTime?:number,endTime?:number,forceRetry?:boolean,lessonId?:any}} [opts]
 * @returns {Promise<'answer'|'retry'>}
 */
export async function submitProblemAnswer(problem, result, opts = {}) {
  // 测试模式：不请求真实接口，直接模拟结果
  const testMode = getTestSubmitMode();
  if (testMode) {
    await new Promise((r) => setTimeout(r, 350));
    if (testMode === 'fail') throw new Error('模拟提交失败');
    markAnswered(problem.problemId, result);
    return testMode === 'retry' ? 'retry' : 'answer';
  }

  const { route } = await submitAnswer(problem, result, {
    lessonId: opts.lessonId ?? repo.currentLessonId,
    autoGate: false, // 手动/工具提交都不套自动延迟
    startTime: opts.startTime,
    endTime: opts.endTime,
    forceRetry: !!opts.forceRetry,
  });
  markAnswered(problem.problemId, result);
  return route;
}
