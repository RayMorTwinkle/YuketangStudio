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

/** 是否处于 student-v3 报告页（收集器的工作现场） */
export function isStudentV3Page() {
  return /\/v2\/web\/student-v3\//.test(window.location.pathname);
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
  log.dbg('[YKS-History] 开始收集历史课件:', ids);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

    // 3. 点击缩略图打开全页预览（lightbox 会把所有页渲染进 DOM）
    const thumb = document.querySelector('.module_ppt .swiper_box img') || document.querySelector('.module_ppt img');
    if (thumb) {
      thumb.click();
      await sleep(3500); // 等 lightbox 渲染
    }

    // 4. 收集全部 slide 图 URL（去重：按文件名主体，保留清晰度最高的版本）
    const uniq = new Map(); // key: cover数字_时间戳 -> {n, url, order}
    let order = 0;
    for (const img of document.querySelectorAll('img')) {
      const src = img.src || '';
      if (!src.includes('/slide/') || !src.includes('token')) continue;
      const m = src.match(/\/slide\/(\d+)\/cover(\d+)_(\d+)\.(\w+)/);
      if (!m) continue;
      const key = `${m[1]}_${m[2]}_${m[3]}`;   // 目录_文件名主体
      const prev = uniq.get(key);
      if (!prev) uniq.set(key, { n: parseInt(m[2], 10), url: src, order: order++ });
      else if (parseInt(m[2], 10) > prev.n) { prev.url = src; prev.n = parseInt(m[2], 10); }
    }
    // 按 DOM 出现顺序排序（lightbox 顺序即页序）
    const urls = [...uniq.values()].sort((a, b) => a.order - b.order).map(x => x.url);
    log.dbg('[YKS-History] 收集到', urls.length, '页');
    statusEl(`已收集 ${urls.length} 页图片，开始下载并生成 PDF…`, 2);

    if (!urls.length) throw new Error('未收集到任何 slide 图片');

    // 5. 逐张下载 + 内容级去重 + 生成横屏 PDF；进度实时上报主页面
    const report = (info) => {
      try {
        if (typeof GM_setValue === 'function')
          GM_setValue(PROGRESS_KEY_PREFIX + lessonId, { ...info, title, phase: 'pdf', ts: Date.now() });
      } catch {}
      const bits = [];
      if (info.skipped) bits.push(`去重 ${info.skipped} 页`);
      if (info.failed) bits.push(`失败 ${info.failed} 页`);
      statusEl(`下载并生成 PDF：${info.text || ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`, info.pct);
      log.dbg('[YKS-History] PDF', info.pct + '%', info.text, bits.join(' '));
    };
    const { pages, skipped, failed } = await exportImagesToPdf(urls, title, { dedupHash: true, onProgress: report });

    // 6. 通知主页面（结果存 GM 存储，主页面监听变更）
    const result = { ok: true, lessonId, title, pages, skipped, failed, total: urls.length, ts: Date.now() };
    if (typeof GM_setValue === 'function') GM_setValue(RESULT_KEY_PREFIX + lessonId, result);
    const tail = [`${pages} 页`];
    if (skipped) tail.push(`去重 ${skipped} 页`);
    if (failed) tail.push(`失败 ${failed} 页`);
    statusEl(`✅ 完成！PDF 已开始下载（${tail.join('，')}）`, 100);
    log.dbg('[YKS-History] 完成:', result);

    // 7. 关闭收集页（若是脚本开的 tab；用户手动打开则保留）
    setTimeout(() => { try { window.close(); } catch {} }, 4000);
  } catch (e) {
    log.err('[YKS-History] 失败:', e);
    statusEl(`❌ 收集失败：${String(e?.message || e).slice(0, 120)}`, 100);
    const result = { ok: false, lessonId, error: String(e?.message || e), ts: Date.now() };
    if (typeof GM_setValue === 'function') {
      GM_setValue(RESULT_KEY_PREFIX + lessonId, result);
      GM_setValue(PROGRESS_KEY_PREFIX + lessonId, { phase: 'error', text: String(e?.message || e).slice(0, 80), ts: Date.now() });
    }
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
  // 清旧结果与进度
  if (typeof GM_setValue === 'function') { GM_setValue(resultKey, null); GM_setValue(progressKey, null); }

  const url = `${location.origin}/v2/web/student-v3/${classId}/${lessonId}/${activityId}`;
  if (typeof GM_openInTab !== 'function') throw new Error('GM_openInTab 不可用');
  const collectTab = GM_openInTab(url, { active: true, insert: true });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 优先走 GM_addValueChangeListener 实时推送（收集页写值即回调），
  // 拿到进度不再依赖轮询间隔，快速下载时不会丢帧。
  // 监听不可用时退化为轮询（下面的 for 循环）。
  let done = null;
  let lastProgressTs = -1;
  const listenerIds = [];

  const handleProgress = (p) => {
    if (!p || p.ts === lastProgressTs) return;
    lastProgressTs = p.ts;
    opts.onProgress?.(p);
  };
  const handleResult = (r) => {
    if (!r || !r.ts) return;
    if (!done) done = r;
  };

  if (typeof GM_addValueChangeListener === 'function') {
    try {
      const id1 = GM_addValueChangeListener(progressKey, (_n, _o, nv) => handleProgress(nv));
      const id2 = GM_addValueChangeListener(resultKey, (_n, _o, nv) => handleResult(nv));
      if (id1 != null) listenerIds.push(id1);
      if (id2 != null) listenerIds.push(id2);
    } catch (e) {
      log.warn('[History] 变更监听不可用，退回轮询:', e?.message);
      listenerIds.length = 0;
    }
  }

  try {
    // 兜底轮询：即使监听可用，也定期确认（防止监听漏事件），间隔 1s，最长 180s
    for (let i = 0; i < 180 && !done; i++) {
      await sleep(1000);
      if (typeof GM_getValue === 'function') {
        handleProgress(GM_getValue(progressKey));
        handleResult(GM_getValue(resultKey));
      }
      if (done) break;
    }
    if (!done) throw new Error('收集超时（180s）——请确认打开的页面里课件正常显示');
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

/** 从当前页面路径提取 classId（studentLog/{classId} 或其它含班级 id 的页面） */
export function currentClassId() {
  const m = window.location.pathname.match(/\/studentLog\/(\d+)/)
    || window.location.pathname.match(/\/student-lesson-report\/(\d+)/)
    || window.location.pathname.match(/\/student-v3\/(\d+)/);
  return m ? m[1] : null;
}
