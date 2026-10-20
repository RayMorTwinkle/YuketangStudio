// src/quiz/quiz-paper.js
// 老版作业/试卷页（/v/quiz/quiz_info/<id>/）：
//   quizData = base64 JSON，Slides[].Shapes[] 是带坐标的 PNG，Problem 是题目元数据
// 这里负责解析、拼题图、导出 JPG/ZIP/PDF/长图。
import { log } from '../core/log.js';
import { ensureJsPDF } from '../core/env.js';

export function isQuizPage() {
  return /^\/v\/quiz\/quiz_info\/\d+/.test(location.pathname);
}

function decodeB64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function readQuizData() {
  try {
    if (window.quizData && typeof window.quizData === 'object') return window.quizData;
    for (const s of document.scripts) {
      const m = (s.textContent || '').match(/var\s+quizData\s*=\s*"([^"]+)"/);
      if (m) return JSON.parse(decodeB64Utf8(m[1]));
    }
  } catch (e) {
    log.warn('[quiz] parse quizData failed', e);
  }
  return null;
}

export function quizMeta(data) {
  const slides = (data?.Slides || []).filter((s) => s?.Problem);
  return {
    title: data?.Title || '作业',
    count: slides.length,
    width: data?.Width || 450,
    height: data?.Height || 720,
    showAnswer: !!data?.showAnswer,
  };
}

const imgCache = new Map();

function loadImage(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';   // CDN 返回 access-control-allow-origin: *
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败: ' + url));
    img.src = url;
  });
  imgCache.set(url, p);
  return p;
}

export async function composeSlide(slide, data, scale = 2) {
  const w = data?.Width || 450;
  const h = data?.Height || 720;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  const shapes = [...(slide?.Shapes || [])].sort(
    (a, b) => (a.ZOrderPosition || 0) - (b.ZOrderPosition || 0),
  );
  for (const sh of shapes) {
    if (!sh?.URL) continue;
    try {
      const img = await loadImage(sh.URL);
      ctx.drawImage(img, sh.Left || 0, sh.Top || 0, sh.Width || 0, sh.Height || 0);
    } catch (e) {
      log.warn('[quiz] shape load failed', sh.URL, e);
    }
  }
  return canvas;
}

export async function composeQuestion(data, index, scale = 2) {
  const slide = data?.Slides?.[index];
  if (!slide) throw new Error('题目不存在');
  return composeSlide(slide, data, scale);
}

export function canvasBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出图片失败'))), type, quality);
  });
}

/** 保存文件：Android 走 YktBridge 分块写入「下载/YuketangStudio」，桌面走 a[download] */
export async function saveBlob(blob, filename) {
  const bridge = window.YktBridge;
  if (bridge?.downloadStart && bridge?.downloadChunk && bridge?.downloadEnd) {
    const job = 'quiz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    bridge.downloadStart(job, filename);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 256 * 1024;
    for (let i = 0; i < buf.length; i += CHUNK) {
      const sub = buf.subarray(i, i + CHUNK);
      let bin = '';
      for (let j = 0; j < sub.length; j += 0x8000) {
        bin += String.fromCharCode.apply(null, sub.subarray(j, j + 0x8000));
      }
      bridge.downloadChunk(job, btoa(bin));
    }
    bridge.downloadEnd(job);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 极简 ZIP（store，不压缩）——JPEG 已压缩，省掉压缩实现 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

function safeTitle(data) {
  return String(data?.Title || '作业').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

export async function downloadQuestion(data, index) {
  const canvas = await composeQuestion(data, index, 2);
  const blob = await canvasBlob(canvas);
  await saveBlob(blob, `作业_${safeTitle(data)}_第${index + 1}题.jpg`);
}

export async function downloadAllZip(data) {
  const files = [];
  for (let i = 0; i < (data?.Slides || []).length; i++) {
    if (!data.Slides[i]?.Problem) continue;
    const canvas = await composeQuestion(data, i, 2);
    const blob = await canvasBlob(canvas);
    files.push({ name: `第${i + 1}题.jpg`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  await saveBlob(zipStore(files), `作业_${safeTitle(data)}_题目图片.zip`);
}

export async function downloadPdf(data) {
  const { jsPDF } = await ensureJsPDF();
  const w = data?.Width || 450;
  const h = data?.Height || 720;
  const doc = new jsPDF({ unit: 'pt', format: [w, h], orientation: 'portrait' });
  let first = true;
  for (let i = 0; i < (data?.Slides || []).length; i++) {
    if (!data.Slides[i]?.Problem) continue;
    const canvas = await composeQuestion(data, i, 2);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    if (!first) doc.addPage([w, h], 'portrait');
    first = false;
    doc.addImage(dataUrl, 'JPEG', 0, 0, w, h);
  }
  await saveBlob(doc.output('blob'), `作业_${safeTitle(data)}.pdf`);
}

export async function downloadLongImage(data) {
  const scale = 2;
  const gap = 24;
  const slides = (data?.Slides || []).filter((s) => s?.Problem);
  const canvases = [];
  let totalH = 0;
  for (const s of slides) {
    const c = await composeSlide(s, data, scale);
    canvases.push(c);
    totalH += c.height + gap;
  }
  if (!canvases.length) throw new Error('没有可导出的题目');
  const out = document.createElement('canvas');
  out.width = canvases[0].width;
  out.height = totalH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of canvases) {
    ctx.drawImage(c, 0, y);
    y += c.height + gap;
  }
  await saveBlob(await canvasBlob(out, 'image/jpeg', 0.9), `作业_${safeTitle(data)}_长图.jpg`);
}

export async function quizQuestionDataUrl(data, index, scale = 2) {
  const canvas = await composeQuestion(data, index, scale);
  return canvas.toDataURL('image/jpeg', 0.9);
}


/**
 * 作业单题暂存（不会交卷）。
 * POST /v/quiz/cache_each_result/{quizId}/ { results:[{problemID,result,time}] }
 */
export async function cacheQuizAnswer({ quizId, problemId, result }) {
  const token = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
  const res = Array.isArray(result) ? result.join('') : String(result ?? '');
  const payload = {
    results: [{ problemID: problemId, result: res, time: Math.ceil(Date.now() / 1000) }],
  };
  const r = await fetch(`${location.origin}/v/quiz/cache_each_result/${quizId}/`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-CSRFToken': decodeURIComponent(token) } : {}),
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(j.msg || `HTTP ${r.status}`);
  return j;
}
