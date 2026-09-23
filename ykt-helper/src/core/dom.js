// src/core/dom.js
// 轻量 DOM 工具——escapeHtml 此前在 ai.js / chat.js / auto-answer-popup.js 各抄了一份
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
