// src/ai/tools.js
// 「提交答案」工具：定义 + 参数归一化。
// 设计原则：模型只负责产出结构化答案，真正的提交由前端 submit-flow 完成
// （含过期补交判断、二次确认），模型没有直接提交权限。

export const SUBMIT_ANSWER_TOOL = {
  type: 'function',
  function: {
    name: 'submit_answer',
    description:
      '把本题的最终答案提交到雨课堂。确定答案后必须调用本工具；只输出文字不算完成。'
      + '选择题传选项字母；填空题按空位顺序每空一项；主观题传完整作答文本。',
    parameters: {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          items: { type: 'string' },
          description:
            '答案数组。单选/多选/投票：["A"] 或 ["A","C"]；'
            + '填空：每个空一项，如 ["12","3.5"]；主观/问答：一个元素，内容为完整作答文本。',
        },
        reason: {
          type: 'string',
          description: '一句话说明选择该答案的理由（可选）。',
        },
      },
      required: ['answers'],
    },
  },
};

/**
 * 运行时追加到 system prompt 的工具使用要求。
 * 不写进 DEFAULT_SYSTEM_PROMPT_AI，避免用户自定义提示词把工具规则覆盖掉。
 * @param {object|null} problem
 * @param {{mandatory?: boolean}} [opts] mandatory=自动作答，必须调用工具
 */
export function toolPromptBlock(problem, { mandatory = false } = {}) {
  if (!problem) return '';
  const isQuiz = problem.__submitTarget === 'quiz';
  const lines = [
    '【工具使用要求】',
    isQuiz
      ? '当前是作业题：submit_answer 只会把答案暂存到该题，不会交卷。确定答案后仍然必须调用工具；只输出文字不算完成。'
      : '当前页有可提交的题目。确定最终答案后，必须调用 submit_answer 工具提交答案；只输出文字不算完成。',
    'submit_answer 的 answers 参数：',
    '- 单选/多选/投票：选项字母数组，例如 ["A"] 或 ["A","C"]；',
    '- 填空：按空位顺序，每个空一项；',
    '- 主观/问答：一个元素，内容为完整作答文本。',
    isQuiz ? '暂存成功后可以继续给用户简要说明思路。' : '提交成功后可以继续给用户简要说明思路。',
  ];
  if (mandatory) lines.push('本次为自动作答：必须调用 submit_answer，否则本次作答视为失败。');
  return lines.join('\n');
}

/** 判断错误是否属于「当前端点不支持 tool calling」 */
export function isToolUnsupportedError(err) {
  const msg = String(err?.message || err || '');
  // 常见形态：HTTP 400: {"error":{"message":"tools is not supported ..."}}
  if (!/HTTP\s*400/i.test(msg) && !/HTTP\s*422/i.test(msg)) return false;
  return /tool|function[_ ]?call|tool_choice/i.test(msg);
}

/**
 * 归一化工具参数 → 提交用的 content 与结构化 result。
 * @param {string|object} rawArgs 模型返回的 arguments（通常是 JSON 字符串）
 * @param {number} problemType 1单选 2多选 3投票 4填空 5主观
 * @returns {{content:string, result:any, display:string}}
 */
export function normalizeToolArgs(rawArgs, problemType) {
  let args = rawArgs;
  if (typeof args === 'string') {
    const s = args.trim();
    if (!s) throw new Error('工具参数为空');
    try {
      args = JSON.parse(s);
    } catch {
      throw new Error('工具参数不是合法 JSON');
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('工具参数格式不正确');
  }

  let answers = args.answers;
  if (typeof answers === 'string') answers = [answers];
  if (!Array.isArray(answers)) throw new Error('answers 必须是数组');
  answers = answers.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!answers.length) throw new Error('answers 为空');

  const pt = Number(problemType);
  if (pt === 1 || pt === 2 || pt === 3) {
    const letters = [];
    for (const a of answers) {
      const m = String(a).toUpperCase().match(/[A-Z]/g) || [];
      for (const c of m) if (!letters.includes(c)) letters.push(c);
    }
    if (!letters.length) throw new Error('选择题答案里没有选项字母');
    letters.sort();
    return { content: letters.join(','), result: letters, display: letters.join('、') };
  }

  if (pt === 4) {
    return { content: answers.join('\n'), result: answers, display: answers.join(' | ') };
  }

  if (pt === 5) {
    const text = answers.join('\n');
    return { content: text, result: { content: text, pics: [] }, display: text };
  }

  throw new Error(`不支持的题型：${problemType}`);
}

/** 从工具参数里取可选的 reason（用于卡片展示，不参与提交） */
export function toolReason(rawArgs) {
  try {
    const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    return String(a?.reason || '').trim();
  } catch {
    return '';
  }
}
