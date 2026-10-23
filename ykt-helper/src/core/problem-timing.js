// src/core/problem-timing.js
// 题目时间唯一入口：服务端可能给秒级或毫秒级时间戳，统一在这里归一化。
// 所有倒计时/过期判断都从这里取，避免 actions / active-problems / 通知弹窗各自算一套。

/** 秒级/毫秒级时间戳 → 毫秒；非法/空 → null */
export function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 1e11 约等于 1973 年的毫秒值；小于它的正数按秒处理
  return Math.abs(n) < 100_000_000_000 ? Math.round(n * 1000) : Math.round(n);
}

/** 解锁时间 + 限时秒数 → 截止时间（毫秒）；无有效限时 → null */
export function deadlineFromLimit(startTime, limitSeconds) {
  const start = normalizeTimestamp(startTime);
  const seconds = Number(limitSeconds);
  if (start == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return start + Math.round(seconds * 1000);
}

/** 服务端时间轴上的“现在” */
export function serverNow(clockOffset = 0, now = Date.now()) {
  return now + (Number(clockOffset) || 0);
}

/** 是否已到截止时间；endTime 为空表示不限时 */
export function isDeadlineReached(endTime, clockOffset = 0, now = Date.now()) {
  const end = normalizeTimestamp(endTime);
  return end != null && serverNow(clockOffset, now) >= end;
}

/** 剩余秒数；endTime 为空表示不限时，返回 null */
export function remainingSeconds(endTime, clockOffset = 0, now = Date.now()) {
  const end = normalizeTimestamp(endTime);
  if (end == null) return null;
  return Math.max(0, Math.floor((end - serverNow(clockOffset, now)) / 1000));
}
