// src/quiz/exam.js
// 考试（type 20）只读链路：
//   EP4  GET  /v/exam/cover?exam_id=&classroom_id=[&sku_id=]        （pro 同源）
//   EP5  POST /v/exam/gen_token {exam_id, classroom_id}              （pro 同源，xtbz/xt-agent/referer）
//   EP6  GET  {exam_host}/login?exam_id&user_id&crypt&next&language  （跨域 gm；接受 200/302/303）
//   EP7-9 GET {exam_host}/exam_room/{cover,problem_results,show_paper}?exam_id=
// 只读：绝不发起开始/重置/交卷类请求；跨域请求不携带 pro 平台凭据。
import { proGet, proPost, gmGet } from './active-http.js';
import {
  AuthError, dataOf, parseExamHost, parseExamProgress, canReviewExam, joinExamPaper,
} from './active-core.js';

const enc = encodeURIComponent;

/** EP4 路径（enrichAssignments 复用）。 */
export function examCoverPath({ leafTypeId, classroomId, skuId }) {
  const query = new URLSearchParams({
    exam_id: String(leafTypeId || ''),
    classroom_id: String(classroomId || ''),
  });
  if (skuId) query.set('sku_id', String(skuId));
  return `/v/exam/cover?${query}`;
}

/**
 * EP5-6：gen_token 换取考试域入口并完成 login。
 * 返回 examGet(path) 读取器：路径白名单 + cover 首调强制校验 user_id
 * 与 token 一致后才放行题目接口（401/403/3xx → AuthError）。
 */
export async function openExamReview(row) {
  const tokenData = dataOf(await proPost('/v/exam/gen_token', {
    exam_id: row.leafTypeId,
    classroom_id: row.classroomId,
  }, {
    xtbz: 'ykt',
    'xt-agent': 'web',
    'classroom-id': String(row.classroomId || ''),
    'university-id': '0',
    'uv-id': '0',
    // 注意：fetch 无法设置 Referer（forbidden header），这里不再传无效值；
    // 实测 gen_token 依赖 xtbz/xt-agent/classroom-id/university-id/uv-id + 浏览器自动 Referer 即可。
  }));
  const token = typeof tokenData.token === 'string' ? tokenData.token : '';
  const userIdOk =
    ['number', 'string'].includes(typeof tokenData.user_id) &&
    String(tokenData.user_id) !== '';
  if (!token || !userIdOk) throw new AuthError();
  const origin = parseExamHost(tokenData.exam_host);
  const resultUrl = `${origin}/result/${enc(String(row.leafTypeId))}?isFrom=2`;
  const loginQuery = new URLSearchParams({
    exam_id: String(row.leafTypeId),
    user_id: String(tokenData.user_id),
    crypt: token,
    next: resultUrl,
    language: 'zh',
  });
  // GM 自动跟随重定向，正常终态 200（结果页）；302/303 为个别实现的中间态上报
  const login = await gmGet(`${origin}/login?${loginQuery}`);
  if (![200, 302, 303].includes(login.status)) throw new AuthError();
  let verifiedUser = false;
  return async (path) => {
    if (
      !['/exam_room/cover', '/exam_room/problem_results', '/exam_room/show_paper'].includes(path)
    ) {
      throw new Error('不支持的考试结果接口。');
    }
    if (path !== '/exam_room/cover' && !verifiedUser) throw new AuthError();
    const res = await gmGet(
      `${origin}${path}?${new URLSearchParams({ exam_id: String(row.leafTypeId) })}`,
      { 'x-client': 'web', xtbz: 'cloud', referer: resultUrl },
    );
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new AuthError();
    }
    if (res.status !== 200) throw new Error(`考试结果读取失败（HTTP ${res.status}）。`);
    let body;
    try {
      body = JSON.parse(String(res.responseText ?? ''));
    } catch {
      throw new Error('考试结果返回非 JSON。');
    }
    if (path === '/exam_room/cover') {
      const user = dataOf(body).user;
      const u = user !== null && typeof user === 'object' ? user : null;
      if (!u || String(u.user_id ?? '') !== String(tokenData.user_id)) throw new AuthError();
      verifiedUser = true;
    }
    return body;
  };
}

/**
 * 考试详情（只读）：
 *   1. EP4 拉最新 cover —— 即使列表缓存说已出分也以实时为准；
 *   2. 未达回顾门禁（未交卷/未出分/缺考/作废/未公布）→ 只返回状态，不碰 token；
 *   3. 达门禁 → EP5-9 考试域复核 cover 后读 problem_results + show_paper 拼卷。
 */
export async function fetchExamReview(row) {
  const cover = dataOf(await proGet(examCoverPath(row)));
  const base = {
    mode: 'exam-cover',
    progress: parseExamProgress(cover),
    problems: [],
    questions: [],
    fontUrl: null,
    descriptionHtml: '',
  };
  if (!canReviewExam(cover, Date.now())) return base;
  const examGet = await openExamReview(row);
  const reviewCoverBody = await examGet('/exam_room/cover');
  const reviewCover = dataOf(reviewCoverBody);
  const refreshed = {
    ...base,
    progress: parseExamProgress(reviewCover),
  };
  if (!canReviewExam(reviewCover, Date.now())) return refreshed;
  const results = dataOf(await examGet('/exam_room/problem_results'));
  const paper = dataOf(await examGet('/exam_room/show_paper'));
  const joined = joinExamPaper(paper, results, reviewCover);
  return {
    ...refreshed,
    mode: 'exam-review',
    problems: joined.problems,
    questions: joined.questions,
    fontUrl: joined.fontUrl,
    descriptionHtml: joined.descriptionHtml,
  };
}
