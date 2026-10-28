// src/quiz/course-cards.js
// 班级上传课件（logs/learn type=2）与课程成绩只读数据层。
// 课堂课件（type=14）是另一条链路，不能和这里混用：
//   - type=14：老师上过课的课堂记录，只下载，不刷
//   - type=2：老师直接上传到班级的课件，可下载，也是刷课目标
import { proGet } from './active-http.js';
import { dataOf } from './active-core.js';

const enc = encodeURIComponent;
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

/** 拉取学习日志原始活动，按页去重，避免服务端忽略分页时死循环。 */
export async function fetchLearnActivities(cid) {
  const all = [];
  const seenPages = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = dataOf(await proGet(
      `/v2/api/web/logs/learn/${enc(cid)}?actype=-1&page=${page}&offset=${PAGE_SIZE}&sort=-1`,
    ));
    const items = Array.isArray(data.activities) ? data.activities : [];
    const signature = JSON.stringify(items);
    if (seenPages.has(signature)) break;
    seenPages.add(signature);
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * 从学习日志里挑出班级上传课件。
 * @returns {{activityId:string,cardsId:string,title:string,count:number,createTime:number}[]}
 */
export function pickClassCards(activities) {
  const rows = new Map();
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!a || Number(a.type) !== 2) continue;
    const cardsId = String(a.courseware_id || '').trim();
    if (!cardsId) continue;
    const activityId = String(a.id || '').trim();
    const key = `${activityId}:${cardsId}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      activityId,
      cardsId,
      title: String(a.title || `班级课件 ${cardsId}`),
      count: Number(a.count) || 0,
      createTime: Number(a.create_time) || 0,
    });
  }
  return [...rows.values()].sort((a, b) => b.createTime - a.createTime);
}

/** 拉取班级上传课件列表（type=2）。 */
export async function fetchClassCards(cid) {
  return pickClassCards(await fetchLearnActivities(cid));
}

/** 拉取单个班级课件的完整页面。 */
export async function fetchClassCardDetail(cid, cardsId) {
  const data = dataOf(await proGet(
    `/v2/api/web/cards/detlist/${enc(cardsId)}?classroom_id=${enc(cid)}`,
  ));
  return data;
}

/** 班级课件阅读进度（官方 view_depth）。 */
export async function fetchClassCardProgress(cid, cardsId) {
  const data = dataOf(await proGet(
    `/v2/api/web/cards/view_depth?classroom_id=${enc(cid)}&cards_id=${enc(cardsId)}`,
  ));
  return {
    depth: Number(data?.depth) || 0,
    duration: Number(data?.duration) || 0,
    finishTime: data?.finish_time || null,
    depthDetail: Array.isArray(data?.depth_detail) ? data.depth_detail : [],
  };
}

function slideCover(slide) {
  return String(
    slide?.Cover ||
    slide?.Background?.Data ||
    '',
  ).trim();
}

/**
 * cards/detlist → 现有 presentation 数据结构。
 * slide id 加 classcards: 前缀，避免和课堂 slide 的数字 id 冲突。
 */
export function buildClassCardPresentation({ cid, cardsId, activityId = '', title = '', detail = {} } = {}) {
  const sourceSlides = Array.isArray(detail?.Slides) ? detail.Slides : [];
  const slides = sourceSlides
    .map((s, i) => {
      const page = Number(s?.PageIndex) || i + 1;
      const image = slideCover(s);
      return {
        id: `classcards:${cardsId}:${s?.SlideID ?? page}`,
        index: page,
        page,
        title: `第 ${page} 页`,
        thumbnail: image,
        image,
        problem: null,
        classCard: true,
      };
    })
    .filter((s) => s.image);
  if (!slides.length) return null;
  const width = Number(detail?.Width) || Number(detail?.last_cover_width) || 1280;
  const height = Number(detail?.Height) || 720;
  return {
    id: `classcards:${cardsId}`,
    title: String(title || detail?.Title || `班级课件 ${cardsId}`),
    source: 'class-card',
    cardsId: String(cardsId),
    activityId: String(activityId || ''),
    classroomId: String(cid || ''),
    width,
    height,
    slides,
  };
}

/** 课程列表里补上成绩接口需要的 skuId。 */
export function normalizeCourse(c = {}) {
  return {
    id: String(c.classroom_id || ''),
    name: c.name || c.course_name || c.course?.name || '课程',
    role: c.role,
    skuId: String(c.free_sku_id || c.sku_id || ''),
    courseId: String(c.course_id || c.course?.id || ''),
    universityId: String(c.course?.university_id || c.university_id || ''),
    teacher: c.teacher_name || c.teacher?.name || '',
  };
}

/** 我的成绩 + 班级统计（只读；接口未公开时返回 null 字段）。 */
export async function fetchCourseScores(cid, skuId) {
  if (!cid || !skuId) return { summary: null, statistic: null, items: [] };
  const q = `classroom_id=${enc(cid)}&sku_id=${enc(skuId)}`;
  const [detailRes, statisticRes] = await Promise.allSettled([
    proGet(`/c27/online_courseware/schedule/score_detail/single/${enc(skuId)}/0/?${q}`, { xtbz: 'ykt' }).then(dataOf),
    proGet(`/c27/online_courseware/schedule/score_statistic/${enc(cid)}/${enc(skuId)}/?${q}`, { xtbz: 'ykt' }).then(dataOf),
  ]);
  const detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
  const statistic = statisticRes.status === 'fulfilled' ? statisticRes.value : null;
  if (!detail && !statistic) {
    throw (detailRes.status === 'rejected' ? detailRes.reason : statisticRes.reason)
      || new Error('成绩接口读取失败');
  }
  const evaluation = Array.isArray(detail?.evaluation_list) ? detail.evaluation_list : [];
  return {
    summary: {
      finalScore: toNumber(detail?.user_final_score),
      evaluation: evaluation.map((e) => ({
        id: String(e?.id ?? ''),
        name: String(e?.name || ''),
        proportion: toNumber(e?.proportion),
      })),
    },
    statistic: {
      max: toNumber(statistic?.data?.max_score),
      min: toNumber(statistic?.data?.min_score),
      average: toNumber(statistic?.data?.average_score),
      passCount: toNumber(statistic?.data?.pass_user_num),
      interval: Array.isArray(statistic?.data?.score_interval) ? statistic.data.score_interval : [],
    },
    items: (Array.isArray(detail?.leaf_level_infos) ? detail.leaf_level_infos : []).map((x) => ({
      id: String(x?.id ?? ''),
      title: String(x?.leaf_level_title || x?.leaf_chapter_title || ''),
      leafType: Number(x?.leaf_type) || 0,
      evaluationId: x?.evaluation_id == null ? null : String(x.evaluation_id),
      userScore: toNumber(x?.user_score),
      leafScore: toNumber(x?.leaf_score),
      isExpired: x?.is_expired === true,
    })),
  };
}

function toNumber(v) {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
