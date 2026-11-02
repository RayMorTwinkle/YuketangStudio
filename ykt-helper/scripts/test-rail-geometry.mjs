// scripts/test-rail-geometry.mjs
// 课件右侧导航轨的 thumb 几何/拖动换算单测。
import assert from 'node:assert/strict';
import {
  clamp,
  computeRailThumb,
  scrollTopForRailPoint,
  scrollTopForDrag,
} from '../src/ui/rail-geometry.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}

ok('clamp 边界', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(11, 0, 10), 10);
});

ok('内容不足一屏时隐藏 thumb', () => {
  const g = computeRailThumb({ trackHeight: 500, viewportHeight: 500, contentHeight: 500, scrollTop: 0 });
  assert.equal(g.visible, false);
  assert.equal(g.height, 0);
});

ok('一屏半内容：thumb 高度按比例，顶部从 inset 开始', () => {
  const g = computeRailThumb({ trackHeight: 500, viewportHeight: 500, contentHeight: 1000, scrollTop: 0 });
  assert.equal(g.visible, true);
  assert.equal(g.usable, 484);
  assert.equal(g.height, 242);
  assert.equal(g.top, 8);
  assert.equal(g.ratio, 0);
});

ok('滚到底部：thumb 落在轨道底部', () => {
  const g = computeRailThumb({ trackHeight: 500, viewportHeight: 500, contentHeight: 1000, scrollTop: 500 });
  assert.equal(g.ratio, 1);
  assert.equal(g.top, 250);
  assert.equal(g.top + g.height, 492);
});

ok('超长内容：thumb 保持最小高度 24', () => {
  const g = computeRailThumb({ trackHeight: 500, viewportHeight: 500, contentHeight: 10000, scrollTop: 0 });
  assert.equal(g.height, 24);
  assert.equal(g.maxTop, 460);
});

ok('点击轨道顶部/底部映射到 0/max', () => {
  assert.equal(scrollTopForRailPoint({ clientY: 108, railTop: 100, trackHeight: 500, maxScroll: 900 }), 0);
  assert.equal(scrollTopForRailPoint({ clientY: 592, railTop: 100, trackHeight: 500, maxScroll: 900 }), 900);
  assert.equal(scrollTopForRailPoint({ clientY: 350, railTop: 100, trackHeight: 500, maxScroll: 900 }), 450);
});

ok('拖动换算并按范围截断', () => {
  assert.equal(scrollTopForDrag({ startScroll: 200, deltaY: 0, maxTop: 460, maxScroll: 500 }), 200);
  assert.equal(scrollTopForDrag({ startScroll: 200, deltaY: 230, maxTop: 460, maxScroll: 500 }), 450);
  assert.equal(scrollTopForDrag({ startScroll: 200, deltaY: 999, maxTop: 460, maxScroll: 500 }), 500);
  assert.equal(scrollTopForDrag({ startScroll: 200, deltaY: -999, maxTop: 460, maxScroll: 500 }), 0);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
