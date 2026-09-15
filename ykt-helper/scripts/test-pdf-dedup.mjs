// scripts/test-pdf-dedup.mjs
// node 端验证 pdf-export 的内容级去重与统计口径：
//   1) 相同内容 → 判为重复（skipped）
//   2) 不同内容 → 保留（pages）
//   3) 图片加载失败 → 计入 failed，不污染 skipped
// 用 stub 替掉浏览器 API（canvas / Image / jsPDF / GM_xhr）

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } };

// ---------- 浏览器 API stub ----------
const W = 256, H = 144;

// canvas stub：drawImage 时把图片 seed 铺成像素，getImageData 返回它
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    const canvas = {
      width: 0, height: 0,
      getContext() {
        return {
          drawImage(img) {
            const g = new Uint8ClampedArray(W * H * 4);
            // seed 决定整体灰度；同 seed = 完全相同的图像
            for (let p = 0; p < W * H; p++) {
              const v = img?.__seed ?? 128;
              g[p * 4] = v; g[p * 4 + 1] = v; g[p * 4 + 2] = v; g[p * 4 + 3] = 255;
            }
            canvas.__pixels = g;
          },
          getImageData() { return { data: canvas.__pixels }; },
        };
      },
    };
    return canvas;
  },
};

globalThis.Image = class {
  constructor() { this.naturalWidth = 960; this.naturalHeight = 540; }
  set src(v) {
    // 模拟异步加载：src 里带 FAIL 的图片加载失败
    setTimeout(() => {
      if (String(v).includes('FAIL')) this.onerror?.(new Error('mock load error'));
      else { this.__seed = Number(String(v).match(/seed(\d+)/)?.[1] || 128); this.onload?.(); }
    }, 0);
  }
};

globalThis.window = globalThis;
globalThis.window.jspdf = {
  jsPDF: class {
    constructor() { this.pages = 0; }
    addPage() { this.pages++; }
    addImage() {}
    save(name) { this.savedAs = name; }
  },
};

// GM_xhr stub：把 URL 直接当作 dataURL 返回
globalThis.GM_xmlhttpRequest = undefined;
globalThis.FileReader = class {
  readAsDataURL(blob) { setTimeout(() => { this.result = blob; this.onload?.(); }, 0); }
};

// ---------- 被测模块 ----------
// pdf-export.js 依赖 env.js 的 ensureJsPDF / fetchAsDataURL（走 GM_xhr）
// 这里直接动态 import，并预先把 jspdf 挂到 window 上（ensureJsPDF 会短路返回）
const { exportImagesToPdf } = await import('../src/core/pdf-export.js');

// fetchAsDataURL 走 gm.xhr（GM_xmlhttpRequest 不可用会抛错），
// 所以测试里 URL 用 data: 开头，跳过 GM 下载路径 → 直接给 Image
const u = (seed) => `data:image/png;base64,seed${seed}`;

console.log('== 去重与统计口径 ==');
{
  const urls = [u(100), u(100), u(200), u(100), u(200)];
  //                    重复        不同       重复      重复
  const r = await exportImagesToPdf(urls, 'test-dedup', { dedupHash: true });
  // 第1张收录(100)，第2张与100重复跳过，第3张收录(200)，第4张与100重复，第5张与200重复
  ok(r.pages === 2, `pages=2（实际 ${r.pages}）`);
  ok(r.skipped === 3, `skipped=3（实际 ${r.skipped}）`);
  ok(r.failed === 0, `failed=0（实际 ${r.failed}）`);
}

console.log('== 加载失败计入 failed 而非 skipped ==');
{
  const urls = [u(100), 'data:image/png;base64,FAIL', u(100)];
  const r = await exportImagesToPdf(urls, 'test-fail', { dedupHash: true });
  ok(r.pages === 1, `pages=1（实际 ${r.pages}）`);
  ok(r.failed === 1, `failed=1（实际 ${r.failed}）`);
  ok(r.skipped === 1, `skipped=1（仅内容重复，实际 ${r.skipped}）`);
}

console.log('== 全不同内容时不误判 ==');
{
  const urls = [u(10), u(60), u(120), u(200)];
  const r = await exportImagesToPdf(urls, 'test-distinct', { dedupHash: true });
  ok(r.pages === 4, `pages=4（实际 ${r.pages}）`);
  ok(r.skipped === 0, `skipped=0（实际 ${r.skipped}）`);
}

console.log('== 关闭去重时全部保留 ==');
{
  const urls = [u(100), u(100), u(100)];
  const r = await exportImagesToPdf(urls, 'test-nodedup', { dedupHash: false });
  ok(r.pages === 3, `pages=3（实际 ${r.pages}）`);
  ok(r.skipped === 0, `skipped=0（实际 ${r.skipped}）`);
}

console.log('== 进度回调字段完整 ==');
{
  const seen = [];
  await exportImagesToPdf([u(1), u(2)], 'test-progress', {
    dedupHash: true,
    onProgress: (i) => seen.push(i),
  });
  const last = seen.at(-1);
  ok(seen.length > 0, 'onProgress 被调用');
  ok(typeof last.pct === 'number' && typeof last.pages !== 'object', 'pct 是数字');
  ok('skipped' in last && 'failed' in last, 'progress 带 skipped/failed 字段');
  ok(last.pct === 100, `最终 pct=100（实际 ${last.pct}）`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
