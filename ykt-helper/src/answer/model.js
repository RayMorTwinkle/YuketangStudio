// src/answer/model.js
// 答题链路的单一事实源：
//   QType      —— 题型语义（不再用 1..5 数字表达判断题/投票题）
//   AnswerTask —— 一道题 + 它的提交目标
//   Answer     —— 模型产出的结构化答案
// 所有适配器、prompt、解析、序列化、提交都只认这里的定义。

export const QTYPE = {
  SINGLE: 'single',
  MULTIPLE: 'multiple',
  JUDGE: 'judge',
  FILL: 'fill',
  SUBJECTIVE: 'subjective',
  POLL: 'poll',
  UNKNOWN: 'unknown',
};

export const TYPE_LABELS = {
  [QTYPE.SINGLE]: '单选题',
  [QTYPE.MULTIPLE]: '多选题',
  [QTYPE.JUDGE]: '判断题',
  [QTYPE.FILL]: '填空题',
  [QTYPE.SUBJECTIVE]: '主观题',
  [QTYPE.POLL]: '投票题',
  [QTYPE.UNKNOWN]: '题目',
};

export const ERROR = {
  NO_TASK: 'NO_TASK',
  NO_TOOL: 'NO_TOOL',
  INVALID_ARGS: 'INVALID_ARGS',
  INVALID_ANSWER: 'INVALID_ANSWER',
  EMPTY_ANSWER: 'EMPTY_ANSWER',
  TOOL_UNSUPPORTED: 'TOOL_UNSUPPORTED',
  HTTP: 'HTTP',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  SUBMIT_FAILED: 'SUBMIT_FAILED',
  UNKNOWN: 'UNKNOWN',
};

export class AnswerError extends Error {
  /**
   * @param {string} code ERROR.*
   * @param {string} message 面向模型/用户的说明
   * @param {{retryable?: boolean, cause?: any, detail?: any}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message || code);
    this.name = 'AnswerError';
    this.code = code;
    this.retryable = opts.retryable !== false;
    this.detail = opts.detail || null;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** 判断题常见符号/词 */
const JUDGE_TRUE = ['√', '对', '正确', 'TRUE', 'T', '1', '是'];
const JUDGE_FALSE = ['×', 'X', '错', '错误', 'FALSE', 'F', '0', '否'];

const STRING_TYPE_MAP = {
  singlechoice: QTYPE.SINGLE,
  single_choice: QTYPE.SINGLE,
  single: QTYPE.SINGLE,
  radio: QTYPE.SINGLE,
  multiplechoice: QTYPE.MULTIPLE,
  multiple_choice: QTYPE.MULTIPLE,
  multiple: QTYPE.MULTIPLE,
  multi: QTYPE.MULTIPLE,
  checkbox: QTYPE.MULTIPLE,
  judgement: QTYPE.JUDGE,
  judgment: QTYPE.JUDGE,
  judge: QTYPE.JUDGE,
  truefalse: QTYPE.JUDGE,
  true_false: QTYPE.JUDGE,
  fillblank: QTYPE.FILL,
  fill_blank: QTYPE.FILL,
  fill: QTYPE.FILL,
  blank: QTYPE.FILL,
  subjective: QTYPE.SUBJECTIVE,
  essay: QTYPE.SUBJECTIVE,
  qa: QTYPE.SUBJECTIVE,
  poll: QTYPE.POLL,
  vote: QTYPE.POLL,
  exam: QTYPE.UNKNOWN,
  link: QTYPE.UNKNOWN,
};

/** 选项文本是否像判断题的“正确/错误” */
function looksLikeJudgeOptions(options) {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const texts = options.map((o) => String(o?.text ?? o?.value ?? o?.label ?? '').trim()).filter(Boolean);
  if (!texts.length) return false;
  const all = texts.join(' ');
  return /(√|×|对|错|正确|错误|TRUE|FALSE|是|否)/i.test(all);
}

/**
 * 归一化题型。
 * @param {string|number|null} raw
 * @param {{source?: 'classroom'|'assignment'|'problem-list', options?: Array}} [opts]
 * @returns {string} QTYPE.*
 */
export function normalizeType(raw, opts = {}) {
  const source = opts.source || 'classroom';
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (STRING_TYPE_MAP[key]) return STRING_TYPE_MAP[key];
    const compact = key.replace(/_/g, '');
    if (STRING_TYPE_MAP[compact]) return STRING_TYPE_MAP[compact];
    // 数字字符串
    if (/^\d+$/.test(key)) return normalizeType(Number(key), opts);
    return QTYPE.UNKNOWN;
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) return QTYPE.UNKNOWN;

  // 课堂约定：1单选 2多选 3投票 4填空 5主观。
  // 判断题在课堂里通常也是 1（选项为 正确/错误 或 √/×），这里按选项内容识别。
  if (n === 1) return looksLikeJudgeOptions(opts.options) ? QTYPE.JUDGE : QTYPE.SINGLE;
  if (n === 2) return QTYPE.MULTIPLE;
  if (n === 3) return source === 'assignment' ? QTYPE.JUDGE : QTYPE.POLL;
  if (n === 4) return QTYPE.FILL;
  if (n === 5) return QTYPE.SUBJECTIVE;
  return QTYPE.UNKNOWN;
}

/** canonical type → 课堂接口的 problemType 数字 */
export function toClassroomCode(type) {
  switch (type) {
    case QTYPE.SINGLE:
    case QTYPE.JUDGE:
      return 1;
    case QTYPE.MULTIPLE:
      return 2;
    case QTYPE.POLL:
      return 3;
    case QTYPE.FILL:
      return 4;
    case QTYPE.SUBJECTIVE:
      return 5;
    default:
      return null;
  }
}

export function isChoiceType(type) {
  return type === QTYPE.SINGLE || type === QTYPE.MULTIPLE || type === QTYPE.JUDGE || type === QTYPE.POLL;
}

export function isSupportedType(type) {
  return !!TYPE_LABELS[type] && type !== QTYPE.UNKNOWN;
}

export function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS[QTYPE.UNKNOWN];
}

/** 选项归一化：{key,text}，兼容 value/label/content */
export function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o, i) => {
      if (o == null) return null;
      if (typeof o === 'string' || typeof o === 'number') {
        return { key: String.fromCharCode(65 + i), text: String(o) };
      }
      const key = String(o.key ?? o.Key ?? o.label ?? o.Label ?? String.fromCharCode(65 + i)).trim();
      const text = String(o.text ?? o.value ?? o.Value ?? o.content ?? '').trim();
      return key ? { key, text } : null;
    })
    .filter(Boolean);
}

/** 选项 key 集合（大写比较；保留原始 key 用于提交） */
export function optionKeySet(taskOrQuestion) {
  const q = taskOrQuestion?.question || taskOrQuestion || {};
  const keys = [];
  for (const o of q.options || []) if (o?.key) keys.push(String(o.key));
  for (const k of q.optionLabels || []) if (k) keys.push(String(k));
  return [...new Set(keys)];
}

/** 判断题符号 → 语义；不是判断题符号返回 null */
export function judgeSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  if (JUDGE_TRUE.includes(s)) return true;
  if (JUDGE_FALSE.includes(s)) return false;
  return null;
}

/**
 * 根据“正确/错误”语义在选项里找 key。
 * 只按选项文本/key 语义匹配；绝不按位置猜。
 * @returns {{key:string, matched:'text'|'key'}|null}
 */
export function findJudgeOption(taskOrQuestion, truthy) {
  const q = taskOrQuestion?.question || taskOrQuestion || {};
  const options = Array.isArray(q.options) ? q.options : [];
  const words = truthy ? JUDGE_TRUE : JUDGE_FALSE;

  // 1) 选项 key 本身就是 √/×/对/错
  for (const o of options) {
    const k = String(o?.key ?? '').trim().toUpperCase();
    if (words.includes(k)) return { key: String(o.key), matched: 'key' };
  }
  // 2) 选项文本包含语义词（优先完全相等，其次包含）
  for (const o of options) {
    const text = String(o?.text ?? '').trim().toUpperCase();
    if (!text) continue;
    if (words.includes(text)) return { key: String(o.key), matched: 'text' };
  }
  for (const o of options) {
    const text = String(o?.text ?? '').trim().toUpperCase();
    if (!text) continue;
    if (words.some((w) => text === w || text.includes(w))) return { key: String(o.key), matched: 'text' };
  }
  // 3) optionLabels 本身是 √/×
  for (const k of q.optionLabels || []) {
    const up = String(k).trim().toUpperCase();
    if (words.includes(up)) return { key: String(k), matched: 'key' };
  }
  return null;
}

/** 展示用：把答案数组拼成字符串 */
export function displayAnswer(answer) {
  if (!answer) return '';
  if (answer.kind === 'subjective') return answer.text || '';
  if (answer.kind === 'fill') return (answer.values || []).join(' | ');
  return (answer.values || []).join('、');
}

/** 构造一个安全的 task id 片段 */
export function safeId(v) {
  return String(v ?? '').replace(/[^\w.-]+/g, '_').slice(0, 80);
}
