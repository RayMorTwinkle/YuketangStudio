// scripts/test-course-context.mjs
// 课程上下文解析单测：桌面/移动/新版作业/老版作业。
import assert from 'node:assert/strict';
import {
  parseCourseContext, preferredCourse, rememberCourseSelection, clearCourseSelection,
} from '../src/core/course-context.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}

function context(path, search = '') {
  return parseCourseContext(path, search);
}

console.log('== 课程上下文解析 ==');

ok('桌面课程日志', () => {
  const c = context('/v2/web/studentLog/25398489');
  assert.equal(c.classId, '25398489');
  assert.equal(c.courseId, '');
  assert.equal(c.newId, '');
});

ok('桌面报告 / 课堂 / 班级课件', () => {
  assert.equal(context('/v2/web/student-lesson-report/123').classId, '123');
  assert.equal(context('/v2/web/student-v3/123/456/789').classId, '123');
  assert.equal(context('/v2/web/studentCards/123/456/789/ppt').classId, '123');
});

ok('新版作业与考试', () => {
  const hw = context('/ai-workspace/lms-graph/123/exercise/98765');
  assert.equal(hw.classId, '123');
  assert.equal(hw.newId, '98765');
  assert.equal(hw.kind, 'homework');
  const exam = context('/ai-workspace/lms-graph/123/quiz/555');
  assert.equal(exam.newId, '555');
  assert.equal(exam.kind, 'exam');
});

ok('老版试卷', () => {
  const c = context('/v/quiz/quiz_info/456789/');
  assert.equal(c.oldQuizId, '456789');
  assert.equal(c.kind, 'homework');
});

ok('移动版课程日志', () => {
  const c = context('/m/v2/course/3115397/logs/3115397/25398489');
  assert.equal(c.courseId, '3115397');
  assert.equal(c.classId, '25398489');
});

ok('移动版课堂 lessonId', () => {
  const c = context('/m/v2/lesson/abc123');
  assert.equal(c.lessonId, 'abc123');
});

ok('query 兜底', () => {
  const c = context('/v2/web/unknown', '?classroom_id=777&course_id=888&lesson_id=999');
  assert.equal(c.classId, '777');
  assert.equal(c.courseId, '888');
  assert.equal(c.lessonId, '999');
});

console.log('== 课程选择 ==');
const courses = [
  { id: '111', courseId: 'c1', name: 'A' },
  { id: '222', courseId: 'c2', name: 'B' },
  { id: '333', courseId: 'c3', name: 'C' },
];

ok('URL classId 优先', () => {
  const c = context('/v2/web/studentLog/222');
  assert.equal(preferredCourse(courses, c).id, '222');
});

ok('手动选择在同一课程上下文内保留', () => {
  clearCourseSelection();
  const c = context('/v2/web/studentLog/111');
  rememberCourseSelection('333', c);
  assert.equal(preferredCourse(courses, c).id, '333');
});

ok('换到另一门课后手动选择失效', () => {
  clearCourseSelection();
  const oldCtx = context('/v2/web/studentLog/111');
  rememberCourseSelection('333', oldCtx);
  const newCtx = context('/v2/web/studentLog/222');
  assert.equal(preferredCourse(courses, newCtx).id, '222');
  clearCourseSelection();
});

ok('直接打开作业/考试时路线课程优先于手动选择', () => {
  clearCourseSelection();
  rememberCourseSelection('333', context('/v2/web/studentLog/111'));
  const direct = context('/ai-workspace/lms-graph/111/exercise/98765');
  assert.equal(preferredCourse(courses, direct).id, '111');
  clearCourseSelection();
});

ok('无 URL 课程时使用上次手动选择', () => {
  clearCourseSelection();
  const globalCtx = context('/m/v2');
  rememberCourseSelection('222', globalCtx);
  assert.equal(preferredCourse(courses, globalCtx).id, '222');
  clearCourseSelection();
});

ok('首页手动选择不会覆盖课程页的当前课程', () => {
  clearCourseSelection();
  rememberCourseSelection('333', context('/m/v2'));
  const course = context('/m/v2/course/1/logs/1/222');
  assert.equal(preferredCourse(courses, course).id, '222');
  clearCourseSelection();
});

ok('完全无上下文时回退第一门课', () => {
  clearCourseSelection();
  assert.equal(preferredCourse(courses, context('/unknown')).id, '111');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
