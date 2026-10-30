// src/core/runtime.js
// Android 后台运行监控：JS 侧只上报状态和心跳，不接管课堂业务。
// 真正的 Foreground Service / 通知 / WakeLock 在 BackgroundRuntimeService.kt。
import { storage } from './storage.js';
import { repo } from '../state/repo.js';
import { log } from './log.js';
import { trace } from './telemetry.js';

const HEARTBEAT_MS = 10_000;
const state = {
  startedAt: Date.now(),
  lastHeartbeatAt: 0,
  lastVisibilityChangeAt: 0,
  lastWsMessageAt: 0,
  lastUnlockAt: 0,
  lastEventAt: 0,
  lastWsState: 'unknown',
  timerLagMs: 0,
  enabled: false,
  strong: false,
  batteryIgnored: null,
  lastError: '',
  native: null,
};
let heartbeatTimer = 0;
let expectedAt = 0;
let started = false;

function bridge() {
  try {
    if (window.YktBridge && typeof window.YktBridge.startBackgroundRuntime === 'function') {
      return window.YktBridge;
    }
  } catch { /* ignore */ }
  return null;
}

export function hasAndroidRuntime() {
  return !!bridge();
}

function readNativeState() {
  try {
    const raw = bridge()?.getBackgroundRuntimeState?.();
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    log.warn('[runtime] read native state failed', e?.message || e);
    return null;
  }
}

export function refreshNativeState() {
  const native = readNativeState();
  if (!native) return state;
  state.native = native;
  state.enabled = !!native.enabled;
  state.strong = !!native.strong;
  if (typeof native.heartbeatAt === 'number') state.lastHeartbeatAt = native.heartbeatAt;
  if (native.lastWsState) state.lastWsState = String(native.lastWsState);
  if (typeof native.lastWsMessageAt === 'number') state.lastWsMessageAt = native.lastWsMessageAt;
  if (typeof native.lastUnlockAt === 'number') state.lastUnlockAt = native.lastUnlockAt;
  if (typeof native.lastEventAt === 'number') state.lastEventAt = native.lastEventAt;
  try {
    state.batteryIgnored = bridge()?.isBatteryOptimizationIgnored?.() ?? null;
  } catch { state.batteryIgnored = null; }
  return state;
}

function snapshotPayload() {
  const cfg = storage.get('config', {}) || {};
  return {
    ts: Date.now(),
    heartbeatAt: Date.now(),
    visibility: document.visibilityState,
    hidden: !!document.hidden,
    hasFocus: document.hasFocus?.() ?? true,
    lastVisibilityChangeAt: state.lastVisibilityChangeAt,
    lastWsState: state.lastWsState,
    lastWsMessageAt: state.lastWsMessageAt,
    lastUnlockAt: state.lastUnlockAt,
    lastEventAt: state.lastEventAt,
    timerLagMs: state.timerLagMs,
    lessonId: String(repo.currentLessonId || ''),
    page: location.pathname,
    scriptVersion: typeof __BUILD_VERSION__ !== 'undefined' ? String(__BUILD_VERSION__) : '',
    autoAnswer: !!cfg.autoAnswer,
    autoJoin: !!cfg.autoJoinEnabled,
    autoAnswerOnAutoJoin: !!cfg.autoAnswerOnAutoJoin,
    enabled: state.enabled,
    strong: state.strong,
    lastError: state.lastError,
  };
}

function dispatchState() {
  try {
    window.dispatchEvent(new CustomEvent('ykt:runtime-state', { detail: getState() }));
  } catch { /* ignore */ }
}

export function getState() {
  refreshNativeState();
  return {
    ...state,
    visibility: document.visibilityState,
    hidden: !!document.hidden,
    hasFocus: document.hasFocus?.() ?? true,
    native: state.native || null,
    heartbeatAgeMs: state.lastHeartbeatAt ? Date.now() - state.lastHeartbeatAt : -1,
  };
}

function sendHeartbeat() {
  const payload = snapshotPayload();
  state.lastHeartbeatAt = payload.heartbeatAt;
  try {
    bridge()?.reportRuntime?.(JSON.stringify(payload));
  } catch (e) {
    state.lastError = String(e?.message || e);
  }
  // 只在强化遥测开启时上传；普通用户通过诊断报告读取本地状态。
  try {
    trace({
      event: 'runtime_heartbeat',
      ok: true,
      payload: {
        visibility: payload.visibility,
        hidden: payload.hidden,
        wsState: payload.lastWsState,
        lastEventAt: payload.lastEventAt,
        lastUnlockAt: payload.lastUnlockAt,
        lessonId: payload.lessonId,
        timerLagMs: payload.timerLagMs,
        enabled: payload.enabled,
        strong: payload.strong,
      },
    });
  } catch { /* ignore */ }
  dispatchState();
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  expectedAt = Date.now() + HEARTBEAT_MS;
  heartbeatTimer = window.setInterval(() => {
    const now = Date.now();
    state.timerLagMs = Math.max(0, now - expectedAt);
    expectedAt = now + HEARTBEAT_MS;
    sendHeartbeat();
  }, HEARTBEAT_MS);
  sendHeartbeat();
}

export function initRuntimeMonitor() {
  if (started) return;
  // 只由顶层页面上报，避免 iframe 里重复心跳/重复通知。
  try { if (window.self !== window.top) return; } catch { return; }
  started = true;
  state.startedAt = Date.now();
  const native = readNativeState();
  state.enabled = !!native?.enabled;
  state.strong = !!native?.strong;
  try {
    state.batteryIgnored = bridge()?.isBatteryOptimizationIgnored?.() ?? null;
  } catch { state.batteryIgnored = null; }
  // 后台服务由 Android 外壳拥有并在冷启动时恢复；脚本只上报心跳，不主动启动服务。

  document.addEventListener('visibilitychange', () => {
    state.lastVisibilityChangeAt = Date.now();
    sendHeartbeat();
    try {
      trace({
        event: 'runtime_visibility',
        ok: true,
        payload: { visibility: document.visibilityState, hidden: !!document.hidden },
      });
    } catch { /* ignore */ }
  });
  window.addEventListener('focus', () => sendHeartbeat());
  window.addEventListener('blur', () => sendHeartbeat());

  window.addEventListener('ykt:ws-state', (e) => {
    const detail = e?.detail || {};
    state.lastWsState = String(detail.state || 'unknown');
    state.lastWsMessageAt = Date.now();
    state.lastEventAt = Date.now();
    sendHeartbeat();
  });
  window.addEventListener('ykt:ws-message', () => {
    state.lastWsMessageAt = Date.now();
    state.lastEventAt = Date.now();
  });
  window.addEventListener('ykt:unlockproblem', () => {
    state.lastUnlockAt = Date.now();
    state.lastEventAt = Date.now();
    sendHeartbeat();
  });

  startHeartbeat();
  window.__yktRuntimePing = () => {
    sendHeartbeat();
    return true;
  };
  window.__yktRuntimeState = getState;
  refreshNativeState();
}
