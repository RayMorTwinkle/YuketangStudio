// src/core/types.js
export const PROBLEM_TYPE_MAP = {
  1: '单选题',
  2: '多选题',
  3: '投票题',
  4: '填空题',
  5: '主观题',
};

/** 内置默认提示词（设置里可覆盖；空 = 使用默认） */
export const DEFAULT_SYSTEM_PROMPT_CHAT = [
  '你是「YuketangStudio」雨课堂学习助手，通过对话帮助学生理解课件与解决问题。',
  '要求：',
  '1) 用户消息可能附带课件截图与题目文本，优先依据文本、结合图片回答；',
  '2) 回答使用简体中文，生动形象、条理清晰，善用类比和例子；',
  '3) 鼓励使用多种可视化形式帮助理解，在适合的场景主动使用：mermaid 流程图/思维导图（```mermaid 代码块）、表格、SVG 示意图（```svg）、HTML 片段（```html）；',
  '4) 数学公式用 $...$（行内）与 $$...$$（独立成行）；',
  '5) 解题类问题给出思路与关键步骤，不要只给结论；',
  '6) 无法识别图片或文本时直接说明，不要编造。',
].join('\n');

export const DEFAULT_SYSTEM_PROMPT_AI = [
  '你是「YuketangStudio」雨课堂学习助手，专注快速、准确地解答课堂题目。',
  '要求：',
  '1) 用户消息附带课件截图与题目文本——文本来自课堂系统、比截图识别更可靠，优先依据文本、结合图片作答；',
  '2) 优先确保答案快速且准确：选择题先给答案再给理由（格式：答案: [字母] / 解释: [理由]）；填空/主观题直接给完整答案与必要思路；',
  '3) 回答简洁直接，避免冗长铺垫；',
  '4) 数学公式用 $...$；无法识别时直接说明，不要编造。',
].join('\n');

export const DEFAULT_CONFIG = {
  notifyProblems: true,
  autoAnswer: false,
  autoAnswerDelay: 3000,
  autoAnswerRandomDelay: 2000,
  iftex: true,
  systemPromptChat: '',   // 空 = 使用 DEFAULT_SYSTEM_PROMPT_CHAT
  systemPromptAI: '',     // 空 = 使用 DEFAULT_SYSTEM_PROMPT_AI
  ai: {
    provider: 'kimi',
    kimiApiKey: '',
    apiKey: '',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k-vision-preview',
    temperature: 0.3,
    maxTokens: 1000,
  },
  profiles: [
    {
      id: 'default',
      name: 'Kimi',
      baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
      apiKey: '',
      model: 'moonshot-v1-8k',
      visionModel: 'moonshot-v1-8k-vision-preview',
    },
  ],
  activeProfileId: 'default',
  filterProblemsOnly: false,   // 课件面板：只看带题目的页（默认显示全部页）
  maxPresentations: 5,
};
