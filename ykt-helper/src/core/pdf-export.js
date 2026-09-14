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
  const greys = [];             // 已收录页的 256x144 灰度缩略（Uint8Array）
  const CONCURRENCY = 5;

  // 阶段1：并发预下载全部图片（带进度），避免逐张串行等待
  onProgress({ cur: 0, total, pct: 0, skipped: 0, text: '并发下载图片中…' });
  const imgs = new Array(total).fill(null);
  let doneCount = 0;
  let nextIdx = 0;
  async function worker() {
    for (;;) {
      const i = nextIdx++;
      if (i >= total) return;
      try {
        imgs[i] = await loadImageViaGM(urls[i]);
      } catch (e) {
        console.warn('[PDF] 第', i + 1, '页图片加载失败，跳过:', e?.message);
        imgs[i] = null;
      }
      doneCount++;
      onProgress({ cur: doneCount, total, pct: Math.round((doneCount / total) * 60), skipped, text: `已下载 ${doneCount}/${total} 张` });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  // 阶段2：顺序去重 + 生成 PDF
  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    const img = imgs[i];
    if (!img) { skipped++; continue; }

    // 内容级去重：256x144 灰度缩略 + 平均绝对差（MAE）
    // 阈值实测校准（真实 slide 样本）：同页 JPEG 重压缩变体 MAE 0.35~0.73（q=0.5 仍 <0.8），
    // 不同页两两 MAE 7.5~12.5 → 取 3：同页 4 倍余量，异页 2.5 倍余量，实测倍数 10.3x
    if (opts.dedupHash) {
      let dup = false;
      try {
        const g = toGrey256(img);
        for (const prev of greys) {
          if (mae(prev, g) <= 3) { dup = true; break; }
        }
        if (!dup) greys.push(g);
      } catch { /* 去重失败不阻断 */ }
      if (dup) {
        skipped++;
        onProgress({ cur: i + 1, total, pct: 60 + Math.round(((i + 1) / total) * 38), skipped, text: `第${i + 1}/${total}页重复，已跳过` });
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
    onProgress({ cur: i + 1, total, pct: 60 + Math.round(((i + 1) / total) * 38), skipped, text: `${pages} 页已收录` });
  }

  onProgress({ cur: total, total, pct: 100, skipped, text: '保存中...' });
  const safe = String(title || '课件').replace(/[\\/:*?"<>|]/g, '_');
  doc.save(`${safe}.pdf`);
  return { pages, skipped };
}

/** 256×144 灰度缩略（Uint8Array，36KB/张，用于内容级去重） */
function toGrey256(img) {
  const W = 256, H = 144;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    g[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  return g;
}

/** 平均绝对差（0~255 尺度） */
function mae(a, b) {
  let s = 0;
  for (let p = 0; p < a.length; p++) s += Math.abs(a[p] - b[p]);
  return s / a.length;
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
