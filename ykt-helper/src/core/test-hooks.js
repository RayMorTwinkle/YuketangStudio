// src/core/test-hooks.js
// 测试模式下的控制台工具：注入假题目、模拟 AI 响应、模拟提交结果。
// 只在 ?ykt_test=1 或 localStorage['ykt:test-mode']='1' 时安装。

import { isTestMode } from './test-mode.js';
import { repo } from '../state/repo.js';
import { ui } from '../ui/ui-api.js';
import { log } from './log.js';
import { sendCurrent, askAIForProblem } from '../ui/panels/ai.js';

const L = (...a) => log.info('[test]', ...a);

function defaultBody(type) {
  switch (Number(type)) {
    case 2: return '测试多选题：以下哪些是编程语言？';
    case 3: return '测试投票题：你更喜欢哪种课堂形式？';
    case 4: return '测试填空题：1 + 1 = ____，2 + 2 = ____';
    case 5: return '测试主观题：请简述牛顿第一定律。';
    default: return '测试单选题：1 + 1 等于多少？';
  }
}

export function installTestHooks() {
  if (!isTestMode()) return;
  let seq = 0;

  const api = {
    /** 注入一道假题目，并设为「当前页」——AI 面板会把它当作真实题目 */
    injectProblem(type = 1, opts = {}) {
      const pid = opts.problemId || (910000 + (++seq));
      const slideId = `test-slide-${pid}`;
      const problem = {
        problemId: pid,
        problemType: Number(type),
        body: opts.body || defaultBody(type),
        options: opts.options || [
          { key: 'A', value: '选项 A' },
          { key: 'B', value: '选项 B' },
          { key: 'C', value: '选项 C' },
          { key: 'D', value: '选项 D' },
        ],
        blanks: opts.blanks || (Number(type) === 4 ? ['第一空', '第二空'] : []),
      };
      const slide = { id: slideId, index: 1, page: 1, problem };
      repo.upsertSlide(slide);
      repo.upsertProblem(problem);
      repo.problemStatus.set(String(pid), {
        slideId,
        startTime: opts.startTime ?? (Date.now() - 60000),
        endTime: opts.endTime ?? (Date.now() + 10 * 60 * 1000),
        clockOffset: 0,
      });
      repo.currentSlideId = slideId;
      repo.currentLessonId = 'test-lesson';
      repo.pushEncounteredProblem(problem, slide, 'test-presentation');
      ui.updateProblemList?.();
      L('已注入测试题', { problemId: pid, type: Number(type) });
      return pid;
    },

    /** 模拟：模型调用 submit_answer 工具 */
    mockTool(args = { answers: ['A'], reason: '测试理由' }, content = '答案是 A。') {
      window.__yktTestMock = { kind: 'tool', tool: args, content };
      L('已开启模拟工具调用', args);
    },

    /** 模拟：模型只输出文字、不调用工具（用于验证重试/降级） */
    mockText(content = '答案: A\n解释: 这是模拟文本回答。') {
      window.__yktTestMock = { kind: 'text', content };
      L('已开启模拟纯文本回答');
    },

    /** 模拟：流被截断 */
    mockTruncated(content = '答案: A\n解释: 输出到一半') {
      window.__yktTestMock = { kind: 'truncated', content };
      L('已开启模拟流中断');
    },

    /** 模拟：端点不支持 tools（HTTP 400） */
    mockNoTools(content = '答案: A\n解释: 模拟「不支持工具」时的降级回答。') {
      window.__yktTestMock = { kind: 'error-tools', content };
      L('已开启模拟「不支持工具调用」');
    },

    clearMock() {
      delete window.__yktTestMock;
      L('已清除模拟 AI 响应');
    },

    /** 模拟提交结果：ok / retry（补交）/ fail；不设置则走真实接口 */
    mockSubmit(mode = 'ok') {
      window.__yktTestMockSubmit = mode;
      L('提交模拟模式:', mode);
    },

    clearSubmitMock() {
      delete window.__yktTestMockSubmit;
      L('已恢复真实提交');
    },

    /** 打开 AI 面板并发起一轮「解答此页」（使用当前注入的假题目） */
    async ask() {
      try { ui.showAIPanel?.(true); } catch {}
      return sendCurrent({ auto: true });
    },

    /** 模拟「自动作答」：指定题目 + 直接提交（不弹确认） */
    async askAuto() {
      const slide = repo.slides.get(String(repo.currentSlideId));
      const problem = slide?.problem;
      if (!problem) throw new Error('请先 injectProblem()');
      try { ui.showAIPanel?.(true); } catch {}
      return askAIForProblem(problem, { autoSubmit: true });
    },

    /** 清空注入的测试题目 */
    reset() {
      for (const id of [...repo.problems.keys()]) {
        if (String(id).startsWith('91')) {
          repo.problems.delete(id);
          repo.problemStatus.delete(id);
          repo.slides.delete(`test-slide-${id}`);
        }
      }
      repo.encounteredProblems = repo.encounteredProblems.filter(
        (p) => !String(p.problemId).startsWith('91'),
      );
      repo.currentSlideId = null;
      delete window.__yktTestMock;
      delete window.__yktTestMockSubmit;
      ui.updateProblemList?.();
      L('已重置测试数据');
    },
  };

  window.__yktTest = api;
  L('测试模式已启用：window.__yktTest.injectProblem() / mockTool() / mockText() / mockSubmit()');
}
