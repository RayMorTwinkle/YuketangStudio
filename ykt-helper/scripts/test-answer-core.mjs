// scripts/test-answer-core.mjs
// Answer Engine V2 核心单测：适配器 / 严格解析 / prompt / 序列化 / 引擎。
import assert from 'node:assert/strict';
import {
  QTYPE, ERROR, AnswerError,
} from '../src/answer/model.js';
import { buildClassroomTask } from '../src/answer/adapters/classroom.js';
import { buildAssignmentTask } from '../src/answer/adapters/assignment.js';
import { buildProblemListTask } from '../src/answer/adapters/problem-list.js';
import { normalizeAnswer, normalizeConfidence, parseRegex, parseLegacy, stripRegexAnswer } from '../src/answer/parse.js';
import { buildQuestionBlock, buildAnswerContract, buildMessages, SUBMIT_ANSWER_TOOL } from '../src/answer/prompt.js';
import { toClassroomResult, toQuizResult } from '../src/answer/serialize.js';
import { runAnswer } from '../src/answer/engine.js';
import { sanitizeTraceEvent } from '../src/core/telemetry.js';
import { normalizeTimestamp, deadlineFromLimit, remainingSeconds, isDeadlineReached } from '../src/core/problem-timing.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}
function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof AnswerError && e.code === code);
}

const classroomProblem = {
  problemId: 101,
  problemType: 2,
  body: '以下哪些是编程语言？',
  options: [
    { key: 'A', value: 'JavaScript' },
    { key: 'B', value: 'Python' },
    { key: 'C', value: 'HTML' },
  ],
};
const classroomStatus = {
  slideId: 's1', startTime: 1000, endTime: 2000, clockOffset: 0, done: false,
};
const classroomTask = buildClassroomTask({
  problem: classroomProblem,
  slide: { id: 's1', index: 1, presentationId: 'p1' },
  status: classroomStatus,
  lessonId: 'L1',
});

console.log('== 时间归一化 ==');
ok('秒级时间戳 → 毫秒', () => {
  assert.equal(normalizeTimestamp(1_700_000_000), 1_700_000_000_000);
});
ok('毫秒时间戳保持毫秒', () => {
  assert.equal(normalizeTimestamp(1_700_000_000_123), 1_700_000_000_123);
});
ok('空/非法时间戳 → null', () => {
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp(0), null);
  assert.equal(normalizeTimestamp('x'), null);
});
ok('dt(秒) + limit(秒) → 正确毫秒截止时间', () => {
  assert.equal(deadlineFromLimit(1_700_000_000, 60), 1_700_000_060_000);
});
ok('剩余秒数带 clockOffset', () => {
  assert.equal(remainingSeconds(1_700_000_060_000, 0, 1_700_000_000_000), 60);
  assert.equal(remainingSeconds(1_700_000_060_000, 5_000, 1_700_000_000_000), 55);
});
ok('到点/过期判断', () => {
  assert.equal(isDeadlineReached(1_700_000_060_000, 0, 1_700_000_060_000), true);
  assert.equal(isDeadlineReached(1_700_000_060_000, 0, 1_700_000_059_999), false);
  assert.equal(isDeadlineReached(null), false);
});

console.log('== 适配器 ==');
ok('课堂题：canonical 多选 + 可提交', () => {
  assert.equal(classroomTask.question.type, QTYPE.MULTIPLE);
  assert.equal(classroomTask.target.kind, 'classroom');
  assert.equal(classroomTask.target.problemType, 2);
  assert.equal(classroomTask.target.allowSubmit, true);
  assert.equal(classroomTask.question.blanks, 0);
});
ok('课堂题：无 status → 只展示', () => {
  const t = buildClassroomTask({ problem: classroomProblem });
  assert.equal(t.target.kind, 'display');
  assert.equal(t.target.allowSubmit, false);
});
ok('课堂判断题：选项为 正确/错误 时识别为 judge', () => {
  const t = buildClassroomTask({
    problem: { problemId: 102, problemType: 1, body: '1+1=2', options: [{ key: 'A', value: '正确' }, { key: 'B', value: '错误' }] },
    status: classroomStatus,
  });
  assert.equal(t.question.type, QTYPE.JUDGE);
  assert.equal(t.target.problemType, 1);
});
ok('作业题：Judgement → judge，A/B 标签只给标签', () => {
  const t = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 9, Type: 'Judgement', Score: 1, Bullets: [{ Label: 'A' }, { Label: 'B' }] } }] },
    index: 0, assignment: { id: 'q1', oldId: '1738865', title: '作业' }, quizId: '1738865',
  });
  assert.equal(t.question.type, QTYPE.JUDGE);
  assert.deepEqual(t.question.optionLabels, ['A', 'B']);
  assert.equal(t.target.kind, 'quiz');
  assert.equal(t.target.allowSubmit, true);
  assert.equal(t.question.body.includes('判断题'), true);
});
ok('作业题：未知题型 → display', () => {
  const t = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 10, Type: 'Exam' } }] },
    index: 0, quizId: '1',
  });
  assert.equal(t.question.type, QTYPE.UNKNOWN);
  assert.equal(t.target.allowSubmit, false);
});
ok('题目列表：无 status → 只展示', () => {
  const t = buildProblemListTask({
    entry: { problemId: 101, problemType: 2, body: 'x', options: classroomProblem.options, slide: { id: 's1' } },
    problem: classroomProblem,
    status: null,
  });
  assert.equal(t.target.kind, 'display');
  assert.equal(t.source, 'problem-list');
});

console.log('== 严格解析：选择 ==');
ok('多选 A,C', () => {
  const a = normalizeAnswer(classroomTask, { answers: ['A', 'C'] });
  assert.deepEqual(a.values, ['A', 'C']);
  assert.equal(a.kind, 'choice');
});
ok('多选连写 AC', () => {
  const a = normalizeAnswer(classroomTask, { answers: ['AC'] });
  assert.deepEqual(a.values, ['A', 'C']);
});
ok('"The answer is B" 必须判无效（不抽 A-Z）', () => {
  throwsCode(() => normalizeAnswer(classroomTask, { answers: ['The answer is B'] }), ERROR.INVALID_ANSWER);
});
ok('"答案是B" 必须判无效', () => {
  throwsCode(() => normalizeAnswer(classroomTask, { answers: ['答案是B'] }), ERROR.INVALID_ANSWER);
});
ok('单选收到多个 → 无效', () => {
  const t = buildClassroomTask({ problem: { ...classroomProblem, problemType: 1 }, status: classroomStatus });
  throwsCode(() => normalizeAnswer(t, { answers: ['A', 'B'] }), ERROR.INVALID_ANSWER);
});
ok('非法选项 → 无效', () => {
  throwsCode(() => normalizeAnswer(classroomTask, { answers: ['Z'] }), ERROR.INVALID_ANSWER);
});

ok('无选项标签时多选 AC 仍可解析（作业 Bullets 缺失兜底）', () => {
  const t = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 88, Type: 'MultipleChoice', Bullets: [] } }] },
    index: 0, quizId: '1',
  });
  assert.deepEqual(normalizeAnswer(t, { answers: ['AC'] }).values, ['A', 'C']);
});

console.log('== 严格解析：判断 ==');
const judgeAB = buildAssignmentTask({
  quizData: { Slides: [{ Problem: { ProblemID: 201, Type: 'Judgement', Score: 1, Bullets: [{ Label: 'A' }, { Label: 'B' }] } }] },
  index: 0, assignment: { id: 'q201', oldId: '1738865' }, quizId: '1738865',
});
const judgeText = buildClassroomTask({
  problem: { problemId: 202, problemType: 1, body: '命题', options: [{ key: 'A', value: '正确' }, { key: 'B', value: '错误' }] },
  status: classroomStatus,
});
const judgeSymbol = buildClassroomTask({
  problem: { problemId: 203, problemType: 1, body: '命题', options: [{ key: '√', value: '√' }, { key: '×', value: '×' }] },
  status: classroomStatus,
});
ok('A/B 标签 + × → 报错，不按位置猜', () => {
  throwsCode(() => normalizeAnswer(judgeAB, { answers: ['×'] }), ERROR.INVALID_ANSWER);
});
ok('A/B 标签 + B → B', () => {
  assert.deepEqual(normalizeAnswer(judgeAB, { answers: ['B'] }).values, ['B']);
});
ok('正确/错误文本 + × → B', () => {
  assert.deepEqual(normalizeAnswer(judgeText, { answers: ['×'] }).values, ['B']);
});
ok('√/× 作为 key + × → ×', () => {
  assert.deepEqual(normalizeAnswer(judgeSymbol, { answers: ['×'] }).values, ['×']);
});

console.log('== 严格解析：填空/主观 ==');
const fillTask = buildClassroomTask({
  problem: { problemId: 301, problemType: 4, body: '1+1=__，2+2=__', blanks: ['a', 'b'] },
  status: classroomStatus,
});
ok('填空按行 → 两空', () => {
  assert.deepEqual(normalizeAnswer(fillTask, { answers: ['2', '4'] }).values, ['2', '4']);
});
ok('填空空数不匹配 → 报错', () => {
  throwsCode(() => normalizeAnswer(fillTask, { answers: ['2'] }), ERROR.INVALID_ANSWER);
});
const subjTask = buildClassroomTask({
  problem: { problemId: 401, problemType: 5, body: '简述' },
  status: classroomStatus,
});
ok('主观题 → text', () => {
  const a = normalizeAnswer(subjTask, { answers: ['第一行', '第二行'] });
  assert.equal(a.kind, 'subjective');
  assert.equal(a.text, '第一行\n第二行');
});

console.log('== regex / legacy ==');
ok('regex 多选 A,C', () => {
  const a = parseRegex(classroomTask, '理由\n<answer>A,C</answer>');
  assert.deepEqual(a.values, ['A', 'C']);
});
ok('regex 判断题 × 且 A/B → 报错', () => {
  throwsCode(() => parseRegex(judgeAB, '<answer>×</answer>'), ERROR.INVALID_ANSWER);
});
ok('stripRegexAnswer 去掉标记', () => {
  assert.equal(stripRegexAnswer('理由\n<answer>B</answer>'), '理由');
});
ok('legacy 答案: B', () => {
  const a = parseLegacy(classroomTask, '答案: B\n解释: x');
  assert.deepEqual(a.values, ['B']);
});
ok('legacy 散文不抽字母', () => {
  throwsCode(() => parseLegacy(classroomTask, '答案: The answer is B'), ERROR.INVALID_ANSWER);
});

console.log('== prompt / serialize ==');
ok('题目块包含选项标签', () => {
  const block = buildQuestionBlock(judgeAB);
  assert.match(block, /选项标签：A、B/);
  assert.match(block, /不要输出 √\/×/);
});
ok('不能提交 → 只展示契约，不含 submit_answer', () => {
  const t = buildClassroomTask({ problem: { ...classroomProblem, problemId: 999 } });
  const c = buildAnswerContract(t, 'tools');
  assert.doesNotMatch(c, /submit_answer/);
  assert.match(c, /只展示/);
});
ok('可提交 → tools 契约', () => {
  const c = buildAnswerContract(classroomTask, 'tools');
  assert.match(c, /submit_answer/);
  assert.match(c, /本题会提交到课堂/);
});
ok('填空答案要求普通文本（工具描述 + tools/regex 契约）', () => {
  assert.match(SUBMIT_ANSWER_TOOL.function.description, /普通文本/);
  assert.match(SUBMIT_ANSWER_TOOL.function.parameters.properties.answers.description, /普通文本/);
  const fillTask = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 9, Type: 'FillBlank', Bullets: [] } }] },
    index: 0, quizId: '1',
  });
  assert.equal(fillTask.question.type, QTYPE.FILL);
  assert.match(buildAnswerContract(fillTask, 'tools'), /普通文本/);
  assert.doesNotMatch(buildAnswerContract(fillTask, 'tools'), /<answer>/);
  assert.match(buildAnswerContract(fillTask, 'regex'), /普通文本/);
  assert.match(buildAnswerContract(fillTask, 'regex'), /<answer>/);
});
ok('课堂 result：多选数组', () => {
  const a = normalizeAnswer(classroomTask, { answers: ['A', 'C'] });
  assert.deepEqual(toClassroomResult(classroomTask, a), ['A', 'C']);
});
ok('作业 result：多选连写', () => {
  const t = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 9, Type: 'MultipleChoice', Bullets: [{ Label: 'A' }, { Label: 'B' }] } }] },
    index: 0, quizId: '1',
  });
  const a = normalizeAnswer(t, { answers: ['A', 'B'] });
  assert.equal(toQuizResult(t, a), 'AB');
});
ok('作业 result：填空换行 / 主观文本', () => {
  const t = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 9, Type: 'FillBlank', Bullets: [] } }] },
    index: 0, quizId: '1',
  });
  assert.equal(toQuizResult(t, normalizeAnswer(t, { answers: ['1', '2'] })), '1\n2');
  const s = buildAssignmentTask({
    quizData: { Slides: [{ Problem: { ProblemID: 10, Type: 'Subjective' } }] },
    index: 0, quizId: '1',
  });
  assert.equal(toQuizResult(s, normalizeAnswer(s, { answers: ['一段话'] })), '一段话');
});
ok('buildMessages：system 带契约，user 带题目', () => {
  const msgs = buildMessages(classroomTask, { baseSystem: 'BASE', transport: 'tools' });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /BASE/);
  assert.match(msgs[0].content, /submit_answer/);
  assert.equal(msgs[1].role, 'user');
  assert.match(msgs[1].content[0].text, /题目信息/);
});

console.log('== 强化遥测 schema ==');
ok('answer_parse_error 保留 task/run/tool/question/error', () => {
  const ev = sanitizeTraceEvent({
    event: 'answer_parse_error', ok: false, taskId: 'assignment:1:2', runId: 'ans_x',
    source: 'assignment', type: 'judge', transport: 'tools', attempt: 2,
    question: { type: 'judge', body: '命题', options: [{ key: 'A', text: '' }], optionLabels: ['A', 'B'], blanks: 0 },
    targetInfo: { kind: 'quiz', allowSubmit: true, submitLabel: '暂存' },
    parse: { ok: false, path: 'tools', code: 'INVALID_ANSWER', error: '选项无效', raw: '答案是 A', toolCall: { name: 'submit_answer', arguments: '{"answers":["×"]}' } },
    error: { name: 'AnswerError', code: 'INVALID_ANSWER', message: '选项无效' },
  });
  assert.equal(ev.taskId, 'assignment:1:2');
  assert.equal(ev.runId, 'ans_x');
  assert.equal(ev.parse.code, 'INVALID_ANSWER');
  assert.equal(ev.parse.toolCall.arguments.includes('×'), true);
  assert.equal(ev.targetInfo.kind, 'quiz');
  assert.equal(ev.question.body, '命题');
});
ok('answer_submit 保留 payload', () => {
  const ev = sanitizeTraceEvent({
    event: 'answer_submit', ok: true, taskId: 'classroom:1', runId: 'ans_y',
    route: 'answer', payload: { kind: 'classroom', problemId: 1, result: ['B'] },
  });
  assert.equal(ev.route, 'answer');
  assert.deepEqual(ev.payload.result, ['B']);
});

console.log('== engine（注入 mock chat）==');
const toolRes = {
  content: '',
  reasoning: '',
  toolCalls: [{ id: 'c1', type: 'function', function: { name: 'submit_answer', arguments: JSON.stringify({ answers: ['A', 'C'], reason: '测试' }) } }],
};
await okAsync('tools 正常解析', async () => {
  const r = await runAnswer(classroomTask, { transport: 'tools', stream: false }, { chat: async () => toolRes });
  assert.equal(r.ok, true);
  assert.deepEqual(r.answer.values, ['A', 'C']);
  assert.equal(r.transport, 'tools');
});
await okAsync('tools 不支持 → 切 regex 并重建 prompt', async () => {
  const seen = [];
  const r = await runAnswer(
    { ...classroomTask, question: { ...classroomTask.question, type: QTYPE.JUDGE }, target: { ...classroomTask.target } },
    { transport: 'tools', stream: false },
    {
      chat: async (opts) => {
        seen.push(opts.messages[0].content);
        if (opts.tools) throw new Error('HTTP 400: {"error":{"message":"tools is not supported"}}');
        return { content: '<answer>B</answer>', reasoning: '', toolCalls: [] };
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'regex');
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[1], /submit_answer/);
  assert.match(seen[1], /<answer>/);
});
await okAsync('第一次无工具 → nudge 后第二次调用工具', async () => {
  let n = 0;
  const r = await runAnswer(classroomTask, { transport: 'tools', stream: false }, {
    chat: async () => {
      n++;
      if (n === 1) return { content: '答案是 A、C', reasoning: '', toolCalls: [] };
      return toolRes;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});
await okAsync('两次都无工具 → 失败，不产生答案', async () => {
  const r = await runAnswer(classroomTask, { transport: 'tools', stream: false }, {
    chat: async () => ({ content: '我不会', reasoning: '', toolCalls: [] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, ERROR.NO_TOOL);
});
await okAsync('display-only 强制 text 契约', async () => {
  const t = buildClassroomTask({ problem: { ...classroomProblem, problemId: 998 } });
  let sys = '';
  const r = await runAnswer(t, { transport: 'tools', stream: false, allowLegacyText: true }, {
    chat: async (opts) => {
      sys = opts.messages[0].content;
      return { content: '答案: A', reasoning: '', toolCalls: [] };
    },
  });
  assert.equal(r.ok, true);
  assert.doesNotMatch(sys, /submit_answer/);
  assert.match(sys, /只展示/);
});
await okAsync('HTTP 429 不重试', async () => {
  const r = await runAnswer(classroomTask, { transport: 'tools', stream: false }, {
    chat: async () => { throw new Error('HTTP 429: too many requests'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, ERROR.HTTP);
  assert.equal(r.attempts, 1);
});

// ===== 置信度（normalizeConfidence / normalizeAnswer.confidence） =====
ok('置信度归一化：小数原样、百分数/100、越界钳制、非法为 null', () => {
  assert.equal(normalizeConfidence(0.85), 0.85);
  assert.equal(normalizeConfidence(0), 0);
  assert.equal(normalizeConfidence(1), 1);
  assert.equal(normalizeConfidence('0.4'), 0.4);
  assert.equal(normalizeConfidence('85%'), 0.85);
  assert.equal(normalizeConfidence(85), 0.85);
  assert.equal(normalizeConfidence(100), 1);
  assert.equal(normalizeConfidence(150), 1);
  assert.equal(normalizeConfidence(-0.2), 0);
  assert.equal(normalizeConfidence(null), null);
  assert.equal(normalizeConfidence('abc'), null);
  assert.equal(normalizeConfidence(undefined), null);
});
ok('normalizeAnswer 透传 confidence 并归一化', () => {
  const a = normalizeAnswer(classroomTask, { answers: ['A'], confidence: 85 }, 'tool');
  assert.equal(a.confidence, 0.85);
  const b = normalizeAnswer(classroomTask, { answers: ['A'] }, 'tool');
  assert.equal(b.confidence, null);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
