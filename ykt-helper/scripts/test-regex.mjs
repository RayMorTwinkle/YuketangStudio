import { parseRegexAnswer, stripRegexAnswer, regexToolCall, regexAnswerPrompt } from '../src/ai/regex-answer.js';

let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${extra}`); failed++; }
};

console.log('== 单选 ==');
const single = parseRegexAnswer('理由：1+1=2。\n<answer>B</answer>', 1);
check('解析出 B', single?.answers?.join(',') === 'B', JSON.stringify(single));
check('matched 正确', single?.matched === '<answer>B</answer>', single?.matched);

console.log('== 多选（排序去重） ==');
const multi = parseRegexAnswer('<answer>C,A,C</answer>', 2);
check('解析出 A,C', multi?.answers?.join(',') === 'A,C', JSON.stringify(multi));

console.log('== 填空（每行一空 / 竖线容错） ==');
const fill1 = parseRegexAnswer('<answer>\n12\n3.5\n</answer>', 4);
check('两空', fill1?.answers?.join('|') === '12|3.5', JSON.stringify(fill1));
const fill2 = parseRegexAnswer('<answer>12|3.5</answer>', 4);
check('单行竖线', fill2?.answers?.join('|') === '12|3.5', JSON.stringify(fill2));

console.log('== 主观（多行保留） ==');
const subj = parseRegexAnswer('<answer>第一行\n第二行</answer>', 5);
check('保留换行', subj?.answers?.[0] === '第一行\n第二行', JSON.stringify(subj));

console.log('== 判断题符号 ==');
const judge = parseRegexAnswer('<answer>×</answer>', 2);
check('判断题 × 解析', judge?.answers?.join('') === '×', JSON.stringify(judge));
const judge2 = parseRegexAnswer('<answer>√</answer>', 2);
check('判断题 √ 解析', judge2?.answers?.join('') === '√', JSON.stringify(judge2));

console.log('== 多个标记取最后一个 ==');
const last = parseRegexAnswer('示例 <answer>A</answer>\n最终 <answer>D</answer>', 1);
check('取 D', last?.answers?.join(',') === 'D', JSON.stringify(last));

console.log('== 中文标记 / 全角 / 大小写 / 代码块 ==');
const cn = parseRegexAnswer('<答案>C</答案>', 1);
check('中文标记', cn?.answers?.join(',') === 'C', JSON.stringify(cn));
const fw = parseRegexAnswer('＜answer＞D＜/answer＞', 1);
check('全角尖括号', fw?.answers?.join(',') === 'D', JSON.stringify(fw));
const code = parseRegexAnswer('```html\n<ANSWER>B</ANSWER>\n```', 1);
check('大小写+代码块', code?.answers?.join(',') === 'B', JSON.stringify(code));

console.log('== 不误判 ==');
check('无标记返回 null', parseRegexAnswer('答案是 B，因为……', 1) === null);
check('空标记返回 null', parseRegexAnswer('<answer></answer>', 1) === null);
check('NO_PROMPT 返回 null', parseRegexAnswer('STATE: NO_PROMPT\n<answer>A</answer>', 1) === null);

console.log('== 只取 content（reasoning 不传） ==');
const reasoningOnly = '<answer>A</answer>'; // 思考内容里有演练
const contentOnly = '我不确定，先按 B 算。\n<answer>B</answer>';
check('content 解析 B（reasoning 不参与）', parseRegexAnswer(contentOnly, 1)?.answers?.join(',') === 'B', reasoningOnly);

console.log('== 去标记 ==');
const stripped = stripRegexAnswer('理由：1+1=2。\n<answer>B</answer>');
check('保留理由、去掉标记', stripped === '理由：1+1=2。', JSON.stringify(stripped));
check('多个标记全部去掉', stripRegexAnswer('示例 <answer>A</answer>\n最终 <answer>B</answer>') === '示例\n最终', JSON.stringify(stripRegexAnswer('示例 <answer>A</answer>\n最终 <answer>B</answer>')));

console.log('== 合成 toolCall ==');
const tc = regexToolCall(['B']);
check('name=submit_answer', tc.function.name === 'submit_answer');
check('arguments 可解析', JSON.parse(tc.function.arguments).answers.join(',') === 'B');

console.log('== prompt ==');
const p1 = regexAnswerPrompt({ problemType: 1 }, { mandatory: true });
check('含单选格式', p1.includes('<answer>B</answer>'), p1);
check('含多选格式', p1.includes('<answer>A,C</answer>'));
check('含填空示例', p1.includes('12') && p1.includes('3.5'));
check('不含 <reason>', !/<reason/i.test(p1));
check('自动作答强制', p1.includes('必须输出 <answer>'));
const p2 = regexAnswerPrompt({ problemType: 2 }, { soft: true });
check('软提示不强制', p2.includes('如果用户要的是最终答案'));
check('无题目返回空', regexAnswerPrompt(null) === '');

process.exit(failed ? 1 : 0);
