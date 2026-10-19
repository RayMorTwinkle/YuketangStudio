// src/core/test-mode.js
// 测试模式：URL 带 ?ykt_test=1 或 localStorage['ykt:test-mode']='1' 时启用。
// 仅用于无真实课堂时验证 AI 工具调用链路，生产环境默认关闭。

export function isTestMode() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('ykt_test') === '1') return true;
    return localStorage.getItem('ykt:test-mode') === '1';
  } catch {
    return false;
  }
}

/** 取当前测试用的假 AI 响应（未启用测试模式时永远为 null） */
export function getTestMock() {
  if (!isTestMode()) return null;
  try {
    return window.__yktTestMock || null;
  } catch {
    return null;
  }
}

/** 取提交模拟模式（null=真实提交；'ok'|'retry'|'fail'） */
export function getTestSubmitMode() {
  if (!isTestMode()) return null;
  try {
    return window.__yktTestMockSubmit || null;
  } catch {
    return null;
  }
}
