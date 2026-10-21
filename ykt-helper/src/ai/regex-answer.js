// src/ai/regex-answer.js
// 「正则化工具调用」：不发 tools，让模型在正文末尾用 <answer>...</answer> 交答案。
// 只解析 content（绝不解析 reasoning/思考内容——模型常在思考里演练格式，那不是最终答案）。
//
// 格式（按题型，提示词只教这一套）：
//   单选/投票：<answer>B</answer>
//   多选：    <answer>A,C</answer>
//   填空：    <answer>\n12\n3.5\n</answer>（每个空一行）
//   主观：    <answer>完整作答文本</answer>
// 理由写在 <answer> 前面的正文里，不单独格式化。

const TYPE_NAME = {
  1: '单选题',
  2: '多选题',
  3: '投票题',
  4: '填空题',
  5: '主观题',
};

/**
 * 正则模式的 system prompt 片段。
 * @param {object|null} problem
 * @param {{mandatory?: boolean, soft?: boolean}} [opts]
 */
export function regexAnswerPrompt(problem, { mandatory = false, soft = false } = {}) {
  if (!problem) return '';
  const pt = Number(problem.problemType);
  const isQuiz = problem.__submitTarget === 'quiz';
  const lines = ['【答案输出格式】'];

  if (soft) {
    lines.push(
      '如果用户要的是最终答案，才在回答最后输出一个 <answer>...</answer> 块；'
      + '如果只是解释、追问或讨论，可以直接用文字回答。',
    );
  } else {
    lines.push(
      '最终答案必须放在回答最后，用 <answer> 和 </answer> 包裹。'
      + '答案前可以写简要理由或解题过程；<answer> 里只放答案本身，不要写理由。',
    );
  }

  lines.push(
    '按题型使用下面的格式：',
    '- 单选/投票：<answer>B</answer>',
    '- 多选：<answer>A,C</answer>（字母用英文逗号分隔）',
    '- 填空：每个空一行，例如：',
    '<answer>',
    '12',
    '3.5',
    '</answer>',
    '- 主观/问答：<answer>完整作答文本</answer>',
    `当前是${TYPE_NAME[pt] || '题目'}。`,
    '只输出一个 <answer> 块，放在回答最后；不要使用「答案：」「解释：」等旧格式。',
  );

  if (isQuiz) {
    lines.push('当前是作业题：<answer> 只会把答案暂存到该题，不会交卷。');
  }
  if (mandatory) {
    lines.push('本次为自动作答：必须输出 <answer>...</answer>，否则本次作答视为失败。');
  } else if (!soft) {
    lines.push(isQuiz ? '暂存成功后可以继续给用户简要说明思路。' : '提交成功后可以继续给用户简要说明思路。');
  }
  return lines.join('\n');
}

/** 全角尖括号归一化（只影响解析，不改展示） */
function normalizeTags(text) {
  return String(text || '')
    .replace(/＜/g, '<')
    .replace(/＞/g, '>');
}

/**
 * 从正文里取最后一个完整的 <answer>...</answer>（也容忍 <答案>）。
 * 只接受 content；调用方不得把 reasoning 传进来。
 * @param {string} content
 * @param {number} problemType 1单选 2多选 3投票 4填空 5主观
 * @returns {{answers:string[], matched:string, index:number}|null}
 */
export function parseRegexAnswer(content, problemType) {
  const text = normalizeTags(content);
  if (!text) return null;
  // 无题目哨兵：与 parseAIAnswer 保持一致，避免把 NO_PROMPT 当答案
  if (/^\s*STATE\s*:/im.test(text) || /\bNO_PROMPT\b/i.test(text)) return null;

  const re = /<(answer|答案)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return null;

  const body = String(last[2] || '').trim();
  if (!body) return null;
  const pt = Number(problemType);
  let answers = [];

  if (pt === 1 || pt === 2 || pt === 3) {
    const letters = [];
    for (const c of body.toUpperCase().match(/[A-Z]/g) || []) {
      if (!letters.includes(c)) letters.push(c);
    }
    letters.sort();
    answers = letters;
  } else if (pt === 4) {
    // 每个空一行；只有一行时容忍 12|3.5 / 12｜3.5 的写法
    let parts = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 1 && /[|｜]/.test(parts[0])) {
      parts = parts[0].split(/[|｜]/).map(s => s.trim()).filter(Boolean);
    }
    answers = parts;
  } else if (pt === 5) {
    answers = [body];
  } else {
    return null;
  }

  if (!answers.length) return null;
  return { answers, matched: last[0], index: last.index };
}

/** 把解析出的答案包装成现有工具调用结构，复用 handleToolCall / 卡片 / 提交流程 */
export function regexToolCall(answers, id) {
  return {
    id: id || `regex_${Date.now().toString(36)}`,
    type: 'function',
    function: {
      name: 'submit_answer',
      arguments: JSON.stringify({ answers }),
    },
  };
}

/** 从展示正文里去掉所有 <answer> 块（保留前面的理由/过程） */
export function stripRegexAnswer(content) {
  const out = normalizeTags(content).replace(/<(answer|答案)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
