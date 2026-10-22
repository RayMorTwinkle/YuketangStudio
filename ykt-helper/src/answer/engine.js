// src/answer/engine.js
// 无 UI 的答题引擎：调用 LLM → 严格解析 → 失败重试/传输降级。
// 不读写全局 history、streaming、DOM；调用方通过 hooks 渲染。
import { agnesChat } from '../ai/agnes.js';
import { isToolUnsupportedError } from './errors.js';
import * as telemetry from '../core/telemetry.js';
import { answerLog } from './debug.js';
import { AnswerError, ERROR } from './model.js';
import { buildMessages, buildNudge, SUBMIT_ANSWER_TOOL } from './prompt.js';
import { parseToolCall, parseRegex, parseLegacy } from './parse.js';

function makeRunId() {
  return `ans_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function targetSummary(task) {
  const t = task?.target || {};
  return {
    kind: t.kind,
    allowSubmit: !!t.allowSubmit,
    submitLabel: t.submitLabel,
    problemId: t.problemId,
    problemType: t.problemType,
    quizId: t.quizId,
    quizProblemId: t.quizProblemId,
    hasStatus: t.kind === 'classroom' ? t.startTime != null || t.endTime != null : undefined,
    answered: !!t.answered,
    cacheText: !!t.cacheText,
  };
}

function questionSummary(task) {
  const q = task?.question || {};
  const img = q.image?.dataUrl || '';
  return {
    type: q.type,
    typeLabel: q.typeLabel,
    body: q.body || '',
    bodyLen: String(q.body || '').length,
    options: (q.options || []).map((o) => ({ key: o.key, text: o.text || '' })),
    optionLabels: q.optionLabels || [],
    blanks: Number(q.blanks) || 0,
    hasImage: !!img,
    imageBytes: img.length,
    rawType: q.rawType,
  };
}

function answerSummary(answer) {
  if (!answer) return null;
  return {
    kind: answer.kind,
    values: answer.values || [],
    text: answer.text || '',
    textLen: (answer.text || '').length,
    display: answer.kind === 'subjective' ? answer.text : (answer.values || []).join('、'),
    source: answer.source,
  };
}

function toolSummary(res) {
  const calls = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
  const call = calls.find((t) => t?.function?.name === 'submit_answer') || calls[0];
  if (!call) return null;
  return {
    name: call.function?.name || '',
    arguments: String(call.function?.arguments || ''),
  };
}

function responseSummary(res) {
  if (!res) return null;
  return {
    content: String(res.content || ''),
    reasoning: String(res.reasoning || ''),
    toolCalls: (res.toolCalls || []).slice(0, 3).map((t) => ({
      name: t?.function?.name || '',
      arguments: String(t?.function?.arguments || ''),
    })),
    truncated: !!res.truncated,
  };
}

function normalizeError(e) {
  if (e instanceof AnswerError) return e;
  const msg = String(e?.message || e || '未知错误');
  if (e?.name === 'AbortError' || /abort|cancel/i.test(msg)) {
    return new AnswerError(ERROR.ABORTED, msg, { retryable: false, cause: e });
  }
  if (/timeout|超时/i.test(msg) && !/^HTTP \d/.test(msg)) {
    return new AnswerError(ERROR.TIMEOUT, msg, { retryable: false, cause: e });
  }
  const m = msg.match(/^HTTP\s+(\d+)/);
  if (m) return new AnswerError(ERROR.HTTP, msg, { retryable: false, cause: e, detail: { status: Number(m[1]) } });
  return new AnswerError(ERROR.UNKNOWN, msg, { retryable: false, cause: e });
}

function parseOnce(task, res, transport, allowLegacyText) {
  // tools 模式：优先工具调用；没有工具但模型输出了 <answer>，也接受
  if (transport === 'tools') {
    const toolAnswer = parseToolCall(task, res?.toolCalls);
    if (toolAnswer) return toolAnswer;
    const regexAnswer = parseRegex(task, res?.content || '');
    if (regexAnswer) return regexAnswer;
    if (allowLegacyText) {
      const legacy = parseLegacy(task, res?.content || '');
      if (legacy) return legacy;
    }
    throw new AnswerError(ERROR.NO_TOOL, '模型没有调用 submit_answer，也没有输出 <answer> 块');
  }
  if (transport === 'regex') {
    let firstError = null;
    try {
      const answer = parseRegex(task, res?.content || '');
      if (answer) return answer;
    } catch (e) {
      firstError = e;
    }
    if (allowLegacyText) {
      const legacy = parseLegacy(task, res?.content || '');
      if (legacy) return legacy;
    }
    throw firstError || new AnswerError(ERROR.NO_TOOL, '模型没有输出 <answer> 块');
  }
  const legacy = parseLegacy(task, res?.content || '');
  if (legacy) return legacy;
  throw new AnswerError(ERROR.NO_TOOL, '模型没有输出可识别的答案');
}

/**
 * @param {object} task AnswerTask
 * @param {object} [policy]
 * @param {string} [policy.transport] 'tools'|'regex'|'text'
 * @param {string} [policy.baseSystem] 用户配置/默认 system prompt
 * @param {Array} [policy.history] 之前的 user/assistant 消息（手动追问用）
 * @param {string} [policy.userText] 用户本轮文字
 * @param {boolean} [policy.autoSubmit]
 * @param {boolean} [policy.soft] 手动追问的软提示
 * @param {number} [policy.maxAttempts=2]
 * @param {boolean} [policy.allowLegacyText] 仅手动展示时允许旧「答案:」格式
 * @param {boolean} [policy.stream=true]
 * @param {boolean} [policy.thinking=true]
 * @param {object} [policy.override] AI profile
 * @param {AbortSignal} [policy.signal]
 * @param {Function} [policy.onDelta]
 * @param {Function} [policy.onReasoning]
 * @param {Function} [policy.onWait]
 * @param {Function} [policy.onAttempt] ({attempt, transport, degraded})
 * @param {object} [deps] { chat }
 * @returns {Promise<{ok:boolean, answer?:object, error?:AnswerError, res?:object, transport:string, attempts:number}>}
 */
export async function runAnswer(task, policy = {}, deps = {}) {
  if (!task) return { ok: false, error: new AnswerError(ERROR.NO_TASK, '没有题目上下文'), transport: policy.transport || 'text', attempts: 0 };
  const chat = deps.chat || agnesChat;
  const maxAttempts = Math.max(1, Number(policy.maxAttempts) || 2);
  let transport = task.target?.allowSubmit ? (policy.transport || 'tools') : 'text';
  if (transport === 'tools' && !task.target?.allowSubmit) transport = 'text';
  const runId = policy.runId || makeRunId();
  const startedAt = Date.now();
  const question = questionSummary(task);
  const targetInfo = targetSummary(task);

  const baseSystem = String(policy.baseSystem || '').trim();
  const baseHistory = Array.isArray(policy.history) ? [...policy.history] : [];
  let retryHistory = [];
  let lastError = null;
  let lastRes = null;
  let attempts = 0;
  let degraded = false;

  answerLog('engine_start', { runId, taskId: task.id, source: task.source, type: task.question?.type, transport, target: task.target?.kind });
  telemetry.trace({
    event: 'answer_start',
    runId,
    taskId: task.id,
    source: task.source,
    type: task.question?.type,
    transport,
    target: task.target?.kind,
    autoSubmit: !!policy.autoSubmit,
    question,
    targetInfo,
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    policy.onAttempt?.({ attempt, transport });
    telemetry.trace({
      event: 'answer_attempt',
      runId,
      taskId: task.id,
      source: task.source,
      type: task.question?.type,
      transport,
      target: task.target?.kind,
      attempt,
      autoSubmit: !!policy.autoSubmit,
      targetInfo,
      userTextLen: String(policy.userText || '').length,
      historyLen: baseHistory.length + retryHistory.length,
    });
    const messages = buildMessages(task, {
      baseSystem,
      history: [...baseHistory, ...retryHistory],
      userText: policy.userText || '',
      transport,
      autoSubmit: !!policy.autoSubmit,
      soft: !!policy.soft,
      includeTask: true,
      attachImage: policy.attachImage !== false,
    });

    let res;
    try {
      res = await chat({
        messages,
        stream: policy.stream !== false,
        thinking: policy.thinking !== false,
        signal: policy.signal,
        override: policy.override || undefined,
        tools: transport === 'tools' ? [SUBMIT_ANSWER_TOOL] : undefined,
        toolChoice: transport === 'tools' ? (policy.toolChoice || (policy.autoSubmit ? 'required' : 'auto')) : undefined,
        traceKind: policy.traceKind || 'answer',
        traceMode: transport,
        traceTaskId: task.id,
        traceRunId: runId,
        traceSource: task.source,
        traceAttempt: attempt,
        onDelta: policy.onDelta,
        onReasoning: policy.onReasoning,
        onWait: policy.onWait,
      });
    } catch (e) {
      // 端点不支持工具：切到 regex 契约并重建 prompt（不消耗重试次数）
      if (transport === 'tools' && !degraded && isToolUnsupportedError(e)) {
        degraded = true;
        transport = 'regex';
        telemetry.trace({
          event: 'answer_transport_switch',
          runId,
          taskId: task.id,
          source: task.source,
          type: task.question?.type,
          attempt,
          transport: 'regex',
          from: 'tools',
          to: 'regex',
          reason: 'tool_unsupported',
          error: { name: e?.name || '', code: 'TOOL_UNSUPPORTED', message: String(e?.message || e) },
        });
        attempt -= 1;
        continue;
      }
      lastError = normalizeError(e);
      break;
    }

    lastRes = res;
    try {
      const answer = parseOnce(task, res, transport, !!policy.allowLegacyText);
      telemetry.trace({
        event: 'answer_parsed',
        runId,
        taskId: task.id,
        source: task.source,
        type: task.question?.type,
        transport,
        target: task.target?.kind,
        attempt,
        ok: true,
        question,
        targetInfo,
        answer: answerSummary(answer),
        tool: toolSummary(res),
        response: responseSummary(res),
      });
      answerLog('engine_done', { runId, taskId: task.id, ok: true, transport, attempts, answerSource: answer.source, values: answer.kind === 'subjective' ? undefined : answer.values });
      return { ok: true, answer, res, transport, attempts, runId };
    } catch (e) {
      lastError = e instanceof AnswerError ? e : normalizeError(e);
      telemetry.trace({
        event: 'answer_parse_error',
        runId,
        taskId: task.id,
        source: task.source,
        type: task.question?.type,
        transport,
        target: task.target?.kind,
        attempt,
        ok: false,
        question,
        targetInfo,
        parse: {
          ok: false,
          path: transport,
          code: lastError.code,
          error: lastError.message,
          raw: String(res?.content || ''),
          toolCall: toolSummary(res),
        },
        response: responseSummary(res),
        error: { name: lastError.name, code: lastError.code, message: lastError.message },
      });
      if (attempt >= maxAttempts || lastError.retryable === false) break;
      const nudge = buildNudge(task, lastError, transport);
      telemetry.trace({
        event: 'answer_retry',
        runId,
        taskId: task.id,
        source: task.source,
        type: task.question?.type,
        transport,
        target: task.target?.kind,
        attempt: attempt + 1,
        ok: true,
        reason: lastError.message,
        nudge,
      });
      retryHistory = [
        ...retryHistory,
        { role: 'assistant', content: String(res?.content || '') || '（无内容）' },
        { role: 'user', content: nudge },
      ];
    }
  }

  answerLog('engine_done', { runId, taskId: task.id, ok: false, code: lastError?.code || ERROR.UNKNOWN, transport, attempts, message: lastError?.message || '' });
  telemetry.trace({
    event: 'answer_error',
    runId,
    taskId: task.id,
    source: task.source,
    type: task.question?.type,
    transport,
    target: task.target?.kind,
    attempts,
    ok: false,
    durationMs: Date.now() - startedAt,
    question,
    targetInfo,
    response: responseSummary(lastRes),
    error: {
      name: lastError?.name || 'AnswerError',
      code: lastError?.code || ERROR.UNKNOWN,
      message: lastError?.message || '',
      detail: lastError?.detail || null,
    },
  });
  return { ok: false, error: lastError || new AnswerError(ERROR.UNKNOWN, '作答失败'), res: lastRes, transport, attempts, runId };
}
