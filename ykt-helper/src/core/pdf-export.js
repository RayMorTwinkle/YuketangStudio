// src/core/pdf-export.js
// 公共 PDF 导出：页面尺寸跟随图片实际宽高比（零白边），GM_xhr 下载图片绕 CORS
import { ensureJsPDF, fetchAsDataURL } from './env.js';

/**
 * 从图片列表构建并下载 PDF（横屏 PPT 出横屏页，页面比例=图片比例）
 * @param {string[]} urls   图片 URL（支持带签名的 CDN 链接 / dataURL）
 * @param {string} title    文件名（自动清理非法字符）
 * @param {Object} [opts]   { onProgress(info), dedupHash: boolean, signal: {aborted} }
 *                          onProgress 收到 { cur, total, pct, skipped, text }
 * @returns {Promise<{pages:number, skipped:number}>}
 */
export async function exportImagesToPdf(urls, title, opts = {}) {
  if (!urls || !urls.length) throw new Error('没有可导出的页面');
  await ensureJsPDF();
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) throw new Error('jsPDF 未加载成功');

  const onProgress = opts.onProgress || (() => {});
  const total = urls.length;
  let doc = null;
  let pages = 0;
  let skipped = 0;
  const seenHashes = [];   // 已收录页的感知哈希
  const seenHashKey = new Set(); // 完全相同的哈希快速判重

  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    let img;
    try {
      img = await loadImageViaGM(urls[i]);
    } catch (e) {
      console.warn('[PDF] 第', i + 1, '页图片加载失败，跳过:', e?.message);
      skipped++;
      onProgress({ cur: i + 1, total, pct: Math.round(((i + 1) / total) * 100), skipped, text: `第${i + 1}/${total}页加载失败` });
      continue;
    }

    // 内容级去重：感知哈希（dHash 8x8 差分，汉明距离阈值 5）
    if (opts.dedupHash) {
      let dup = false;
      try {
        const h = dHash(img);
        if (seenHashKey.has(h)) dup = true;
        else if (seenHashes.some(x => hamming(x, h) <= 5)) dup = true;
        if (!dup) { seenHashes.push(h); seenHashKey.add(h); }
      } catch { /* 哈希失败不阻断 */ }
      if (dup) {
        skipped++;
        onProgress({ cur: i + 1, total, pct: Math.round(((i + 1) / total) * 100), skipped, text: `第${i + 1}/${total}页重复，已跳过` });
        continue;
      }
    }

    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const fmt = [iw, ih];
    const orient = iw >= ih ? 'landscape' : 'portrait';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: fmt, orientation: orient });
    else doc.addPage(fmt, orient);
    doc.addImage(img, 'PNG', 0, 0, iw, ih);
    pages++;
    onProgress({ cur: i + 1, total, pct: Math.round(((i + 1) / total) * 100), skipped, text: `${pages} 页已收录` });
  }

  onProgress({ cur: total, total, pct: 100, skipped, text: '保存中...' });
  const safe = String(title || '课件').replace(/[\\/:*?"<>|]/g, '_');
  doc.save(`${safe}.pdf`);
  return { pages, skipped };
}

/** 8x8 差分哈希（dHash）：缩到 9x8 灰度，横向比较亮度 */
function dHash(img) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const lum = [];
  for (let p = 0; p < 72; p++) {
    const i = p * 4;
    lum.push(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
  }
  let bits = '';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits += lum[y * 9 + x] > lum[y * 9 + x + 1] ? '1' : '0';
  return bits;
}

function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** GM_xhr 转 dataURL 后加载 Image（绕开 OSS CORS 限制） */
async function loadImageViaGM(src) {
  let url = src;
  if (!src.startsWith('data:')) {
    try { url = await fetchAsDataURL(src); }
    catch (e) { console.warn('[PDF] dataURL 转换失败，直载:', e?.message); }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image 加载失败'));
    img.src = url;
  });
}
