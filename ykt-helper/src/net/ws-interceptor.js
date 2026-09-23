// src/net/ws-interceptor.js
import { gm } from '../core/env.js';
import { log } from '../core/log.js';
import { actions } from '../state/actions.js';
import { repo } from '../state/repo.js';

export function installWSInterceptor() {

  // 环境识别（标准/荷塘/长江/未知），主要用于日志和后续按需适配
  function detectEnvironmentAndAdaptAPI() {
    const hostname = location.hostname;
    let envType = 'unknown';
    if (hostname === 'www.yuketang.cn') {
      envType = 'standard';
      log.dbg('[雨课堂助手][INFO] 检测到标准雨课堂环境');
    } else if (hostname === 'pro.yuketang.cn') {
      envType = 'pro';
      log.dbg('[雨课堂助手][INFO] 检测到荷塘雨课堂环境');
    } else if (hostname === 'changjiang.yuketang.cn'){
      envType = 'changjiang';
      log.dbg('[雨课堂助手][INFO] 检测到长江雨课堂环境');
    } else {
      log.dbg('[雨课堂助手][INFO] 未知环境:', hostname);
    }
    return envType;
  }

  class MyWebSocket extends WebSocket {
    static handlers = [];
    static addHandler(h) { this.handlers.push(h); }
    constructor(url, protocols) {
      super(url, protocols);
      const parsed = new URL(url, location.href);
      for (const h of this.constructor.handlers) h(this, parsed);
    }
    intercept(cb) {
      const raw = this.send;
      this.send = (data) => { try { cb(JSON.parse(data)); } catch {} return raw.call(this, data); };
    }
    listen(cb) { this.addEventListener('message', (e) => { try { cb(JSON.parse(e.data)); } catch {} }); }
  }

MyWebSocket.addHandler((ws, url) => {
    const envType = detectEnvironmentAndAdaptAPI();
    log.dbg('[雨课堂助手][INFO] 拦截WebSocket通信 - 环境:', envType);
    log.dbg('[雨课堂助手][INFO] WebSocket连接尝试:', url.href);

    // 更宽松的路径匹配
    const wsPath = url.pathname || '';
    const isRainClassroomWS =
      wsPath === '/wsapp/' ||
      wsPath.includes('/ws') ||
      wsPath.includes('/websocket') ||
      url.href.includes('websocket');

    if (!isRainClassroomWS) {
      log.dbg('[雨课堂助手][ERR] 非雨课堂WebSocket:', wsPath);
      return;
    }
    log.dbg('[雨课堂助手][INFO] 检测到雨课堂WebSocket连接:', wsPath);

    // 发送侧拦截（可用于调试）
    ws.intercept((message) => {
      log.dbg('[雨课堂助手][INFO] WebSocket发送:', message);
    });

    // 接收侧统一分发
    ws.listen(dispatchWSMessage);
  });

  gm.uw.WebSocket = MyWebSocket;
}

/** WS 消息统一分发：页面侧被拦截的连接与脚本自建（auto-join）连接共用 */
function dispatchWSMessage(message) {
  try {
    log.dbg('[雨课堂助手][INFO] WebSocket接收:', message);
    switch (message.op) {
      case 'fetchtimeline':
        log.dbg('[雨课堂助手][INFO] 收到时间线:', message.timeline);
        actions.onFetchTimeline(message.timeline);
        break;
      case 'unlockproblem':
        log.dbg('[雨课堂助手][INFO] 收到解锁问题:', message.problem);
        actions.onUnlockProblem(message.problem);
        break;
      case 'lessonfinished':
        log.dbg('[雨课堂助手][INFO] 课程结束');
        actions.onLessonFinished();
        break;
      default:
        log.dbg('[雨课堂助手][WARN] 未知WebSocket操作:', message.op, message);
    }
    // 监听后端传递的url
    const url = (function findUrl(obj){
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.url === 'string') return obj.url;
      if (Array.isArray(obj)) { for (const it of obj){ const u = findUrl(it); if (u) return u; } }
      else { for (const k in obj){ const v = obj[k]; if (v && typeof v==='object'){ const u = findUrl(v); if (u) return u; } } }
      return null;
    })(message);
    if (url) {
      window.dispatchEvent(new CustomEvent('ykt:url-change', { detail: { url, raw: message } }));
      repo.currentSelectedUrl = url;
      log.dbg('[雨课堂助手][INFO] 当前选择 URL:', url);
    }
  } catch (e) {
    log.dbg('[雨课堂助手][ERR] 解析WebSocket消息失败', e, message);
  }
}

// ===== 主动为某个课堂建立/复用 WebSocket 连接 =====
export function connectOrAttachLessonWS({ lessonId, auth }) {
  if (!lessonId || !auth) {
    log.warn('[雨课堂助手][WARN] 缺少 lessonId 或 auth，放弃建链');
    return null;
  }
  if (repo.isLessonConnected(lessonId)) {
    return repo.lessonSockets.get(lessonId);
  }

  // 根据当前域名选择 ws 地址（标准/荷塘/长江跟随当前域）
  const host = `wss://${location.hostname}/wsapp/`;

  const ws = new WebSocket(host);

  ws.addEventListener('open', () => {
    try {
      const hello = {
        op: 'hello',
        // userid 可选：尽力获取，获取不到也不阻断流程
        userid: getUserIdSafe(),
        role: 'student',
        auth,              // 关键：lessonToken
        lessonid: lessonId // 关键：目标课堂
      };
      ws.send(JSON.stringify(hello));
      log.dbg('[雨课堂助手][INFO][AutoJoin] 已发送 hello 握手:', hello);
    } catch (e) {
      log.err('[雨课堂助手][INFO][AutoJoin] 发送 hello 失败:', e);
    }
  });

  // 自建连接也要吃消息流——否则自动进入的课堂永远收不到 unlockproblem
  ws.addEventListener('message', (e) => {
    try { dispatchWSMessage(JSON.parse(e.data)); } catch {}
  });

  ws.addEventListener('close', () => {
    log.dbg('[雨课堂助手][WARN][AutoJoin] 课堂 WS 关闭:', lessonId);
    // 清掉死连接——否则 isLessonConnected 仍返回旧 socket，断线后永远不会重连
    if (repo.lessonSockets.get(lessonId) === ws) repo.lessonSockets.delete(lessonId);
    repo.listeningLessons.delete(lessonId);
  });
  ws.addEventListener('error', (e) => {
    log.err('[雨课堂助手][ERR][AutoJoin] 课堂 WS 错误:', lessonId, e);
  });

  repo.markLessonConnected(lessonId, ws, auth);
  return ws;
}

function getUserIdSafe() {
  try {
    // 常见挂载点（不同环境可能不同）
    if (window?.YktUser?.id) return window.YktUser.id;
    if (window?.__INITIAL_STATE__?.user?.userId) return window.__INITIAL_STATE__.user.userId;
    const m = document.cookie.match(/(?:^|;\s*)user_id=(\d+)/);
    if (m) return Number(m[1]);
  } catch {}
  return undefined;
}