// src/quiz/course-data.js
// 刷课/课程内容的数据汇聚层：API 优先，当前页 Vue 目录只做兜底。
//
// 数据源：
// - 成绩接口：leaf_level_infos（有成绩的内容，含每项得分/权重）
// - 学习日志：全部活动（视频/图文/班级课件/作业/考试）
// - 班级课件：type=2 的逐页进度
// - 新版作业/考试：type=19/20 的状态
//
// 这里只做纯数据合并；DOM 解析仍留在 brush.js（作为无 API 时的兜底）。

import {
  fetchCourseScores, fetchLearnActivities, pickClassCards,
  fetchClassCardProgress, fetchClassroomInfo,
} from './course-cards.js';
import { fetchAssignments } from './assignments.js';

const BRUSHABLE = new Set([0, 1, 3, 7]);

export const TYPE_LABEL = {
  0: '视频', 1: '音频', 2: '直播', 3: '图文', 4: '讨论',
  5: '考试', 6: '作业', 7: '班级课件', 8: '课堂', 9: '试卷',
};

function str(v) { return v == null ? '' : String(v); }
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function scoreNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function evalMap(score) {
  const m = new Map();
  for (const e of (score?.summary?.evaluation || [])) {
    if (e?.id != null) m.set(String(e.id), e);
  }
  return m;
}

function weightFor(score, evaluationId, isScore) {
  if (!isScore) return 0;
  const e = evalMap(score).get(String(evaluationId));
  return e && Number.isFinite(Number(e.proportion)) ? Number(e.proportion) : 0;
}

/** 成绩接口的 leaf_level_infos → 统一条目。 */
export function scoreRows(score) {
  const rows = [];
  for (const it of (score?.items || [])) {
    const id = str(it?.id);
    if (!id) continue;
    const type = num(it?.leafType);
    // 班级课件单独由 cards/view_depth 提供，避免生成没有 cardsId 的假条目。
    if (type === 7) continue;
    const weight = weightFor(score, it?.evaluationId, true);
    const userScore = scoreNum(it?.userScore);
    const leafScore = scoreNum(it?.leafScore);
    rows.push({
      id,
      title: str(it?.title || `内容 ${id}`),
      type,
      typeLabel: TYPE_LABEL[type] || `类型${type}`,
      schedule: { done: 0, total: 0 },
      // 有 user_score 说明至少有一次成绩记录；不能仅凭 leaf_score 判断完成。
      completed: userScore != null,
      completionSource: 'score',
      brushable: BRUSHABLE.has(type),
      scored: weight > 0,
      weight,
      weightUnknown: false,
      isScore: true,
      score: userScore,
      maxScore: leafScore,
      hasScore: true,
      isExpired: it?.isExpired === true,
      total: 0,
      state: 'idle',
    });
  }
  return rows;
}

/** 学习日志活动 → 统一条目（只收刷课类型；作业/考试单独由 assignments 提供）。 */
export function activityRows(activities) {
  const rows = [];
  const seen = new Set();
  for (const a of (Array.isArray(activities) ? activities : [])) {
    if (!a) continue;
    const type = num(a.type);
    if (!BRUSHABLE.has(type) || type === 7) continue;
    const id = str(a.courseware_id || a.leaf_id || a.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const total = num(a.total ?? a.count ?? a.problem_count);
    const done = num(a.done ?? a.finish ?? a.finished_count ?? a.progress);
    rows.push({
      id,
      title: str(a.title || `内容 ${id}`),
      type,
      typeLabel: TYPE_LABEL[type] || `类型${type}`,
      schedule: { done, total },
      completed: total > 0 ? done >= total : false,
      completionSource: 'activity',
      brushable: true,
      scored: false,
      weight: 0,
      weightUnknown: true,
      isScore: false,
      score: null,
      maxScore: null,
      hasScore: false,
      total,
      state: 'idle',
    });
  }
  return rows;
}

/** 新版作业/考试 → 统一条目（只展示，不刷）。 */
export function assignmentRows(assignments) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter((a) => a && [4, 19, 20].includes(Number(a.type)))
    .map((a) => {
      const type = Number(a.type);
      const exam = type === 20;
      const completed = exam
        ? a.examStatus === 'submitted'
        : a.status === 'graded' || a.status === 'submitted';
      return {
        id: `assignment:${type}:${str(a.id)}`,
        assignmentId: str(a.id),
        title: str(a.title || (exam ? '考试' : '作业')),
        type,
        typeLabel: exam ? '考试' : '作业',
        schedule: { done: 0, total: 0 },
        completed,
        completionSource: 'assignment',
        brushable: false,
        scored: false,
        weight: 0,
        weightUnknown: true,
        isScore: false,
        score: scoreNum(a.score),
        maxScore: scoreNum(a.totalScore),
        hasScore: a.score != null,
        statusMessage: str(a.statusMessage),
        deadline: num(a.deadline),
        total: num(a.problemCount),
        state: 'idle',
      };
    });
}

/**
 * 合并“目录行”和“API 补充行”。
 * 目录行提供准确的 done/total/顺序；API 行提供成绩、班级课件、作业状态。
 */
export function mergeBrushItems(baseItems, extraItems) {
  const byId = new Map();
  for (const it of baseItems || []) byId.set(String(it.id), it);
  for (const e of extraItems || []) {
    const id = String(e?.id || '');
    if (!id) continue;
    const it = byId.get(id);
    if (!it) {
      byId.set(id, { ...e, id });
      continue;
    }
    const existingTotal = Number(it.schedule?.total) || 0;
    const extraTotal = Number(e.schedule?.total) || 0;
    const schedule = existingTotal > 0
      ? it.schedule
      : (extraTotal > 0 ? e.schedule : (it.schedule || e.schedule || { done: 0, total: 0 }));
    const completed = existingTotal > 0
      ? !!it.completed
      : (e.completed != null ? !!e.completed : !!it.completed);
    Object.assign(it, {
      schedule,
      completed,
      completionSource: it.completionSource || e.completionSource || '',
      score: e.score != null ? e.score : it.score,
      maxScore: e.maxScore != null ? e.maxScore : it.maxScore,
      hasScore: !!(it.hasScore || e.hasScore),
      weight: e.hasScore ? (Number(e.weight) || 0) : (Number(it.weight) || 0),
      scored: !!(it.scored || e.scored),
      weightUnknown: !!(it.weightUnknown && e.weightUnknown),
      isScore: !!(it.isScore || e.isScore),
      cardsId: it.cardsId || e.cardsId || '',
      activityId: it.activityId || e.activityId || '',
      assignmentId: it.assignmentId || e.assignmentId || '',
      statusMessage: it.statusMessage || e.statusMessage || '',
      total: existingTotal > 0 ? it.total : (e.total || it.total || 0),
    });
  }
  return [...byId.values()];
}

/**
 * 拉取 API 侧数据。任何单个接口失败都不影响其他来源。
 * @returns {Promise<{score:object|null, activities:Array, classCards:Array, assignments:Array, items:Array, errors:Array}>}
 */
export async function loadCourseSnapshot(cid, skuId) {
  const errors = [];
  if (!skuId) {
    try {
      const info = await fetchClassroomInfo(cid);
      skuId = info?.skuId || '';
    } catch (e) {
      errors.push('班级信息：' + (e?.message || e));
    }
  }
  const [scoreRes, actsRes, assignmentsRes] = await Promise.allSettled([
    skuId ? fetchCourseScores(cid, skuId) : Promise.resolve(null),
    fetchLearnActivities(cid),
    fetchAssignments(cid),
  ]);

  const score = scoreRes.status === 'fulfilled' ? scoreRes.value : null;
  if (scoreRes.status === 'rejected') errors.push('成绩：' + (scoreRes.reason?.message || scoreRes.reason));
  const activities = actsRes.status === 'fulfilled' ? actsRes.value : [];
  if (actsRes.status === 'rejected') errors.push('学习日志：' + (actsRes.reason?.message || actsRes.reason));
  const assignments = assignmentsRes.status === 'fulfilled' ? assignmentsRes.value : [];
  if (assignmentsRes.status === 'rejected') errors.push('作业/考试：' + (assignmentsRes.reason?.message || assignmentsRes.reason));

  const classCards = pickClassCards(activities);
  const cardItems = [];
  // 只读 view_depth 的逐页进度；并发限制 3，避免一次打几十个请求。
  const queue = [...classCards];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const c = queue.shift();
      try {
        const p = await fetchClassCardProgress(cid, c.cardsId);
        cardItems.push({
          id: `classcard:${c.cardsId}`,
          title: c.title,
          type: 7,
          typeLabel: TYPE_LABEL[7],
          schedule: { done: num(p.depth), total: Math.max(num(c.count), num(p.depth)) },
          completed: num(p.depth) > 0 && num(p.depth) >= Math.max(num(c.count), num(p.depth)),
          completionSource: 'class-card',
          brushable: true,
          scored: false,
          weight: 0,
          weightUnknown: true,
          isScore: false,
          cardsId: c.cardsId,
          activityId: c.activityId,
          total: Math.max(num(c.count), num(p.depth)),
          state: 'idle',
        });
      } catch (e) {
        errors.push(`班级课件 ${c.title}：` + (e?.message || e));
      }
    }
  }));

  const items = [
    ...scoreRows(score),
    ...activityRows(activities),
    ...assignmentRows(assignments),
    ...cardItems,
  ];
  return { score, activities, classCards, assignments, items, errors };
}
