// src/answer/parse.js
// 严格答案解析：
//   - 只接受选项标签，绝不从任意文本抽 A-Z
//   - 判断题只按选项语义/标签映射，绝不按位置猜 √/×
//   - 填空校验空位数
//   - 返回 Answer / AnswerError
import {
  QTYPE, ERROR, AnswerError, judgeSymbol, findJudgeOption, optionKeySet,
} from './model.js';

function fail(code, message) {
  throw new AnswerError(code, message);
}

function keyMaps(task) {
  const keys = optionKeySet(task);
  const upper = new Map();
  for (const k of keys) upper.set(String(k).toUpperCase(), String(k));
  return { keys, upper };
}

/** 把单个 answer 字符串拆成 token；不拆普通文本里的字母 */
function splitToken(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  // 明确的分隔符（逗号/顿号/分号/竖线/换行/制表符/多空格）
  if (/[,，、;；|｜\n\t]/.test(s)) {
    return s.split(/[,，、;；|｜\n\t]+/).map((x) => x.trim()).filter(Boolean);
  }
  // 纯空格分隔的多个单字符标签（"A B"）才拆；含普通单词的不拆
  if (/\s/.test(s)) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => p.length <= 2)) return parts;
  }
  return [s];
}

function normalizeToken(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[[(（【"'“”]+/, '')
    .replace(/[\])）】"'“”。.]+$/, '')
    .trim();
}

function parseChoice(task, answers) {
  const { keys, upper } = keyMaps(task);
  const type = task?.question?.type;
  const tokens = [];
  for (const a of answers) {
    for (const piece of splitToken(a)) {
      const t = normalizeToken(piece);
      if (!t) continue;
      // 多选连写 "AC"：只有每个字符都是合法 key 时才拆
      const compact = t.replace(/[\s,，、;；|｜]/g, '').toUpperCase();
      if (compact.length > 1 && keys.length && [...compact].every((c) => upper.has(c))) {
        for (const c of compact) tokens.push(upper.get(c));
        continue;
      }
      if (upper.has(t.toUpperCase())) {
        tokens.push(upper.get(t.toUpperCase()));
        continue;
      }
      // 没有选项 key 的极端情况（作业 Bullets 缺失）：只接受纯 A-Z 标签
      if (!keys.length && /^[A-Za-z]$/.test(t)) {
        tokens.push(t.toUpperCase());
        continue;
      }
      if (!keys.length && /^[A-Za-z]{2,}$/.test(t) && type !== QTYPE.SINGLE && type !== QTYPE.POLL) {
        for (const c of t.toUpperCase()) tokens.push(c);
        continue;
      }
      fail(
        ERROR.INVALID_ANSWER,
        `答案「${t}」不是有效选项${keys.length ? `（可选：${keys.join('、')}）` : ''}`,
      );
    }
  }
  const unique = [...new Set(tokens)];
  if (!unique.length) fail(ERROR.EMPTY_ANSWER, '没有解析到选项标签');
  if ((type === QTYPE.SINGLE || type === QTYPE.JUDGE || type === QTYPE.POLL) && unique.length > 1) {
    fail(ERROR.INVALID_ANSWER, `本题只能选一个选项，收到：${unique.join('、')}`);
  }
  // 按选项顺序排序，展示更稳定
  const order = new Map(keys.map((k, i) => [String(k).toUpperCase(), i]));
  unique.sort((a, b) => (order.get(a.toUpperCase()) ?? 999) - (order.get(b.toUpperCase()) ?? 999));
  return unique;
}

function parseJudge(task, answers) {
  const { keys, upper } = keyMaps(task);
  const out = [];
  for (const a of answers) {
    for (const piece of splitToken(a)) {
      const t = normalizeToken(piece);
      if (!t) continue;
      // 1) 直接是选项标签
      if (upper.has(t.toUpperCase())) {
        out.push(upper.get(t.toUpperCase()));
        continue;
      }
      // 没有选项标签的极端情况：接受单个 A-Z
      if (!keys.length && /^[A-Za-z]$/.test(t)) {
        out.push(t.toUpperCase());
        continue;
      }
      // 2) 判断题符号/词 → 按选项文本或 key 映射
      const truthy = judgeSymbol(t);
      if (truthy != null) {
        const hit = findJudgeOption(task, truthy);
        if (hit) {
          out.push(hit.key);
          continue;
        }
        fail(
          ERROR.INVALID_ANSWER,
          `本题选项只有 ${keys.length ? keys.join('、') : '标签'}，请只输出选项标签，不要输出「${t}」`,
        );
      }
      fail(
        ERROR.INVALID_ANSWER,
        `答案「${t}」不是有效选项${keys.length ? `（可选：${keys.join('、')}）` : ''}`,
      );
    }
  }
  const unique = [...new Set(out)];
  if (!unique.length) fail(ERROR.EMPTY_ANSWER, '没有解析到判断题答案');
  if (unique.length > 1) fail(ERROR.INVALID_ANSWER, `判断题只能选一个选项，收到：${unique.join('、')}`);
  return unique;
}

function parseFill(task, answers) {
  const values = [];
  for (const a of answers) {
    const s = String(a ?? '');
    if (!s.trim()) continue;
    if (/[\n|｜]/.test(s)) {
      for (const part of s.split(/[\n|｜]+/)) {
        const v = part.trim();
        if (v) values.push(v);
      }
    } else {
      values.push(s.trim());
    }
  }
  if (!values.length) fail(ERROR.EMPTY_ANSWER, '没有解析到填空答案');
  const expected = Number(task?.question?.blanks) || 0;
  if (expected > 0 && values.length !== expected) {
    fail(ERROR.INVALID_ANSWER, `空位数不匹配：题目 ${expected} 空，收到 ${values.length} 项`);
  }
  return values;
}

function parseSubjective(answers) {
  const text = answers.map((a) => String(a ?? '').trim()).filter(Boolean).join('\n').trim();
  if (!text) fail(ERROR.EMPTY_ANSWER, '没有解析到主观题答案');
  return text;
}

/**
 * 置信度归一化：'85%' → 0.85；>1 且 ≤100 的数视为百分数（85 → 0.85）；
 * 非有限数 → null；结果钳制到 [0, 1]。
 */
export function normalizeConfidence(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return null;
  const percent = typeof raw === 'string' && raw.endsWith('%');
  const numeric = percent ? Number(raw.replace(/%$/, '')) : Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
  const normalized = percent || (numeric > 1 && numeric <= 100) ? numeric / 100 : numeric;
  return Math.max(0, Math.min(1, normalized));
}

/**
 * 归一化一份答案。
 * @param {object} task
 * @param {object|Array|string} raw {answers, reason, confidence} / answers / string
 * @param {'tool'|'regex'|'text'} source
 * @returns {object} Answer
 */
export function normalizeAnswer(task, raw, source = 'tool') {
  if (!task) fail(ERROR.NO_TASK, '没有题目上下文');
  let args = raw;
  if (typeof args === 'string') args = { answers: [args] };
  if (Array.isArray(args)) args = { answers: args };
  if (!args || typeof args !== 'object') fail(ERROR.INVALID_ARGS, '答案格式不正确');

  let answers = args.answers;
  if (typeof answers === 'string') answers = [answers];
  if (!Array.isArray(answers)) fail(ERROR.INVALID_ARGS, 'answers 必须是数组');
  answers = answers.map((x) => String(x ?? '')).filter((x) => x.trim());
  if (!answers.length) fail(ERROR.EMPTY_ANSWER, 'answers 为空');

  const type = task?.question?.type;
  const reason = String(args.reason || '').trim();
  const confidence = normalizeConfidence(args.confidence);
  if (type === QTYPE.SINGLE || type === QTYPE.MULTIPLE || type === QTYPE.POLL) {
    return { kind: 'choice', values: parseChoice(task, answers), text: '', reason, confidence, source };
  }
  if (type === QTYPE.JUDGE) {
    return { kind: 'choice', values: parseJudge(task, answers), text: '', reason, confidence, source };
  }
  if (type === QTYPE.FILL) {
    return { kind: 'fill', values: parseFill(task, answers), text: '', reason, confidence, source };
  }
  if (type === QTYPE.SUBJECTIVE) {
    const text = parseSubjective(answers);
    return { kind: 'subjective', values: [text], text, reason, confidence, source };
  }
  fail(ERROR.INVALID_ANSWER, `不支持的题型：${type}`);
}

/** 从 tools 响应里取 submit_answer，并严格解析 */
export function parseToolCall(task, toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const call = toolCalls.find((t) => t?.function?.name === 'submit_answer');
  if (!call) return null;
  const raw = call.function?.arguments;
  let args;
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AnswerError(ERROR.INVALID_ARGS, '工具参数不是合法 JSON');
  }
  return normalizeAnswer(task, args, 'tool');
}

function normalizeTags(text) {
  return String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
}

/** 从正文里取最后一个 <answer> 块 */
export function extractRegexBody(content) {
  const text = normalizeTags(content);
  if (!text) return '';
  if (/^\s*STATE\s*:/im.test(text) || /\bNO_PROMPT\b/i.test(text)) return '';
  const re = /<(answer|答案)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m;
  return last ? String(last[2] || '').trim() : '';
}

/** 解析 regex <answer> */
export function parseRegex(task, content) {
  const body = extractRegexBody(content);
  if (!body) return null;
  const type = task?.question?.type;
  if (type === QTYPE.FILL) {
    const parts = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1 && /[|｜]/.test(parts[0])) {
      return normalizeAnswer(task, { answers: parts[0].split(/[|｜]/) }, 'regex');
    }
    return normalizeAnswer(task, { answers: parts }, 'regex');
  }
  return normalizeAnswer(task, { answers: [body] }, 'regex');
}

/** 从展示正文里去掉所有 <answer> 块 */
export function stripRegexAnswer(content) {
  const out = normalizeTags(content).replace(/<(answer|答案)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 旧文本格式（仅展示/手动兜底）：
 * 只认「答案:」行；选择题必须是纯标签，不做 A-Z 抽取。
 */
export function parseLegacy(task, content) {
  const text = String(content || '');
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let idx = -1;
  let answerLine = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*答案\s*[:：]\s*(.*)$/);
    if (m) { idx = i; answerLine = m[1].trim(); break; }
  }
  if (idx < 0) return null;
  const type = task?.question?.type;
  if (type === QTYPE.FILL) {
    const block = [answerLine];
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\s*解释\s*[:：]/.test(lines[i])) break;
      block.push(lines[i].trim());
    }
    return normalizeAnswer(task, { answers: block.filter(Boolean) }, 'text');
  }
  return normalizeAnswer(task, { answers: [answerLine] }, 'text');
}

/** 给 UI 的错误文案 */
export function errorText(error) {
  if (!error) return '';
  return String(error.message || error.code || error);
}
