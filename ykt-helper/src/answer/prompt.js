// src/answer/prompt.js
// 统一题目上下文 + 答案契约（tools / regex / text）。
// 不再有 buildUserText / toolPromptBlock / regexAnswerPrompt 三套并行提示词。
import { ensureImageUrl } from '../core/dom.js';
import { QTYPE, typeLabel } from './model.js';

export const SUBMIT_ANSWER_TOOL = {
  type: 'function',
  function: {
    name: 'submit_answer',
    description:
      '把本题的最终答案提交/暂存到雨课堂。确定答案后必须调用本工具；只输出文字不算完成。'
      + '选择题传选项标签；判断题传选项标签（A/B 或 √/×）；填空题按空位顺序每空一项；主观题传完整作答文本。'
      + '填空答案必须是普通文本：不要带 TeX/LaTeX 或 Markdown 格式，数学式写成普通文字（如 1/2、x^2，不要写 \\frac{1}{2}、$x^2$、**加粗**）。',
    parameters: {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          items: { type: 'string' },
          description:
            '答案数组。单选/多选/投票：["A"] 或 ["A","C"]；'
            + '判断题：["A"]/["B"] 或 ["√"]/["×"]；'
            + '填空：每个空一项，如 ["12","3.5"]，必须是普通文本（数学式写 1/2、x^2，不带 TeX/LaTeX 或 Markdown）；主观/问答：一个元素，内容为完整作答文本。',
        },
        reason: {
          type: 'string',
          description: '一句话说明选择该答案的理由（可选）。',
        },
        confidence: {
          type: 'number',
          description: '你对这个答案的把握：0 到 1 的小数（如 0.9 很有把握，0.4 不太确定）。可选。',
        },
      },
      required: ['answers'],
    },
  },
};

function targetText(task) {
  if (task?.target?.kind === 'quiz') return '暂存到作业（不会交卷）';
  if (task?.target?.kind === 'classroom') return '提交到课堂';
  return '仅展示答案，不提交';
}

function optionLines(q) {
  const lines = [];
  const opts = Array.isArray(q.options) ? q.options : [];
  const hasText = opts.some((o) => String(o.text || '').trim());
  if (hasText) {
    lines.push('选项：');
    for (const o of opts) lines.push(`${o.key}. ${o.text || ''}`.trimEnd());
  }
  if (!hasText && Array.isArray(q.optionLabels) && q.optionLabels.length) {
    lines.push(`选项标签：${q.optionLabels.join('、')}（题目只给了标签；请只输出这些标签，不要输出解释）`);
  }
  return lines;
}

/** 题目上下文：作为 user 消息的主体 */
export function buildQuestionBlock(task) {
  const q = task?.question || {};
  const lines = ['【题目信息（来自系统，比截图更可靠）】'];
  lines.push(`来源：${task?.source === 'assignment' ? '作业题' : task?.source === 'exercise' ? '新版作业题' : task?.source === 'problem-list' ? '历史题目' : '课堂实时题'}`);
  lines.push(`题型：${q.typeLabel || typeLabel(q.type)}`);
  if (q.body) lines.push(`题干：${q.body}`);
  lines.push(...optionLines(q));
  if (q.blanks > 0) lines.push(`空位数：${q.blanks}`);
  if (q.image?.dataUrl) lines.push('题目截图已附上；如果截图与文本冲突，以截图为准。');
  else lines.push('本题没有题图，只能依据以上文本作答。');

  if (q.type === QTYPE.JUDGE && !q.options.some((o) => String(o.text || '').trim())) {
    lines.push('判断题注意：本题只给了选项标签，answers 只能输出标签（如 A/B），不要输出 √/× 或解释。');
  }
  lines.push(`提交目标：${targetText(task)}。`);
  return lines.join('\n');
}

/** 答案契约：拼到 system prompt 末尾 */
export function buildAnswerContract(task, transport, { autoSubmit = false, soft = false } = {}) {
  const q = task?.question || {};
  const target = targetText(task);
  const lines = [];

  // 不能提交的题只走展示契约
  if (!task?.target?.allowSubmit) {
    lines.push('【回答格式】');
    lines.push('本题只展示答案，不会自动提交。请给出答案与简要理由；最后一行写「答案：...」。');
    if (q.type === QTYPE.FILL) lines.push('如果是多空填空，每个空写一行，或按题目顺序写清楚。');
    return lines.join('\n');
  }

  if (transport === 'tools') {
    lines.push('【工具使用要求】');
    if (soft) {
      lines.push('当前有题目上下文。如果用户要的是最终答案，请调用 submit_answer；如果只是解释、追问或讨论，可以直接用文字回答。');
    } else {
      lines.push(`当前有可提交的题目。确定最终答案后必须调用 submit_answer；只输出文字不算完成。本题会${target}。`);
    }
    lines.push(
      'submit_answer 的 answers 参数：',
      '- 单选/多选/投票：选项标签数组，例如 ["A"] 或 ["A","C"]；',
      '- 判断题：必须是选项标签（如 ["A"]/["B"]，或题目选项本身就是 √/× 时用 ["√"]/["×"]）；',
      '- 如果题目只给了 A/B 标签，只能输出 A/B，不要输出 √/× 或解释；',
      '- 填空：按空位顺序，每个空一项；每空必须是普通文本，不要用 TeX/LaTeX 或 Markdown 格式（数学式写 1/2、x^2，不写 \\frac{1}{2}、$x^2$、**加粗**）；',
      '- 主观/问答：一个元素，内容为完整作答文本。',
    );
    if (autoSubmit) lines.push('本次为自动作答：必须调用 submit_answer，否则本次作答视为失败。');
    return lines.join('\n');
  }

  if (transport === 'regex') {
    lines.push('【答案输出格式】');
    if (soft) {
      lines.push('如果用户要的是最终答案，才在回答最后输出一个 <answer>...</answer> 块；如果只是解释、追问或讨论，可以直接用文字回答。');
    } else {
      lines.push('最终答案必须放在回答最后，用 <answer> 和 </answer> 包裹。答案前可以写简要理由；<answer> 里只放答案本身，不要写理由。');
    }
    lines.push('按题型使用下面的格式：');
    switch (q.type) {
      case QTYPE.MULTIPLE:
        lines.push('- 多选：<answer>A,C</answer>（英文逗号分隔）');
        break;
      case QTYPE.JUDGE:
        lines.push('- 判断题：<answer>B</answer>（只输出选项标签；如果选项本身就是 √/×，才输出 √/×）');
        break;
      case QTYPE.FILL:
        lines.push('- 填空：每个空一行，例如 <answer>\\n12\\n3.5\\n</answer>；每空必须是普通文本，不要用 TeX/LaTeX 或 Markdown 格式（数学式写 1/2、x^2，不写 \\frac{1}{2}、$x^2$、**加粗**）');
        break;
      case QTYPE.SUBJECTIVE:
        lines.push('- 主观/问答：<answer>完整作答文本</answer>');
        break;
      default:
        lines.push('- 单选/投票：<answer>B</answer>');
    }
    lines.push(`当前是${q.typeLabel || typeLabel(q.type)}。`);
    lines.push(`本题会${target}。`);
    lines.push('只输出一个 <answer> 块，放在回答最后；不要使用「答案：」「解释：」等旧格式。');
    if (autoSubmit) lines.push('本次为自动作答：必须输出 <answer>...</answer>，否则本次作答视为失败。');
    return lines.join('\n');
  }

  lines.push('【回答格式】');
  lines.push('请先给答案，再给简要理由；最后一行写「答案：...」。');
  return lines.join('\n');
}

/** 构造本轮 user content（text + image_url） */
export function buildUserContent(task, { userText = '', includeTask = true, attachImage = true } = {}) {
  const parts = [];
  if (includeTask) parts.push(buildQuestionBlock(task));
  if (userText) parts.push(`【用户问题】\n${userText}`);
  if (!parts.length) parts.push('请解答本题。');

  const content = [{ type: 'text', text: parts.join('\n\n') }];
  const dataUrl = task?.question?.image?.dataUrl;
  if (attachImage && includeTask && dataUrl) {
    content.push({ type: 'image_url', image_url: { url: ensureImageUrl(dataUrl) } });
  }
  return content;
}

/**
 * 构造完整 messages。
 * @param {object} task
 * @param {object} opts
 * @param {string} opts.baseSystem 用户配置/默认 system prompt
 * @param {Array} [opts.history] 之前的 user/assistant 消息（不含 system）
 * @param {string} [opts.userText]
 * @param {'tools'|'regex'|'text'} opts.transport
 * @param {boolean} [opts.autoSubmit]
 * @param {boolean} [opts.soft]
 * @param {boolean} [opts.includeTask]
 * @param {boolean} [opts.attachImage]
 */
export function buildMessages(task, {
  baseSystem = '',
  history = [],
  userText = '',
  transport = 'tools',
  autoSubmit = false,
  soft = false,
  includeTask,
  attachImage = true,
} = {}) {
  const hasHistoryUser = Array.isArray(history) && history.some((m) => m?.role === 'user');
  const include = includeTask !== undefined ? includeTask : !hasHistoryUser;
  const sys = [String(baseSystem || '').trim(), buildAnswerContract(task, transport, { autoSubmit, soft })]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: sys },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: buildUserContent(task, { userText, includeTask: include, attachImage }) },
  ];
}

/** 重试时给模型的内部提示（不渲染成用户消息） */
export function buildNudge(task, error, transport) {
  const q = task?.question || {};
  const msg = String(error?.message || error || '答案格式不正确');
  const lines = [`上一次没有形成可提交的答案：${msg}`];
  if (transport === 'regex') {
    lines.push('请重新作答，并且只在最后输出一个 <answer>...</answer> 块。');
    if (q.type === QTYPE.JUDGE) lines.push('判断题只输出选项标签（如 A/B），不要输出 √/× 或解释。');
    if (q.type === QTYPE.MULTIPLE) lines.push('多选题用英文逗号分隔，如 <answer>A,C</answer>。');
  } else if (transport === 'tools') {
    lines.push('请现在调用 submit_answer 工具；answers 必须是数组，不要只输出文字。');
    if (q.type === QTYPE.JUDGE) lines.push('判断题 answers 只放选项标签（如 ["A"] 或 ["B"]），不要放解释。');
    if (q.type === QTYPE.FILL) lines.push(`填空题按空位顺序放 ${q.blanks || '每'} 项。`);
  } else {
    lines.push('请重新给出答案，并在最后一行写「答案：...」。');
  }
  return lines.join('\n');
}
