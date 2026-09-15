// src/core/log.js
// 统一日志出口：默认只输出 warn/error，避免控制台被调试日志淹没。
// 需要排查问题时，在控制台执行 localStorage.setItem('yksDebug', '1') 后刷新页面即可全量输出。
// 关闭：localStorage.removeItem('yksDebug')
//
// 用法：
//   import { log } from './log.js';
//   log.dbg('[Chat] xxx', obj);     // 仅在 debug 模式输出
//   log.info('已加载');              // 仅在 debug 模式输出（普通信息）
//   log.warn('降级到 XXX');          // 始终输出
//   log.err('请求失败', e);          // 始终输出

const DEBUG_FLAG = 'yksDebug';

function isDebug() {
  try { return !!localStorage.getItem(DEBUG_FLAG); } catch { return false; }
}

// 允许运行时切换（控制台里 log.enable() / log.disable()）
let debugEnabled = isDebug();

const PREFIX = '[YuketangStudio]';

export const log = {
  /** 是否处于调试模式 */
  get debug() { return debugEnabled; },
  enable() { debugEnabled = true; try { localStorage.setItem(DEBUG_FLAG, '1'); } catch {} },
  disable() { debugEnabled = false; try { localStorage.removeItem(DEBUG_FLAG); } catch {} },

  /** 调试日志：默认静默 */
  dbg(...args) {
    if (!debugEnabled) return;
    try { console.log(PREFIX, ...args); } catch {}
  },
  /** 一般信息：默认静默（避免噪声淹没有效信息） */
  info(...args) {
    if (!debugEnabled) return;
    try { console.info(PREFIX, ...args); } catch {}
  },
  /** 警告：始终输出 */
  warn(...args) {
    try { console.warn(PREFIX, ...args); } catch {}
  },
  /** 错误：始终输出 */
  err(...args) {
    try { console.error(PREFIX, ...args); } catch {}
  },
};

export default log;
