// src/index.js
import { installWSInterceptor } from './net/ws-interceptor.js';
import { installXHRInterceptor } from './net/xhr-interceptor.js';
import  './net/fetch-interceptor.js';
import { injectStyles } from './ui/styles.js';
import { installToolbar } from './ui/toolbar.js';
import { actions } from './state/actions.js';
import { ui } from './ui/ui-api.js';
import { isStudentV3Page, runHistoryCapture } from './core/history-capture.js'; 
import { log } from './core/log.js';

(function loadFA() {
  // document-start 极早期 document.head 可能尚未解析出来（手动 CDP 注入/异常时序），需兜底
  const target = document.head || document.documentElement || document;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
  target.appendChild(link);
})();

/** 用户正在页面里输入时，不要刷新打断 */
function userIsTyping() {
  try {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
  } catch {}
  return false;
}

function maybeAutoReloadOnMount() {
  try {
    // 脚本在 DOM ready 之后才挂载时，重载一次让 XHR/WS 拦截器尽早生效。
    // 用 sessionStorage 防无限循环。
    const key = '__ykt_helper_auto_reload_once__';
    if (document.readyState === 'loading') return false;
    if (!window.sessionStorage) return false;
    if (window.sessionStorage.getItem(key) === '1') return false;

    window.sessionStorage.setItem(key, '1');
    log.info('Late mount detected; reloading once to arm interceptors.');
    window.setTimeout(() => window.location.reload(), 50);
    return true;
  } catch {
    return false;
  }
}

function startPeriodicReload(opts = {}) {
  try {
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 5 * 60 * 1000;
    const onlyWhenHidden = (opts.onlyWhenHidden !== false);
    const skipLessonPages = (opts.skipLessonPages !== false);

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    window.setInterval(() => {
      try {
        // 课堂/报告页永不刷新（会被打断）
        if (skipLessonPages && /\/lesson\/|\/student-lesson-report\/|\/student-v3\//.test(window.location.pathname)) {
          log.dbg('skip reload: lesson/report page');
          return;
        }
        // 任意助手面板打开时不刷新，避免打断用户操作（PDF导出、AI对话等）
        if (document.querySelector('.ykt-panel.visible')) {
          log.dbg('skip reload: panel open');
          return;
        }
        // 页面可见时不刷新（用户在看着这个页面，刷新会造成明显干扰）
        if (onlyWhenHidden && !document.hidden) {
          log.dbg('skip reload: page visible');
          return;
        }
        // 用户正在输入时不刷新
        if (userIsTyping()) {
          log.dbg('skip reload: user typing');
          return;
        }

        log.info('Periodic reload triggered to avoid zombie session.');
        window.location.reload();
      } catch (e) {
        log.err('periodic reload tick failed', e);
      }
    }, intervalMs);
  } catch {}
}

(function main() {
  if (maybeAutoReloadOnMount()) return;
  // 仅在页面隐藏时刷新，且间隔放宽到 3 分钟：
  // 此前是 1 分钟 + 页面可见也刷新，是「面板莫名消失 / 脚本好像失效」的根源
  startPeriodicReload({ intervalMs: 3 * 60 * 1000, onlyWhenHidden: true, skipLessonPages: true });
  // 样式/图标
  injectStyles();

  // 挂 UI
  ui._mountAll?.();  

  // 再装网络拦截
  installWSInterceptor();
  installXHRInterceptor();

  // 加载工具条
  installToolbar();

  // 启动自动作答轮询
  actions.startAutoAnswerLoop();

  // 更新课件加载
  actions.launchLessonHelper();

  // 历史课件收集器：student-v3 报告页自动执行（配合课件面板的「历史课件」导入）
  if (isStudentV3Page()) {
    runHistoryCapture().catch(e => log.err('[History] 启动失败', e));
  }
})();
