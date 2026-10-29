// src/ui/slide-source.js
// 把「老师正在讲的 PPT」和「课件页选中的 PPT」分离成可持久化的两种上下文。
import { repo } from '../state/repo.js';

export const SLIDE_SOURCES = ['teacher', 'selected'];

function asStr(v) {
  return v == null ? '' : String(v);
}

function slideForId(idStr) {
  if (!idStr) return null;
  const direct = repo.slides.get(idStr);
  if (direct) return direct;
  for (const [, pres] of repo.presentations) {
    const hit = (pres?.slides || []).find((s) => asStr(s.id) === idStr);
    if (hit) return hit;
  }
  return null;
}

export function normalizeSlideSource(value) {
  return SLIDE_SOURCES.includes(value) ? value : 'teacher';
}

export function teacherSlideId() {
  return asStr(repo.teacherSlideId || repo.currentSlideId);
}

export function selectedSlideId() {
  return asStr(repo.selectedSlideId || teacherSlideId());
}

/** 按来源解析 slide；某一侧缺失时安全回退，不悄悄换题。 */
export function resolveSlideForSource(source, { fallback = true } = {}) {
  const kind = normalizeSlideSource(source);
  const wanted = kind === 'selected' ? selectedSlideId() : teacherSlideId();
  let slide = slideForId(wanted);
  if (!slide && fallback) {
    slide = slideForId(kind === 'selected' ? teacherSlideId() : selectedSlideId());
  }
  return {
    source: kind,
    requestedSlideId: wanted,
    slide,
    fallback: !!(wanted && slide && asStr(slide.id) !== wanted),
  };
}
