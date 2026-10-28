// scripts/test-course-cards.mjs
// 班级上传课件（logs/learn type=2）与课堂课件（type=14）映射单测。
import assert from 'node:assert/strict';
import {
  pickClassCards, buildClassCardPresentation, normalizeCourse, normalizeClassroom,
} from '../src/quiz/course-cards.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}

const acts = [
  { type: 2, id: 33714282, courseware_id: '3293023', title: '第1章 Java概述', count: 45, create_time: 1788311738000 },
  { type: 14, id: 1, courseware_id: '999', title: '课堂记录' },
  { type: 2, id: 33714282, courseware_id: '3293023', title: '重复', count: 45, create_time: 1788311738000 },
  { type: 2, id: 35232360, courseware_id: '3382533', title: '第2章 Java基础知识', count: 103, create_time: 1793146831000 },
  { type: 2, id: 3, courseware_id: '', title: '缺 cardsId' },
];

console.log('== 班级课件识别 ==');
ok('只收 type=2，按 activityId + cardsId 去重', () => {
  const rows = pickClassCards(acts);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => [x.activityId, x.cardsId]), [
    ['35232360', '3382533'],
    ['33714282', '3293023'],
  ]);
});
ok('忽略 type=14 课堂课件', () => {
  assert.equal(pickClassCards(acts).some((x) => x.cardsId === '999'), false);
});
ok('空 cardsId 不产生条目', () => {
  assert.equal(pickClassCards(acts).some((x) => x.title === '缺 cardsId'), false);
});

console.log('== cards/detlist → presentation ==');
const detail = {
  Title: '第1章 Java概述.pptx',
  last_cover_width: 1280,
  Slides: [
    { PageIndex: 1, SlideID: 1001, Cover: 'https://cdn/slide-1.jpg' },
    { PageIndex: 2, SlideID: 1002, Cover: '', Background: { Data: 'https://cdn/slide-2.jpg' } },
    { PageIndex: 3, SlideID: 1003, Cover: '' },
  ],
};
ok('标题/来源/页数正确', () => {
  const p = buildClassCardPresentation({ cid: '25398489', cardsId: '3293023', activityId: '33714282', detail });
  assert.equal(p.id, 'classcards:3293023');
  assert.equal(p.source, 'class-card');
  assert.equal(p.title, '第1章 Java概述.pptx');
  assert.equal(p.slides.length, 2);
  assert.equal(p.slides[0].id, 'classcards:3293023:1001');
  assert.equal(p.slides[0].index, 1);
  assert.equal(p.slides[1].image, 'https://cdn/slide-2.jpg');
});
ok('无可用封面 → null，不产生空课件', () => {
  const p = buildClassCardPresentation({ cardsId: '1', detail: { Slides: [{ PageIndex: 1 }] } });
  assert.equal(p, null);
});

console.log('== 课程列表 skuId ==');
ok('free_sku_id 优先，保留 classroomId/name', () => {
  const c = normalizeCourse({ classroom_id: 25398489, course_name: 'Java程序设计', free_sku_id: 12532145, course_id: 3115397 });
  assert.deepEqual(c, {
    id: '25398489', name: 'Java程序设计', role: undefined, skuId: '12532145', courseId: '3115397', universityId: '', teacher: '',
  });
});

console.log('== 班级信息 skuId ==');
ok('classroom 接口带 free_sku_id', () => {
  const c = normalizeClassroom({
    id: 26739809, name: '物理实验绪论2026秋-1', course_id: '3697615', free_sku_id: 13224417, teacher_name: '编号47', uv_id: 3195,
  });
  assert.deepEqual(c, {
    id: '26739809', name: '物理实验绪论2026秋-1', skuId: '13224417', courseId: '3697615', teacher: '编号47', universityId: '3195',
  });
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
