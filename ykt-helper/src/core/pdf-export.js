// src/core/pdf-export.js
// 公共 PDF 导出：页面尺寸跟随图片实际宽高比（零白边），GM_xhr 下载图片绕 CORS
import { ensureJsPDF, fetchAsDataURL } from './env.js';

/**
 * 从图片列表构建并下载 PDF（横屏 PPT 出横屏页，页面比例=图片比例）
 * @param {string[]} urls   图片 URL（支持带签名的 CDN 链接 / dataURL）
 * @param {string} title    文件名（自动清理非法字符）
 * @param {Object} [opts]   { onProgress(pct, text), filter: (url, i) => boolean }
 * @returns {Promise<number>} 成功写入的页数
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

  for (let i = 0; i < total; i++) {
    onProgress(Math.round(((i + 1) / total) * 100), `${i + 1}/${total}`);
    let img;
    try {
      img = await loadImageViaGM(urls[i]);
    } catch (e) {
      console.warn('[PDF] 第', i + 1, '页图片加载失败，跳过:', e?.message);
      continue;
    }
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const fmt = [iw, ih];
    const orient = iw >= ih ? 'landscape' : 'portrait';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: fmt, orientation: orient });
    else doc.addPage(fmt, orient);
    doc.addImage(img, 'PNG', 0, 0, iw, ih);
    pages++;
  }

  onProgress(100, '保存中...');
  const safe = String(title || '课件').replace(/[\\/:*?"<>|]/g, '_');
  doc.save(`${safe}.pdf`);
  return pages;
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
