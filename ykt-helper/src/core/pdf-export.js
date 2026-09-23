// src/core/pdf-export.js
// 公共 PDF 导出：页面尺寸跟随图片实际宽高比（零白边），GM_xhr 下载图片绕 CORS
import { ensureJsPDF, fetchAsDataURL } from './env.js';
import { log } from './log.js';

/** 让出事件循环：phase-2 的同步编码循环必须定期 yield，否则主线程阻塞 → 进度不 paint、关闭/取消按钮失灵。
 *  用 MessageChannel 而非 setTimeout(0)：后台标签页里定时器被节流到 1s+（实测 yield 一次 ~4s，
 *  158 页拖到 10min+），MessageChannel 走任务队列不受定时器节流影响。
 *  且距上次 yield <32ms 时直接跳过——前台页全速跑，不为一页一次的调度开销买单。 */
const _yieldCh = new MessageChannel();
let _yieldResolve = null;
_yieldCh.port1.onmessage = () => { const r = _yieldResolve; _yieldResolve = null; r?.(); };
let _lastYield = 0;
const yieldFrame = () => {
  const now = performance.now();
  if (now - _lastYield < 32) return Promise.resolve();
  _lastYield = now;
  return new Promise(r => { _yieldResolve = r; _yieldCh.port2.postMessage(0); });
};

/**
 * 从图片列表构建并下载 PDF（横屏 PPT 出横屏页，页面比例=图片比例）
 * @param {string[]} urls   图片 URL（支持带签名的 CDN 链接 / dataURL）
 * @param {string} title    文件名（自动清理非法字符）
 * @param {Object} [opts]   { onProgress(info), dedupHash: boolean, signal: {aborted},
 *                          imageTimeoutMs: 单图下载+解码超时（默认 30s，超时计 failed 跳过） }
 *                          onProgress 收到 { cur, total, pct, skipped, failed, pages, text }
 * @returns {Promise<{pages:number, skipped:number, failed:number}>}
 *          pages   = 实际写入 PDF 的页数
 *          skipped = 内容级重复被跳过的页数
 *          failed  = 图片下载/加载失败被跳过的页数
 *          （两者分开统计——此前混在一起导致"去重 n 页"数字不可信）
 */
export async function exportImagesToPdf(urls, title, opts = {}) {
  if (!urls || !urls.length) throw new Error('没有可导出的页面');
  const jsPDF = (await ensureJsPDF())?.jsPDF;
  if (!jsPDF) throw new Error('jsPDF 未加载成功');

  const onProgress = opts.onProgress || (() => {});
  const total = urls.length;
  const imageTimeoutMs = opts.imageTimeoutMs || 30000;
  const checkAbort = () => { if (opts.signal?.aborted) throw new Error('已取消'); };
  let doc = null;
  let pages = 0;
  let skipped = 0;
  let failed = 0;
  const sigSet = new Set();     // 已收录页的内容签名（精确匹配判重）
  const _prof = { page: 0, grey: 0, jspdf: 0, progress: 0, yield: 0 };  // 分段耗时（临时诊断）
  const CONCURRENCY = 5;

  // 阶段1：并发预下载全部图片（带进度），避免逐张串行等待
  onProgress({ cur: 0, total, pct: 0, skipped: 0, failed: 0, pages: 0, text: '并发下载图片中…' });
  const items = new Array(total).fill(null);  // { img, dataUrl }
  let doneCount = 0;
  let nextIdx = 0;
  async function worker() {
    for (;;) {
      checkAbort();
      const i = nextIdx++;
      if (i >= total) return;
      try {
        items[i] = await loadImageViaGM(urls[i], imageTimeoutMs);
      } catch (e) {
        log.warn('[PDF] 第', i + 1, '页图片加载失败，跳过:', e?.message);
        items[i] = null;
      }
      doneCount++;
      onProgress({ cur: doneCount, total, pct: Math.round((doneCount / total) * 60), skipped, failed, pages, text: `已下载 ${doneCount}/${total} 张` });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  checkAbort();

  // 阶段2：顺序去重 + 生成 PDF（每页 yield 一帧 + try/catch，单页失败不拖垮全册、UI 不冻结）
  for (let i = 0; i < total; i++) {
    checkAbort();
    const it = items[i];
    items[i] = null;   // 尽早释放位图内存（145+ 页时 decoded bitmap 累计可达 GB 级）
    if (!it) {
      failed++;   // 下载/解码失败，与"内容重复"区分开
      onProgress({ cur: i + 1, total, pct: 60 + Math.round(((i + 1) / total) * 38), skipped, failed, pages, text: `第${i + 1}/${total}页下载失败，已跳过` });
      await yieldFrame();
      continue;
    }
    const { img, dataUrl } = it;
    const _t0 = performance.now();
    try {
      // 内容级去重：8x8 块均值签名精确匹配（Set O(1)）。
      // 沙箱里 TypedArray 逐元素读 ~1µs，任何 O(n) 逐页对比都是 O(n²) 灾难（158 页实测 ~10min）；
      // 精确签名判重覆盖真实重复场景（同图重推/模板重复页），漏判仅多收几页、绝不丢内容
      if (opts.dedupHash) {
        let dup = false;
        const _tg = performance.now();
        try {
          const sig = toSig(img);
          if (sigSet.has(sig)) dup = true;
          else sigSet.add(sig);
        } catch { /* 去重失败不阻断 */ }
        _prof.grey += performance.now() - _tg;
        if (dup) {
          skipped++;
          onProgress({ cur: i + 1, total, pct: 60 + Math.round(((i + 1) / total) * 38), skipped, failed, pages, text: `第${i + 1}/${total}页重复，已跳过` });
          const _ty = performance.now(); await yieldFrame(); _prof.yield += performance.now() - _ty;
          continue;
        }
      }

      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (!iw || !ih) {
        failed++;
        log.warn('[PDF] 第', i + 1, '页图片尺寸为 0，跳过');
        const _ty = performance.now(); await yieldFrame(); _prof.yield += performance.now() - _ty;
        continue;
      }
      const fmt = [iw, ih];
      const orient = iw >= ih ? 'landscape' : 'portrait';
      const _td = performance.now();
      if (!doc) doc = new jsPDF({ unit: 'pt', format: fmt, orientation: orient });
      else doc.addPage(fmt, orient);
      // 优先内嵌原始字节（JPEG dataURL 零重编码，体积小一个量级）；
      // webp 等无法内嵌的格式：先转 JPEG 再嵌——addImage(img,'PNG') 是全尺寸 PNG 重编码，
      // 实测每张 ~4s（158 页≈10min），转 JPEG 后编码快数倍且 PDF 体积小一个量级
      const imgFmt = formatOfDataUrl(dataUrl);
      if (imgFmt) doc.addImage(dataUrl, imgFmt, 0, 0, iw, ih);
      else doc.addImage(imgToJpeg(img, iw, ih), 'JPEG', 0, 0, iw, ih);
      _prof.jspdf += performance.now() - _td;
      pages++;
      const _tp = performance.now();
      onProgress({ cur: i + 1, total, pct: 60 + Math.round(((i + 1) / total) * 38), skipped, failed, pages, text: `${pages} 页已收录` });
      _prof.progress += performance.now() - _tp;
    } catch (e) {
      // 单页异常（如 canvas 污染 SecurityError）计 failed 继续，不让全册陪葬
      failed++;
      log.warn('[PDF] 第', i + 1, '页写入 PDF 失败，跳过:', e?.message);
      onProgress({ cur: i + 1, total, pct: 60 + Math.round(((i + 1) / total) * 38), skipped, failed, pages, text: `第${i + 1}/${total}页写入失败，已跳过` });
    } finally {
      try { img.src = ''; } catch {}   // 释放解码位图
    }
    _prof.page += performance.now() - _t0;
    if ((i + 1) % 20 === 0) {
      const _s = i + 1 + ':' + JSON.stringify({
        v: 3, page: Math.round(_prof.page), grey: Math.round(_prof.grey),
        jspdf: Math.round(_prof.jspdf), progress: Math.round(_prof.progress), yield: Math.round(_prof.yield)
      });
      log.dbg('[PDF][prof] 页累计ms:', _s);
      try { localStorage.setItem('yksProf', (localStorage.getItem('yksProf') || '') + _s + '\n'); } catch {}
      _prof.page = _prof.grey = _prof.jspdf = _prof.progress = _prof.yield = 0;
    }
    const _ty2 = performance.now(); await yieldFrame(); _prof.yield += performance.now() - _ty2;
  }

  if (!doc) throw new Error('所有页面图片下载失败，未生成 PDF');
  onProgress({ cur: total, total, pct: 100, skipped, failed, pages, text: '保存中...' });
  const safe = String(title || '课件').replace(/[\\/:*?"<>|]/g, '_');
  doc.save(`${safe}.pdf`);
  return { pages, skipped, failed };
}

/** 8×8 块均值内容签名（用于内容级去重，精确匹配）。
 *  注意：油猴沙箱世界里 TypedArray 逐元素读写比主世界慢 ~50-100 倍（实测 ~1µs/元素），
 *  所以：1) 页面 realm 的 ImageData.data 先整块 set() 拷进沙箱数组，再逐元素读；
 *       2) 128×72 缩略 + 隔点采样 + Uint32 一次读 4 字节，逐元素操作压到 ~1 万次/页。 */
function toSig(img) {
  const W = 128, H = 72;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const local = new Uint8ClampedArray(d.length);
  local.set(d);                       // 一次原生块拷贝，避免逐元素跨 realm 读
  const u32 = new Uint32Array(local.buffer);  // 1 次读 4 字节
  const B = 8, bw = W / B, bh = H / B;         // 8×8 分块
  const blockSum = new Float64Array(B * B);
  const blockCnt = new Float64Array(B * B);
  for (let p = 0; p < W * H; p += 2) {          // 隔点采样（去重精度足够）
    const px = u32[p];                          // RGBA little-endian
    const lum = ((px & 0xff) * 0.299 + ((px >> 8) & 0xff) * 0.587 + ((px >> 16) & 0xff) * 0.114) | 0;
    const x = p % W, y = (p / W) | 0;
    const b = ((y / bh) | 0) * B + ((x / bw) | 0);
    blockSum[b] += lum; blockCnt[b]++;
  }
  let sig = '';
  for (let b = 0; b < B * B; b++) {
    const m = blockCnt[b] ? blockSum[b] / blockCnt[b] : 0;
    sig += (m >> 3).toString(36)[0];            // 32 级量化（0-255 → 0-31 → '0'..'v'）
  }
  return sig;
}

/** 位图 → JPEG dataURL（webp 等不可内嵌格式的降级路径；白底兜底透明像素） */
function imgToJpeg(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}

/** dataURL 的 mime → jsPDF 格式（仅 jpeg/png 可安全内嵌原字节；其余返回 null 走 canvas 重编码） */
function formatOfDataUrl(dataUrl) {
  const m = /^data:image\/(\w+)/i.exec(String(dataUrl || ''));
  const t = m?.[1]?.toLowerCase();
  if (t === 'jpeg' || t === 'jpg') return 'JPEG';
  if (t === 'png') return 'PNG';
  return null;
}

/** GM_xhr 转 dataURL 后加载 Image（绕开 OSS CORS 限制） */
async function loadImageViaGM(src, timeoutMs) {
  let url = src;
  if (!src.startsWith('data:')) {
    // GM 下载失败不再直载跨域原图——canvas 污染会让 addImage/toGrey256 抛 SecurityError
    url = await fetchAsDataURL(src, Math.min(timeoutMs, 20000));
  }
  const img = await loadImageEl(url, timeoutMs);
  return { img, dataUrl: url.startsWith('data:') ? url : null };
}

/** Image 元素加载 + 解码超时兜底（onload/onerror 都可能不触发） */
function loadImageEl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      try { img.src = ''; } catch {}
      reject(new Error('图片解码超时'));
    }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('Image 加载失败')); };
    img.src = url;
  });
}
