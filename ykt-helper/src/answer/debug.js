// src/answer/debug.js
// 答题链路调试环形缓冲：真机/ego 可直接读 window.__yktAnswerLog。
const MAX = 200;
let log = [];

function push(ev) {
  try {
    log.push({ t: Date.now(), ...ev });
    if (log.length > MAX) log.splice(0, log.length - MAX);
    window.__yktAnswerLog = log;
  } catch { /* ignore */ }
}

export function answerLog(event, data = {}) {
  push({ event, ...data });
}

export function getAnswerLog() {
  return log.slice();
}

export function clearAnswerLog() {
  log = [];
  try { window.__yktAnswerLog = log; } catch { /* ignore */ }
}
