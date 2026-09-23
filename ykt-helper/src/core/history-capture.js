// src/core/history-capture.js
// 历史课件收集器：在 student-v3 报告页自动运行
// 流程：等课件卡片渲染 → 点击缩略图打开全页预览 → DOM 收集全部 slide 图 URL
//      → 去重排序 → 直接生成横屏 PDF 下载 → 通过 GM_setValue 通知主页面 → 关闭标签页
import { exportImagesToPdf } from './pdf-export.js';
import { log } from './log.js';

const RESULT_KEY_PREFIX = 'ykt-history-result:';
const PROGRESS_KEY_PREFIX = 'ykt-history-progress:';

/** 收集页内的可见状态条（进度对本页用户可见） */
function statusEl(text, pct) {
  let el = document.getElementById('yks-history-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'yks-history-status';
    el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#1d63df;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:420px;font-family:system-ui,sans-serif;';
    document.body?.appendChild(el);
  }
  el.innerHTML = `<b>📥 YuketangStudio 收集器</b><div style="margin-top:4px">${text || ''}</div>` +
    (pct != null ? `<div style="margin-top:6px;background:rgba(255,255,255,.25);border-radius:4px;overflow:hidden"><div style="height:6px;width:${pct}%;background:#fff;border-radius:4px;transition:width .3s"></div></div>` : '');
  return el;
}

/** 是否处于 student-v3 报告页（收集器的工作现场）。
 *  只有脚本自己打开的收集页（URL 带 #yks-collect 标记）才自动执行——
 *  用户手动浏览报告页不应被劫持点击/下载/关页。 */
export function isStudentV3Page() {
  return /\/v2\/web\/student-v3\//.test(window.location.pathname)
    && /yks-collect/.test(window.location.hash);
}

/** 本次收集 runId（importHistoryLesson 生成在 URL hash 里），用于区分旧 run 残留的写值 */
function collectRunId() {
  return (window.location.hash.match(/yks-collect-(\w+)/) || [])[1] || null;
}

/** 收集全部 slide 图 URL：读 currentSrc/src/data-src（懒加载图可能还没挂 src），
 *  过滤放宽为 /slide/<id>/ + 图片扩展名（不再硬性要求 token 参数） */
function collectSlideUrls() {
  const uniq = new Map(); // key: cover数字_时间戳（命名漂移时退化为完整 URL）-> {n, url, order}
  let order = 0;
  let filteredSlideLike = 0;
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!src.includes('/slide/')) continue;
    if (!/\.(png|jpe?g|webp)(\?|#|$)/i.test(src)) { filteredSlideLike++; continue; }
    const m = src.match(/\/slide\/(\d+)\/cover(\d+)_(\d+)\.(\w+)/);
    const key = m ? `${m[1]}_${m[2]}_${m[3]}` : src;
    const prev = uniq.get(key);
    const n = m ? parseInt(m[2], 10) : 0;
    if (!prev) uniq.set(key, { n, url: src, order: order++ });
    else if (n > prev.n) { prev.url = src; prev.n = n; }
  }
  if (filteredSlideLike) log.warn('[YKS-History] 有', filteredSlideLike, '个 /slide/ URL 因扩展名不匹配被过滤');
  // 按 DOM 出现顺序排序（lightbox 顺序即页序）
  return [...uniq.values()].sort((a, b) => a.order - b.order).map(x => x.url);
}

/** 页面上声明的总页数（「共N页」「x/N」等），用于收集结果比对告警 */
function expectedPageCount() {
  try {
    const text = document.querySelector('.module_ppt')?.innerText || '';
    const m = text.match(/共\s*(\d+)\s*页/) || text.match(/(\d+)\s*页/) || text.match(/\b1\s*\/\s*(\d+)\b/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

/** 从 URL 提取 lessonId（student-v3/{classId}/{lessonId}/{activityId}） */
export function parseStudentV3Ids() {
  const m = window.location.pathname.match(/\/v2\/web\/student-v3\/(\d+)\/(\d+)\/(\d+)/);
  return m ? { classId: m[1], lessonId: m[2], activityId: m[3] } : null;
}

/**
 * 在 v3 页面执行收集。由 index.js 在匹配页面时调用（fire-and-forget）。
 */
export async function runHistoryCapture() {
  const ids = parseStudentV3Ids();
  if (!ids) return;
  const { lessonId } = ids;
  const runId = collectRunId();
  log.dbg('[YKS-History] 开始收集历史课件:', ids, 'runId:', runId);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const gmSet = (key, val) => { try { if (typeof GM_setValue === 'function') GM_setValue(key, val); } catch {} };

  // 入口心跳：主页面据此知道收集页已活（而不是静默等超时）
  gmSet(PROGRESS_KEY_PREFIX + lessonId, { runId, phase: 'start', text: '收集页已启动', ts: Date.now() });

  try {
    statusEl('等待课件卡片渲染…');
    // 1. 等待课件卡片渲染（最长 30s）
    let card = null;
    for (let i = 0; i < 30; i++) {
      card = document.querySelector('.module_ppt .swiper_box img, .module_ppt .ppt_info_box');
      if (card) break;
      await sleep(1000);
    }
    if (!card) throw new Error('课件卡片未渲染（可能该课堂无课件）');

    // 2. 取标题
    const title = (document.querySelector('.ppt_name')?.textContent || '历史课件').trim();
    statusEl(`已找到课件「${title}」，打开全页预览…`);

    // 3. 点击缩略图打开全页预览；懒加载兜底：反复滚动容器+重扫，直到 img 计数稳定
    const thumb = document.querySelector('.module_ppt .swiper_box img') || document.querySelector('.module_ppt img');
    if (thumb) {
      thumb.click();
      let lastCount = -1, stable = 0;
      for (let i = 0; i < 45; i++) {
        await sleep(1000);
        // 触发懒加载：把所有可疑滚动容器拉到底
        for (const sc of document.querySelectorAll('.swiper_box, [class*="lightbox"], [class*="preview"], [class*="viewer"]')) {
          try { sc.scrollTop = sc.scrollHeight; } catch {}
        }
        try { window.scrollTo(0, document.body?.scrollHeight || 0); } catch {}
        const n = collectSlideUrls().length;
        statusEl(`预览渲染中…已发现 ${n} 页`);
        if (n === lastCount) { if (++stable >= 3) break; }
        else { stable = 0; lastCount = n; }
      }
    } else {
      log.warn('[YKS-History] 未找到缩略图入口，直接收集现有 DOM');
    }

    // 4. 收集全部 slide 图 URL（去重：按文件名主体，保留清晰度最高的版本）
    const urls = collectSlideUrls();
    const expected = expectedPageCount();
    log.dbg('[YKS-History] 收集到', urls.length, '页，页面声明总页数:', expected);
    if (expected && urls.length < expected) {
      log.warn(`[YKS-History] 收集页数(${urls.length})少于页面声明(${expected})，PDF 可能缺页`);
    }
    statusEl(`已收集 ${urls.length} 页图片，开始下载并生成 PDF…`, 2);

    if (!urls.length) throw new Error('未收集到任何 slide 图片');

    // 5. 逐张下载 + 内容级去重 + 生成横屏 PDF；进度实时上报主页面（节流 ≥150ms）
    let lastReport = 0;
    const report = (info, force = false) => {
      const now = Date.now();
      if (force || now - lastReport > 150) {
        lastReport = now;
        gmSet(PROGRESS_KEY_PREFIX + lessonId, { ...info, runId, title, phase: 'pdf', ts: now });
      }
      const bits = [];
      if (info.skipped) bits.push(`去重 ${info.skipped} 页`);
      if (info.failed) bits.push(`失败 ${info.failed} 页`);
      statusEl(`下载并生成 PDF：${info.text || ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`, info.pct);
      log.dbg('[YKS-History] PDF', info.pct + '%', info.text, bits.join(' '));
    };
    const { pages, skipped, failed } = await exportImagesToPdf(urls, title, { dedupHash: true, onProgress: report });

    // 6. 通知主页面（结果存 GM 存储，主页面监听变更；带 runId 防旧 run 串扰）
    const result = { ok: true, lessonId, runId, title, pages, skipped, failed, total: urls.length, expectedTotal: expected, ts: Date.now() };
    gmSet(RESULT_KEY_PREFIX + lessonId, result);
    const tail = [`${pages} 页`];
    if (skipped) tail.push(`去重 ${skipped} 页`);
    if (failed) tail.push(`失败 ${failed} 页`);
    if (expected && urls.length < expected) tail.push(`⚠️ 仅收集到 ${urls.length}/${expected} 页`);
    statusEl(`✅ 完成！PDF 已开始下载（${tail.join('，')}）`, 100);
    log.dbg('[YKS-History] 完成:', result);

    // 7. 关闭收集页（脚本开的 tab 才走到这里——isStudentV3Page 已用 hash 标记把关）
    setTimeout(() => { try { window.close(); } catch {} }, 4000);
  } catch (e) {
    log.err('[YKS-History] 失败:', e);
    statusEl(`❌ 收集失败：${String(e?.message || e).slice(0, 120)}`, 100);
    const result = { ok: false, lessonId, runId, error: String(e?.message || e), ts: Date.now() };
    gmSet(RESULT_KEY_PREFIX + lessonId, result);
    gmSet(PROGRESS_KEY_PREFIX + lessonId, { runId, phase: 'error', text: String(e?.message || e).slice(0, 80), ts: Date.now() });
  }
}

/**
 * 主页面调用：打开 v3 页收集并等待结果
 * @param {string} classId   班级 ID
 * @param {Object} activity  logs API 的条目 { id: activityId, courseware_id: lessonId, title }
 * @returns {Promise<{ok, title, pages}>}
 */
export async function importHistoryLesson(classId, activity, opts = {}) {
  const lessonId = String(activity.courseware_id);
  const activityId = String(activity.id);
  const resultKey = RESULT_KEY_PREFIX + lessonId;
  const progressKey = PROGRESS_KEY_PREFIX + lessonId;
  // runId：区分本次 run 与上一次超时残留收集 tab 的写值（旧 run 的回报直接丢弃）
  const runId = Math.random().toString(36).slice(2, 10);
  // 清旧结果与进度
  if (typeof GM_setValue === 'function') { GM_setValue(resultKey, null); GM_setValue(progressKey, null); }

  // #yks-collect-<runId> 标记：收集器只在这种脚本开的 tab 里自动运行（并在完成后自动关闭）
  const url = `${location.origin}/v2/web/student-v3/${classId}/${lessonId}/${activityId}#yks-collect-${runId}`;
  if (typeof GM_openInTab !== 'function') throw new Error('GM_openInTab 不可用');
  // GM4/Violentmonkey 返回 Promise——await 兼容两种签名，否则 collectTab.close 静默无效
  const collectTab = await Promise.resolve(GM_openInTab(url, { active: true, insert: true }));

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 优先走 GM_addValueChangeListener 实时推送（收集页写值即回调），
  // 拿到进度不再依赖轮询间隔，快速下载时不会丢帧。
  // 监听不可用时退化为轮询（下面的 while 循环）。
  let done = null;
  let lastProgressTs = -1;
  let lastActivity = Date.now();   // 任何匹配的 progress/result 写值都刷新——停滞检测用
  const listenerIds = [];

  const handleProgress = (p) => {
    try {
      if (!p || p.runId !== runId || p.ts === lastProgressTs) return;
      lastProgressTs = p.ts;
      lastActivity = Date.now();
      opts.onProgress?.(p);
    } catch (e) { log.warn('[History] onProgress 回调异常:', e?.message); }
  };
  const handleResult = (r) => {
    try {
      if (!r || !r.ts || r.runId !== runId) return;
      lastActivity = Date.now();
      if (!done) done = r;
    } catch (e) { log.warn('[History] handleResult 异常:', e?.message); }
  };

  if (typeof GM_addValueChangeListener === 'function') {
    try {
      const id1 = GM_addValueChangeListener(progressKey, (_n, _o, nv) => handleProgress(nv));
      if (id1 != null) listenerIds.push(id1);
      const id2 = GM_addValueChangeListener(resultKey, (_n, _o, nv) => handleResult(nv));
      if (id2 != null) listenerIds.push(id2);
    } catch (e) {
      log.warn('[History] 变更监听不可用，退回轮询:', e?.message);
      // 半程注册成功的也要清掉，否则旧监听器持有已 detach 的 bar 引用
      if (typeof GM_removeValueChangeListener === 'function') {
        for (const id of listenerIds) { try { GM_removeValueChangeListener(id); } catch {} }
      }
      listenerIds.length = 0;
    }
  }

  // 墙钟超时而非迭代次数——本页可能因收集 tab active:true 被切到后台，
  // setTimeout 被节流到 ~1min/次，用计数会让"180s 超时"实际拖成数小时
  const HEARTBEAT_TIMEOUT = 120000;          // 120s 无任何进展 → 判收集页已死
  const ABSOLUTE_TIMEOUT = 15 * 60 * 1000;   // 绝对上限 15min（大册导出本身可能很久）
  const t0 = Date.now();

  try {
    while (!done) {
      await sleep(1000);
      if (typeof GM_getValue === 'function') {
        handleProgress(GM_getValue(progressKey));
        handleResult(GM_getValue(resultKey));
      }
      if (done) break;
      if (Date.now() - lastActivity > HEARTBEAT_TIMEOUT) {
        throw new Error('收集页超过 120s 无进展，可能已卡死——请检查新开的收集标签页');
      }
      if (Date.now() - t0 > ABSOLUTE_TIMEOUT) {
        throw new Error('收集超时（15min）——请确认打开的页面里课件正常显示');
      }
    }
    return done;
  } finally {
    // 释放监听器，避免同一页面多次导入后回调累积
    if (typeof GM_removeValueChangeListener === 'function') {
      for (const id of listenerIds) {
        try { GM_removeValueChangeListener(id); } catch {}
      }
    }
    // 完成/失败后关闭收集页（GM_openInTab 返回的 tab 对象支持 close）
    try { collectTab?.close?.(); } catch {}
    setTimeout(() => { try { collectTab?.close?.(); } catch {} }, 1500);
  }
}

/**
 * 主页面调用：拉取某班级的全部课堂列表（自动翻页，不再局限于前 50 条）
 * @param {string} classId
 * @returns {Promise<Array>} [{ id, courseware_id, title, attend_status, create_time }]
 */
export async function fetchClassActivities(classId) {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20;         // 上限 1000 条，防死循环
  const all = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `/v2/api/web/logs/learn/${classId}?actype=-1&page=${page}&offset=${PAGE_SIZE}&sort=-1`,
      { credentials: 'include' }
    );
    if (!res.ok) throw new Error(`课堂列表请求失败：HTTP ${res.status}`);
    const j = await res.json();
    const acts = j?.data?.activities || [];
    if (!acts.length) break;

    let added = 0;
    for (const a of acts) {
      if (a.type !== 14 || !a.courseware_id) continue;   // 14 = 课堂
      const key = `${a.id}:${a.courseware_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(a);
      added++;
    }
    // 本页没有新增（或不足一页）说明已到末尾
    if (added === 0 || acts.length < PAGE_SIZE) break;
  }
  return all;
}

/** 从当前页面路径提取 classId（含桌面版与移动版 /m/v2 课程日志页） */
export function currentClassId() {
  const path = window.location.pathname;
  const m = path.match(/\/studentLog\/(\d+)/)
    || path.match(/\/student-lesson-report\/(\d+)/)
    || path.match(/\/student-v3\/(\d+)/)
    || path.match(/\/m\/v\d\/course\/[^/]+\/logs\/(\d+)\/(\d+)/);   // 移动版：/logs/{courseId}/{classId}
  return m ? (m[2] || m[1]) : null;
}
