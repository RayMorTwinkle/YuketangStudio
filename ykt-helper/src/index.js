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
import { ensureFontAwesome } from './core/env.js';
import { checkForUpdate } from './core/update-check.js';

// Font Awesome：内嵌 css（字体 data-URI）优先；CSP 拦时 env.js 里退回 CDN
ensureFontAwesome();

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
        // AI 流式进行中不刷新——刷新直接掐断在途请求且无法恢复
        if (document.body?.dataset?.yksStreaming === '1') {
          log.dbg('skip reload: AI streaming in progress');
          return;
        }
        // 批量课件导入进行中不刷新（收集页 active:true 会让本页变 hidden，最易被误杀）
        if (document.getElementById('ykt-import-progress')) {
          log.dbg('skip reload: batch import in progress');
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

/** UI 调试模式：给所有 ykt-* 元素描红框（iframe 内橙框）+ 标 frame 来源。
 *  开启方式：URL ?ykt-debug=1、localStorage ykt-debug-outline=1、
 *  控制台 __yktDebugOutline(true)。 */
function installDebugOutline() {
  try {
    const tag = (window.self === window.top) ? 'top' : 'iframe';
    const stamp = () => {
      if (!document.body) return;
      for (const el of document.querySelectorAll('#ykt-helper-toolbar, .ykt-panel, .ykt-shell')) {
        if (!el.hasAttribute('data-ykt-frame')) el.setAttribute('data-ykt-frame', tag);
      }
    };
    window.__yktDebugOutline = (on = true) => {
      try { localStorage.setItem('ykt-debug-outline', on ? '1' : '0'); } catch {}
      document.body?.classList.toggle('ykt-debug-outline', !!on);
      if (on) { stamp(); }
    };
    const want = /[?&]ykt-debug=1/.test(location.search)
      || (() => { try { return localStorage.getItem('ykt-debug-outline') === '1'; } catch { return false; } })();
    if (want) {
      const t = setInterval(() => {
        if (document.body) {
          document.body.classList.add('ykt-debug-outline');
          stamp();
        }
      }, 500);
      setTimeout(() => clearInterval(t), 20000);
    }
  } catch {}
}

/** document.body 尚未出现时延迟挂载（document-start 注入/移动版 SPA 时序） */
function whenBodyReady(fn) {
  if (document.body) { fn(); return; }
  const timer = setInterval(() => {
    if (document.body) { clearInterval(timer); fn(); }
  }, 50);
  setTimeout(() => clearInterval(timer), 15000);
}

(function main() {
  if (maybeAutoReloadOnMount()) return;
  // 仅在页面隐藏时刷新，且间隔放宽到 3 分钟：
  // 此前是 1 分钟 + 页面可见也刷新，是「面板莫名消失 / 脚本好像失效」的根源
  startPeriodicReload({ intervalMs: 3 * 60 * 1000, onlyWhenHidden: true, skipLessonPages: true });
  // 样式/图标
  injectStyles();
  installDebugOutline();

  // iframe 里不挂 UI（toolbar/面板）——雨课堂 /v2/web/* 页会嵌套同源 iframe
  // （如 student-lesson-report 内嵌 /m/v2/lesson/student），双层各挂一套工具条
  // 会视觉重叠且外层无法读到 iframe 里的课件数据。数据抓取（拦截器/收集器）仍照常跑。
  const inIframe = window.self !== window.top;
  try { if (inIframe) document.documentElement.classList.add('ykt-in-iframe'); } catch {}

  // 挂 UI（单步失败不拖垮其余步骤）；iframe 内跳过 UI 挂载
  whenBodyReady(() => {
    if (!inIframe) {
      try { ui._mountAll?.(); } catch (e) { log.err('[mount] panels failed', e); }
      try { installToolbar(); } catch (e) { log.err('[mount] toolbar failed', e); }
    } else {
      log.dbg('[mount] iframe 内跳过 UI 挂载:', window.location.pathname);
    }
  });

  // 每次使用自动检查更新（15min 节流，失败静默）
  try { checkForUpdate(); } catch {}

  // 再装网络拦截
  installWSInterceptor();
  installXHRInterceptor();

  // 启动自动作答轮询
  actions.startAutoAnswerLoop();

  // 更新课件加载
  actions.launchLessonHelper();

  // 历史课件收集器：student-v3 报告页自动执行（配合课件面板的「历史课件」导入）
  if (isStudentV3Page()) {
    runHistoryCapture().catch(e => log.err('[History] 启动失败', e));
  }
})();
