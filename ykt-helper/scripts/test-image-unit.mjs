// 图片体积控制纯函数单测（不依赖 DOM）。
import assert from 'node:assert/strict';
import { imageDataUrlBytes, shouldCompressImage, prepareMessagesForRequest } from '../src/core/image.js';

let pass = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✅', name); }
  catch (e) { console.error('  ❌', name, e?.message || e); process.exitCode = 1; }
};

const image = (bytes) => {
  // 生成足够长的合法 base64；只用于长度估算，不需要真正可解码。
  const b64 = Buffer.alloc(bytes, 0x41).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
};

await ok('data URL 按 base64 的 3/4 估算字节', () => {
  const bytes = 512 * 1024 - ((512 * 1024) % 3);
  assert.equal(imageDataUrlBytes(image(bytes)), bytes);
});

await ok('500KB 以下不触发压缩', () => {
  assert.equal(shouldCompressImage(image(400 * 1024), 500 * 1024), false);
});

await ok('500KB 以上触发压缩', () => {
  assert.equal(shouldCompressImage(image(600 * 1024), 500 * 1024), true);
});

await ok('非 data URL 不误判', () => {
  assert.equal(imageDataUrlBytes('https://example.com/a.png'), 0);
});

await ok('prepareMessagesForRequest 不修改调用方对象', async () => {
  const src = image(1024);
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: src } }] }];
  const out = await prepareMessagesForRequest(messages);
  assert.notEqual(out, messages);
  assert.equal(messages[0].content[0].image_url.url, src);
  assert.equal(out[0].content[0].image_url.url, src);
});

console.log(`结果：${pass} 通过，0 失败`);
