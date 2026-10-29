// src/quiz/active-core.js
// 新版作业（type 19）/考试（type 20）纯函数核心：数据解包、状态解析、题目解析、试卷拼装、保留窗口。
// 协议参考：smartThise/OneTHU PR #28（b9b82ef）/ PR #32（5225a05），适配本项目数据形态。
// 本文件只含纯函数（无 fetch/DOM），供 active-http/exercise/exam/assignments 复用与单测覆盖。

/** 登录态失效：发现/详情队列遇到后应整体中止并提示用户刷新。 */
export class AuthError extends Error {
  constructor() {
    super('雨课堂登录已失效，请刷新页面或重新登录后再试。');
  }
}

/** 对象则原样返回，否则 null（数组也算非对象）。 */
export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** 字符串则原样返回，否则 ''。 */
export function text(value) {
  return typeof value === 'string' ? value : '';
}

/** string/number → trim 后字符串，否则 ''。 */
export function id(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

/** 非负有限数（字符串数字也接受，如 '0.00'→0）；负数/NaN/Infinity/空串 → null。 */
export function number(value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** 严格非负安全整数（不接受字符串）。 */
export function nonnegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** 严格非负有限数（不接受字符串）。 */
export function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** 分数字段归一：'5.00'→5，-1/缺失 → null。 */
export function numericScore(value) {
  return nonnegativeNumber(
    typeof value === 'string' && value.trim() ? Number(value) : value,
  );
}

/** 学习日志 score_d → 毫秒时间戳；缺失/非法/非正数 → null。 */
export function parseDeadline(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    !Number.isNaN(new Date(value).getTime())
    ? value
    : null;
}

/** 我的作答是否有实质内容（trim 后非空字符串 / 递归数组 / 有限数字）。 */
export function hasAnswer(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasAnswer);
  return typeof value === 'number' && Number.isFinite(value);
}

/** https 绝对/协议相对 URL 规范化；非 https/非法 → null。 */
export function httpsUrl(value) {
  const raw = text(value);
  if (!raw.trim()) return null;
  try {
    const u = new URL(raw, 'https://pro.yuketang.cn/');
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** 5 实体 HTML 转义。 */
export function escapeText(value) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** 正确答案渲染：数组逐项转义后 <br> 连接，字符串原样（服务端 HTML 交由 sanitizeHtml）。 */
export function reviewAnswer(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map((v) => escapeText(String(v)))
      .join('<br>');
  }
  return typeof value === 'number' ? String(value) : '';
}

/** uv_id → university_id → '2598' 兜底（与官网前端行为一致）。 */
export function uvIdFromCookie(cookieString, fallback = '2598') {
  const raw = typeof cookieString === 'string' ? cookieString : '';
  const jar = new Map();
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!jar.has(name)) jar.set(name, part.slice(eq + 1).trim());
  }
  return jar.get('uv_id') || jar.get('university_id') || fallback;
}

/**
 * 解包 {success, data} / {errcode|error_code|code, ...} 信封。
 * 401000/401/403（任意字段）→ AuthError；其余错误码/未成功/缺数据 → Error。
 */
export function dataOf(value) {
  const body = record(value);
  if (!body) throw new Error('雨课堂返回非 JSON，请重新登录后重试。');
  for (const field of ['errcode', 'error_code', 'code']) {
    const code = body[field];
    if (code === undefined || code === null || code === 0 || code === '0') continue;
    if (['401000', '401', '403'].includes(String(code))) throw new AuthError();
    throw new Error(`雨课堂作业接口失败（${field}=${String(code)}）。`);
  }
  if (body.success === false) throw new Error('雨课堂作业接口未成功。');
  const data = record(body.data);
  if (!data) throw new Error('雨课堂作业接口未返回数据。');
  return data;
}

/** 三个日历月（UTC，月末钳制），与宿主时区无关。 */
export function assignmentRetentionCutoff(now = Date.now()) {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 3);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/** 缺失/非法 deadline 不能证明过期，一律保留；否则按三个月窗口过滤。 */
export function isAssignmentRetained(assignment, now = Date.now()) {
  const d =
    assignment !== null && typeof assignment === 'object'
      ? assignment.deadline
      : null;
  return (
    d === null ||
    d === undefined ||
    !Number.isFinite(d) ||
    d >= assignmentRetentionCutoff(now)
  );
}

/**
 * 考试 cover 状态（/v/exam/cover 与 /exam_room/cover 同构）。
 * 已验证官网判定：result.status 4/5=已交卷，6=缺考；monitor_status=2 覆盖为作废；
 * 仅已交卷且 score_finish!==false 且 score/total_score 均为非负有限数才算已出分（零分有效）。
 */
export function parseExamProgress(data) {
  const cover = record(data) ?? {};
  const result = record(cover.result) ?? {};
  const code = result.status;
  const submitted = code === 4 || code === 5;
  const invalid = (record(cover.face_auth_status) ?? {}).monitor_status === 2;
  const examStatus = invalid
    ? 'invalid'
    : submitted
      ? 'submitted'
      : code === 6
        ? 'absent'
        : 'unknown';
  const total = nonnegativeInteger(cover.problem_count);
  const unfinished = nonnegativeInteger(result.unfinished_count);
  const totalCount = total !== null && total > 0 ? total : null;
  // 缺失/越界的未答数不是 0；仅交卷不等于全部作答。
  const answeredCount =
    submitted &&
    !invalid &&
    totalCount !== null &&
    unfinished !== null &&
    unfinished <= totalCount
      ? totalCount - unfinished
      : null;
  const score = nonnegativeNumber(result.score);
  const totalScore = nonnegativeNumber(cover.total_score);
  // 实测：score_finish=null 的考试在官方结果页是空白；必须显式 true 才算已出分。
  const graded =
    submitted &&
    !invalid &&
    result.score_finish === true &&
    score !== null &&
    totalScore !== null;
  return {
    examStatus,
    graded,
    score: graded ? score : null,
    totalScore: graded ? totalScore : null,
    status:
      answeredCount === null
        ? 'unknown'
        : answeredCount === totalCount
          ? 'answered'
          : answeredCount > 0
            ? 'partial'
            : 'unanswered',
    answeredCount,
    totalCount,
    // cover 只有总题数与未答数，无逐题明细。
    questions: [],
    statusMessage:
      examStatus === 'unknown' ? '暂无法获取考试状态，请在官网查看。' : null,
  };
}

/** 考试回顾门禁：已交卷 + 已出分 + 允许查看 + 成绩公布时间已到，才允许读取题目。 */
export function canReviewExam(data, now) {
  const cover = record(data) ?? {};
  const progress = parseExamProgress(cover);
  const release = number(cover.show_score_time);
  return (
    progress.examStatus === 'submitted' &&
    progress.graded === true &&
    cover.show_perm === true &&
    cover.show_score === true &&
    release !== null &&
    release <= (number(cover.server_time) ?? now)
  );
}

/**
 * 考试试卷查看门禁：已交卷 + 老师允许查看 + 公布时间已到。
 * 与 canReviewExam 的区别：不要求已经批改/出分——编程题等待批改时，
 * 官方结果页仍然展示题目和我的答案，脚本也应允许读取并交给 AI 分析。
 * 仍然拒绝未交卷、缺考、作废和明确禁止查看的考试。
 */
export function canViewExamPaper(data, now) {
  const cover = record(data) ?? {};
  const progress = parseExamProgress(cover);
  const release = number(cover.show_score_time);
  return (
    progress.examStatus === 'submitted' &&
    cover.show_perm === true &&
    release !== null &&
    release <= (number(cover.server_time) ?? now)
  );
}

/** 作业批改汇总（graded 仅在证据充分时给出 true/false，否则 null）。 */
function homeworkGraded(problems, aggregate, answered) {
  if (answered === 0 && (aggregate ?? 0) === 0) return false;
  const relevant = problems.filter((value) => {
    const user = record(record(value)?.user) ?? {};
    const answer = record(user.my_answer) ?? {};
    return (
      (aggregate ?? 0) > 0 ||
      [3, 4].includes(user.status) ||
      hasAnswer(answer.content) ||
      (Array.isArray(answer.attachment) && answer.attachment.length > 0)
    );
  });
  if (!relevant.length) return null;
  let allGraded = true;
  for (const value of relevant) {
    const user = record(record(value)?.user) ?? {};
    const rawScore = user.my_score;
    const score =
      typeof rawScore === 'string' && rawScore.trim() ? Number(rawScore) : rawScore;
    // status=3 或 my_score=-1（含 '-1.00'）优先表示待批改。
    if (user.status === 3 || score === -1) return false;
    // 缺少批改字段不能被误判为已批改。
    if (user.status !== 4 && nonnegativeNumber(score) === null) allGraded = false;
  }
  return allGraded ? true : null;
}

/**
 * 作业（exercise）状态汇总：逐题 user 数据缺失时 answered=null（未知≠未答）。
 * problems 为空且 answer_count 缺失时抛错（调用方降级为 statusMessage）。
 */
export function parseProgress(data) {
  const body = record(data) ?? {};
  const raw = Array.isArray(body.problems) ? body.problems : [];
  const aggregate = nonnegativeInteger(numericScore(body.answer_count));
  if (!raw.length && aggregate === null) {
    throw new Error('作业状态数据为空');
  }
  const questions = raw.map((value, index) => {
    const problem = record(value) ?? {};
    const user = record(problem.user);
    const answer = user ? record(user.my_answer) : null;
    return {
      id: id(problem.problem_id) || id(problem.id) || String(index + 1),
      index: index + 1,
      // 缺失的 user 数据不能证明该题未作答。
      answered: !user
        ? null
        : user.status === 3 ||
          user.status === 4 ||
          hasAnswer(record(user.my_answer)?.content) ||
          (answer !== null &&
            Array.isArray(answer.attachment) &&
            answer.attachment.length > 0),
    };
  });
  const answered = questions.filter((q) => q.answered === true).length;
  const allKnown =
    questions.length > 0 && questions.every((q) => q.answered !== null);
  // 聚合数只能证明有活动，不能定位到具体题目。
  const count = answered > 0 ? answered : (aggregate ?? (allKnown ? 0 : null));
  const status =
    allKnown && answered === questions.length
      ? 'answered'
      : count !== null && count > 0
        ? 'partial'
        : allKnown || aggregate === 0
          ? 'unanswered'
          : 'unknown';
  const scored =
    raw.length > 0 &&
    raw.every((value) => {
      const user = record(record(value)?.user) ?? {};
      const content = record(record(value)?.content) ?? {};
      return (
        user.status !== 3 &&
        numericScore(user.my_score) !== null &&
        numericScore(content.score) !== null
      );
    });
  const graded = homeworkGraded(raw, aggregate, answered);
  return {
    status,
    score:
      graded === true && scored
        ? raw.reduce(
            (sum, value) =>
              sum + numericScore((record(record(value)?.user) ?? {}).my_score),
            0,
          )
        : null,
    totalScore:
      graded === true && scored
        ? raw.reduce(
            (sum, value) =>
              sum + numericScore((record(record(value)?.content) ?? {}).score),
            0,
          )
        : null,
    graded,
    answeredCount: count,
    totalCount: questions.length || null,
    questions,
    statusMessage: null,
  };
}

/**
 * 单题解析（exercise 详情 / 考试试卷共用）。
 * status：3=已交待批改；4 或非负 my_score=已批改；有作答内容=已作答；
 * my_answer 显式含 content=未作答；其余=未知。
 */
export function parseProblem(raw, position = 0) {
  const problem = record(raw) ?? {};
  const content = record(problem.content) ?? {};
  const user = record(problem.user) ?? {};
  const answer = record(user.my_answer) ?? {};
  const answerHtml =
    typeof answer.content === 'string'
      ? answer.content
      : Array.isArray(answer.content)
        ? answer.content
            .filter((v) => typeof v === 'string' || typeof v === 'number')
            .map((v) => escapeText(String(v)))
            .join('<br>')
        : typeof answer.content === 'number'
          ? String(answer.content)
          : '';
  const attachments = (
    Array.isArray(answer.attachment) ? answer.attachment : []
  ).flatMap((item) => {
    const entry = record(item) ?? {};
    const name = text(entry.name);
    const href = httpsUrl(entry.url);
    return name || href ? [{ name: name || '附件', url: href }] : [];
  });
  const userStatus = number(user.status);
  const score = number(user.my_score);
  const pendingScore =
    String(user.my_score ?? '').trim() !== '' && Number(user.my_score) === -1;
  const status =
    userStatus === 3
      ? 'submitted'
      : !pendingScore && (userStatus === 4 || score !== null)
        ? 'graded'
        : answerHtml.trim() || attachments.length
          ? 'answered'
          : Object.hasOwn(answer, 'content')
            ? 'unanswered'
            : 'unknown';
  const count = number(user.count);
  const used = number(user.my_count) ?? 0;
  const type = number(content.ProblemType ?? content.Type) ?? 0;
  const typeNames = {
    1: '单选题',
    2: '多选题',
    3: '判断题',
    4: '填空题',
    5: '主观题',
    6: '试卷',
    9: '外链题',
  };
  return {
    id: id(problem.problem_id) || String(position + 1),
    index: number(problem.index) ?? position + 1,
    type,
    typeText: text(content.TypeText) || typeNames[type] || '题目',
    score: number(content.score),
    bodyHtml: text(content.Body),
    options: (Array.isArray(content.Options) ? content.Options : []).map(
      (rawOption, i) => {
        const option = record(rawOption) ?? {};
        return {
          label: text(option.name) || String.fromCharCode(65 + i),
          html:
            typeof rawOption === 'string'
              ? rawOption
              : text(option.content ?? option.Body ?? option.text),
        };
      },
    ),
    answerHtml,
    attachments,
    status,
    myScore: status === 'graded' ? score : null,
    remarkHtml: text(user.remark),
    comments: (Array.isArray(user.comment) ? user.comment : []).flatMap(
      (rawComment) => {
        const item = record(rawComment) ?? {};
        const html = text(item.content);
        return html.trim()
          ? [{ html, name: text(item.name), index: number(item.index) }]
          : [];
      },
    ),
    externalUrl:
      type === 9
        ? httpsUrl((record(content.data) ?? {}).answer_problem_url)
        : null,
    maxRetry: number(content.max_retry ?? problem.max_retry) ?? 0,
    remainingRetries:
      count !== null && count > 0 ? Math.max(0, count - used) : null,
    allowResults: (
      Array.isArray(content.AllowResults) ? content.AllowResults : []
    ).filter((v) => typeof v === 'string'),
  };
}

/**
 * 拼装考试回顾试卷（show_paper × problem_results × exam 域 cover）。
 * 已验证试卷 index 恒为 0、results 与试卷顺序相反：一律按 problem_id 关联并重排 index=i+1。
 * show_answer!==true 时隐去参考答案与解析（answer/Remark）。
 */
export function joinExamPaper(paper, results, reviewCover) {
  const paperBody = record(paper) ?? {};
  const cover = record(reviewCover) ?? {};
  const byId = new Map(
    (Array.isArray(record(results)?.problem_results)
      ? record(results).problem_results
      : []
    )
      .map((raw) => [id(record(raw)?.problem_id), record(raw) ?? {}])
      .filter(([key]) => key),
  );
  const problems = (Array.isArray(paperBody.problems) ? paperBody.problems : []).map(
    (raw, i) => {
      const p = record(raw) ?? {};
      const pid = id(p.problem_id ?? p.ProblemID);
      const result = pid ? byId.get(pid) ?? {} : {};
      const grade = number(result.grade);
      const parsed = parseProblem(
        {
          problem_id: pid,
          index: i + 1,
          content: {
            ...p,
            score: p.score ?? p.Score,
            Options: (Array.isArray(p.Options) ? p.Options : []).map(
              (rawOption) => {
                const option = record(rawOption) ?? {};
                return { name: option.key, content: option.value };
              },
            ),
          },
          user: { my_answer: { content: result.result } },
        },
        i,
      );
      return {
        ...parsed,
        status:
          grade !== null
            ? 'graded'
            : result.finished === false
              ? 'unanswered'
              : result.finished === true
                ? 'submitted'
                : 'unknown',
        myScore: grade,
        correct:
          grade !== null && typeof result.correct === 'boolean'
            ? result.correct
            : null,
        correctAnswerHtml:
          cover.show_answer === true
            ? reviewAnswer(result.answer ?? p.Answer)
            : '',
        explanationHtml: cover.show_answer === true ? text(p.Remark) : '',
      };
    },
  );
  return {
    problems,
    questions: problems.map((p) => {
      const entry = byId.get(p.id);
      return {
        id: p.id,
        index: p.index,
        answered: typeof entry?.finished === 'boolean' ? entry.finished : null,
      };
    }),
    fontUrl: httpsUrl(paperBody.font),
    descriptionHtml: text(cover.description),
  };
}

const EXAM_HOSTS = ['tsinghua-exam.yuketang.cn', 'changjiang-exam.yuketang.cn', 'examination.xuetangx.com'];

/**
 * gen_token 返回的 exam_host 白名单校验：仅 https、无凭据/端口、域名在白名单内。
 * 非法/不支持 → Error（提示去官网），默认缺省为 examination.xuetangx.com。
 */
export function parseExamHost(value) {
  let host;
  try {
    host = new URL(
      typeof value === 'string' && value
        ? value
        : 'https://examination.xuetangx.com',
    );
  } catch {
    throw new Error('考试结果服务地址暂不支持，请在官网查看。');
  }
  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.port ||
    !EXAM_HOSTS.includes(host.hostname)
  ) {
    throw new Error('考试结果服务地址暂不支持，请在官网查看。');
  }
  return host.origin;
}
