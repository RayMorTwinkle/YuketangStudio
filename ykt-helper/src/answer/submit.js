// src/answer/submit.js
// 唯一提交分发器：课堂 / 作业暂存 / 仅展示。
import { cacheQuizAnswer } from '../quiz/quiz-paper.js';
import { submitProblemAnswer } from '../tsm/submit-flow.js';
import { getTestSubmitMode } from '../core/test-mode.js';
import * as telemetry from '../core/telemetry.js';
import { answerLog } from './debug.js';
import { ERROR, AnswerError } from './model.js';
import { toClassroomResult, toQuizResult, toDisplayAnswer } from './serialize.js';

/** 生成提交 payload（测试/日志用，不真正发请求） */
export function buildSubmitPayload(task, answer) {
  if (!task || !answer) return null;
  if (task.target?.kind === 'classroom') {
    return {
      kind: 'classroom',
      problemId: task.target.problemId,
      problemType: task.target.problemType,
      result: toClassroomResult(task, answer),
    };
  }
  if (task.target?.kind === 'quiz') {
    return {
      kind: 'quiz',
      quizId: task.target.quizId,
      problemId: task.target.quizProblemId,
      result: toQuizResult(task, answer),
    };
  }
  return { kind: 'display', display: toDisplayAnswer(answer) };
}

/**
 * 提交/暂存一份答案。
 * @param {object} task
 * @param {object} answer
 * @param {object} [opts]
 * @param {boolean} [opts.forceRetry] 课堂已过期时强制走补交
 * @param {boolean} [opts.dryRun] 只返回 payload，不发请求
 * @returns {Promise<{route:'answer'|'retry'|'cache'|'display', display:string, payload?:object}>}
 */
export async function submitAnswerTask(task, answer, opts = {}) {
  if (!task || !answer) throw new AnswerError(ERROR.NO_TASK, '没有可提交的答案');
  const display = toDisplayAnswer(answer);
  const payload = buildSubmitPayload(task, answer);
  if (!payload) throw new AnswerError(ERROR.NO_TASK, '没有可提交的答案');
  const base = {
    taskId: task.id,
    runId: opts.runId || '',
    source: task.source,
    type: task.question?.type,
    target: task.target?.kind,
    payload,
  };
  answerLog('submit_start', base);
  telemetry.trace({ event: 'answer_submit_start', ...base, ok: true });

  if (payload.kind === 'display' || !task.target?.allowSubmit) {
    telemetry.trace({ event: 'answer_submit', ...base, route: 'display', ok: true });
    return { route: 'display', display, payload };
  }
  if (opts.dryRun) return { route: payload.kind === 'quiz' ? 'cache' : 'answer', display, payload };

  // 测试模式：绝不碰真实接口
  const mock = getTestSubmitMode();
  if (mock) {
    await new Promise((r) => setTimeout(r, 300));
    if (mock === 'fail') {
      const err = new AnswerError(ERROR.SUBMIT_FAILED, '模拟提交失败');
      telemetry.trace({ event: 'answer_submit_error', ...base, ok: false, route: 'submit', error: { name: err.name, code: err.code, message: err.message } });
      throw err;
    }
    const route = mock === 'retry' ? 'retry' : (payload.kind === 'quiz' ? 'cache' : 'answer');
    task.target.answered = route !== 'cache';
    if (route === 'cache') task.target.cached = true;
    telemetry.trace({ event: 'answer_submit', ...base, route, ok: true, mocked: true });
    return { route, display, payload, mocked: true };
  }

  try {
    if (payload.kind === 'classroom') {
      const route = await submitProblemAnswer(
        { problemId: payload.problemId, problemType: payload.problemType },
        payload.result,
        {
          startTime: task.target.startTime,
          endTime: task.target.endTime,
          forceRetry: !!opts.forceRetry,
          lessonId: task.target.lessonId ?? undefined,
        },
      );
      task.target.answered = true;
      telemetry.trace({ event: 'answer_submit', ...base, route, ok: true });
      return { route, display, payload };
    }

    if (payload.kind === 'quiz') {
      await cacheQuizAnswer({
        quizId: payload.quizId,
        problemId: payload.problemId,
        result: payload.result,
      });
      task.target.cached = true;
      task.target.answered = false; // 暂存 ≠ 交卷
      telemetry.trace({ event: 'answer_submit', ...base, route: 'cache', ok: true });
      return { route: 'cache', display, payload };
    }
  } catch (e) {
    const err = e instanceof AnswerError ? e : new AnswerError(ERROR.SUBMIT_FAILED, String(e?.message || e), { cause: e });
    telemetry.trace({
      event: 'answer_submit_error',
      ...base,
      ok: false,
      route: payload.kind === 'quiz' ? 'cache' : 'answer',
      error: { name: err.name, code: err.code, message: err.message },
    });
    throw err;
  }

  return { route: 'display', display, payload };
}
