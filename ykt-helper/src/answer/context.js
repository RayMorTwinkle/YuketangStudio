// src/answer/context.js
// 当前页面/题目 → AnswerTask。替代 ai.js 里的 pickCurrentSlide + canSubmitProblem。
import { repo } from '../state/repo.js';
import { ui } from '../ui/ui-api.js';
import {
  getCurrentMainPageSlideId, getCurrentMainPageMeta,
} from '../core/vuex-helper.js';
import { resolveCurrentSlideImage } from '../ui/slide-image.js';
import { captureSlideImage } from '../capture/screenshoot.js';
import { buildClassroomTask } from './adapters/classroom.js';
import { buildProblemListTask } from './adapters/problem-list.js';

function asIdStr(v) { return v == null ? null : String(v); }

function findSlideAcrossPresentations(idStr) {
  for (const [, pres] of repo.presentations) {
    const hit = (pres?.slides || []).find((s) => String(s.id) === idStr);
    if (hit) return hit;
  }
  return null;
}

/** 当前应分析的 slide：显式指定 > 主界面 > 课件浏览选中 > 最近题目关联页 */
export function pickCurrentSlide({ preferredSlideId = null } = {}) {
  const preferred = asIdStr(preferredSlideId);
  if (preferred) {
    const hit = repo.slides.get(preferred) || findSlideAcrossPresentations(preferred);
    if (hit) return { slide: hit, source: `指定页（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  const prio = ui?.config?.aiSlidePickPriority !== false;
  const mainSid = asIdStr(getCurrentMainPageSlideId());
  if (prio && mainSid) {
    const hit = repo.slides.get(mainSid) || findSlideAcrossPresentations(mainSid);
    if (hit) return { slide: hit, source: `主界面当前页（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  if (repo.currentSlideId != null) {
    const sid = asIdStr(repo.currentSlideId);
    const hit = repo.slides.get(sid) || findSlideAcrossPresentations(sid);
    if (hit) return { slide: hit, source: `课件浏览选中（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  try {
    if (repo.encounteredProblems?.length > 0) {
      const latest = repo.encounteredProblems.at(-1);
      const st = repo.problemStatus.get(String(latest.problemId));
      const sid = st?.slideId ? String(st.slideId) : null;
      const hit = sid ? (repo.slides.get(sid) || findSlideAcrossPresentations(sid)) : null;
      if (hit) return { slide: hit, source: `最近题目关联页（第 ${hit.index ?? hit.page ?? '?'} 页）` };
    }
  } catch { /* ignore */ }
  return { slide: null, source: '' };
}

async function imageForSlide(slide) {
  if (!slide?.id) return '';
  try {
    const b64 = await captureSlideImage(String(slide.id));
    if (b64) return b64;
  } catch { /* ignore */ }
  return '';
}

/**
 * 当前页/指定页 → 课堂 AnswerTask。
 * @param {{preferredSlideId?: string|null, imageDataUrl?: string}} [opts]
 */
export async function resolveCurrentTask({ preferredSlideId = null, imageDataUrl = '' } = {}) {
  const { slide, source } = pickCurrentSlide({ preferredSlideId });
  const problem = slide?.problem || null;
  const meta = getCurrentMainPageMeta();
  const looksProblem = !!(meta?.problemID || String(meta?.type || '') === 'problem');
  if (!problem) {
    return { task: null, slide, source, looksProblem, reason: slide ? '当前页没有题目' : '没有检测到课件页' };
  }
  const status = repo.problemStatus.get(String(problem.problemId)) || null;
  let image = imageDataUrl || '';
  if (!image) {
    image = await imageForSlide(slide);
    if (!image) {
      try {
        const r = await resolveCurrentSlideImage();
        image = r?.dataUrl || '';
      } catch { /* ignore */ }
    }
  }
  const task = buildClassroomTask({
    problem,
    slide,
    status,
    lessonId: repo.currentLessonId,
    imageDataUrl: image,
    source: 'classroom',
  });
  return { task, slide, status, source, looksProblem, reason: '' };
}

/** 题目列表条目 → AnswerTask */
export async function resolveProblemListTask(entry) {
  if (!entry) return { task: null, reason: '没有题目' };
  const pid = entry.problemId;
  const prob = repo.problems.get(String(pid)) || entry;
  const slide = entry.slide || (entry.slideId ? repo.slides.get(String(entry.slideId)) : null);
  const status = repo.problemStatus.get(String(pid)) || null;
  let image = '';
  if (slide?.id) image = await imageForSlide(slide);
  const task = buildProblemListTask({
    entry,
    problem: prob,
    slide,
    status,
    lessonId: repo.currentLessonId,
    imageDataUrl: image,
  });
  return { task, slide, status, reason: task ? '' : '题目信息不完整' };
}
