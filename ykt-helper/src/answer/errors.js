// src/answer/errors.js
// 共享错误识别（不依赖旧 tools.js）。

/** 判断错误是否属于「当前端点不支持 tool calling」 */
export function isToolUnsupportedError(err) {
  const msg = String(err?.message || err || '');
  if (!/HTTP\s*400/i.test(msg) && !/HTTP\s*422/i.test(msg)) return false;
  return /tool|function[_ ]?call|tool_choice/i.test(msg);
}
