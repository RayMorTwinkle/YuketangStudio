// scripts/test-slide-source.mjs
// AI/PPT 附图来源的选择与回退单测。
import assert from 'node:assert/strict';
import { repo } from '../src/state/repo.js';
import { normalizeSlideSource, resolveSlideForSource } from '../src/ui/slide-source.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}

repo.slides.clear();
repo.slides.set('t1', { id: 't1', index: 1 });
repo.slides.set('s2', { id: 's2', index: 2 });
repo.teacherSlideId = 't1';
repo.selectedSlideId = 's2';

ok('默认来源是老师当前页', () => assert.equal(normalizeSlideSource('unknown'), 'teacher'));
ok('老师来源命中 teacherSlideId', () => {
  const r = resolveSlideForSource('teacher');
  assert.equal(r.slide?.id, 't1');
  assert.equal(r.fallback, false);
});
ok('课件来源命中 selectedSlideId', () => {
  const r = resolveSlideForSource('selected');
  assert.equal(r.slide?.id, 's2');
});
ok('选中页缺失时回退老师页并标记 fallback', () => {
  repo.selectedSlideId = 'missing';
  const r = resolveSlideForSource('selected');
  assert.equal(r.slide?.id, 't1');
  assert.equal(r.fallback, true);
});
ok('两侧都缺失返回 null', () => {
  repo.teacherSlideId = '';
  repo.selectedSlideId = '';
  repo.slides.clear();
  assert.equal(resolveSlideForSource('selected').slide, null);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
