/* eslint-disable no-undef */
// scripts/e2e-answer.mjs
// Answer Engine V2 的 ego 浏览器端到端测试（测试模式，不联网、不真实提交）。
// 运行：ego-browser nodejs < scripts/e2e-answer.mjs
// 依赖：dist/YuketangStudio-<version>.user.js 已构建（npm run build）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const DIST = '/Users/Ray/Desktop/AI工作台/YuketangStudio-main/ykt-helper/dist/YuketangStudio-latest.user.js';
const SRC = await readFile(DIST, 'utf8');

let pass = 0;
let fail = 0;
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.message || e); }
}

async function setup(space, { regex = false } = {}) {
  const task = await taskSpace(space);
  const page = task.page('p1');
  await page.goto('https://changjiang.yuketang.cn/m/v2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    ['ykt-helper-toolbar', 'ykt-shell-panel', 'ykt-ai-answer-panel', 'ykt-onboarding'].forEach((id) => document.getElementById(id)?.remove());
    document.querySelectorAll('.ykt-panel,.ykt-problem-notify,.ykt-onboarding').forEach((e) => e.remove());
    localStorage.setItem('ykt:test-mode', '1');
    localStorage.setItem('ykt-helper:onboarding.version', '1');
    localStorage.setItem('ykt-helper:config', JSON.stringify({
      regexToolCall: false,
      aiAutoAnalyze: false,
      ai: { profiles: [{ id: 'p', name: 'Mock', baseUrl: 'https://example.com/v1', apiKey: 'mock', model: 'mock' }], activeProfileId: 'p' },
    }));
  });
  // 设置 regex 配置需要刷新后再注入（config 在脚本启动时读取）
  if (regex) {
    await page.evaluate(() => {
      const cfg = JSON.parse(localStorage.getItem('ykt-helper:config') || '{}');
      cfg.regexToolCall = true;
      localStorage.setItem('ykt-helper:config', JSON.stringify(cfg));
    });
  }
  for (let i = 0; i < 4; i++) {
    await page.evaluate((s) => {
      const el = document.createElement('script');
      el.textContent = s;
      document.documentElement.appendChild(el);
    }, SRC);
    await page.waitForTimeout(2200);
    if (await page.evaluate(() => !!window.__yktTest)) break;
  }
  const ready = await page.evaluate(() => !!window.__yktTest);
  if (!ready) throw new Error(`注入失败：${space}`);
  await page.evaluate(() => {
    window.__e2e = {
      card() {
        const c = [...document.querySelectorAll('#ykt-ai-log .ykt-tool-card')].at(-1);
        if (!c) return null;
        return {
          title: c.querySelector('.ykt-tool-title')?.textContent || '',
          answer: c.querySelector('.ykt-tool-answer')?.textContent || '',
          status: c.querySelector('.ykt-tool-status')?.textContent || '',
          btn: c.querySelector('.ykt-tool-submit')?.textContent || '',
        };
      },
      count() { return document.querySelectorAll('#ykt-ai-log .ykt-tool-card').length; },
      warn() { return [...document.querySelectorAll('#ykt-ai-log .ykt-chat-warn')].map((x) => x.textContent).join('\n'); },
      lastUser() { return [...document.querySelectorAll('#ykt-ai-log .ykt-ai-msg.user')].at(-1)?.textContent || ''; },
      input(v) { const el = document.querySelector('#ykt-ai-input'); if (el) el.value = v; },
    };
  });
  return page;
}

const toolsPage = await setup('answer-e2e-tools', { regex: false });

console.log('== tools 模式：课堂题 ==');
await okAsync('课堂多选：工具调用 → 卡片 A、C', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.injectProblem(2, { body: '以下哪些是编程语言？', options: [{ key: 'A', value: 'JavaScript' }, { key: 'B', value: 'Python' }, { key: 'C', value: 'HTML' }] });
    T.mockSubmit('ok'); T.mockTool({ answers: ['A', 'C'], reason: '测试' });
    const run = await T.ask();
    return { ok: run?.ok, transport: run?.run?.transport, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'tools');
  assert.equal(r.card.answer, 'A、C');
  assert.equal(r.card.title, '📤 提交答案');
});

await okAsync('课堂单选：模型只回「答案: A」→ 手动兜底成卡片', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.injectProblem(1, { body: '1+1=?', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] });
    T.mockText('答案: A\n解释: 1+1=2');
    window.__e2e.input('再解释一下');
    const run = await T.ask();
    return { ok: run?.ok, source: run?.run?.answer?.source, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'text');
  assert.equal(r.card.answer, 'A');
});

await okAsync('课堂填空：空数不匹配 → 报错且不产生卡片', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.injectProblem(4, { body: '1+1=__，2+2=__', blanks: ['a', 'b'] });
    T.mockTool({ answers: ['1'] });
    const run = await T.ask();
    return { ok: run?.ok, code: run?.run?.error?.code, count: window.__e2e.count(), warn: window.__e2e.warn() };
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_ANSWER');
  assert.equal(r.count, 0);
  assert.match(r.warn, /空位数不匹配/);
});

console.log('== tools 模式：作业题 ==');
await okAsync('作业单选：工具调用 → 暂存卡片', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.mockTool({ answers: ['B'] });
    const run = await T.askAssignment('SingleChoice', { bullets: [{ Label: 'A' }, { Label: 'B' }] });
    return { ok: run?.ok, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.card.title, '📥 暂存答案（作业）');
  assert.equal(r.card.answer, 'B');
  assert.equal(r.card.btn, '暂存');
});

await okAsync('作业判断 A/B：模型回 × → 报错、不生成卡片、不猜 B', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.mockTool({ answers: ['×'] });
    const run = await T.askAssignment('Judgement', { bullets: [{ Label: 'A' }, { Label: 'B' }] });
    return { ok: run?.ok, code: run?.run?.error?.code, count: window.__e2e.count(), warn: window.__e2e.warn() };
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_ANSWER');
  assert.equal(r.count, 0);
  assert.match(r.warn, /请只输出选项标签/);
});

await okAsync('作业填空：工具调用 → 暂存卡片，点击后 mock 暂存成功', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.mockSubmit('ok');
    T.mockTool({ answers: ['1', '2'] });
    const run = await T.askAssignment('FillBlank', { blanks: ['a', 'b'] });
    const c = [...document.querySelectorAll('#ykt-ai-log .ykt-tool-card')].at(-1);
    c?.querySelector('.ykt-tool-submit')?.click();
    await new Promise((r) => setTimeout(r, 900));
    return { ok: run?.ok, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.card.title, '📥 暂存答案（作业）');
  assert.equal(r.card.answer, '1 | 2');
  assert.match(r.card.status, /已暂存/);
});

await okAsync('作业主观：工具调用 → 暂存卡片，点击后 mock 暂存成功', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.mockSubmit('ok');
    T.mockTool({ answers: ['一段完整作答'] });
    const run = await T.askAssignment('Subjective');
    const c = [...document.querySelectorAll('#ykt-ai-log .ykt-tool-card')].at(-1);
    c?.querySelector('.ykt-tool-submit')?.click();
    await new Promise((r) => setTimeout(r, 900));
    return { ok: run?.ok, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.card.answer, '一段完整作答');
  assert.match(r.card.status, /已暂存/);
});

console.log('== 自动作答（headless）==');
await okAsync('自动作答：合法工具调用 → status.done=true', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    const pid = T.injectProblem(1, { body: '1+1=?', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] });
    T.mockSubmit('ok'); T.mockTool({ answers: ['B'] });
    await T.askAutoAction(pid);
    return T.getAutoState(pid);
  });
  assert.equal(r.status.done, true);
});

await okAsync('自动作答：非法答案 → 不提交（status.done 不为 true）', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    const pid = T.injectProblem(1, { body: '非法', options: [{ key: 'A', value: '' }, { key: 'B', value: '' }] });
    T.mockSubmit('ok'); T.mockTool({ answers: ['×'] });
    await T.askAutoAction(pid);
    return T.getAutoState(pid);
  });
  assert.notEqual(r.status.done, true);
});

await okAsync('自动作答：端点不支持 tools → 不猜文本、不提交', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    const pid = T.injectProblem(1, { body: '不支持工具', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] });
    T.mockSubmit('ok'); T.mockNoTools('答案: A');
    await T.askAutoAction(pid);
    return T.getAutoState(pid);
  });
  assert.notEqual(r.status.done, true);
});

console.log('== 题目列表 / 展示-only ==');
await okAsync('历史题无 status → 只展示，复制答案', async () => {
  const r = await toolsPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    const pid = T.injectProblem(2, { body: '历史题' });
    T.dropStatus(pid);
    T.mockText('答案: A');
    const run = await T.askProblemList(pid);
    return { ok: run?.ok, transport: run?.run?.transport, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'text');
  assert.equal(r.card.title, '💡 参考答案（不提交）');
  assert.equal(r.card.btn, '复制答案');
});

console.log('== regex 模式 ==');
const regexPage = await setup('answer-e2e-regex', { regex: true });
await okAsync('regex 单选：<answer>B</answer> → B', async () => {
  const r = await regexPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.injectProblem(1, { body: '1+1=?', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] });
    T.mockText('理由\n<answer>B</answer>');
    const run = await T.ask();
    return { ok: run?.ok, transport: run?.run?.transport, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'regex');
  assert.equal(r.card.answer, 'B');
});

await okAsync('regex 判断 A/B：<answer>×</answer> → 报错、不猜、不生成卡片', async () => {
  const r = await regexPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.mockText('<answer>×</answer>');
    const run = await T.askAssignment('Judgement', { bullets: [{ Label: 'A' }, { Label: 'B' }] });
    return { ok: run?.ok, code: run?.run?.error?.code, count: window.__e2e.count() };
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_ANSWER');
  assert.equal(r.count, 0);
});

await okAsync('regex 填空：多行 <answer> → 1 | 2', async () => {
  const r = await regexPage.evaluate(async () => {
    const T = window.__yktTest; T.reset(); T.clearUI();
    T.mockText('<answer>\n1\n2\n</answer>');
    const run = await T.askAssignment('FillBlank', { blanks: ['a', 'b'] });
    return { ok: run?.ok, card: window.__e2e.card() };
  });
  assert.equal(r.ok, true);
  assert.equal(r.card.answer, '1 | 2');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
