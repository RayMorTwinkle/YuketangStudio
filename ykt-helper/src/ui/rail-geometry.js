// 课件右侧导航轨的纯几何计算：与 DOM 解耦，便于单测和回归。
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 算出 thumb 的高度/顶部位置。
 * trackHeight = rail.clientHeight；viewportHeight = list.clientHeight；contentHeight = list.scrollHeight。
 */
export function computeRailThumb({
  trackHeight,
  viewportHeight,
  contentHeight,
  scrollTop = 0,
  inset = 8,
  minHeight = 24,
} = {}) {
  const railHeight = Math.max(0, Number(trackHeight) || 0);
  const viewport = Math.max(0, Number(viewportHeight) || 0);
  const content = Math.max(0, Number(contentHeight) || 0);
  const usable = Math.max(0, railHeight - inset * 2);
  const maxScroll = Math.max(0, content - viewport);

  if (usable <= 0 || maxScroll <= 0) {
    return { visible: false, height: 0, top: inset, usable, maxScroll, maxTop: 0, ratio: 0 };
  }

  const visibleRatio = Math.min(1, viewport / Math.max(1, content));
  const height = Math.max(
    Math.min(minHeight, usable),
    Math.min(usable, Math.round(usable * visibleRatio)),
  );
  const maxTop = Math.max(0, usable - height);
  const ratio = clamp((Number(scrollTop) || 0) / maxScroll, 0, 1);

  return {
    visible: true,
    height,
    top: inset + Math.round(maxTop * ratio),
    usable,
    maxScroll,
    maxTop,
    ratio,
  };
}

/** 点击轨道时按点击位置映射到 scrollTop；顶部/底部能精确到达。 */
export function scrollTopForRailPoint({
  clientY,
  railTop,
  trackHeight,
  maxScroll,
  inset = 8,
}) {
  const usable = Math.max(0, Number(trackHeight) - inset * 2);
  const max = Math.max(0, Number(maxScroll) || 0);
  if (usable <= 0 || max <= 0) return 0;
  const ratio = clamp((Number(clientY) - Number(railTop) - inset) / usable, 0, 1);
  return ratio * max;
}

/** 拖动 thumb 时根据指针位移换算 scrollTop。 */
export function scrollTopForDrag({ startScroll, deltaY, maxTop, maxScroll }) {
  const max = Math.max(0, Number(maxScroll) || 0);
  const top = Math.max(0, Number(maxTop) || 0);
  if (max <= 0 || top <= 0) return clamp(Number(startScroll) || 0, 0, max);
  return clamp((Number(startScroll) || 0) + (Number(deltaY) / top) * max, 0, max);
}
