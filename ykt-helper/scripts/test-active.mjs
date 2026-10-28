// scripts/test-active.mjs
// 新版作业/考试（type 19/20）纯函数核心单测：active-core.js。
// 用例移植自 yuketang-helper-auto 契约测试（assignments / assignment-detail / exam-review）。
import assert from 'node:assert/strict';
import {
  AuthError,
  dataOf,
  record,
  text,
  id,
  number,
  nonnegativeInteger,
  nonnegativeNumber,
  numericScore,
  parseDeadline,
  hasAnswer,
  httpsUrl,
  escapeText,
  reviewAnswer,
  uvIdFromCookie,
  assignmentRetentionCutoff,
  isAssignmentRetained,
  parseExamProgress,
  canReviewExam,
  parseProgress,
  parseProblem,
  joinExamPaper,
  parseExamHost,
} from '../src/quiz/active-core.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}
function throwsAuth(fn) {
  assert.throws(fn, (e) => e instanceof AuthError);
}
function throwsMsg(fn, pattern) {
  assert.throws(fn, (e) => !(e instanceof AuthError) && pattern.test(e.message));
}

console.log('== 基础归一化 ==');
ok('record：对象原样、数组/null/原始值 → null', () => {
  const o = { a: 1 };
  assert.equal(record(o), o);
  assert.equal(record([1]), null);
  assert.equal(record(null), null);
  assert.equal(record('x'), null);
  assert.equal(record(undefined), null);
});
ok('text/id/number 基础语义', () => {
  assert.equal(text('a'), 'a');
  assert.equal(text(1), '');
  assert.equal(id(55), '55');
  assert.equal(id(' 42 '), '42');
  assert.equal(id(null), '');
  assert.equal(number('0.00'), 0);
  assert.equal(number('3'), 3);
  assert.equal(number('-1.00'), null);
  assert.equal(number(''), null);
  assert.equal(number(-5), null);
  assert.equal(number(Infinity), null);
});
ok('nonnegativeInteger/Number 严格不接受字符串', () => {
  assert.equal(nonnegativeInteger(3), 3);
  assert.equal(nonnegativeInteger('3'), null);
  assert.equal(nonnegativeInteger(2.5), null);
  assert.equal(nonnegativeInteger(-1), null);
  assert.equal(nonnegativeNumber(2.5), 2.5);
  assert.equal(nonnegativeNumber('2.5'), null);
  assert.equal(nonnegativeNumber(-0.5), null);
});
ok('numericScore：字符串分数归一，负数/缺失 → null', () => {
  assert.equal(numericScore('5.00'), 5);
  assert.equal(numericScore('0.00'), 0);
  assert.equal(numericScore(5), 5);
  assert.equal(numericScore(-1), null);
  assert.equal(numericScore(undefined), null);
});
ok('parseDeadline：毫秒截止时间', () => {
  assert.equal(parseDeadline(1790697599000), 1790697599000);
  assert.equal(parseDeadline(0), null);
  assert.equal(parseDeadline(-1), null);
  assert.equal(parseDeadline('123'), null);
  assert.equal(parseDeadline(Infinity), null);
});
ok('hasAnswer：字符串/数组/数字递归判断', () => {
  assert.equal(hasAnswer(' x '), true);
  assert.equal(hasAnswer('  '), false);
  assert.equal(hasAnswer(['', 'A']), true);
  assert.equal(hasAnswer(['', '']), false);
  assert.equal(hasAnswer(0), true);
  assert.equal(hasAnswer(null), false);
  assert.equal(hasAnswer(undefined), false);
});
ok('httpsUrl：协议相对/绝对 https，拒绝 http 与非法', () => {
  assert.equal(httpsUrl('//fe-static-yuketang.yuketang.cn/f.ttf'), 'https://fe-static-yuketang.yuketang.cn/f.ttf');
  assert.equal(httpsUrl('https://a.yuketang.cn/x'), 'https://a.yuketang.cn/x');
  assert.equal(httpsUrl('http://a.yuketang.cn/x'), null);
  assert.equal(httpsUrl(''), null);
  assert.equal(httpsUrl(null), null);
  assert.equal(httpsUrl('https://'), null);
});
ok('escapeText/reviewAnswer', () => {
  assert.equal(escapeText('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(reviewAnswer('A'), 'A');
  assert.equal(reviewAnswer(['A', 'B']), 'A<br>B');
  assert.equal(reviewAnswer(['<x>', 2]), '&lt;x&gt;<br>2');
  assert.equal(reviewAnswer(42), '42');
  assert.equal(reviewAnswer(null), '');
  assert.equal(reviewAnswer({ a: 1 }), '');
});

console.log('== uv_id / cookie ==');
ok('uvIdFromCookie：uv_id 优先于 university_id，兜底 2598', () => {
  assert.equal(uvIdFromCookie('uv_id=2598'), '2598');
  assert.equal(uvIdFromCookie('university_id=2021'), '2021');
  assert.equal(uvIdFromCookie('uv_id=42; university_id=2021'), '42');
  assert.equal(uvIdFromCookie('university_id=2021; uv_id=42'), '42');
  assert.equal(uvIdFromCookie('sessionid=abc'), '2598');
  assert.equal(uvIdFromCookie(''), '2598');
  assert.equal(uvIdFromCookie(undefined), '2598');
  assert.equal(uvIdFromCookie('uv_id = 7; other=x'), '7');
});

console.log('== dataOf 信封解包 ==');
ok('success/data 正常解包', () => {
  assert.deepEqual(dataOf({ success: true, data: { a: 1 } }), { a: 1 });
  assert.deepEqual(dataOf({ errcode: 0, success: true, data: {} }), {});
  assert.deepEqual(dataOf({ code: '0', success: true, data: { b: 2 } }), { b: 2 });
});
ok('401000/401/403（各字段、字符串形式）→ AuthError', () => {
  throwsAuth(() => dataOf({ errcode: 401000 }));
  throwsAuth(() => dataOf({ error_code: 401 }));
  throwsAuth(() => dataOf({ code: '403' }));
  assert.ok(new AuthError() instanceof Error);
  assert.match(new AuthError().message, /登录/);
});
ok('其余错误码 / success:false / 缺 data → 普通错误', () => {
  throwsMsg(() => dataOf({ errcode: 500 }), /500/);
  throwsMsg(() => dataOf({ success: false }), /未成功/);
  throwsMsg(() => dataOf({ success: true }), /未返回数据/);
  throwsMsg(() => dataOf({ success: true, data: 'str' }), /未返回数据/);
  throwsMsg(() => dataOf('not json'), /非 JSON/);
  throwsMsg(() => dataOf([1, 2]), /非 JSON/);
});

console.log('== 保留窗口（三个月日历月，UTC 月末钳制） ==');
ok('assignmentRetentionCutoff：普通月份回退三个月', () => {
  assert.equal(assignmentRetentionCutoff(Date.UTC(2026, 9, 27)), Date.UTC(2026, 6, 27));
  assert.equal(assignmentRetentionCutoff(Date.UTC(2026, 0, 15)), Date.UTC(2025, 9, 15));
});
ok('assignmentRetentionCutoff：月末钳制（5/31 → 2/28，闰年 2/29）', () => {
  assert.equal(assignmentRetentionCutoff(Date.UTC(2026, 4, 31)), Date.UTC(2026, 1, 28));
  assert.equal(assignmentRetentionCutoff(Date.UTC(2024, 4, 31)), Date.UTC(2024, 1, 29));
});
ok('isAssignmentRetained：缺失 deadline 保留，边界 >= 保留，过期丢弃', () => {
  const now = Date.UTC(2026, 9, 27);
  const cutoff = assignmentRetentionCutoff(now);
  assert.equal(isAssignmentRetained({ deadline: null }, now), true);
  assert.equal(isAssignmentRetained({ deadline: undefined }, now), true);
  assert.equal(isAssignmentRetained({ deadline: NaN }, now), true);
  assert.equal(isAssignmentRetained({ deadline: cutoff }, now), true);
  assert.equal(isAssignmentRetained({ deadline: cutoff - 1 }, now), false);
  assert.equal(isAssignmentRetained({ deadline: now + 86400000 }, now), true);
});

console.log('== parseExamProgress（考试 cover） ==');
const examCoverBase = {
  problem_count: 10,
  total_score: 100,
  result: { status: 4, unfinished_count: 0, score: 60, score_finish: true },
};
ok('已交卷已出分：分数/总分/进度齐全', () => {
  const p = parseExamProgress(examCoverBase);
  assert.equal(p.examStatus, 'submitted');
  assert.equal(p.graded, true);
  assert.equal(p.score, 60);
  assert.equal(p.totalScore, 100);
  assert.equal(p.answeredCount, 10);
  assert.equal(p.totalCount, 10);
  assert.equal(p.status, 'answered');
  assert.equal(p.statusMessage, null);
  assert.deepEqual(p.questions, []);
});
ok('零分有效；未出分/缺 total_score → graded:false 且不展示分数', () => {
  assert.equal(parseExamProgress({ ...examCoverBase, result: { ...examCoverBase.result, score: 0 } }).score, 0);
  const noFinish = parseExamProgress({ ...examCoverBase, result: { ...examCoverBase.result, score_finish: false } });
  assert.equal(noFinish.graded, false);
  assert.equal(noFinish.score, null);
  assert.equal(noFinish.totalScore, null);
  const noTotal = parseExamProgress({ problem_count: 10, result: examCoverBase.result });
  assert.equal(noTotal.graded, false);
  assert.equal(noTotal.score, null);
});
ok('分数缺失/-1/Infinity/字符串 → 未出分', () => {
  for (const score of [null, -1, Infinity, '60']) {
    const p = parseExamProgress({ ...examCoverBase, result: { ...examCoverBase.result, score } });
    assert.equal(p.graded, false, `score=${String(score)}`);
    assert.equal(p.score, null);
  }
});
ok('作答进度：部分/未答/未知/缺考/作废', () => {
  assert.equal(parseExamProgress({ ...examCoverBase, result: { status: 5, unfinished_count: 2, score: 60, score_finish: true } }).status, 'partial');
  assert.equal(parseExamProgress({ ...examCoverBase, result: { status: 5, unfinished_count: 2, score: 60, score_finish: true } }).answeredCount, 8);
  assert.equal(parseExamProgress({ ...examCoverBase, result: { status: 4, unfinished_count: 10, score: 60, score_finish: true } }).status, 'unanswered');
  for (const unfinished of [null, 11, -1]) {
    const p = parseExamProgress({ ...examCoverBase, result: { status: 4, unfinished_count: unfinished, score: 60, score_finish: true } });
    assert.equal(p.answeredCount, null);
    assert.equal(p.status, 'unknown');
  }
  const absent = parseExamProgress({ ...examCoverBase, result: { status: 6, unfinished_count: 0, score: 90, score_finish: true } });
  assert.equal(absent.examStatus, 'absent');
  assert.equal(absent.graded, false);
  assert.equal(absent.answeredCount, null);
  assert.equal(absent.statusMessage, null);
});
ok('未知状态带提示；result 缺失 → unknown', () => {
  const unknown = parseExamProgress({ ...examCoverBase, result: { status: 99, unfinished_count: 0 } });
  assert.equal(unknown.examStatus, 'unknown');
  assert.match(unknown.statusMessage, /官网/);
  assert.equal(parseExamProgress({ problem_count: 10 }).examStatus, 'unknown');
  assert.equal(parseExamProgress({ problem_count: 10 }).statusMessage !== null, true);
});
ok('monitor_status=2 覆盖为作废，即使已交卷', () => {
  const p = parseExamProgress({ ...examCoverBase, face_auth_status: { monitor_status: 2 } });
  assert.equal(p.examStatus, 'invalid');
  assert.equal(p.graded, false);
  assert.equal(p.answeredCount, null);
  assert.equal(p.status, 'unknown');
});
ok('problem_count 缺失/为 0 → totalCount:null，不作答数推断', () => {
  const p = parseExamProgress({ result: { status: 4, unfinished_count: 0, score: 1, score_finish: true }, total_score: 10 });
  assert.equal(p.totalCount, null);
  assert.equal(p.answeredCount, null);
});

console.log('== canReviewExam（回顾门禁） ==');
const reviewableCover = {
  user: { user_id: 7 },
  problem_count: 2,
  total_score: 20,
  show_perm: true,
  show_score: true,
  show_answer: true,
  show_score_time: 0,
  server_time: 1000,
  result: { status: 4, score: 10, score_finish: true, unfinished_count: 0 },
};
ok('可回顾：交卷+出分+允许查看+公布时间已到', () => {
  assert.equal(canReviewExam(reviewableCover, 1000), true);
});
ok('未交卷/缺考/未知/作废 → 不可回顾', () => {
  for (const status of [0, 1, 2, 3, 6, 99]) {
    assert.equal(
      canReviewExam({ ...reviewableCover, result: { ...reviewableCover.result, status } }, 1000),
      false,
      `status=${status}`,
    );
  }
  assert.equal(canReviewExam({ ...reviewableCover, face_auth_status: { monitor_status: 2 } }, 1000), false);
});
ok('未出分/未公布 → 不可回顾', () => {
  for (const change of [
    { score: null },
    { score: -1 },
    { score_finish: false },
  ]) {
    assert.equal(
      canReviewExam({ ...reviewableCover, result: { ...reviewableCover.result, ...change } }, 1000),
      false,
      JSON.stringify(change),
    );
  }
  // 公布时间晚于服务器时间 → 不可回顾（show_score_time 是 cover 级字段）
  assert.equal(canReviewExam({ ...reviewableCover, show_score_time: 2000 }, 1000), false);
  const noTotal = { ...reviewableCover };
  delete noTotal.total_score;
  assert.equal(canReviewExam(noTotal, 1000), false);
});
ok('show_perm/show_score 缺失或 false → 不可回顾', () => {
  assert.equal(canReviewExam({ ...reviewableCover, show_perm: false }, 1000), false);
  const noPerm = { ...reviewableCover };
  delete noPerm.show_perm;
  assert.equal(canReviewExam(noPerm, 1000), false);
  assert.equal(canReviewExam({ ...reviewableCover, show_score: false }, 1000), false);
});

console.log('== parseProgress（exercise 汇总） ==');
const progressBody = {
  answer_count: 3,
  problems: [
    { content: {}, user: {} },
    { content: {}, user: { my_answer: { content: '有记录' } } },
    { content: {}, user: { status: 3, my_score: '-1.00', my_answer: { content: '' } } },
    null,
  ],
};
ok('逐题状态：未知≠未答，聚合数只作兜底计数', () => {
  const p = parseProgress(progressBody);
  assert.deepEqual(p.questions.map((q) => q.answered), [false, true, true, null]);
  assert.equal(p.answeredCount, 2);
  assert.equal(p.totalCount, 4);
  assert.equal(p.status, 'partial');
  assert.equal(p.graded, false); // 存在 status=3 待批改题 → 明确未出分
  assert.equal(p.score, null);
  assert.equal(p.totalScore, null);
});
ok('全部批改完成：分数按题求和', () => {
  const p = parseProgress({
    problems: [
      { problem_id: 1, content: { score: 5 }, user: { status: 4, my_score: '5.00' } },
      { problem_id: 2, content: { score: 5 }, user: { status: 4, my_score: '3.00' } },
    ],
  });
  assert.equal(p.status, 'answered');
  assert.equal(p.answeredCount, 2);
  assert.equal(p.graded, true);
  assert.equal(p.score, 8);
  assert.equal(p.totalScore, 10);
  assert.deepEqual(p.questions.map((q) => q.answered), [true, true]);
});
ok('空数据抛错；聚合数兜底；零聚合=未作答', () => {
  throwsMsg(() => parseProgress({}), /为空/);
  throwsMsg(() => parseProgress({ problems: [], answer_count: 'x' }), /为空/);
  const onlyCount = parseProgress({ answer_count: 5 });
  assert.equal(onlyCount.answeredCount, 5);
  assert.equal(onlyCount.status, 'partial');
  assert.equal(onlyCount.totalCount, null);
  assert.equal(onlyCount.graded, null);
  const zero = parseProgress({ answer_count: 0 });
  assert.equal(zero.status, 'unanswered');
  assert.equal(zero.answeredCount, 0);
  assert.equal(zero.graded, false);
});

console.log('== parseProblem（单题） ==');
const exerciseProblem = {
  problem_id: 55,
  index: 2,
  content: {
    ProblemType: 1,
    TypeText: '单选题',
    Body: '<span class="xuetangx-com-encrypted-font">𛈒</span>',
    Options: [{ name: 'A', content: '<b>选项一</b>' }],
    score: 5,
    AllowResults: ['text'],
    max_retry: 1,
  },
  user: {
    status: 4,
    my_score: '0.00',
    count: 3,
    my_count: 1,
    my_answer: { content: '<p>A</p>', attachment: [{ name: '说明.png' }] },
    remark: '评语',
    comment: [{ name: '老师', content: '评语', index: 1 }],
  },
};
ok('已批改单题全字段解析（真实样例）', () => {
  const p = parseProblem(exerciseProblem, 2);
  assert.equal(p.id, '55');
  assert.equal(p.index, 2);
  assert.equal(p.type, 1);
  assert.equal(p.typeText, '单选题');
  assert.equal(p.score, 5);
  assert.equal(p.bodyHtml, '<span class="xuetangx-com-encrypted-font">𛈒</span>');
  assert.deepEqual(p.options, [{ label: 'A', html: '<b>选项一</b>' }]);
  assert.equal(p.answerHtml, '<p>A</p>');
  assert.deepEqual(p.attachments, [{ name: '说明.png', url: null }]);
  assert.equal(p.status, 'graded');
  assert.equal(p.myScore, 0);
  assert.equal(p.remarkHtml, '评语');
  assert.deepEqual(p.comments, [{ html: '评语', name: '老师', index: 1 }]);
  assert.equal(p.maxRetry, 1);
  assert.equal(p.remainingRetries, 2);
  assert.deepEqual(p.allowResults, ['text']);
  assert.equal(p.externalUrl, null);
});
ok('状态矩阵：unknown / answered / submitted / unknown，myScore 均为 null', () => {
  const statuses = progressBody.problems.map((raw, i) => parseProblem(raw, i).status);
  assert.deepEqual(statuses, ['unknown', 'answered', 'submitted', 'unknown']);
  assert.deepEqual(progressBody.problems.map((raw, i) => parseProblem(raw, i).myScore), [null, null, null, null]);
});
ok('显式空作答 → unanswered；缺 user 数据 → unknown', () => {
  assert.equal(parseProblem({ content: {}, user: { my_answer: { content: '' } } }).status, 'unanswered');
  assert.equal(parseProblem({ content: {}, user: {} }).status, 'unknown');
  assert.equal(parseProblem(null).status, 'unknown');
  assert.equal(parseProblem(null, 3).id, '4');
});
ok('题型名兜底与附件链接', () => {
  const p = parseProblem({
    problem_id: 9,
    content: { ProblemType: 2 },
    user: { my_answer: { content: ['A', 'B'], attachment: [{ url: 'https://x.yuketang.cn/f.png' }] } },
  });
  assert.equal(p.typeText, '多选题');
  assert.equal(p.answerHtml, 'A<br>B');
  assert.deepEqual(p.attachments, [{ name: '附件', url: 'https://x.yuketang.cn/f.png' }]);
  assert.equal(p.status, 'answered');
});

console.log('== joinExamPaper（考试回顾试卷拼装） ==');
const examPaper = {
  font: '//fe-static-yuketang.yuketang.cn/current.ttf',
  problems: [
    {
      problem_id: 20,
      index: 0,
      ProblemType: 1,
      score: 10,
      Body: '<b>Second</b>',
      Options: [{ key: 'A', value: 'Option' }],
      Answer: ['A'],
      Remark: '<p>Explanation</p>',
    },
    {
      problem_id: 10,
      index: 0,
      ProblemType: 1,
      score: 10,
      Body: '<span class="xuetangx-com-encrypted-font">𛈒</span>',
    },
  ],
};
const examResults = {
  problem_results: [
    { problem_id: 10, finished: true, grade: 10, correct: true, result: ['B'], answer: ['B'] },
    { problem_id: 20, finished: true, grade: 0, correct: false, result: ['C'], answer: ['A'] },
  ],
};
ok('反序结果按 problem_id 关联并重排 index；零分保留', () => {
  const joined = joinExamPaper(examPaper, examResults, { ...reviewableCover, description: '考试说明' });
  assert.equal(joined.fontUrl, 'https://fe-static-yuketang.yuketang.cn/current.ttf');
  assert.equal(joined.descriptionHtml, '考试说明');
  const [first, second] = joined.problems;
  assert.equal(first.id, '20');
  assert.equal(first.index, 1);
  assert.equal(first.status, 'graded');
  assert.equal(first.myScore, 0);
  assert.equal(first.correct, false);
  assert.equal(first.answerHtml, 'C');
  assert.equal(first.correctAnswerHtml, 'A');
  assert.equal(first.explanationHtml, '<p>Explanation</p>');
  assert.deepEqual(first.options, [{ label: 'A', html: 'Option' }]);
  assert.equal(first.typeText, '单选题');
  assert.equal(second.id, '10');
  assert.equal(second.index, 2);
  assert.equal(second.myScore, 10);
  assert.equal(second.answerHtml, 'B');
  assert.equal(second.status, 'graded');
  assert.equal(second.correct, true);
  assert.deepEqual(joined.questions, [
    { id: '20', index: 1, answered: true },
    { id: '10', index: 2, answered: true },
  ]);
});
ok('show_answer=false：隐去参考答案与解析；缺失结果条目 → unknown/null', () => {
  const joined = joinExamPaper(
    examPaper,
    { problem_results: [{ problem_id: 20, finished: false, grade: -1 }] },
    { ...reviewableCover, show_answer: false },
  );
  const [first, second] = joined.problems;
  assert.equal(first.status, 'unanswered');
  assert.equal(first.myScore, null);
  assert.equal(first.correctAnswerHtml, '');
  assert.equal(first.explanationHtml, '');
  assert.equal(second.status, 'unknown');
  assert.equal(second.myScore, null);
  assert.equal(second.correctAnswerHtml, '');
  assert.equal(second.explanationHtml, '');
  assert.deepEqual(joined.questions.map((q) => q.answered), [false, null]);
});
ok('容错：非对象输入不抛错，产出空集', () => {
  const joined = joinExamPaper(null, undefined, null);
  assert.deepEqual(joined.problems, []);
  assert.deepEqual(joined.questions, []);
  assert.equal(joined.fontUrl, null);
  assert.equal(joined.descriptionHtml, '');
});

console.log('== parseExamHost（白名单） ==');
ok('白名单域名与缺省值', () => {
  assert.equal(parseExamHost('https://tsinghua-exam.yuketang.cn'), 'https://tsinghua-exam.yuketang.cn');
  assert.equal(parseExamHost('https://examination.xuetangx.com/path/x'), 'https://examination.xuetangx.com');
  assert.equal(parseExamHost(undefined), 'https://examination.xuetangx.com');
  assert.equal(parseExamHost(''), 'https://examination.xuetangx.com');
});
ok('http/端口/凭据/非白名单/非法 → 拒绝', () => {
  throwsMsg(() => parseExamHost('http://tsinghua-exam.yuketang.cn'), /暂不支持/);
  throwsMsg(() => parseExamHost('https://evil.example.com'), /暂不支持/);
  throwsMsg(() => parseExamHost('https://tsinghua-exam.yuketang.cn:8443'), /暂不支持/);
  throwsMsg(() => parseExamHost('https://user@tsinghua-exam.yuketang.cn'), /暂不支持/);
  throwsMsg(() => parseExamHost('::bad::'), /暂不支持/);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
