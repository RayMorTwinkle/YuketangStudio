// scripts/test-tools.mjs
// 「提交答案」工具参数归一化的单元测试（纯函数，不依赖浏览器）
import assert from 'node:assert/strict';
import {
  normalizeToolArgs,
  toolPromptBlock,
  isToolUnsupportedError,
} from '../src/ai/tools.js';

// 单选：字母大写 + 去重 + 排序
let r = normalizeToolArgs({ answers: ['a', 'C'] }, 1);
assert.equal(r.content, 'A,C');
assert.deepEqual(r.result, ['A', 'C']);
assert.equal(r.display, 'A、C');

// 多选：JSON 字符串入参
r = normalizeToolArgs('{"answers":["b"]}', 2);
assert.equal(r.content, 'B');
assert.deepEqual(r.result, ['B']);

// 判断题：×/√ 映射到作业选项标签 A/B
r = normalizeToolArgs({ answers: ['×'] }, 2, { __optionLabels: ['A', 'B'] });
assert.equal(r.content, 'B');
assert.deepEqual(r.result, ['B']);
r = normalizeToolArgs({ answers: ['√'] }, 2, { __optionLabels: ['A', 'B'] });
assert.equal(r.content, 'A');
// 选项 key 本身是 √/×
r = normalizeToolArgs({ answers: ['×'] }, 2, { options: [{ key: '√' }, { key: '×' }] });
assert.equal(r.content, '×');

// 填空：按空顺序换行拼接
r = normalizeToolArgs({ answers: ['12', '3.5'] }, 4);
assert.equal(r.content, '12\n3.5');
assert.deepEqual(r.result, ['12', '3.5']);

// 主观：合并为一段文本 + pics 结构
r = normalizeToolArgs({ answers: ['第一行', '第二行'] }, 5);
assert.equal(r.content, '第一行\n第二行');
assert.deepEqual(r.result, { content: '第一行\n第二行', pics: [] });

// 非法 JSON
assert.throws(() => normalizeToolArgs('{bad', 1), /JSON/);
// 空答案
assert.throws(() => normalizeToolArgs({ answers: [] }, 1), /为空/);
// 选择题没有字母
assert.throws(() => normalizeToolArgs({ answers: ['123'] }, 1), /选项字母/);
// 未知题型
assert.throws(() => normalizeToolArgs({ answers: ['x'] }, 9), /不支持/);

// 工具不支持错误的识别
assert.equal(
  isToolUnsupportedError(new Error('HTTP 400: {"error":{"message":"tools is not supported"}}')),
  true,
);
assert.equal(isToolUnsupportedError(new Error('HTTP 400: bad request')), false);
assert.equal(isToolUnsupportedError(new Error('HTTP 500: boom')), false);

// 自动作答提示必须包含「必须调用」
const block = toolPromptBlock({ problemType: 1 }, { mandatory: true });
assert.match(block, /必须调用/);
assert.match(block, /submit_answer/);
assert.match(block, /判断题/);

console.log('✅ tools tests passed');
