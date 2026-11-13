import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
const values = new Map();
const localValues = new Map();
globalThis.localStorage = { getItem: k => localValues.get(k) ?? null, setItem: (k, v) => localValues.set(k, v), removeItem: k => localValues.delete(k) };
globalThis.GM_getValue = (k, d) => values.has(k) ? values.get(k) : d;
globalThis.GM_setValue = (k, v) => values.set(k, v);
globalThis.document = { addEventListener: noop };
globalThis.window = { addEventListener: noop };
const { agnesChat } = await import('../src/ai/agnes.js');
const telemetry = await import('../src/core/telemetry.js');
const timing = await import('../src/core/problem-timing.js');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✅', name); }

for (const stream of [false, true]) {
  await test(`GM 降级${stream ? '流式' : '非流式'}取消：终止请求，忽略迟到回调`, async () => {
    let pending;
    let aborts = 0;
    globalThis.window.GM_xmlhttpRequest = options => { pending = options; return { abort() { aborts++; } }; };
    globalThis.fetch = async () => { throw new TypeError('simulated CORS'); };
    const ctrl = new AbortController();
    const task = agnesChat({ messages: [], stream, thinking: false, signal: ctrl.signal,
      override: { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture' } });
    const rejected = assert.rejects(task, { name: 'AbortError' });
    for (let i = 0; i < 20 && !pending; i++) await tick();
    assert.ok(pending);
    ctrl.abort();
    await rejected;
    assert.equal(aborts, 1);
    pending.onload({ status: 200, responseText: '{"choices":[]}' });
  });
}
await test('遥测迁移保留明确关闭/开启选择，并且只迁移一次', () => {
  for (const setting of [false, true]) {
    values.delete('ykt-helper:telemetry.defaultOnMigrated');
    values.set('ykt-helper:telemetry.enabled', setting);
    assert.equal(telemetry.migrateDefaultOn(), true);
    assert.equal(telemetry.enabled(), setting);
    assert.equal(telemetry.migrateDefaultOn(), false);
  }
});

async function actionsFixture(chat = async () => ({ ok: true, answer: {} })) {
  let now = 1800000000000;
  const intervals = [];
  const listeners = new Map();
  const submits = [];
  const repo = { problems: new Map(), slides: new Map([['s1', { id: 's1' }]]), problemStatus: new Map(), pendingUnlocks: [], encounteredProblems: [], currentLessonId: 'lesson' };
  const ui = { config: { autoAnswer: true, autoAnswerAgreementAccepted: true, autoAnswerDelay: 1000, autoAnswerRandomDelay: 0, notifyProblems: false,
    ai: { profiles: [{ id: 'p', apiKey: 'fixture' }], activeProfileId: 'p' } }, toast: noop, updateActiveProblems: noop };
  const bindings = {
    PROBLEM_TYPE_MAP: { 1: 'single' }, DEFAULT_SYSTEM_PROMPT_AI: '', log: { dbg: noop, warn: noop, err: noop }, randInt: () => 0, gm: {}, repo, ui,
    submitAnswer: async () => { submits.push('default'); }, showAutoAnswerPopup: noop, submitProblemAnswer: noop, parseManualAnswer: noop,
    getOnLesson: noop, checkinClass: noop, connectOrAttachLessonWS: noop, isMobileVersionPage: () => false, isNarrowDevice: () => false, syncMobileSlidesIntoRepo: noop,
    buildClassroomTask: () => ({ id: 'fixture', target: { allowSubmit: true }, question: {} }), runAnswer: chat,
    submitAnswerTask: async () => { submits.push('AI'); return { route: 'answer' }; }, displayAnswer: () => '', getOverride: () => ({}), captureSlideImage: async () => '',
    ...timing, answerLog: noop, ensureAutoAnswerAgreement: async () => true, trace: noop,
  };
  const win = { addEventListener: (type, fn) => listeners.set(type, fn), dispatchEvent: noop };
  const context = vm.createContext({ console, AbortController, Date: class extends Date { static now() { return now; } }, window: win,
    document: { visibilityState: 'visible', hidden: false }, CustomEvent: class {}, setInterval: fn => { intervals.push(fn); return 1; }, setTimeout: () => 1, clearTimeout: noop, location: { pathname: '' } });
  const source = await fs.readFile(new URL('src/state/actions.js', root), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async specifier => {
    const match = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].find(m => m[2] === specifier);
    const names = match[1].split(',').map(s => s.trim());
    return new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, bindings[n]); }, { context });
  });
  await module.evaluate();
  const actions = module.namespace.actions;
  actions.startAutoAnswerLoop();
  return { actions, repo, ui, submits,
    unlock(id, age = 0) { repo.problems.set(id, { problemId: id, problemType: 1, body: 'fixture' }); actions.onUnlockProblem({ prob: id, sid: 's1', dt: now - age, limit: 60 }); },
    advance(ms) { now += ms; intervals[0](); },
    stop() { ui.config.autoAnswer = false; listeners.get('ykt:config:changed')(); },
  };
}
await test('关闭自动作答取消已排队的定时任务', async () => {
  const f = await actionsFixture(); f.unlock('p1'); f.stop(); f.advance(2000); await tick();
  assert.equal(f.submits.length, 0);
  assert.equal(f.repo.problemStatus.get('p1').autoAnswerTime, null);
});
await test('关闭自动作答中止在途 AI，迟到结果不能提交', async () => {
  let finish;
  let signal;
  const f = await actionsFixture(async (_task, policy) => { signal = policy.signal; return new Promise(resolve => { finish = resolve; }); });
  f.unlock('p1'); f.advance(1100); await tick(); assert.ok(finish);
  f.stop(); assert.equal(signal.aborted, true);
  finish({ ok: true, answer: {} }); await tick();
  assert.equal(f.submits.length, 0);
  assert.equal(f.repo.problemStatus.get('p1').answering, false);
});
await test('停止后重新开启不复活旧队列', async () => {
  let finish;
  let calls = 0;
  const f = await actionsFixture(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  f.unlock('p1'); f.unlock('p2'); f.advance(1100); await tick();
  f.stop(); f.ui.config.autoAnswer = true;
  finish({ ok: true, answer: {} }); await tick();
  assert.equal(calls, 1); assert.equal(f.submits.length, 0);
});
await test('历史解锁事件不会重新获得完整作答窗口', async () => {
  const f = await actionsFixture(); f.unlock('old', 120000); f.advance(2000); await tick();
  assert.equal(f.repo.problemStatus.get('old').clockOffset, 0);
  assert.equal(f.submits.length, 0);
});
await test('时钟偏差只取独立 HTTP Date，慢响应不污染校时', () => {
  const now = 1800000000000;
  timing.observeServerClock(new Date(now + 10000).toUTCString(), now, now);
  assert.equal(timing.getServerClockOffset(), 10000);
  timing.observeServerClock(new Date(now - 20000).toUTCString(), now - 6000, now);
  assert.equal(timing.getServerClockOffset(), 10000);
  timing.observeServerClock(new Date(now).toUTCString(), now, now);
});

const shim = await fs.readFile(new URL('../android/app/src/main/assets/gm-shim.js', root), 'utf8');
function shimFixture(fetchImpl) {
  const timers = new Map(); let timerId = 0;
  class Target { dispatchEvent() {} }
  class Anchor extends Target { click() {} }
  const context = vm.createContext({ console: { log: noop, warn: noop }, AbortController, localStorage: globalThis.localStorage,
    HTMLAnchorElement: Anchor, EventTarget: Target, document: { addEventListener: noop },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), fetch: fetchImpl,
  });
  context.window = context; context.addEventListener = noop;
  vm.runInContext(shim, context);
  return { context, timers };
}
await test('Android fetch 超时只触发一次 ontimeout，不再发原生请求', async () => {
  const f = shimFixture((_url, opt) => new Promise((_resolve, reject) => opt.signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })))));
  let native = 0, timeouts = 0;
  f.context.YktBridge = { fetchRequest() { native++; } };
  const handle = f.context.GM_xmlhttpRequest({ url: 'https://example.invalid', timeout: 10, ontimeout() { timeouts++; } });
  [...f.timers.values()][0](); await tick();
  assert.equal(timeouts, 1); assert.equal(native, 0); assert.equal(typeof handle.abort, 'function');
});
await test('Android 原生降级超时会中止原生请求，忽略迟到回调', async () => {
  const f = shimFixture(async () => { throw new TypeError('CORS'); });
  let aborts = 0, timeouts = 0, loads = 0, late;
  f.context.YktBridge = { fetchRequest(_m, _u, _h, _b, _binary, id) { late = f.context[id]; return { abort() { aborts++; } }; } };
  f.context.GM_xmlhttpRequest({ url: 'https://example.invalid', timeout: 10, ontimeout() { timeouts++; }, onload() { loads++; } });
  await tick(); assert.ok(late);
  [...f.timers.values()][0](); late(true, 200, '{}', '');
  assert.equal(aborts, 1); assert.equal(timeouts, 1); assert.equal(loads, 0);
});
await test('Android 响应体挂起仍受超时限制', async () => {
  const f = shimFixture(async () => ({ status: 200, headers: new Map(), text: () => new Promise(noop) }));
  let timeouts = 0;
  f.context.GM_xmlhttpRequest({ url: 'https://example.invalid', timeout: 10, ontimeout() { timeouts++; } });
  await tick(); assert.equal(f.timers.size, 1); [...f.timers.values()][0](); assert.equal(timeouts, 1);
});
const facade = await fs.readFile(new URL('../android/app/src/main/assets/native-bridge.js', root), 'utf8');
await test('原生消息结果只回到发起页面；取消后丢弃结果；子 frame 不建立 facade', () => {
  function page(subframe = false) {
    const sent = [];
    const c = { localStorage: globalThis.localStorage, __yktNativeChannel: { postMessage(raw) { sent.push(JSON.parse(raw)); } } };
    c.window = c; c.top = subframe ? {} : c;
    vm.runInNewContext(facade, c); return { c, sent };
  }
  const a = page(), b = page(), frame = page(true);
  assert.equal(frame.c.YktBridge, undefined);
  let resultA = 0, resultB = 0;
  a.c.cb = () => { resultA++; }; b.c.cb = () => { resultB++; };
  const handle = a.c.YktBridge.fetchRequest('GET', 'https://example.invalid', '{}', '', false, 'cb');
  const request = a.sent.at(-1);
  a.c.__yktNativeChannel.onmessage({ data: JSON.stringify({ id: request.id, result: { ok: true, status: 200, body: 'fixture' } }) });
  assert.equal(resultA, 1); assert.equal(resultB, 0);
  handle.abort();
  a.c.__yktNativeChannel.onmessage({ data: JSON.stringify({ id: request.id, result: { ok: true, status: 200, body: 'late' } }) });
  assert.equal(resultA, 1); assert.equal(a.sent.at(-1).method, 'cancelRequest');
});
console.log(`结果：${passed} 通过，0 失败`);
