// src/core/dom.js
// 轻量 DOM 工具——escapeHtml 此前在 ai.js / chat.js / auto-answer-popup.js 各抄了一份
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 把截图数据统一成合法的 image_url：
 * - 已经是 data:image/... 或 http(s) URL → 原样返回
 * - 裸 base64（captureSlideImage 的返回值）→ 按魔数补 data: 前缀
 */
export function ensureImageUrl(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (/^data:image\//i.test(v) || /^https?:\/\//i.test(v)) return v;
  const mime = v.startsWith('iVBORw0KGgo') ? 'image/png'
    : v.startsWith('R0lGOD') ? 'image/gif'
      : v.startsWith('UklGR') ? 'image/webp'
        : 'image/jpeg';
  return `data:${mime};base64,${v}`;
}
