/* eslint-disable no-undef */
// scripts/e2e-image-compress.mjs
// 浏览器端验证：大图 data URL → 500KB 以内 → messages 请求体 < 2MB。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const DIST = '/Users/Ray/Desktop/AI工作台/YuketangStudio-main/ykt-helper/dist/YuketangStudio-latest.user.js';
const SRC = await readFile(DIST, 'utf8');
const task = await taskSpace('yks-imgcors');
const page = task.page('p1');
await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.evaluate(() => {
  localStorage.setItem('ykt:test-mode', '1');
  localStorage.setItem('ykt-helper:onboarding.version', '1');
  sessionStorage.setItem('__ykt_helper_auto_reload_once__', '1');
  ['ykt-helper-toolbar', 'ykt-shell-panel', 'ykt-onboarding'].forEach((id) => document.getElementById(id)?.remove());
});
await page.evaluate((src) => {
  const el = document.createElement('script');
  el.textContent = src;
  document.documentElement.appendChild(el);
}, SRC);
await page.waitForTimeout(1800);
assert.equal(await page.evaluate(() => !!window.__yktTest), true, '测试钩子未安装');

const result = await page.evaluate(async () => {
  const w = 1200;
  const h = 1600;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 13) & 255;
    img.data[i + 1] = (i * 29) & 255;
    img.data[i + 2] = (i * 47) & 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const original = canvas.toDataURL('image/jpeg', 1);
  const beforeBytes = window.__yktTest.imageBytes(original);
  const compressed = await window.__yktTest.compressImage(original, { maxBytes: 500 * 1024 });
  const afterBytes = window.__yktTest.imageBytes(compressed);
  const messages = [{ role: 'user', content: [
    { type: 'text', text: '请解答这张题图' },
    { type: 'image_url', image_url: { url: compressed } },
  ] }];
  const prepared = await window.__yktTest.prepareImages(messages, { maxBytes: 500 * 1024 });
  const body = JSON.stringify({ model: 'test', messages: prepared });
  return {
    beforeBytes,
    afterBytes,
    prefix: compressed.slice(0, 30),
    bodyBytes: body.length,
    sameObject: prepared === messages,
  };
});

console.log(JSON.stringify(result, null, 2));
assert.ok(result.beforeBytes > 500 * 1024, '测试原图没有超过 500KB');
assert.ok(result.afterBytes > 0 && result.afterBytes <= 500 * 1024, '压缩结果超过 500KB');
assert.ok(result.prefix.startsWith('data:image/jpeg'), '压缩结果不是 JPEG data URL');
assert.ok(result.bodyBytes < 2 * 1024 * 1024, '请求体超过 2MB');
assert.equal(result.sameObject, false, 'prepareImages 不应修改调用方对象');
console.log('结果：图片压缩通过');
