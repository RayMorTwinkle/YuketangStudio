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

function findSlideForProblem(problemId) {
  const pid = asIdStr(problemId);
  if (!pid) return null;
  for (const [, pres] of repo.presentations) {
    const hit = (pres?.slides || []).find((s) => String(s.problem?.problemId ?? s.problem?.id) === pid);
    if (hit) return hit;
  }
  return null;
}

/** 当前应分析的 slide：显式指定 > 用户配置的图源（老师/课件选中） > 最近题目关联页 */
export function pickCurrentSlide({ preferredSlideId = null } = {}) {
  const preferred = asIdStr(preferredSlideId);
  if (preferred) {
    const hit = repo.slides.get(preferred) || findSlideAcrossPresentations(preferred);
    if (hit) return { slide: hit, source: `指定页（第 ${hit.index ?? hit.page ?? '?'} 页）` };
  }
  const source = ui?.config?.aiSlideSource === 'selected' ? 'selected' : 'teacher';
  const mainSid = asIdStr(getCurrentMainPageSlideId());
  const selectedSid = asIdStr(repo.selectedSlideId || repo.currentSlideId);
  const candidates = source === 'selected'
    ? [{ sid: selectedSid, label: '课件选中页' }, { sid: mainSid, label: '老师当前页' }]
    : [{ sid: mainSid || asIdStr(repo.teacherSlideId), label: '老师当前页' }, { sid: selectedSid, label: '课件选中页' }];
  for (const c of candidates) {
    if (!c.sid) continue;
    const hit = repo.slides.get(c.sid) || findSlideAcrossPresentations(c.sid);
    if (hit) return { slide: hit, source: `${c.label}（第 ${hit.index ?? hit.page ?? '?'} 页）` };
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


/**
 * 活跃题目（答题提醒卡片）→ AnswerTask。
 * 必须使用该题自己的 slide/problem，绝不回退到当前页，否则通知里的 AI 会答成别的题。
 */
export async function resolveActiveProblemTask(problemId) {
  const pid = asIdStr(problemId);
  if (!pid) return { task: null, reason: '没有题目 ID' };
  const status = repo.problemStatus.get(pid) || null;
  let problem = repo.problems.get(pid) || null;
  if (!problem) {
    const entry = repo.encounteredProblems.find((p) => String(p.problemId) === pid);
    if (entry) problem = entry;
  }
  if (!problem) return { task: null, status, reason: '题目数据尚未加载' };
  const slide = (status?.slideId ? (repo.slides.get(String(status.slideId)) || findSlideAcrossPresentations(String(status.slideId))) : null)
    || findSlideForProblem(pid);
  let image = '';
  if (slide?.id) image = await imageForSlide(slide);
  const task = buildClassroomTask({
    problem,
    slide,
    status,
    lessonId: repo.currentLessonId,
    imageDataUrl: image,
    source: 'classroom',
  });
  return { task, slide, status, reason: task ? '' : '题目信息不完整' };
}
