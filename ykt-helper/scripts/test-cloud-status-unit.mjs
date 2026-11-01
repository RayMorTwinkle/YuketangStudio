// 云端状态摘要纯函数单测。
import assert from 'node:assert/strict';
import { cloudStatusSummary, getCloudProfile } from '../src/core/cloud-status.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { console.error('  ❌', name, e?.message || e); process.exitCode = 1; }
};

const status = (over = {}) => ({ ok: true, status: 'ok', textOk: true, visionOk: true, ...over });

ok('文本与视觉正常', () => {
  const s = cloudStatusSummary(status());
  assert.equal(s.kind, 'ok');
});

ok('文本正常、视觉异常：默认不阻塞文本', () => {
  const s = cloudStatusSummary(status({ status: 'degraded', visionOk: false }), { needVision: true });
  assert.equal(s.kind, 'warn');
});

ok('设置页显示部分可用', () => {
  const s = cloudStatusSummary(status({ status: 'degraded', visionOk: false }), { includeDegraded: true });
  assert.equal(s.kind, 'warn');
  assert.match(s.title, /部分可用/);
});

ok('全部故障', () => {
  const s = cloudStatusSummary(status({ status: 'down', textOk: false, visionOk: false }));
  assert.equal(s.kind, 'error');
});

ok('不是云端 profile 时返回 null', () => {
  assert.equal(getCloudProfile({ ai: { activeProfileId: 'x', profiles: [{ id: 'x', baseUrl: 'https://api.example.com', apiKey: 'k' }] } }), null);
});

ok('云端 profile 能取出解锁码', () => {
  const p = getCloudProfile({ ai: { activeProfileId: 'x', profiles: [{ id: 'x', baseUrl: 'https://api.raymor.top/yuketangstudio', apiKey: 'code' }] } });
  assert.equal(p.apiKey, 'code');
});

console.log(`结果：${pass} 通过，0 失败`);
