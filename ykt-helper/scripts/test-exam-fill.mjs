// scripts/test-exam-fill.mjs
// 考试 AI 填入的纯解析单测（DOM 适配器需浏览器 E2E 验证）。
import assert from 'node:assert/strict';
import { parseChoiceLetters } from '../src/quiz/exam-fill.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.error('  ❌', name, '\n    ', e?.stack || e); }
}

console.log('== 选择题答案解析 ==');
ok('单字母', () => assert.deepEqual(parseChoiceLetters('A'), ['A']));
ok('答案：B', () => assert.deepEqual(parseChoiceLetters('答案：B'), ['B']));
ok('多选逗号', () => assert.deepEqual(parseChoiceLetters('A, C'), ['A', 'C']));
ok('多选中文顿号', () => assert.deepEqual(parseChoiceLetters('A、B、D'), ['A', 'B', 'D']));
ok('带解释仍提取选项', () => assert.deepEqual(parseChoiceLetters('正确答案是 C，因为……'), ['C']));
ok('小写', () => assert.deepEqual(parseChoiceLetters('b'), ['B']));
ok('空文本', () => assert.deepEqual(parseChoiceLetters(''), []));
ok('不把普通单词里的 A 当选项', () => assert.deepEqual(parseChoiceLetters('A cat'), ['A']));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
