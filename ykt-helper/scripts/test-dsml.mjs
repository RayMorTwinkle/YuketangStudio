import { parseDsmlToolCalls, stripDsml } from '../src/ai/dsml.js';

const sample = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="submit_answer">
<｜｜DSML｜｜ parameter name="answers" string="false">["C"]</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const std = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="submit_answer">
<｜DSML｜parameter name="answers" string="false">["A","C"]</｜DSML｜parameter>
<｜DSML｜parameter name="reason" string="true">因为 A、C 正确</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${extra}`); failed++; }
};

console.log('== DSML 双竖线格式 ==');
const a = parseDsmlToolCalls(sample);
check('解析出 1 个工具调用', a.length === 1, JSON.stringify(a));
check('name=submit_answer', a[0]?.function?.name === 'submit_answer');
check('answers=["C"]', a[0]?.function?.arguments === '{"answers":["C"]}', a[0]?.function?.arguments);

console.log('== DSML 标准格式 ==');
const b = parseDsmlToolCalls(std);
check('解析出 1 个工具调用', b.length === 1);
check('answers=["A","C"]', JSON.parse(b[0]?.function?.arguments || '{}').answers?.join(',') === 'A,C');
check('reason 字符串', JSON.parse(b[0]?.function?.arguments || '{}').reason === '因为 A、C 正确');

console.log('== 普通文本不误判 ==');
check('无 DSML 返回空', parseDsmlToolCalls('答案是 C，因为……').length === 0);

console.log('== stripDsml ==');
check('正文去标记', stripDsml(`答案是 C\n${sample}`) === '答案是 C', JSON.stringify(stripDsml(`答案是 C\n${sample}`)));

process.exit(failed ? 1 : 0);
