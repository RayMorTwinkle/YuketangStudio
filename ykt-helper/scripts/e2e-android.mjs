// scripts/e2e-android.mjs
// Android 真机端到端测试（debug APK + EVAL/NAV 广播，测试模式，不真实提交）。
// 运行：node scripts/e2e-android.mjs
// 前置：debug APK 已安装（com.yuketangstudio.shell），设备已连 adb。
import { execFileSync } from 'node:child_process';

const PKG = 'com.yuketangstudio.shell';
const ACTION_NAV = `${PKG}.NAV`;
const ACTION_EVAL = `${PKG}.EVAL`;
const LOGIN_URL = 'https://changjiang.yuketang.cn/web/?next=/m/v2&type=3&ykt_test=1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function adb(args, opts = {}) {
  return execFileSync('adb', args, { encoding: 'utf8', ...opts }).toString();
}
function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}
async function evalJs(js, { wait = 900 } = {}) {
  try { adb(['logcat', '-c']); } catch { /* ignore */ }
  const code = `eval(decodeURIComponent(escape(atob('${b64(js)}'))))`;
  adb(['shell', `am broadcast -p ${PKG} -a ${ACTION_EVAL} --es js "${code.replace(/"/g, '\\"')}"`]);
  const end = Date.now() + wait;
  while (Date.now() < end) {
    const out = adb(['logcat', '-d', '-s', 'YktShell']);
    const lines = out.split('\n').filter((l) => l.includes('EVAL 结果: '));
    if (lines.length) {
      const raw = lines.at(-1).split('EVAL 结果: ')[1].trim();
      if (!raw) break;
      try {
        let v = JSON.parse(raw);
        if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
          try { v = JSON.parse(v); } catch { /* keep string */ }
        }
        return v;
      } catch { /* wait */ }
    }
    await sleep(200);
  }
  return undefined;
}
function nav(url) {
  adb(['shell', `am broadcast -p ${PKG} -a ${ACTION_NAV} --es url '${url}'`]);
}
async function ensureTestMode() {
  try { adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]); } catch { /* ignore */ }
  await sleep(2500);
  let t = await evalJs('typeof window.__yktTest', { wait: 1500 });
  if (t === 'object') return;
  for (let i = 0; i < 3 && t !== 'object'; i++) {
    await evalJs(`localStorage.setItem('ykt:test-mode','1');localStorage.setItem('ykt-helper:onboarding.version','1');'ok'`, { wait: 1200 });
    nav(LOGIN_URL);
    await sleep(6000);
    t = await evalJs('typeof window.__yktTest', { wait: 1500 });
  }
  if (t !== 'object') throw new Error('真机测试模式未就绪，请确认 debug APK 与页面');
}
async function setTestConfig(regex) {
  await evalJs(`window.__yktTest.setTestConfig({regex:${regex ? 'true' : 'false'}});'ok'`, { wait: 900 });
}
async function setRegex(on) {
  await setTestConfig(!!on);
}
async function run(name, js, wait = 5000) {
  await evalJs(js, { wait: 500 });
  const end = Date.now() + wait;
  let result;
  while (Date.now() < end) {
    result = await evalJs('window.__e2eResult ? JSON.stringify(window.__e2eResult) : null', { wait: 900 });
    if (result && !(typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0)) break;
    await sleep(500);
  }
  if (!result) throw new Error(`${name}: 超时`);
  return result;
}

const CARD = `(()=>{const c=[...document.querySelectorAll('#ykt-ai-log .ykt-tool-card')].at(-1);return c?{title:c.querySelector('.ykt-tool-title')?.textContent||'',answer:c.querySelector('.ykt-tool-answer')?.textContent||'',status:c.querySelector('.ykt-tool-status')?.textContent||'',btn:c.querySelector('.ykt-tool-submit')?.textContent||''}:null})()`;
const PRE = `const T=window.__yktTest;window.__e2eResult=null;`;
const ASYNC = (body) => `${PRE}(async()=>{${body}})()`;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.message || e); }
}

await ensureTestMode();
await setTestConfig(false);
console.log('== 真机 tools 模式 ==');
for (let round = 1; round <= 3; round++) {
  console.log(`-- 第 ${round} 轮 --`);
  await check(`课堂多选 → A、C（第 ${round} 轮）`, async () => {
    const r = await run('classroom', ASYNC(`
      T.reset();T.clearUI();
      T.injectProblem(2,{body:'以下哪些是编程语言？',options:[{key:'A',value:'JavaScript'},{key:'B',value:'Python'},{key:'C',value:'HTML'}]});
      T.mockSubmit('ok');T.mockTool({answers:['A','C'],reason:'手机'});
      const r=await T.ask();
      window.__e2eResult={ok:r?.ok,transport:r?.run?.transport,card:${CARD}};
    `));
    if (!r.ok || r.card?.answer !== 'A、C' || r.card?.title !== '📤 提交答案') throw new Error(JSON.stringify(r));
  });

  await check(`诊断报告 → 有 task/lastRun/log（第 ${round} 轮）`, async () => {
    const r = await run('diagnostic', ASYNC(`
      T.reset();T.clearUI();
      T.injectProblem(2,{body:'诊断报告',options:[{key:'A',value:'甲'},{key:'B',value:'乙'}]});
      T.mockTool({answers:['A']});
      await T.ask();
      const d=T.diagnostic();
      window.__e2eResult={task:d.task?.id,ok:d.lastRun?.ok,runId:d.lastRun?.runId,logLen:d.answerLog?.length||0,version:d.version};
    `));
    if (!/^classroom:/.test(r.task || '') || r.ok !== true || !/^ans_/.test(r.runId || '') || (r.logLen || 0) < 3) throw new Error(JSON.stringify(r));
  });

  await check(`课堂单选 文本兜底 → A（第 ${round} 轮）`, async () => {
    const r = await run('legacy', ASYNC(`
      T.reset();T.clearUI();
      T.injectProblem(1,{body:'1+1=?',options:[{key:'A',value:'1'},{key:'B',value:'2'}]});
      T.mockText('答案: A\\n解释: 1+1=2');
      const el=document.querySelector('#ykt-ai-input');if(el)el.value='再解释一下';
      const r=await T.ask();
      window.__e2eResult={ok:r?.ok,source:r?.run?.answer?.source,card:${CARD}};
    `));
    if (!r.ok || r.card?.answer !== 'A') throw new Error(JSON.stringify(r));
  });

  await check(`作业判断 A/B + × → 不猜、不生成卡片（第 ${round} 轮）`, async () => {
    const r = await run('judge', ASYNC(`
      T.reset();T.clearUI();
      T.mockTool({answers:['×']});
      const r=await T.askAssignment('Judgement',{bullets:[{Label:'A'},{Label:'B'}]});
      window.__e2eResult={ok:r?.ok,code:r?.run?.error?.code,count:document.querySelectorAll('#ykt-ai-log .ykt-tool-card').length};
    `));
    if (r.ok !== false || r.code !== 'INVALID_ANSWER' || r.count !== 0) throw new Error(JSON.stringify(r));
  });

  await check(`作业填空 暂存 → 已暂存（第 ${round} 轮）`, async () => {
    const r = await run('fill', ASYNC(`
      T.reset();T.clearUI();T.mockSubmit('ok');T.mockTool({answers:['1','2']});
      const r=await T.askAssignment('FillBlank',{blanks:['a','b']});
      const c=[...document.querySelectorAll('#ykt-ai-log .ykt-tool-card')].at(-1);
      c?.querySelector('.ykt-tool-submit')?.click();
      await new Promise(x=>setTimeout(x,900));
      window.__e2eResult={ok:r?.ok,card:${CARD}};
    `));
    if (!r.ok || r.card?.answer !== '1 | 2' || !/已暂存/.test(r.card?.status || '')) throw new Error(JSON.stringify(r));
  });

  await check(`作业主观 暂存 → 已暂存（第 ${round} 轮）`, async () => {
    const r = await run('subjective', ASYNC(`
      T.reset();T.clearUI();T.mockSubmit('ok');T.mockTool({answers:['一段完整作答']});
      const r=await T.askAssignment('Subjective');
      const c=[...document.querySelectorAll('#ykt-ai-log .ykt-tool-card')].at(-1);
      c?.querySelector('.ykt-tool-submit')?.click();
      await new Promise(x=>setTimeout(x,900));
      window.__e2eResult={ok:r?.ok,card:${CARD}};
    `));
    if (!r.ok || r.card?.answer !== '一段完整作答' || !/已暂存/.test(r.card?.status || '')) throw new Error(JSON.stringify(r));
  });

  await check(`自动作答 合法 → done（第 ${round} 轮）`, async () => {
    const r = await run('auto', ASYNC(`
      T.reset();T.clearUI();
      const pid=T.injectProblem(1,{body:'1+1=?',options:[{key:'A',value:'1'},{key:'B',value:'2'}]});
      T.mockSubmit('ok');T.mockTool({answers:['B']});
      await T.askAutoAction(pid);
      const log=T.getAnswerLog().filter(e=>e.taskId==='classroom:'+pid).map(e=>({event:e.event,code:e.code,transport:e.transport}));
      window.__e2eResult={state:T.getAutoState(pid),log};
    `), 9000);
    if (r.state?.status?.done !== true) throw new Error(JSON.stringify(r));
    if (!r.log.some((e) => e.event === 'engine_start')) throw new Error('自动作答没有走新引擎: ' + JSON.stringify(r.log));
  });

  await check(`自动作答 非法 → 不提交（第 ${round} 轮）`, async () => {
    const r = await run('auto-bad', ASYNC(`
      T.reset();T.clearUI();
      const pid=T.injectProblem(1,{body:'非法',options:[{key:'A',value:''},{key:'B',value:''}]});
      T.mockSubmit('ok');T.mockTool({answers:['×']});
      await T.askAutoAction(pid);
      const log=T.getAnswerLog().filter(e=>e.taskId==='classroom:'+pid).map(e=>({event:e.event,code:e.code,transport:e.transport}));
      window.__e2eResult={state:T.getAutoState(pid),log};
    `), 9000);
    if (r.state?.status?.done === true) throw new Error(JSON.stringify(r));
    if (!r.log.some((e) => e.code === 'INVALID_ANSWER')) throw new Error('没有记录非法答案解析: ' + JSON.stringify(r.log));
  });

  await check(`自动作答 tools 不支持 → 不猜文本（第 ${round} 轮）`, async () => {
    const r = await run('auto-notools', ASYNC(`
      T.reset();T.clearUI();
      const pid=T.injectProblem(1,{body:'不支持工具',options:[{key:'A',value:'1'},{key:'B',value:'2'}]});
      T.mockSubmit('ok');T.mockNoTools('答案: A');
      await T.askAutoAction(pid);
      const log=T.getAnswerLog().filter(e=>e.taskId==='classroom:'+pid).map(e=>({event:e.event,code:e.code,transport:e.transport}));
      window.__e2eResult={state:T.getAutoState(pid),log};
    `), 9000);
    if (r.state?.status?.done === true) throw new Error(JSON.stringify(r));
    if (!r.log.some((e) => e.event === 'engine_done' && e.code === 'NO_TOOL')) throw new Error('没有记录降级失败: ' + JSON.stringify(r.log));
  });

  await check(`历史题 无 status → 只展示（第 ${round} 轮）`, async () => {
    const r = await run('display', ASYNC(`
      T.reset();T.clearUI();
      const pid=T.injectProblem(2,{body:'历史题'});
      T.dropStatus(pid);T.mockText('答案: A');
      const r=await T.askProblemList(pid);
      window.__e2eResult={ok:r?.ok,transport:r?.run?.transport,card:${CARD}};
    `));
    if (!r.ok || r.transport !== 'text' || r.card?.title !== '💡 参考答案（不提交）') throw new Error(JSON.stringify(r));
  });
}

console.log('== 真机提醒 AI ==');
await check('提醒卡片 AI 使用该题 task（不是当前页）', async () => {
  const r = await run('notify-card', ASYNC(`
    T.reset();T.clearUI();
    const pid1=T.injectProblem(1,{body:'提醒里的题',options:[{key:'A',value:'甲'},{key:'B',value:'乙'}]});
    const pid2=T.injectProblem(1,{body:'当前页另一题',options:[{key:'A',value:'甲'},{key:'B',value:'乙'}]});
    T.mockTool({answers:['A']});
    const run=await T.askProblem(pid1);
    window.__e2eResult={ok:run?.ok,task:T.diagnostic()?.task?.id||'',pid1:String(pid1),pid2:String(pid2)};
  `), 9000);
  if (!r.ok || r.task !== `classroom:${r.pid1}` || r.pid1 === r.pid2) throw new Error(JSON.stringify(r));
});

await check('通知弹窗 AI 使用该题 task', async () => {
  const r = await run('notify-popup', ASYNC(`
    T.reset();T.clearUI();
    const pid1=T.injectProblem(1,{body:'通知弹窗里的题',options:[{key:'A',value:'甲'},{key:'B',value:'乙'}]});
    T.injectProblem(1,{body:'当前页另一题',options:[{key:'A',value:'甲'},{key:'B',value:'乙'}]});
    T.mockTool({answers:['B']});
    document.querySelectorAll('.ykt-problem-notify').forEach(e=>e.remove());
    T.notifyProblem(pid1);
    await new Promise(x=>setTimeout(x,80));
    const popup=document.querySelector('.ykt-problem-notify');
    const btn=popup?[...popup.querySelectorAll('button')].find(b=>b.textContent.includes('AI 解答')):null;
    btn?.click();
    await new Promise(x=>setTimeout(x,1200));
    window.__e2eResult={task:T.diagnostic()?.task?.id||'',pid1:String(pid1),hasPopup:!!popup,hasBtn:!!btn};
  `), 9000);
  if (!r.hasPopup || !r.hasBtn || r.task !== `classroom:${r.pid1}`) throw new Error(JSON.stringify(r));
});

await check('unlockproblem dt 秒 → 状态毫秒', async () => {
  const r = await run('notify-time', ASYNC(`
    T.reset();T.clearUI();
    const pid=T.injectProblem(1,{body:'秒级时间戳'});
    const dt=Math.floor(Date.now()/1000)+300;
    const st=T.unlockProblem(pid,{dt,limit:60});
    window.__e2eResult={dt,startTime:st?.startTime,endTime:st?.endTime};
  `), 5000);
  if (r.startTime !== r.dt * 1000 || r.endTime !== r.dt * 1000 + 60000) throw new Error(JSON.stringify(r));
});

console.log('== 真机 regex 模式 ==');
await setRegex(true);
for (let round = 1; round <= 2; round++) {
  console.log(`-- 第 ${round} 轮 --`);
  await check(`regex 单选 → B（第 ${round} 轮）`, async () => {
    const r = await run('regex-choice', ASYNC(`
      T.reset();T.clearUI();
      T.injectProblem(1,{body:'1+1=?',options:[{key:'A',value:'1'},{key:'B',value:'2'}]});
      T.mockText('理由\\n<answer>B</answer>');
      const r=await T.ask();
      window.__e2eResult={ok:r?.ok,transport:r?.run?.transport,card:${CARD}};
    `));
    if (!r.ok || r.transport !== 'regex' || r.card?.answer !== 'B') throw new Error(JSON.stringify(r));
  });
  await check(`regex 判断 A/B + × → 报错（第 ${round} 轮）`, async () => {
    const r = await run('regex-judge', ASYNC(`
      T.reset();T.clearUI();
      T.mockText('<answer>×</answer>');
      const r=await T.askAssignment('Judgement',{bullets:[{Label:'A'},{Label:'B'}]});
      window.__e2eResult={ok:r?.ok,code:r?.run?.error?.code,count:document.querySelectorAll('#ykt-ai-log .ykt-tool-card').length};
    `));
    if (r.ok !== false || r.code !== 'INVALID_ANSWER' || r.count !== 0) throw new Error(JSON.stringify(r));
  });
}
await setRegex(false);

console.log(`\n真机结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
