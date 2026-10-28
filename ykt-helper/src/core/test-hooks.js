// src/core/test-hooks.js
// 测试模式下的控制台工具：注入假题目、模拟 AI 响应、模拟提交结果。
// 只在 ?ykt_test=1 或 localStorage['ykt:test-mode']='1' 时安装。

import { isTestMode } from './test-mode.js';
import { repo } from '../state/repo.js';
import { ui } from '../ui/ui-api.js';
import { log } from './log.js';
import { sendCurrent, askAIForProblem, askAnswer, askProblem as askProblemById, getAIHistory, resetAIView, buildDiagnosticReport, copyDiagnosticReport } from '../ui/panels/ai.js';
import { buildAssignmentTask } from '../answer/adapters/assignment.js';
import { resolveProblemListTask } from '../answer/context.js';
import { getAnswerLog } from '../answer/debug.js';
import { actions } from '../state/actions.js';
import { collectExamQuestions, fillExamAnswers } from '../quiz/exam-fill.js';
import * as telemetry from './telemetry.js';

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
      // 测试用：给假题挂一张图，验证图片请求 / trace 脱敏
      if (opts.imageDataUrl) problem.__imageDataUrl = opts.imageDataUrl;
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

    /** 注入一个作业题并返回 AnswerTask（不打开面板） */
    injectAssignmentTask(type = 'SingleChoice', opts = {}) {
      const pid = opts.problemId || (920000 + (++seq));
      const bullets = opts.bullets || [{ Label: 'A' }, { Label: 'B' }];
      const problem = {
        ProblemID: pid,
        Type: type,
        Score: opts.score ?? 1,
        Bullets: bullets,
        Blanks: opts.blanks,
      };
      const quizData = { Title: opts.title || '测试作业', Slides: [{ Problem: problem }] };
      const task = buildAssignmentTask({
        quizData,
        index: 0,
        assignment: { id: opts.assignmentId || 'test-assignment', oldId: opts.quizId || 'test-quiz', title: opts.title || '测试作业' },
        quizId: opts.quizId || 'test-quiz',
        imageDataUrl: opts.imageDataUrl || '',
      });
      window.__yktTestTask = task;
      L('已注入作业题', { problemId: pid, type });
      return task;
    },

    /** 注入作业题并在 AI 面板解答（mock 响应由 mockTool/mockText 决定） */
    async askAssignment(type = 'SingleChoice', opts = {}) {
      const task = api.injectAssignmentTask(type, opts);
      try { ui.showAIPanel?.(true); } catch {}
      return askAnswer(task, { autoSubmit: !!opts.autoSubmit });
    },

    /** 从题目列表条目发起 AI 解答 */
    async askProblemList(problemId) {
      const entry = repo.encounteredProblems.find((p) => String(p.problemId) === String(problemId));
      if (!entry) throw new Error('题目列表里没有该题');
      const r = await resolveProblemListTask(entry);
      if (!r.task) throw new Error('题目信息不完整');
      try { ui.showAIPanel?.(true); } catch {}
      return askAnswer(r.task);
    },

    /** 从答题提醒卡片发起 AI 解答（显式 problemId，等价点卡片上的 AI 按钮） */
    async askProblem(problemId) {
      const r = await askProblemById(problemId);
      if (!r) throw new Error('题目信息不完整');
      return r;
    },

    /** 直接触发一次 unlockproblem（验证 dt 秒/毫秒归一化与状态写入） */
    unlockProblem(problemId, { dt, limit } = {}) {
      const pid = String(problemId);
      const st = repo.problemStatus.get(pid);
      const problem = repo.problems.get(pid);
      if (!st || !problem) throw new Error('题目不存在');
      actions.onUnlockProblem({ prob: pid, sid: st.slideId, pres: 'test-presentation', dt, limit });
      return repo.problemStatus.get(pid);
    },

    /** 弹一次题目提醒（用于验证通知弹窗里的 AI 入口） */
    notifyProblem(problemId) {
      const pid = String(problemId);
      const problem = repo.problems.get(pid);
      if (!problem) throw new Error('题目不存在');
      const st = repo.problemStatus.get(pid);
      const slide = st?.slideId ? repo.slides.get(String(st.slideId)) : null;
      ui.notifyProblem(problem, slide);
      return true;
    },

    /** 删除题目 status（模拟历史题） */
    dropStatus(problemId) {
      repo.problemStatus.delete(String(problemId));
      return true;
    },

    /** 打开/关闭强化遥测（测试用） */
    setTelemetry(on = true) {
      telemetry.setEnabled(!!on);
      telemetry.setEnhanced(!!on);
      return { enabled: telemetry.enabled(), enhanced: telemetry.enhancedEnabled() };
    },

    /** 设置测试配置（直接写 ui.config 并持久化，兼容 Android GM shim） */
    setTestConfig({ regex = false, profile = null } = {}) {
      ui.config.regexToolCall = !!regex;
      ui.config.aiAutoAnalyze = false;
      const p = profile || { id: 'test-mock', name: 'Mock', baseUrl: 'https://example.com/v1', apiKey: 'mock', model: 'mock' };
      ui.config.ai = { ...(ui.config.ai || {}), profiles: [p], activeProfileId: p.id };
      ui.saveConfig();
      return { regexToolCall: ui.config.regexToolCall, ai: ui.config.ai };
    },

    /** 读当前测试配置 */
    getConfig() {
      return { regexToolCall: !!ui.config.regexToolCall, ai: ui.config.ai };
    },

    /** 走真实「诊断」按钮逻辑（上传诊断；测试时用 mockDiagnostic 拦截网络） */
    copyDiagnostic() {
      return copyDiagnosticReport();
    },

    /** 模拟诊断上传：ok / fail；清除则不拦截 */
    mockDiagnostic(mode = 'ok') {
      if (mode == null || mode === 'off') delete window.__yktTestMockDiagnostic;
      else window.__yktTestMockDiagnostic = mode;
      return true;
    },

    /** 生成诊断报告（不复制/不写文件） */
    diagnostic() {
      const r = buildDiagnosticReport();
      try { return JSON.parse(r.json); } catch { return r; }
    },

    /** 清空 AI 面板视图/历史（题目保留） */
    clearUI() {
      resetAIView();
      return true;
    },

    /** 自动作答状态（调试） */
    getAutoState(problemId) {
      const pid = String(problemId ?? [...repo.problems.keys()].find(k => String(k).startsWith('91')));
      const status = repo.problemStatus.get(pid) || null;
      const problem = repo.problems.get(pid) || null;
      return {
        pid,
        status: status ? { ...status } : null,
        problem: problem ? { problemId: problem.problemId, problemType: problem.problemType, result: problem.result } : null,
        ai: ui.config.ai,
        mock: window.__yktTestMock || null,
        mockSubmit: window.__yktTestMockSubmit || null,
      };
    },

    getHistory: getAIHistory,

    /** 考试页 DOM 适配器（测试模式）：收集/填入，不提交。 */
    examCollect() {
      return collectExamQuestions(document);
    },
    examFill(answers) {
      return fillExamAnswers(answers);
    },

    /** 读取答题链路调试日志 */
    getAnswerLog,

    /** 走真实自动作答入口（actions.handleAutoAnswer，headless） */
    async askAutoAction(problemId) {
      const pid = problemId ?? [...repo.problems.keys()].find(k => String(k).startsWith('91'));
      const problem = pid != null ? repo.problems.get(String(pid)) : null;
      if (!problem) throw new Error('请先 injectProblem()');
      return actions.handleAutoAnswer(problem);
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
