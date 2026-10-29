// scripts/test-course-data.mjs
// 刷课数据汇聚单测：成绩/日志/作业 → 统一条目 → 与目录合并。
import assert from 'node:assert/strict';
import {
  scoreRows, activityRows, assignmentRows, mergeBrushItems,
} from '../src/quiz/course-data.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}

console.log('== 成绩接口 ==');
const score = {
  summary: {
    finalScore: 88,
    evaluation: [
      { id: 'e1', proportion: 0.3 },
      { id: 'e2', proportion: 0.7 },
    ],
  },
  statistic: { average: 80, max: 100, min: 0 },
  items: [
    { id: '101', title: '视频一', leafType: 0, userScore: 10, leafScore: 10, evaluationId: 'e1' },
    { id: '102', title: '作业一', leafType: 6, userScore: 0, leafScore: 100, evaluationId: 'e2' },
    { id: '103', title: '班级课件', leafType: 7, userScore: 5, leafScore: 5, evaluationId: 'e2' },
  ],
};

ok('成绩条目带分数/权重，跳过班级课件', () => {
  const rows = scoreRows(score);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '101');
  assert.equal(rows[0].score, 10);
  assert.equal(rows[0].weight, 0.3);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[1].id, '102');
  assert.equal(rows[1].score, 0);
  assert.equal(rows[1].brushable, false);
});

console.log('== 学习日志 ==');
ok('只收刷课类型，type=7 交给班级课件专用链路', () => {
  const rows = activityRows([
    { id: 1, type: 0, courseware_id: '201', title: '视频', total: 10, finish: 10 },
    { id: 2, type: 3, courseware_id: '202', title: '图文', total: 5, finish: 2 },
    { id: 3, type: 7, courseware_id: '203', title: '班级课件', total: 5, finish: 5 },
    { id: 4, type: 6, courseware_id: '204', title: '作业' },
    { id: 5, type: 3, courseware_id: '202', title: '重复' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['201', '202']);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[1].completed, false);
});

console.log('== 作业/考试 ==');
ok('作业和考试只展示，标记完成状态', () => {
  const rows = assignmentRows([
    { id: 'a1', type: 19, title: '新版作业', status: 'graded', score: 90, totalScore: 100, problemCount: 5 },
    { id: 'a2', type: 20, title: '考试', examStatus: 'submitted', problemCount: 10 },
    { id: 'a3', type: 4, title: '老版作业', status: 'submitted' },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].brushable, false);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[1].typeLabel, '考试');
  assert.equal(rows[1].completed, true);
});

console.log('== 目录合并 ==');
ok('目录的 done/total 优先，API 只补成绩', () => {
  const base = [{
    id: '101', title: '视频一', type: 0, schedule: { done: 4, total: 10 }, completed: false,
    brushable: true, weight: 0.3, weightUnknown: false, scored: true, uniq: 'keep',
  }];
  const extra = [{
    id: '101', title: '视频一', type: 0, schedule: { done: 0, total: 0 }, completed: true,
    score: 10, maxScore: 10, hasScore: true, weight: 0.3, scored: true, weightUnknown: false,
  }];
  const rows = mergeBrushItems(base, extra);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].schedule, { done: 4, total: 10 });
  assert.equal(rows[0].completed, false);
  assert.equal(rows[0].score, 10);
  assert.equal(rows[0].uniq, 'keep');
});

ok('目录没有的 API 条目会追加', () => {
  const rows = mergeBrushItems([], [
    { id: '201', title: '视频', type: 0, schedule: { done: 10, total: 10 }, completed: true, brushable: true },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completed, true);
});

ok('班级课件基础行不覆盖 view_depth 真实进度', () => {
  const base = [{
    id: 'classcard:3293023', title: '第1章 Java概述', type: 7,
    schedule: { done: 0, total: 45 }, completed: false, brushable: true,
    completionSource: 'class-card', cardsId: '3293023',
  }];
  const extra = [{
    id: 'classcard:3293023', title: '第1章 Java概述', type: 7,
    schedule: { done: 38, total: 45 }, completed: false, brushable: true,
    completionSource: 'class-card', cardsId: '3293023', total: 45,
  }];
  const rows = mergeBrushItems(base, extra);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].schedule, { done: 38, total: 45 });
  assert.equal(rows[0].total, 45);
});

ok('无目录 total 时采用 API completed', () => {
  const rows = mergeBrushItems(
    [{ id: '301', title: '视频', schedule: { done: 0, total: 0 }, completed: false }],
    [{ id: '301', title: '视频', schedule: { done: 0, total: 0 }, completed: true }],
  );
  assert.equal(rows[0].completed, true);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
