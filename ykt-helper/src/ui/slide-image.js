// src/ui/slide-image.js
// 「当前 PPT 页图片」解析的共享模块：chat 与 AI 解答面板都用它。
// 三级来源：repo slide 数据 → 页面 DOM → 明确失败（绝不悄悄截整页当 PPT）。
import { repo } from '../state/repo.js';
import { fetchAsDataURL } from '../core/env.js';
import { log } from '../core/log.js';

/** 在 repo 中定位当前 slide（课堂内主路径） */
export function findCurrentSlide() {
  try {
    const sid = repo.currentSlideId != null ? String(repo.currentSlideId) : null;
    if (sid && repo.slides.has(sid)) return repo.slides.get(sid);
    for (const [, pres] of repo.presentations) {
      const hit = (pres?.slides || []).find(s => String(s.id) === sid);
      if (hit) return hit;
    }
    // 退化：取 presentation 的第一页
    for (const [, pres] of repo.presentations) {
      if (pres?.slides?.length) return pres.slides[0];
    }
  } catch (e) { log.warn('[SlideImage] findCurrentSlide', e); }
  return null;
}

export function slideImageUrl(slide) {
  return slide?.coverAlt || slide?.cover || slide?.image || slide?.thumbnail || '';
}

/** 从页面 DOM 里找 slide 图（报告页/静态课件的退化路径） */
function findSlideUrlInDom() {
  try {
    const selectors = [
      'img[src*="/slide/"]',           // 课堂 fullscreen 页的主 PPT 图
      '.slide-item.active-slide-item img',
      '.slide-item img',
      '.swiper-slide-active img',
      '.ppt-courseware-inner img',
      '.ppt-inner img',
    ];
    for (const sel of selectors) {
      const img = document.querySelector(sel);
      const src = img?.currentSrc || img?.src || '';
      if (src && /\/slide\/|cover/i.test(src)) return src;
    }
  } catch (e) { log.warn('[SlideImage] findSlideUrlInDom', e); }
  return '';
}

/**
 * 解析当前 PPT 页图片。
 * @returns {Promise<{dataUrl:string|null, source:'repo'|'dom'|'failed', reason?:string}>}
 *   source: 'repo' = 命中课件数据（最可信）；'dom' = 页面 DOM；'failed' = 拿不到
 * 注意：不做整页 html2canvas 兜底——那会把整页截图当 PPT 发给 AI 且用户毫不知情。
 */
export async function resolveCurrentSlideImage() {
  // 1) repo 中的 slide（课堂内正常路径）
  const slide = findCurrentSlide();
  const url = slideImageUrl(slide);
  if (url) {
    try {
      const dataUrl = await fetchAsDataURL(url);
      if (dataUrl) return { dataUrl, source: 'repo' };
    } catch (e) {
      try { (window.unsafeWindow || window).__yksImgErr = `repo(${String(url).slice(0, 70)}): ${String(e?.message || e).slice(0, 100)}`; } catch {}
      log.warn('[SlideImage] repo slide 图下载失败，尝试 DOM 兜底:', e?.message);
    }
  }

  // 2) DOM 兜底：报告页/静态课件等 repo 数据失效但页面有新鲜 slide 图的场景
  const domUrl = findSlideUrlInDom();
  if (domUrl) {
    try {
      const dataUrl = await fetchAsDataURL(domUrl);
      if (dataUrl) return { dataUrl, source: 'dom' };
    } catch (e) {
      try { (window.unsafeWindow || window).__yksImgErr = `dom(${String(domUrl).slice(0, 70)}): ${String(e?.message || e).slice(0, 100)}`; } catch {}
      log.warn('[SlideImage] DOM slide 图下载失败:', e?.message);
    }
  }

  return {
    dataUrl: null,
    source: 'failed',
    reason: slide || url ? 'PPT 图片下载失败（可能是网络或权限问题）' : '当前页面没有可用的 PPT 页',
  };
}
