// ==UserScript==
// @name         YuketangStudio 雨课堂助手
// @namespace    https://github.com/RayMorTwinkle/YuketangStudio
// @version      0.3.0
// @description  课堂习题提醒、AI解答（思考/图片/流式）、PPT提取与多轮对话、历史课件归档
// @license      MIT
// @icon         https://raw.githubusercontent.com/RayMorTwinkle/YuketangStudio/main/static/icon.svg
// @match        https://pro.yuketang.cn/web/*
// @match        https://pro.yuketang.cn/web
// @match        https://changjiang.yuketang.cn/web/*
// @match        https://changjiang.yuketang.cn/web
// @match        https://www.yuketang.cn/web/*
// @match        https://www.yuketang.cn/web
// @match        https://*.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://*.yuketang.cn/lesson/student/v3/*
// @match        https://*.yuketang.cn/v2/web/*
// @match        https://*.yuketang.cn/m/v2/*
// @match        https://*.yuketang.cn/m/*
// @match        https://www.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://www.yuketang.cn/v2/web/*
// @match        https://pro.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://pro.yuketang.cn/v2/web/*
// @match        https://pro.yuketang.cn/v2/web/index
// @match        https://pro.yuketang.cn/v2/web/student-lesson-report/*
// @match        https://changjiang.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://changjiang.yuketang.cn/v2/web/*
// @match        https://changjiang.yuketang.cn/v2/web/index
// @match        https://changjiang.yuketang.cn/v2/web/student-lesson-report/*
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getTab
// @grant        GM_getTabs
// @grant        GM_saveTab
// @grant        unsafeWindow
// @connect      api.moonshot.cn
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      generativelanguage.googleapis.com
// @connect      api.longcat.chat
// @connect      api.agnes-ai.cn
// @connect      yuketang.cn
// @connect      *.yuketang.cn
// @connect      changjiang-private-qn.yuketang.cn
// @connect      thu-private-qn.yuketang.cn
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.min.js
// ==/UserScript==
(function() {
  "use strict";
  // src/core/env.js
    const gm = {
    notify(opt) {
      if (typeof window.GM_notification === "function") window.GM_notification(opt);
    },
    addStyle(css) {
      if (typeof window.GM_addStyle === "function") window.GM_addStyle(css); else {
        const s = document.createElement("style");
        s.textContent = css;
        document.head.appendChild(s);
      }
    },
    xhr(opt) {
      if (typeof window.GM_xmlhttpRequest === "function") return window.GM_xmlhttpRequest(opt);
      throw new Error("GM_xmlhttpRequest is not available");
    },
    uw: window.unsafeWindow || window
  };
  function loadScriptOnce(src, timeoutMs = 3e4) {
    return new Promise((resolve, reject) => {
      if ([ ...document.scripts ].some(s => s.src === src)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      // CDN 连接挂死时 onload/onerror 都不会触发——必须有自己的兜底计时
            const timer = setTimeout(() => reject(new Error(`加载超时: ${src}`)), timeoutMs);
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Failed to load: ${src}`));
      };
      document.head.appendChild(s);
    });
  }
  /** GM_xhr 下载任意图片转 dataURL（绕开 CORS；OSS 无跨域头也能拿） */  function fetchAsDataURL(url, timeoutMs = 2e4) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          fn(v);
        }
      };
      // 兜底计时器：部分 GM 实现不支持 timeout 字段 / 未授权域挂起等待用户授权时
      // ontimeout 也不会触发——不能让 Promise 永远 pending
            const watchdog = setTimeout(() => done(reject, new Error(`图片下载超时(${timeoutMs}ms): ${hostOf(url)}`)), timeoutMs + 5e3);
      try {
        gm.xhr({
          method: "GET",
          url: url,
          responseType: "blob",
          timeout: timeoutMs,
          onload: res => {
            // 回调内任何同步 throw 都会让 Promise 永远 pending——整体包 try
            try {
              if (res.status !== 200) return done(reject, new Error(`图片下载 HTTP ${res.status}: ${hostOf(url)}`));
              let blob = res.response;
              // 兼容返回 ArrayBuffer/string 的 GM 实现
                            if (!(blob instanceof Blob)) blob = new Blob([ blob || "" ]);
              const reader = new FileReader;
              reader.onload = () => done(resolve, reader.result);
              reader.onerror = () => done(reject, new Error("图片读取失败"));
              reader.readAsDataURL(blob);
            } catch (e) {
              done(reject, new Error(`图片响应处理失败: ${e?.message || e}`));
            }
          },
          onerror: () => done(reject, new Error(`图片下载失败: ${hostOf(url)}`)),
          ontimeout: () => done(reject, new Error(`图片下载超时: ${hostOf(url)}`)),
          onabort: () => done(reject, new Error(`图片下载中止: ${hostOf(url)}`))
        });
      } catch (e) {
        done(reject, e);
      }
    });
  }
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return String(url).slice(0, 60);
    }
  }
  async function ensureHtml2Canvas() {
    const w = gm.uw || window;
    if (typeof w.html2canvas === "function") return w.html2canvas;
    await loadScriptOnce("https://html2canvas.hertzen.com/dist/html2canvas.min.js");
    const h2c = w.html2canvas?.default || w.html2canvas;
    if (typeof h2c === "function") return h2c;
    throw new Error("html2canvas 未正确加载");
  }
  async function ensureJsPDF() {
    // jsPDF 由 @require 预置 → 落在沙箱 window；script 注入降级 → 落在主世界 gm.uw。两处都查
    const pick = () => window.jspdf?.jsPDF ? window.jspdf : gm.uw?.jspdf?.jsPDF ? gm.uw.jspdf : null;
    const ready = pick();
    if (ready) return ready;
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
    const after = pick();
    if (!after) throw new Error("jsPDF 未加载成功");
    return after;
  }
  /** mermaid 按需加载（AI 回复里出现 ```mermaid 块时才拉取 CDN） */  async function ensureMermaid() {
    const w = gm.uw || window;
 // 脚本标签注入主世界，属性也挂在主世界
        if (w.mermaid?.render) return w.mermaid;
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js");
    const m = w.mermaid;
    if (!m?.render) throw new Error("mermaid 未正确加载");
    m.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict"
    });
    return m;
  }
  /** marked（专业 Markdown 解析）按需加载（v9：renderer.code(code, lang) 旧签名稳定） */  async function ensureMarked() {
    const w = gm.uw || window;
    if (w.marked?.parse) return w.marked;
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js");
    if (!w.marked?.parse) throw new Error("marked 未正确加载");
    return w.marked;
  }
  /** DOMPurify（HTML 清洗）按需加载 */  async function ensureDOMPurify() {
    const w = gm.uw || window;
    if (w.DOMPurify?.sanitize) return w.DOMPurify;
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js");
    if (!w.DOMPurify?.sanitize) throw new Error("DOMPurify 未正确加载");
    return w.DOMPurify;
  }
  function randInt(l, r) {
    return l + Math.floor(Math.random() * (r - l + 1));
  }
  // src/core/log.js
  // 统一日志出口：默认只输出 warn/error，避免控制台被调试日志淹没。
  // 需要排查问题时，在控制台执行 localStorage.setItem('yksDebug', '1') 后刷新页面即可全量输出。
  // 关闭：localStorage.removeItem('yksDebug')
  
  // 用法：
  //   import { log } from './log.js';
  //   log.dbg('[Chat] xxx', obj);     // 仅在 debug 模式输出
  //   log.info('已加载');              // 仅在 debug 模式输出（普通信息）
  //   log.warn('降级到 XXX');          // 始终输出
  //   log.err('请求失败', e);          // 始终输出
    const DEBUG_FLAG = "yksDebug";
  function isDebug() {
    try {
      return !!localStorage.getItem(DEBUG_FLAG);
    } catch {
      return false;
    }
  }
  // 允许运行时切换（控制台里 log.enable() / log.disable()）
    let debugEnabled = isDebug();
  const PREFIX = "[YuketangStudio]";
  const log = {
    /** 是否处于调试模式 */
    get debug() {
      return debugEnabled;
    },
    enable() {
      debugEnabled = true;
      try {
        localStorage.setItem(DEBUG_FLAG, "1");
      } catch {}
    },
    disable() {
      debugEnabled = false;
      try {
        localStorage.removeItem(DEBUG_FLAG);
      } catch {}
    },
    /** 调试日志：默认静默 */
    dbg(...args) {
      if (!debugEnabled) return;
      try {
        console.log(PREFIX, ...args);
      } catch {}
    },
    /** 一般信息：默认静默（避免噪声淹没有效信息） */
    info(...args) {
      if (!debugEnabled) return;
      try {
        console.info(PREFIX, ...args);
      } catch {}
    },
    /** 警告：始终输出 */
    warn(...args) {
      try {
        console.warn(PREFIX, ...args);
      } catch {}
    },
    /** 错误：始终输出 */
    err(...args) {
      try {
        console.error(PREFIX, ...args);
      } catch {}
    }
  };
  // src/core/types.js
    const PROBLEM_TYPE_MAP = {
    1: "单选题",
    2: "多选题",
    3: "投票题",
    4: "填空题",
    5: "主观题"
  };
  /** 内置默认提示词（设置里可覆盖；空 = 使用默认） */  const DEFAULT_SYSTEM_PROMPT_CHAT = [ "你是「YuketangStudio」雨课堂学习助手，通过对话帮助学生理解课件与解决问题。", "要求：", "1) 用户消息可能附带课件截图与题目文本，优先依据文本、结合图片回答；", "2) 回答使用简体中文，生动形象、条理清晰，善用类比和例子；", "3) 鼓励使用多种可视化形式帮助理解，在适合的场景主动使用：mermaid 流程图/思维导图（```mermaid 代码块）、表格、SVG 示意图（```svg）、HTML 片段（```html）；", "4) 数学公式用 $...$（行内）与 $$...$$（独立成行）；", "5) 解题类问题给出思路与关键步骤，不要只给结论；", "6) 无法识别图片或文本时直接说明，不要编造。" ].join("\n");
  const DEFAULT_SYSTEM_PROMPT_AI = [ "你是「YuketangStudio」雨课堂学习助手，专注快速、准确地解答课堂题目。", "要求：", "1) 用户消息附带课件截图与题目文本——文本来自课堂系统、比截图识别更可靠，优先依据文本、结合图片作答；", "2) 优先确保答案快速且准确：选择题先给答案再给理由（格式：答案: [字母] / 解释: [理由]）；填空/主观题直接给完整答案与必要思路；", "3) 回答简洁直接，避免冗长铺垫；", "4) 数学公式用 $...$；无法识别时直接说明，不要编造。" ].join("\n");
  const DEFAULT_CONFIG = {
    notifyProblems: true,
    autoAnswer: false,
    autoAnswerDelay: 3e3,
    autoAnswerRandomDelay: 2e3,
    // 未配置 API Key 时是否提交兜底答案（A/略）。默认关——宁缺答不误答
    autoAnswerFallbackDefault: false,
    iftex: true,
    systemPromptChat: "",
    // 空 = 使用 DEFAULT_SYSTEM_PROMPT_CHAT
    systemPromptAI: "",
    // 空 = 使用 DEFAULT_SYSTEM_PROMPT_AI
    // AI profiles（config.ai.profiles / config.ai.activeProfileId）由 settings.js 的 ensureAIProfiles 惰性创建
    ai: {
      provider: "kimi",
      kimiApiKey: "",
      apiKey: "",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      model: "moonshot-v1-8k",
      visionModel: "moonshot-v1-8k-vision-preview",
      temperature: .3,
      maxTokens: 1e3
    },
    filterProblemsOnly: false,
    // 课件面板：只看带题目的页（默认显示全部页）
    maxPresentations: 5
  };
  // src/core/storage.js
  // 存储后端优先用 GM_getValue/GM_setValue（脚本私有存储，页面不可见——
  // API Key 等敏感配置此前明文落在页面同源 localStorage，同源 XSS/恶意页面脚本可读取）。
  // GM 不可用时退回 localStorage；读 GM 未命中时自动把旧 localStorage 值迁移过去。
    const hasGMStorage = () => typeof GM_getValue === "function" && typeof GM_setValue === "function";
  class StorageManager {
    constructor(prefix) {
      this.prefix = prefix;
    }
    get(key, dv = null) {
      const k = this.prefix + key;
      if (hasGMStorage()) try {
        const v = GM_getValue(k, void 0);
        if (v !== void 0) return v;
        // 迁移旧 localStorage 值（只搬一次，搬完删除明文）
                const legacy = localStorage.getItem(k);
        if (legacy != null) try {
          const parsed = JSON.parse(legacy);
          GM_setValue(k, parsed);
          localStorage.removeItem(k);
          return parsed;
        } catch {/* 迁移失败不阻断读取 */}
        return dv;
      } catch {/* fall through to localStorage */}
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : dv;
      } catch {
        return dv;
      }
    }
    set(key, value) {
      const k = this.prefix + key;
      if (hasGMStorage()) try {
        GM_setValue(k, value);
        localStorage.removeItem(k);
 // 清掉可能残留的明文副本
                return;
      } catch {/* fall through */}
      localStorage.setItem(k, JSON.stringify(value));
    }
    remove(key) {
      const k = this.prefix + key;
      if (hasGMStorage()) try {
        GM_setValue(k, void 0);
      } catch {}
      localStorage.removeItem(k);
    }
    getMap(key) {
      const arr = this.get(key, []);
      try {
        return new Map(arr);
      } catch {
        return new Map;
      }
    }
    setMap(key, map) {
      this.set(key, [ ...map ]);
    }
    alterMap(key, fn) {
      const m = this.getMap(key);
      fn(m);
      this.setMap(key, m);
    }
  }
  const storage = new StorageManager("ykt-helper:");
  // src/state/repo.js
    const repo = {
    presentations: new Map,
    // id -> presentation
    // slides / problems / problemStatus 的 key 一律存为字符串（WS/页面数据里 id 可能是数字）
    slides: new Map,
    // slideId -> slide
    problems: new Map,
    // problemId -> problem
    problemStatus: new Map,
    // problemId -> {presentationId, slideId, startTime, endTime, done, autoAnswerTime, answering, clockOffset}
    encounteredProblems: [],
    // [{problemId, ...ref}]
    pendingUnlocks: [],
    // unlockproblem 先于课件 XHR 到达时的暂存队列
    currentPresentationId: null,
    currentSlideId: null,
    currentLessonId: null,
    currentSelectedUrl: null,
    // 按课程分组存储课件
    setPresentation(id, data) {
      const pid = String(id);
      this.presentations.set(pid, {
        ...data,
        id: pid
      });
      const key = this.currentLessonId ? `presentations-${this.currentLessonId}` : "presentations";
      storage.alterMap(key, m => {
        m.set(pid, data);
        // 仍然做容量裁剪
                const max = storage.get("config", {})?.maxPresentations ?? 5;
        const excess = m.size - max;
        if (excess > 0) [ ...m.keys() ].slice(0, excess).forEach(k => m.delete(k));
      });
    },
    upsertSlide(slide) {
      this.slides.set(String(slide.id), slide);
    },
    upsertProblem(prob) {
      this.problems.set(String(prob.problemId), prob);
    },
    pushEncounteredProblem(prob, slide, presentationId) {
      if (!this.encounteredProblems.some(p => String(p.problemId) === String(prob.problemId))) this.encounteredProblems.push({
        problemId: prob.problemId,
        problemType: prob.problemType,
        body: prob.body || `题目ID: ${prob.problemId}`,
        options: prob.options || [],
        blanks: prob.blanks || [],
        answers: prob.answers || [],
        slide: slide,
        presentationId: presentationId
      });
    },
    // === 自动进入课堂所需的多“线程”（多课堂）状态 ===
    listeningLessons: new Set,
    // lessonId 的集合，表示已经建立WS监听
    lessonTokens: new Map,
    // lessonId -> lessonToken（/lesson/checkin 返回）
    lessonSockets: new Map,
    // lessonId -> WebSocket 实例
    autoJoinRunning: false,
    // 轮询开关
    autoJoinedLessons: new Set,
    // 被“自动进入”的课堂集合（仅标记自动进入建立的连接）
    forceAutoAnswerLessons: new Set,
    // 若需要，可以对某些课强制视为“自动答题开启”
    // 载入本课（按课程分组）在本地存储过的课件
    loadStoredPresentations() {
      if (!this.currentLessonId) return;
      const key = `presentations-${this.currentLessonId}`;
      const stored = storage.getMap(key);
      for (const [id, data] of stored.entries()) this.setPresentation(id, data);
    },
    markLessonConnected(lessonId, ws, token) {
      if (token) this.lessonTokens.set(lessonId, token);
      if (ws) this.lessonSockets.set(lessonId, ws);
      this.listeningLessons.add(lessonId);
    },
    isLessonConnected(lessonId) {
      return this.listeningLessons.has(lessonId) && this.lessonSockets.get(lessonId);
    },
    markLessonAutoJoined(lessonId, enabled = true) {
      if (!lessonId) return;
      if (enabled) this.autoJoinedLessons.add(lessonId); else this.autoJoinedLessons.delete(lessonId);
    }
  };
  // src/ui/toast.js
    function toast(message, duration = 2e3) {
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = `\n    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);\n    background: rgba(0,0,0,.7); color: #fff; padding: 10px 20px;\n    border-radius: 4px; z-index: 10000000; max-width: 80%;\n  `;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .5s";
      setTimeout(() => el.remove(), 500);
    }, duration);
  }
  var tpl$6 = '<div id="ykt-ai-answer-panel" class="ykt-panel">\n  <style>\n    #ykt-ai-answer-panel { display: none; flex-direction: column; }\n    #ykt-ai-answer-panel.visible { display: flex; }\n    #ykt-ai-answer-panel .panel-header { display: flex; align-items: center; gap: 8px; }\n    #ykt-ai-answer-panel .panel-header h3 { margin: 0; flex: 1; }\n    #ykt-ai-log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; min-height: 200px; max-height: 44vh; }\n    .ykt-ai-msg { max-width: 92%; border-radius: 10px; padding: 8px 10px; font-size: 13px; line-height: 1.55; }\n    .ykt-ai-msg.user { align-self: flex-end; background: #1d63df; color: #fff; border-bottom-right-radius: 2px; }\n    .ykt-ai-msg.user img { max-width: 220px; max-height: 130px; border-radius: 6px; display: block; margin-top: 6px; }\n    .ykt-ai-msg.ai { align-self: flex-start; background: #f2f4f8; color: var(--ykt-fg, #222); border-bottom-left-radius: 2px; }\n    .ykt-ai-msg.ai p { margin: 0 0 6px; }\n    .ykt-ai-msg.ai p:last-child { margin-bottom: 0; }\n    .ykt-ai-msg.ai details { margin-bottom: 6px; }\n    .ykt-ai-msg.ai summary { cursor: pointer; color: #607190; font-size: 12px; user-select: none; }\n    .ykt-ai-msg.ai .reasoning-body { color: #607190; font-size: 12px; white-space: pre-wrap; border-left: 3px solid #d8dee9; padding-left: 8px; margin: 4px 0; max-height: 160px; overflow-y: auto; }\n    .ykt-ai-msg .err { color: #c0392b; }\n    .ykt-ai-msg .muted { color: #607190; font-size: 12px; }\n    .ykt-ai-msg.user .ykt-chat-warn { margin-top: 6px; font-size: 12px; background: rgba(255,255,255,.18); border-radius: 4px; padding: 3px 6px; }\n    #ykt-ai-ctx { padding: 4px 10px; font-size: 12px; color: #607190; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--ykt-border, #ddd); }\n    #ykt-ai-ctx img { height: 34px; border-radius: 4px; border: 1px solid #ddd; }\n    #ykt-ai-ctx .ctx-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n    #ykt-ai-custom { display: flex; gap: 6px; padding: 4px 10px; align-items: center; }\n    #ykt-ai-custom input { flex: 1; font-size: 12px; padding: 4px 8px; border: 1px solid var(--ykt-border-strong, #ccc); border-radius: 6px; }\n    .ykt-ai-inputbar { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--ykt-border, #ddd); align-items: flex-end; }\n    #ykt-ai-input { flex: 1; resize: none; font-size: 13px; padding: 6px 8px; border: 1px solid var(--ykt-border-strong, #ccc); border-radius: 6px; font-family: inherit; }\n    #ykt-ai-input:focus { outline: none; border-color: var(--ykt-accent, #1d63df); }\n    #ykt-ai-send { padding: 7px 14px; border: none; border-radius: 6px; background: var(--ykt-accent, #1d63df); color: #fff; cursor: pointer; white-space: nowrap; }\n    #ykt-ai-send:disabled { opacity: .5; cursor: not-allowed; }\n    #ykt-ai-clear { padding: 3px 8px; font-size: 12px; }\n  </style>\n  <div class="panel-header">\n    <h3>🤖 AI 解答</h3>\n    <button id="ykt-ai-clear">清空会话</button>\n    <span class="close-btn" id="ykt-ai-close"><i class="fas fa-times"></i></span>\n  </div>\n  <div class="panel-body" style="display:flex;flex-direction:column;padding:0;">\n    <div id="ykt-ai-log"></div>\n    <div id="ykt-ai-ctx">\n      <label><input type="checkbox" id="ykt-ai-attach" checked> 附带当前页</label>\n      <span class="ctx-status" id="ykt-ai-text-status">正在检测页面信息...</span>\n      <span id="ykt-ai-ctx-thumb"></span>\n    </div>\n    <div id="ykt-ai-custom">\n      <input type="text" id="ykt-ai-custom-prompt" placeholder="自定义要求（可选，每轮生效）：如「只给思路不给答案」">\n    </div>\n    <div class="ykt-ai-inputbar">\n      <textarea id="ykt-ai-input" rows="2" placeholder="留空发送 = 解答此页题目；输入内容 = 针对题目追问（Enter 发送）"></textarea>\n      <button id="ykt-ai-send">发送</button>\n    </div>\n  </div>\n</div>\n';
  const L$2 = (...a) => log.dbg("[雨课堂助手][DBG][vuex-helper]", ...a);
  const W$2 = (...a) => log.warn("[雨课堂助手][WARN][vuex-helper]", ...a);
  const E = (...a) => log.err("[雨课堂助手][ERR][vuex-helper]", ...a);
  let _vueMissWarned = false;
  function getVueApp() {
    try {
      // 页面 Vue 实例的 expando（__vue__）挂在主世界 DOM 上——沙箱 document 读不到，
      // 必须经 unsafeWindow（gm.uw）拿主世界的 document
      const doc = gm.uw?.document || document;
      const el = doc.querySelector("#app");
      const app = el?.__vue__ || el?.__vue_app__ || null;
      if (!app) {
        if (!_vueMissWarned) {
          _vueMissWarned = true;
          W$2("getVueApp: 找不到 #app.__vue__（静默重试中，直到 waitForVueReady 超时）");
        }
        return null;
      }
      _vueMissWarned = false;
      return app;
    } catch (e) {
      E("getVueApp 错误:", e);
      return null;
    }
  }
  /** Vue2 是 app.$store；Vue3 挂在 app.config.globalProperties.$store */  function getStore(app) {
    return app?.$store || app?.config?.globalProperties?.$store || null;
  }
  // 统一返回「字符串」，并打印原始类型
    function getCurrentMainPageSlideId() {
    try {
      const app = getVueApp();
      const store = getStore(app);
      const currSlide = store?.state?.currSlide;
      if (currSlide) {
        const rawSid = currSlide.sid;
        const sidStr = rawSid == null ? null : String(rawSid);
        log.dbg("[getCurrentMainPageSlideId] 获取到 slideId:", sidStr, "{type:", currSlide.type, ", problemID:", currSlide.problemID, ", index:", currSlide.index, "}", "(raw type:", typeof rawSid, ", raw value:", rawSid, ")");
        return sidStr;
      }
      // 移动版课堂页（/m/v2/lesson/*）：时间线幻灯片列表最后一项即老师最新页
            const tl = store?.state?.lessonTimelineSlides;
      if (Array.isArray(tl) && tl.length) {
        const last = tl[tl.length - 1];
        const sid = last?.sid ?? last?.id;
        if (sid != null) {
          const sidStr = String(sid);
          log.dbg("[getCurrentMainPageSlideId] 移动版时间线幻灯片最新页:", sidStr, "{index:", last.index, "}");
          return sidStr;
        }
      }
      // 移动版实时课堂（/lesson/student/v3）：store 无 currSlide，
      // 时间线卡片数组 state.cards 中最后一个含 sid 的卡片即最新推送页
            const cards = store?.state?.cards;
      if (Array.isArray(cards)) for (let i = cards.length - 1; i >= 0; i--) {
        const c = cards[i];
        if (c?.sid != null) {
          const sidStr = String(c.sid);
          log.dbg("[getCurrentMainPageSlideId] 移动版时间线最新页:", sidStr, "{type:", c.type, ", problemID:", c.problemID ?? null, "}");
          return sidStr;
        }
      }
      if (!app) W$2("getCurrentMainPageSlideId: 找不到 #app.__vue__");
      return null;
    } catch (e) {
      E("getCurrentMainPageSlideId 错误:", e);
      return null;
    }
  }
  function watchMainPageChange(callback) {
    const app = getVueApp();
    const store = getStore(app);
    if (!app || !store) {
      E("watchMainPageChange: 无法获取 Vue 实例或 store");
      return () => {};
    }
    // 移动版课堂页（/m/v2/lesson/*）：watch 时间线幻灯片最后一项的 sid
        if (Array.isArray(store.state?.lessonTimelineSlides)) {
      const lastSid = s => {
        const a = s.lessonTimelineSlides;
        if (!Array.isArray(a) || !a.length) return null;
        const sid = a[a.length - 1]?.sid ?? a[a.length - 1]?.id;
        return sid == null ? null : String(sid);
      };
      const unwatch = store.watch(lastSid, (n, o) => {
        if (!n || n === o) return;
        L$2("移动版时间线幻灯片切换", {
          newSid: n
        });
        callback(n, null);
      });
      L$2("已启动移动版时间线幻灯片监听");
      return unwatch;
    }
    // 移动版实时课堂：watch「最后一个含 sid 卡片的 sid 值」——
    // 不能只 watch 数量：数量不变的重发/回跳也需要触发
        if (Array.isArray(store.state?.cards)) {
      const lastSid = s => {
        const arr = s.cards;
        if (!Array.isArray(arr)) return null;
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i]?.sid != null) return String(arr[i].sid);
        return null;
      };
      const unwatch = store.watch(lastSid, (n, o) => {
        if (!n || n === o) return;
        L$2("移动版时间线页面切换", {
          newSid: n
        });
        callback(n, null);
      });
      L$2("已启动移动版时间线页面监听");
      return unwatch;
    }
    const unwatch = store.watch(state => state.currSlide, (ns, os) => {
      const newSid = ns?.sid == null ? null : String(ns.sid);
      const oldSid = os?.sid == null ? null : String(os.sid);
      L$2("主界面页面切换", {
        oldSid: oldSid,
        newSid: newSid,
        newType: ns?.type,
        newProblemID: ns?.problemID,
        newIndex: ns?.index,
        rawNewSidType: typeof ns?.sid
      });
      if (newSid) callback(newSid, ns);
    }, {
      deep: false
    });
    L$2("已启动主界面页面切换监听");
    return unwatch;
  }
  /** 统一从各种移动版 store 形态取「幻灯片列表」：
   *  /m/v2/lesson/*    → state.lessonTimelineSlides（cover/index/sid/presentationId 全量数据）
   *  /lesson/student/v3 → state.cards（type 2 卡片含 sid/pageIndex/src/webp）
   * 返回标准化 slide 数组或 null（桌面页走 XHR/WS 拦截器，不用这里） */  function getMainPageSlides() {
    try {
      const store = getStore(getVueApp());
      const st = store?.state;
      const tl = st?.lessonTimelineSlides;
      if (Array.isArray(tl) && tl.length) return tl.map(s => ({
        id: String(s.sid ?? s.id),
        index: s.index,
        title: `第 ${s.index} 页`,
        thumbnail: s.cover,
        image: s.cover,
        cover: s.cover,
        presentationId: String(s.presentationId ?? s.pres ?? ""),
        problem: s.problem || null
      }));
      const cards = st?.cards;
      if (Array.isArray(cards) && cards.length) return cards.filter(c => c?.sid != null).map(c => ({
        id: String(c.sid),
        index: c.pageIndex,
        title: `第 ${c.pageIndex} 页`,
        thumbnail: c.webp || c.src,
        image: c.src || c.webp,
        cover: c.src || c.webp,
        presentationId: String(c.presentationid ?? c.pres ?? ""),
        problem: null
      }));
      return null;
    } catch (e) {
      E("getMainPageSlides 错误:", e);
      return null;
    }
  }
  /** 把移动版 store 里的幻灯片列表镜像进 repo（presentation + slides）。
   *  移动版页面 XHR 拦截器抓不到课件数据，store 是唯一可靠来源；
   *  老师翻页会追加条目，需周期调用（幂等 upsert，已有更全数据时跳过）。 */  function syncMobileSlidesIntoRepo() {
    const slides = getMainPageSlides();
    if (!slides?.length) return 0;
    const byPres = new Map;
    for (const s of slides) {
      const pid = s.presentationId || "unknown";
      if (!byPres.has(pid)) byPres.set(pid, []);
      byPres.get(pid).push(s);
      repo.upsertSlide(s);
    }
    let updated = 0;
    for (const [pid, arr] of byPres) {
      const existing = repo.presentations.get(pid);
      // 已有页数 ≥ 当前镜像：数据来自更全的来源（XHR 拦截/存储），不降级覆盖
            if (existing?.slides?.length >= arr.length) continue;
      repo.setPresentation(pid, {
        title: existing?.title || document.title || "课件",
        slides: arr
      });
      updated++;
    }
    if (updated) L$2("移动版幻灯片镜像进 repo:", updated, "个课件");
    return updated;
  }
  function waitForVueReady(timeoutMs = 15e3) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const check = () => {
        const app = getVueApp();
        if (app && getStore(app)) {
          L$2("waitForVueReady: ok, elapsed(ms)=", Date.now() - t0);
          resolve(app);
        } else if (Date.now() - t0 >= timeoutMs) {
          W$2(`waitForVueReady: ${timeoutMs}ms 内未等到 Vue store，放弃（跟随/识别功能降级）`);
          resolve(null);
        } else setTimeout(check, 100);
      };
      check();
    });
  }
  // src/core/devmode-blob.js
  // AUTO-GENERATED by scripts/gen-devmode.js — DO NOT EDIT MANUALLY
  // 重新生成：修改 scripts/gen-devmode.js 中的 DEV_PASSWORD / DEV_CONFIG 后运行 node scripts/gen-devmode.js
    const DEV_BLOB = {
    saltB64: "WbhvTSzq7jX1bYQyNs5KSQ==",
    ivB64: "KoYwUmOXYammoVAi",
    ctB64: "za37BMXQXCHLL3W45LSuNy+pMLXWjaqR0svInBDIJc4KzpISbs1RrhM2ZP88Q0PlpbonUaU9o7XWcJTkfOrN5KhAsu8OfvAYbY9pUfxOKflhQWgx3SJJfQnOKOEYKFoTksfwlHzKZdNPlqumjREKDlWQpXuFbZI/63O66KY/Ww9NVK+4JGgR6a/sw0gSqY/QIDUv1EGngwZOkxrGxg13o1fDMml+v6+hKBoCFAAOj7QSCt2+MzF+YP/qzmE/Q1LoznQplmOkPnTGItbIrGvJMd5/m/6XAxyx0Vz4cs379g==",
    pwHash: "29bd1a86cd27bbe3ded241e6c810a7ac17f18a5f90f9de976e7918494e4aba7c",
    iterations: 31e4
  };
  // src/core/devmode.js
  // 开发者模式：解锁内置的加密 LLM 配置
  // 加密：AES-256-GCM，密钥由密码 PBKDF2 派生（与 scripts/gen-devmode.js 配套）
  // 校验：pwHash = SHA-256(PBKDF2 派生密钥原始字节) —— 校验也挂在慢哈希后，
  //       攻击者离线爆破每个候选密码都要跑完全部迭代
  // 解锁后配置缓存到 localStorage（同浏览器免重复输入）；换浏览器重新输密码即可
    const enc = new TextEncoder;
  const b64ToU8 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  async function sha256HexBytes(bytes) {
    const h = await crypto.subtle.digest("SHA-256", bytes);
    return [ ...new Uint8Array(h) ].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function deriveBitsAndKey(password, saltBytes, iterations) {
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [ "deriveBits" ]);
    const rawBits = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt: saltBytes,
      iterations: iterations,
      hash: "SHA-256"
    }, keyMaterial, 256));
    const key = await crypto.subtle.importKey("raw", rawBits, {
      name: "AES-GCM"
    }, false, [ "decrypt" ]);
    return {
      rawBits: rawBits,
      key: key
    };
  }
  /**
   * 用密码解锁内置配置。成功返回配置对象并缓存；失败抛错（不暴露原因细节）。
   * @param {string} password
   * @returns {Promise<Object>} 配置 { name, baseUrl, apiKey, model, visionModel, reasoningEffort }
   */  async function unlockDevMode(password) {
    const pw = String(password || "");
    if (!pw) throw new Error("请输入解锁码");
    const {rawBits: rawBits, key: key} = await deriveBitsAndKey(pw, b64ToU8(DEV_BLOB.saltB64), DEV_BLOB.iterations);
    const hash = await sha256HexBytes(rawBits);
    if (hash !== DEV_BLOB.pwHash) throw new Error("解锁码错误");
    let plain;
    try {
      plain = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: b64ToU8(DEV_BLOB.ivB64)
      }, key, b64ToU8(DEV_BLOB.ctB64));
    } catch {
      throw new Error("解密失败（blob 与解锁码不匹配，请重新生成）");
    }
    const cfg = JSON.parse((new TextDecoder).decode(plain));
    setDevUnlocked(cfg);
    return cfg;
  }
  /** 获取解锁的配置（未解锁返回 null） */  function getDevConfig() {
    return storage.get("devmode.config");
  }
  function setDevUnlocked(cfg) {
    storage.set("devmode.config", cfg);
  }
  // src/ai/agnes.js
  // Agnes（OpenAI 兼容）LLM 封装：对话 / 图片 / 思考 / 流式 / 工具调用
  // 默认配置来自开发者模式解锁的内置配置（core/devmode.js），也可传参覆盖
  /** 本模块日志前缀 */  const dlog = (...args) => log.dbg("[Agnes]", ...args);
  /** 与 openai.js 的 makeChatUrl 相同的自适应拼接逻辑 */  function makeChatUrl$1(baseUrl) {
    let base = String(baseUrl || "").replace(/\/+$/, "");
    if (!base) base = "https://api.agnes-ai.cn/v1";
    if (base.includes("/chat/completions")) return base;
    if (base.includes("/v1")) return base + "/chat/completions";
    if (base.includes("/openai")) return base + "/v1/chat/completions";
    return base + "/v1/chat/completions";
  }
  /** 解析 SSE data 行的缓冲器 */  function sseParser(onEvent) {
    let buf = "";
    return chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") {
          if (data === "[DONE]") onEvent(null);
          continue;
        }
        try {
          onEvent(JSON.parse(data));
        } catch (e) {
          dlog("sse parse fail", e);
        }
      }
    };
  }
  /**
   * 调用 Agnes chat completions
   * @param {Object} opts
   * @param {Array}  opts.messages        OpenAI 格式消息（content 可含 image_url）
   * @param {boolean} [opts.stream]       流式（默认 false）
   * @param {(delta:string)=>void} [opts.onDelta]        流式正文增量
   * @param {(delta:string)=>void} [opts.onReasoning]    流式思考增量
   * @param {boolean} [opts.thinking]     是否开启思考（默认 true，reasoning_effort 取配置）
   * @param {Array}  [opts.tools]         工具定义
   * @param {Object} [opts.override]      { baseUrl, apiKey, model, reasoningEffort } 覆盖内置配置
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{content:string, reasoning:string, toolCalls?:Array, usage?:Object}>}
   */  async function agnesChat(opts) {
    const dev = getDevConfig() || {};
    const ov = opts.override || {};
    const baseUrl = ov.baseUrl || dev.baseUrl;
    const apiKey = ov.apiKey || dev.apiKey;
    const model = ov.model || dev.model;
    if (!baseUrl || !apiKey) throw new Error("开发者模式未解锁：请到设置中解锁内置配置");
    const thinking = opts.thinking !== false;
    // 只在显式配置时发 reasoning_effort——硬编码 'medium' 会让不支持该字段的端点报 400
        const effort = ov.reasoningEffort || dev.reasoningEffort || null;
    const body = {
      model: model,
      messages: opts.messages
    };
    if (thinking && effort && effort !== "off") body.reasoning_effort = effort;
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    const stream = !!opts.stream;
    if (stream) body.stream = true;
    const url = makeChatUrl$1(baseUrl);
    const timeoutMs = opts.timeoutMs || 12e4;
    dlog("request", {
      url: url,
      model: model,
      stream: stream,
      thinking: thinking
    });
    // 只有「网络层失败」（CORS/连接错误）才值得降级 GM_xhr；
    // 中止与明确的 HTTP 错误都意味着请求已到达服务端——重发会造成重复计费/双份回答
        const shouldFallback = e => e?.name !== "AbortError" && !opts.signal?.aborted && !/^HTTP \d/.test(String(e?.message || ""));
    if (stream) 
    // 先试 fetch 真流式；CORS 失败自动降级 GM_xmlhttpRequest 伪流式
    try {
      return await fetchStream(url, apiKey, body, opts, timeoutMs);
    } catch (e) {
      if (!shouldFallback(e)) throw e;
      dlog("fetch stream failed, fallback to GM_xhr:", e?.message || e);
      return await gmXhrStream(url, apiKey, body, opts, timeoutMs);
    }
    // 非流式同样 fetch 优先，GM_xhr 兜底
        try {
      return await fetchStream(url, apiKey, body, opts, timeoutMs);
    } catch (e) {
      if (!shouldFallback(e)) throw e;
      dlog("fetch failed, fallback to GM_xhr:", e?.message || e);
      return gmXhrOnce(url, apiKey, body, timeoutMs);
    }
  }
  function pickDelta(obj, opts, acc) {
    const d = obj?.choices?.[0]?.delta || {};
    if (d.reasoning_content) {
      acc.reasoning += d.reasoning_content;
      opts.onReasoning?.(d.reasoning_content);
    }
    if (d.content) {
      acc.content += d.content;
      opts.onDelta?.(d.content);
    }
    const tc = d.tool_calls;
    if (tc) for (const t of tc) {
      const i = t.index ?? 0;
      acc.toolCalls[i] = acc.toolCalls[i] || {
        id: t.id || "",
        type: "function",
        function: {
          name: "",
          arguments: ""
        }
      };
      if (t.id) acc.toolCalls[i].id = t.id;
      if (t.function?.name) acc.toolCalls[i].function.name += t.function.name;
      if (t.function?.arguments) acc.toolCalls[i].function.arguments += t.function.arguments;
    }
  }
  async function fetchStream(url, apiKey, body, opts, timeoutMs) {
    const ctrl = new AbortController;
    // abort 的 reason 必须带 AbortError 名——否则外层 catch 识别不出中止，
    // 会掉进 GM_xhr 兜底再发一次请求
        const mkAbort = msg => Object.assign(new Error(msg), {
      name: "AbortError"
    });
    const timer = setTimeout(() => ctrl.abort(mkAbort("请求超时")), timeoutMs);
    const onAbort = () => ctrl.abort(mkAbort("aborted"));
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        throw mkAbort("aborted");
      }
      opts.signal.addEventListener("abort", onAbort, {
        once: true
      });
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (!body.stream) {
        const data = await res.json();
        const m = data?.choices?.[0]?.message || {};
        return {
          content: m.content || "",
          reasoning: m.reasoning_content || "",
          toolCalls: m.tool_calls,
          usage: data.usage
        };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder;
      const acc = {
        content: "",
        reasoning: "",
        toolCalls: []
      };
      let buf = "";
      for (;;) {
        const {done: done, value: value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {
          stream: true
        });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") break;
          try {
            pickDelta(JSON.parse(data), opts, acc);
          } catch (e) {
            dlog("parse", e);
          }
        }
      }
      return acc;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  function gmXhrStream(url, apiKey, body, opts, timeoutMs) {
    return new Promise((resolve, reject) => {
      const acc = {
        content: "",
        reasoning: "",
        toolCalls: []
      };
      let seen = 0;
      // sseParser 必须跨 onprogress 复用——每次新建会丢掉跨 chunk 拆开的 data: 行
            const feed = sseParser(obj => {
        if (obj) pickDelta(obj, opts, acc);
      });
      gm.xhr({
        method: "POST",
        url: url,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        data: JSON.stringify(body),
        onprogress: res => {
          const text = res.responseText || "";
          const chunk = text.slice(seen);
          seen = text.length;
          feed(chunk);
        },
        onload: res => {
          if (res.status !== 200) return reject(new Error(`HTTP ${res.status}: ${(res.responseText || "").slice(0, 200)}`));
          // 兜底：progress 可能漏最后一段（补个 \n 把半行 data: 喂完）
                    const text = res.responseText || "";
          feed(text.slice(seen) + "\n");
          resolve(acc);
        },
        onerror: () => reject(new Error("网络错误（GM_xhr）")),
        ontimeout: () => reject(new Error("请求超时（GM_xhr）"))
      });
    });
  }
  function gmXhrOnce(url, apiKey, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      gm.xhr({
        method: "POST",
        url: url,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        data: JSON.stringify(body),
        onload: res => {
          if (res.status !== 200) return reject(new Error(`HTTP ${res.status}: ${(res.responseText || "").slice(0, 200)}`));
          try {
            const data = JSON.parse(res.responseText);
            const m = data?.choices?.[0]?.message || {};
            resolve({
              content: m.content || "",
              reasoning: m.reasoning_content || "",
              toolCalls: m.tool_calls,
              usage: data.usage
            });
          } catch (e) {
            reject(new Error("响应解析失败: " + e.message));
          }
        },
        onerror: () => reject(new Error("网络错误")),
        ontimeout: () => reject(new Error("请求超时"))
      });
    });
  }
  // src/ui/slide-image.js
  // 「当前 PPT 页图片」解析的共享模块：chat 与 AI 解答面板都用它。
  // 三级来源：repo slide 数据 → 页面 DOM → 明确失败（绝不悄悄截整页当 PPT）。
  /** 在 repo 中定位当前 slide（课堂内主路径） */  function findCurrentSlide() {
    try {
      const sid = repo.currentSlideId != null ? String(repo.currentSlideId) : null;
      if (sid && repo.slides.has(sid)) return repo.slides.get(sid);
      for (const [, pres] of repo.presentations) {
        const hit = (pres?.slides || []).find(s => String(s.id) === sid);
        if (hit) return hit;
      }
      // 退化：取 presentation 的第一页
            for (const [, pres] of repo.presentations) if (pres?.slides?.length) return pres.slides[0];
    } catch (e) {
      log.warn("[SlideImage] findCurrentSlide", e);
    }
    return null;
  }
  function slideImageUrl(slide) {
    return slide?.coverAlt || slide?.cover || slide?.image || slide?.thumbnail || "";
  }
  /** 从页面 DOM 里找 slide 图（报告页/静态课件的退化路径） */  function findSlideUrlInDom() {
    try {
      const selectors = [ 'img[src*="/slide/"]', // 课堂 fullscreen 页的主 PPT 图
      ".slide-item.active-slide-item img", ".slide-item img", ".swiper-slide-active img", ".ppt-courseware-inner img", ".ppt-inner img" ];
      for (const sel of selectors) {
        const img = document.querySelector(sel);
        const src = img?.currentSrc || img?.src || "";
        if (src && /\/slide\/|cover/i.test(src)) return src;
      }
    } catch (e) {
      log.warn("[SlideImage] findSlideUrlInDom", e);
    }
    return "";
  }
  /**
   * 解析当前 PPT 页图片。
   * @returns {Promise<{dataUrl:string|null, source:'repo'|'dom'|'failed', reason?:string}>}
   *   source: 'repo' = 命中课件数据（最可信）；'dom' = 页面 DOM；'failed' = 拿不到
   * 注意：不做整页 html2canvas 兜底——那会把整页截图当 PPT 发给 AI 且用户毫不知情。
   */  async function resolveCurrentSlideImage() {
    // 1) repo 中的 slide（课堂内正常路径）
    const slide = findCurrentSlide();
    const url = slideImageUrl(slide);
    if (url) try {
      const dataUrl = await fetchAsDataURL(url);
      if (dataUrl) return {
        dataUrl: dataUrl,
        source: "repo"
      };
    } catch (e) {
      try {
        (window.unsafeWindow || window).__yksImgErr = `repo(${String(url).slice(0, 70)}): ${String(e?.message || e).slice(0, 100)}`;
      } catch {}
      log.warn("[SlideImage] repo slide 图下载失败，尝试 DOM 兜底:", e?.message);
    }
    // 2) DOM 兜底：报告页/静态课件等 repo 数据失效但页面有新鲜 slide 图的场景
        const domUrl = findSlideUrlInDom();
    if (domUrl) try {
      const dataUrl = await fetchAsDataURL(domUrl);
      if (dataUrl) return {
        dataUrl: dataUrl,
        source: "dom"
      };
    } catch (e) {
      try {
        (window.unsafeWindow || window).__yksImgErr = `dom(${String(domUrl).slice(0, 70)}): ${String(e?.message || e).slice(0, 100)}`;
      } catch {}
      log.warn("[SlideImage] DOM slide 图下载失败:", e?.message);
    }
    return {
      dataUrl: null,
      source: "failed",
      reason: slide || url ? "PPT 图片下载失败（可能是网络或权限问题）" : "当前页面没有可用的 PPT 页"
    };
  }
  // src/core/dom.js
  // 轻量 DOM 工具——escapeHtml 此前在 ai.js / chat.js / auto-answer-popup.js 各抄了一份
    function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }
  // src/ui/panels/ai.js
  // AI 解答面板：题目专注版多轮对话。
  // 与 PPT对话(chat) 的区别：自动识别当前页 + 注入课堂系统的题干文本（比截图 OCR 可靠），
  // 首轮「解答此页」一键触发，后续追问共享上下文。
  // 调用链：agnesChat（OpenAI 兼容流式，支持 reasoning_content 思考链与取消），
  //         override 来自当前激活的 AI Profile——任意 OpenAI 兼容端点都能用。
    const L$1 = (...a) => log.dbg("[ai]", ...a);
  const W$1 = (...a) => log.warn("[ai]", ...a);
  let mounted$6 = false;
  let root$5;
  let preferredSlideFromPresentation = null;
 // 来自课件面板/事件的指定页
    let history$1 = [];
 // OpenAI 格式消息
    let streaming$1 = false;
 // 防并发发送
    let abortCtrl$1 = null;
  const systemPrompt$1 = () => String(ui?.config?.systemPromptAI || "").trim() || DEFAULT_SYSTEM_PROMPT_AI;
  const DEFAULT_ANALYZE_PROMPT = "请解答此页的题目：先给答案，再给简要解题过程。若页面不是题目页，请概述页面内容。";
  function ensureMathJax() {
    const mj = window.MathJax;
    const ok = !!(mj && mj.typesetPromise);
    if (!ok) log.warn("[ai] MathJax 未就绪（未通过 @require 预置？）");
    return Promise.resolve(ok);
  }
  function typesetTexIn(el) {
    const mj = window.MathJax;
    if (!el || !mj || typeof mj.typesetPromise !== "function") return Promise.resolve(false);
    const ready = mj.startup && mj.startup.promise ? mj.startup.promise : Promise.resolve();
    return ready.then(() => mj.typesetPromise([ el ]).then(() => true).catch(() => false));
  }
  function $sel$1(sel) {
    return root$5.querySelector(sel);
  }
  function mountAIPanel() {
    if (mounted$6) return root$5;
    const host = document.createElement("div");
    host.innerHTML = tpl$6;
    document.body.appendChild(host.firstElementChild);
    root$5 = document.getElementById("ykt-ai-answer-panel");
    // 面板嵌在 shell 里——关闭=通知 shell 收起（并触发 __yksOnHide 中止流式）
        $sel$1("#ykt-ai-close").addEventListener("click", () => window.dispatchEvent(new CustomEvent("ykt:close-shell")));
    $sel$1("#ykt-ai-clear").addEventListener("click", () => {
      abortStreaming$1("清空会话");
      history$1 = [];
      renderHistory$1();
      addBubble$1("ai", mdToHtml("会话已清空。点击「发送」（输入留空）可解答当前页题目。"));
    });
    const $input = $sel$1("#ykt-ai-input");
    const $send = $sel$1("#ykt-ai-send");
    $send.addEventListener("click", () => sendCurrent$1());
    $input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendCurrent$1();
      }
    });
    waitForVueReady().then(() => {
      watchMainPageChange((slideId, slideInfo) => {
        L$1("主界面页面切换事件", {
          slideId: slideId,
          slideInfoType: slideInfo?.type,
          problemID: slideInfo?.problemID,
          index: slideInfo?.index
        });
        preferredSlideFromPresentation = null;
        renderCtxStatus();
      });
    }).catch(e => {
      W$1("Vue 实例初始化失败，将使用备用方案:", e);
    });
    window.addEventListener("ykt:presentation:slide-selected", ev => {
      L$1("收到小窗选页事件", ev?.detail);
      const sid = asIdStr(ev?.detail?.slideId);
      if (sid) preferredSlideFromPresentation = {
        slideId: sid,
        imageUrl: ev?.detail?.imageUrl || null
      };
      renderCtxStatus();
    });
    // ykt:open-ai 统一由 ui-api → Shell.openTab('ai') 处理，走 __yksOnShow
        warmupRichAssets();
    mounted$6 = true;
    renderCtxStatus();
    // shell 切到本 tab 时刷新（数据晚于挂载到达的场景：WS 课件、页面切换）
        root$5.__yksOnShow = () => {
      renderCtxStatus();
      if (history$1.length === 0 && !$sel$1("#ykt-ai-log").children.length) addBubble$1("ai", mdToHtml("点击「发送」（输入留空）即可解答当前页题目；也可以直接输入问题针对页面内容追问。"));
      // 「打开时自动分析」原来挂在 showAIPanel——改走 shell tab 后挪进 show 钩子
            if (ui.config.aiAutoAnalyze && history$1.length === 0 && !streaming$1) queueMicrotask(() => sendCurrent$1({
        auto: true
      }));
    };
    root$5.__yksOnHide = () => abortStreaming$1("面板已隐藏");
    return root$5;
  }
  /** 中止正在进行的流式请求 */  function abortStreaming$1(reason = "已取消") {
    if (abortCtrl$1) try {
      abortCtrl$1.abort(reason);
    } catch {}
  }
  // ---------------- 当前页与题目上下文 ----------------
    function asIdStr(v) {
    return v == null ? null : String(v);
  }
  /** 当前应分析的 slide（优先：课件面板指定页 > 主界面当前页 > 最近题目关联页） */  function pickCurrentSlide() {
    if (preferredSlideFromPresentation?.slideId) {
      const sid = asIdStr(preferredSlideFromPresentation.slideId);
      const hit = repo.slides.get(sid) || findSlideAcrossPresentations$1(sid);
      if (hit) return {
        slide: hit,
        source: `课件面板指定（第 ${hit.index ?? hit.page ?? "?"} 页）`
      };
    }
    // 设置页存的是布尔（勾选=主界面优先），不是 'presentation' 字符串
        const prio = ui?.config?.aiSlidePickPriority !== false;
    const mainSid = asIdStr(getCurrentMainPageSlideId());
    if (prio && mainSid) {
      const hit = repo.slides.get(mainSid) || findSlideAcrossPresentations$1(mainSid);
      if (hit) return {
        slide: hit,
        source: `主界面当前页（第 ${hit.index ?? hit.page ?? "?"} 页）`
      };
    }
    if (repo.currentSlideId != null) {
      const sid = asIdStr(repo.currentSlideId);
      const hit = repo.slides.get(sid) || findSlideAcrossPresentations$1(sid);
      if (hit) return {
        slide: hit,
        source: `课件浏览选中（第 ${hit.index ?? hit.page ?? "?"} 页）`
      };
    }
    try {
      if (repo.encounteredProblems?.length > 0) {
        const latest = repo.encounteredProblems.at(-1);
        const sid = repo.problemStatus.get(String(latest.problemId))?.slideId ? String(repo.problemStatus.get(String(latest.problemId)).slideId) : null;
        const hit = sid ? repo.slides.get(sid) || findSlideAcrossPresentations$1(sid) : null;
        if (hit) return {
          slide: hit,
          source: `最近题目关联页（第 ${hit.index ?? hit.page ?? "?"} 页）`
        };
      }
    } catch (e) {
      W$1("pickCurrentSlide fallback:", e);
    }
    return {
      slide: null,
      source: ""
    };
  }
  function findSlideAcrossPresentations$1(idStr) {
    for (const [, pres] of repo.presentations) {
      const hit = (pres?.slides || []).find(s => String(s.id) === idStr);
      if (hit) return hit;
    }
    return null;
  }
  /** 组装首轮/追问的用户文本：题干文本注入（来自课堂系统，比截图 OCR 可靠） */  function buildUserText(problem, customPrompt, isAnalyze) {
    const parts = [];
    if (problem) {
      parts.push("【题目信息（来自课堂系统，比截图更可靠）】");
      const typeStr = PROBLEM_TYPE_MAP[problem.problemType] || (problem.problemType != null ? `类型 ${problem.problemType}` : "");
      if (typeStr) parts.push(`题型：${typeStr}`);
      if (problem.body) parts.push(`题干：${problem.body}`);
      if (Array.isArray(problem.options) && problem.options.length) {
        parts.push("选项：");
        for (const o of problem.options) parts.push(`${o.key}. ${o.value}`);
      }
      if (Array.isArray(problem.blanks) && problem.blanks.length) parts.push(`空位：${problem.blanks.join(" | ")}`);
    }
    if (isAnalyze) parts.push(problem ? "请结合以上题目文本与页面截图解答此题。" : "【页面说明】当前页面可能不是题目页；请根据截图内容概述页面，若有题目请解答。");
    if (customPrompt) parts.push(`【用户自定义要求】\n${customPrompt}`);
    return parts.join("\n");
  }
  /** 页面识别状态行（面板底部小字） */  function renderCtxStatus() {
    if (!mounted$6) return;
    const statusEl = $sel$1("#ykt-ai-text-status");
    if (!statusEl) return;
    const {slide: slide, source: source} = pickCurrentSlide();
    if (slide) {
      const hasProblem = !!slide.problem;
      statusEl.textContent = `✓ ${source}${hasProblem ? " · 含题目" : ""}`;
      statusEl.style.color = "";
    } else {
      statusEl.textContent = "⚠ 未检测到课件页（可先在课堂里翻页）";
      statusEl.style.color = "#b42318";
    }
    renderCtxThumb();
  }
  async function renderCtxThumb() {
    const span = $sel$1("#ykt-ai-ctx-thumb");
    if (!span) return;
    span.textContent = "⏳";
    const {dataUrl: dataUrl} = await resolveCurrentSlideImage();
    if (dataUrl) {
      span.innerHTML = "";
      const img = document.createElement("img");
      img.src = dataUrl;
      img.title = "当前 PPT 页";
      span.appendChild(img);
    } else span.textContent = "（无图）";
  }
  // ---------------- 渲染 ----------------
    function addBubble$1(kind, htmlOrNode) {
    const $log = $sel$1("#ykt-ai-log");
    const div = document.createElement("div");
    div.className = `ykt-ai-msg ${kind}`;
    if (typeof htmlOrNode === "string") div.innerHTML = htmlOrNode; else div.appendChild(htmlOrNode);
    $log.appendChild(div);
    $log.scrollTop = $log.scrollHeight;
    return div;
  }
  function renderHistory$1() {
    const $log = $sel$1("#ykt-ai-log");
    $log.innerHTML = "";
    for (const m of history$1) {
      const text = (Array.isArray(m.content) ? m.content : [ {
        type: "text",
        text: m.content
      } ]).filter(c => c.type === "text").map(c => c.text).join("\n");
      const imgs = (Array.isArray(m.content) ? m.content : []).filter(c => c.type === "image_url").map(c => c.image_url.url);
      const div = document.createElement("div");
      div.className = `ykt-ai-msg ${m.role === "user" ? "user" : "ai"}`;
      if (m.role === "user") {
        div.textContent = text || "（图片）";
        for (const src of imgs) {
          const img = document.createElement("img");
          img.src = src;
          div.appendChild(img);
        }
      } else div.innerHTML = mdToHtml(text);
      $log.appendChild(div);
    }
    $log.scrollTop = $log.scrollHeight;
  }
  /** 把历史中除最近 N 张外的图片替换为占位符，控制 token */  function trimOldImages$1(keep = 1) {
    const imgMsgs = [];
    for (const m of history$1) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      const imgIdx = m.content.map((c, i) => c.type === "image_url" ? i : -1).filter(i => i >= 0);
      if (imgIdx.length) imgMsgs.push({
        m: m,
        imgIdx: imgIdx
      });
    }
    for (const {m: m, imgIdx: imgIdx} of imgMsgs.slice(0, Math.max(0, imgMsgs.length - keep))) for (const i of imgIdx) m.content[i] = {
      type: "text",
      text: "[此前的 PPT 页图片已省略]"
    };
  }
  // ---------------- 发送 ----------------
  /** 当前激活 Profile → agnesChat override（保留任意 OpenAI 兼容端点能力） */  function getOverride() {
    const aiCfg = ui.config.ai;
    const profiles = Array.isArray(aiCfg?.profiles) ? aiCfg.profiles : [];
    const p = profiles.find(x => x.id === aiCfg.activeProfileId) || profiles[0];
    if (!p || !p.apiKey) return null;
    // 带图消息必须走 vision 能力模型；现代多模态模型通常 text/vision 同 ID
        return {
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.visionModel || p.model,
      reasoningEffort: p.reasoningEffort
    };
  }
  async function sendCurrent$1({auto: auto = false} = {}) {
    if (streaming$1) return;
    const $input = $sel$1("#ykt-ai-input");
    const text = ($input?.value || "").trim();
    const isAnalyze = !text;
 // 空输入 = 解答此页
        const customPrompt = ($sel$1("#ykt-ai-custom-prompt")?.value || "").trim();
    const attach = $sel$1("#ykt-ai-attach")?.checked ?? true;
    streaming$1 = true;
    $sel$1("#ykt-ai-send").disabled = true;
    try {
      const content = [ {
        type: "text",
        text: text || DEFAULT_ANALYZE_PROMPT
      } ];
      let attachFailed = "";
      if (attach || isAnalyze) {
        const pending = addBubble$1("user", `⏳ 正在获取当前 PPT…${text ? "" : "（解答此页）"}`);
        const {dataUrl: dataUrl, reason: reason} = await resolveCurrentSlideImage();
        pending.remove();
        if (dataUrl) content.push({
          type: "image_url",
          image_url: {
            url: dataUrl
          }
        }); else if (isAnalyze) attachFailed = reason || "未取到当前 PPT 页";
      }
      const userText = buildUserText(pickCurrentSlide().slide?.problem, customPrompt, isAnalyze);
      // 题干文本注入：首轮整段作为文本；追问时只追加用户输入（题干已在历史里）
            if (isAnalyze) content[0].text = userText || DEFAULT_ANALYZE_PROMPT; else if (text) content[0].text = text + (customPrompt ? `\n【用户自定义要求】\n${customPrompt}` : "");
      history$1.push({
        role: "user",
        content: content
      });
      trimOldImages$1(1);
      const userBubble = addBubble$1("user", escapeHtml(text || DEFAULT_ANALYZE_PROMPT));
      for (const c of content) if (c.type === "image_url") {
        const img = document.createElement("img");
        img.src = c.image_url.url;
        img.alt = "当前 PPT 页";
        userBubble.appendChild(img);
      }
      if (attachFailed) {
        const warn = document.createElement("div");
        warn.className = "ykt-chat-warn";
        warn.textContent = `⚠️ ${attachFailed}——本条无截图，仅依据题目文本作答`;
        userBubble.appendChild(warn);
      }
      if ($input) $input.value = "";
      // AI 气泡（流式，思考中自动展开 → 正文自动折叠）
            const aiBubble = addBubble$1("ai", "<em>思考中…</em>");
      const acc = {
        content: "",
        reasoning: ""
      };
      let raf = 0;
      let phase = "waiting";
      const paint = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (phase !== "answering" && acc.content) phase = "answering"; else if (phase === "waiting" && acc.reasoning) phase = "thinking";
          const thinking = phase === "thinking";
          aiBubble.innerHTML = (acc.reasoning ? `<details ${thinking ? "open" : ""}><summary>💭 思考过程${thinking ? "（进行中…）" : "（点击展开）"}</summary><div class="reasoning-body"></div></details>` : "") + (acc.content ? mdToHtml(acc.content) : thinking ? "" : "<em>…</em>");
          const rBody = aiBubble.querySelector(".reasoning-body");
          if (rBody) {
            rBody.textContent = acc.reasoning;
            rBody.scrollTop = rBody.scrollHeight;
          }
          const $log = $sel$1("#ykt-ai-log");
          $log.scrollTop = $log.scrollHeight;
        });
      };
      abortCtrl$1 = new AbortController;
      const res = await agnesChat({
        messages: [ {
          role: "system",
          content: systemPrompt$1()
        }, ...history$1 ],
        stream: true,
        thinking: true,
        signal: abortCtrl$1.signal,
        override: getOverride() || void 0,
        onDelta: d => {
          acc.content += d;
          paint();
        },
        onReasoning: d => {
          acc.reasoning += d;
          paint();
        }
      });
      acc.content = res.content || acc.content;
      acc.reasoning = res.reasoning || acc.reasoning;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
 // 防止挂起的 paint 覆盖 renderRich 成果
            aiBubble.innerHTML = (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : "") + (acc.content ? mdToHtml(acc.content) : '<span class="err">（空回复）</span>');
      renderRich(aiBubble);
      history$1.push({
        role: "assistant",
        content: acc.content || "（无内容）"
      });
    } catch (e) {
      const emsg = String(e?.message || "");
      const isTimeout = /timeout|超时/i.test(emsg);
      const aborted = e?.name === "AbortError" && !isTimeout || /abort|cancel/i.test(emsg);
      if (aborted) addBubble$1("ai", '<span class="muted">（已取消）</span>'); else addBubble$1("ai", `<span class="err">出错了：${escapeHtml(e?.message || String(e))}</span><br/><small>提示：到设置里检查 AI 配置的 API Key。</small>`);
    } finally {
      streaming$1 = false;
      abortCtrl$1 = null;
      $sel$1("#ykt-ai-send").disabled = false;
      $sel$1("#ykt-ai-log").scrollTop = $sel$1("#ykt-ai-log").scrollHeight;
    }
  }
  // ---------------- 兼容旧导出（其他模块引用） ----------------
    async function askAIForCurrent() {
    return sendCurrent$1({
      auto: true
    });
  }
  // ---------------- Markdown / 富媒体渲染 ----------------
  // ---------------- Markdown / 富媒体渲染 ----------------
    const MERMAID_LOOSE_RE = /^\s*(graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie\b|mindmap|timeline|gitGraph)/i;
  /** 行级剥离 HTML 包裹标签（AI 偶尔把 mermaid 包在 <p>/<br/> 里输出） */  function stripHtmlWrappers(text) {
    return String(text ?? "").split("\n").map(l => l.replace(/<\/?p[^>]*>/gi, "").replace(/<br\s*\/?>/gi, "\n")).join("\n").replace(/\n{3,}/g, "\n\n");
  }
  /** marked 实例在页面主世界（ensureMarked 用 script 标签注入），沙箱 window 上读不到 */  const getMarked = () => (gm.uw || window).marked || window.marked;
  /** marked 产物进 innerHTML 前的清洗：优先 DOMPurify（已预热则同步可用），否则 sanitizeHtml */  function sanitizeFinal(md) {
    const purify = (gm.uw || window).DOMPurify || window.DOMPurify;
    if (purify?.sanitize) return purify.sanitize(md, {
      ADD_ATTR: [ "target", "data-raw" ]
    });
    return sanitizeHtml(md);
  }
  /** 同步清洗（DOMPurify 未就绪时的回退） */  function sanitizeHtml(html) {
    try {
      const doc = (new DOMParser).parseFromString(String(html), "text/html");
      doc.querySelectorAll("script, style, iframe, object, embed, link, meta, base, form").forEach(n => n.remove());
      doc.querySelectorAll("*").forEach(n => {
        for (const a of [ ...n.attributes ]) {
          const name = a.name.toLowerCase();
          if (name.startsWith("on") || [ "href", "src", "xlink:href" ].includes(name) && /^\s*javascript:/i.test(String(a.value || ""))) n.removeAttribute(a.name);
        }
      });
      return doc.body.innerHTML;
    } catch {
      return "";
    }
  }
  /** marked 解析前预处理：AI 偶尔输出「裸 mermaid + HTML 包裹」混合体，剥壳后围栏化 */  function preprocessRaw(raw) {
    if (/```/.test(raw)) return raw;
 // 有围栏的交给 marked
        const stripped = stripHtmlWrappers(raw).trim();
    if (stripped && MERMAID_LOOSE_RE.test(stripped) && stripped.split("\n").length >= 2 && stripped.length < 5e3) return "```mermaid\n" + stripped + "\n```";
    return raw;
  }
  /**
   * Markdown → HTML（同步，供流式 paint 使用）。
   * 富媒体占位：mermaid/svg/html 代码块转占位 div，真正渲染在 renderRich。
   * marked 未就绪时回退内置简化解析。
   */  function mdToHtml(mdRaw = "") {
    const raw = preprocessRaw(String(mdRaw ?? ""));
    const blocks = [];
 // 代码块暂存（占位符 → 原文），每次调用独立——模块级共享会串号
        let md;
    const marked = getMarked();
    if (marked?.parse) try {
      // marked v9：options.renderer 传普通对象会整体替换默认 Renderer（缺方法即崩）——
      // 实例化 Renderer 再覆写 code；Renderer 不可用时才退化为对象字面量
      const onCode = function(code, lang) {
        const l = String(lang || "").toLowerCase().trim();
        blocks.push({
          lang: l,
          code: String(code ?? "")
        });
        return `B${blocks.length - 1}`;
      };
      const renderer = typeof marked.Renderer === "function" ? Object.assign(new marked.Renderer, {
        code: onCode
      }) : {
        code: onCode
      };
      md = marked.parse(raw, {
        breaks: true,
        gfm: true,
        renderer: renderer
      });
    } catch (e) {
      // 自定义 renderer 与 marked 版本不兼容时退回默认解析（代码块变 <pre><code>，embed 失效但不至于全崩）
      log.warn("[mdToHtml] marked renderer 解析失败，退回默认解析:", e?.message);
      try {
        md = marked.parse(raw, {
          breaks: true,
          gfm: true
        });
      } catch (e2) {
        md = escapeHtml(raw);
      }
    } else {
      md = raw.replace(/```([a-zA-Z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)```/g, (_, lang, code) => {
        blocks.push({
          lang: String(lang || "").toLowerCase(),
          code: code.replace(/\n$/, "")
        });
        return `B${blocks.length - 1}`;
      });
      md = escapeHtml(md).replace(/\r\n?/g, "\n");
      md = md.replace(/`([^`]+?)`/g, (_, code) => `<code class="ykt-md-inline">${code}</code>`);
      md = md.replace(/^######\s+(.*)$/gm, "<h6>$1</h6>").replace(/^#####\s+(.*)$/gm, "<h5>$1</h5>").replace(/^####\s+(.*)$/gm, "<h4>$1</h4>").replace(/^###\s+(.*)$/gm, "<h3>$1</h3>").replace(/^##\s+(.*)$/gm, "<h2>$1</h2>").replace(/^#\s+(.*)$/gm, "<h1>$1</h1>");
      md = md.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+?)\*/g, "<em>$1</em>");
    }
    const MERMAID_START_RE = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie\b|mindmap|timeline|gitGraph)\b/i;
    md = md.replace(/\uE000B(\d+)\uE001/g, (_, i) => {
      const b = blocks[Number(i)];
      if (!b) return "";
      const looksMermaid = b.lang === "mermaid" || !b.lang && MERMAID_START_RE.test(b.code);
      if (looksMermaid) return `<div class="ykt-mermaid" data-raw="${escapeHtml(b.code).replace(/"/g, "&quot;")}"></div>`;
      if (b.lang === "svg" || b.lang === "html") return `<div class="ykt-embed" data-raw="${escapeHtml(b.code).replace(/"/g, "&quot;")}"></div>`;
      return `<pre class="ykt-md-code"><code${b.lang ? ` data-lang="${b.lang}"` : ""}>${escapeHtml(b.code)}</code></pre>`;
    });
    // marked 透传 markdown 里的原始 HTML——模型输出可能含危险标签，innerHTML 前必须清洗
        if (marked?.parse) return sanitizeFinal(md);
    // 回退路径的段落包裹
        const lines = md.split("\n");
    const out = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      out.push(`<p>${buf.join("<br/>")}</p>`);
      buf = [];
    };
    const isBlock = s => /^(<h[1-6]|<ul>|<ol>|<pre |<blockquote>|<hr\/>|<p>|<table|<div|\uE000B\d+\uE001$)/.test(s.trim());
    for (const ln of lines) {
      if (!ln.trim()) {
        flush();
        continue;
      }
      if (isBlock(ln)) {
        flush();
        out.push(ln);
      } else buf.push(ln);
    }
    flush();
    return out.join("\n");
  }
  /** 裸 mermaid 兜底：AI 不守规矩直接输出流程图文本时（含被 <p>/<br/> 包裹的） */  function rescueLooseMermaid(el) {
    for (const p of [ ...el.querySelectorAll("p") ]) {
      const text = stripHtmlWrappers(p.textContent || "");
      if (MERMAID_LOOSE_RE.test(text) && text.split("\n").length >= 2) {
        const div = document.createElement("div");
        div.className = "ykt-mermaid";
        div.setAttribute("data-raw", text);
        p.replaceWith(div);
      }
    }
  }
  /**
   * 富媒体后处理（异步）：mermaid 图、HTML/SVG 嵌入、MathJax 公式。
   * 在流式完成的最终 innerHTML 之后调用。
   */  async function renderRich(el) {
    if (!el) return;
    try {
      // marked 默认解析路径（自定义 renderer 不可用时）把围栏代码块渲染成
      // <pre><code class="language-*">——把 mermaid/html/svg 捞回 embed 占位再走正常管线
      for (const codeEl of [ ...el.querySelectorAll('pre > code[class*="language-"]') ]) {
        const lang = (codeEl.className.match(/language-(\w+)/) || [])[1];
        if (![ "mermaid", "html", "svg" ].includes(lang)) continue;
        const div = document.createElement("div");
        div.className = lang === "mermaid" ? "ykt-mermaid" : "ykt-embed";
        div.setAttribute("data-raw", codeEl.textContent || "");
        codeEl.parentElement.replaceWith(div);
      }
      rescueLooseMermaid(el);
      // 1) mermaid → SVG
            const mermaidEls = [ ...el.querySelectorAll(".ykt-mermaid[data-raw]") ];
      if (mermaidEls.length) try {
        const mermaid = await ensureMermaid();
        for (const node of mermaidEls) {
          // AI 偶尔在 mermaid 源码里混入 <p>/<br/> 等标签导致解析失败——渲染前剥掉
          const src = stripHtmlWrappers(node.getAttribute("data-raw") || "");
          try {
            const {svg: svg} = await mermaid.render(`ykmmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, src);
            const wrap = document.createElement("div");
            wrap.className = "ykt-mermaid-render";
            wrap.innerHTML = svg;
            node.replaceWith(wrap);
          } catch (e) {
            log.warn("[Rich] mermaid 渲染失败，显示源码:", e?.message);
            const pre = document.createElement("pre");
            pre.className = "ykt-md-code";
            pre.textContent = src;
            node.replaceWith(pre);
          }
        }
      } catch (e) {
        log.warn("[Rich] mermaid 加载失败:", e?.message);
        mermaidEls.forEach(node => {
          const pre = document.createElement("pre");
          pre.className = "ykt-md-code";
          pre.textContent = node.getAttribute("data-raw") || "";
          node.replaceWith(pre);
        });
      }
      // 2) svg/html 嵌入 → DOMPurify 清洗后渲染
            for (const node of [ ...el.querySelectorAll(".ykt-embed[data-raw]") ]) {
        const rawHtml = node.getAttribute("data-raw") || "";
        try {
          const purify = await ensureDOMPurify();
          node.innerHTML = purify.sanitize(rawHtml, {
            ADD_ATTR: [ "target" ]
          });
        } catch {
          node.innerHTML = sanitizeHtml(rawHtml);
        }
        node.removeAttribute("data-raw");
      }
      // 3) MathJax 公式
            if (ui?.config?.iftex) {
        const ok = await ensureMathJax();
        if (ok) {
          el.classList.add("tex-enabled");
          await typesetTexIn(el);
        }
      }
    } catch (e) {
      log.warn("[Rich] renderRich 失败:", e);
    }
  }
  /** 预热富媒体依赖（面板挂载时后台拉 CDN） */  function warmupRichAssets() {
    ensureMarked().then(m => {
      try {
        m.setOptions({
          breaks: true,
          gfm: true
        });
      } catch {}
    }).catch(e => log.warn("[Rich] marked 预热失败", e?.message));
    ensureDOMPurify().catch(e => log.warn("[Rich] DOMPurify 预热失败", e?.message));
  }
  var tpl$5 = '<div id="ykt-presentation-panel" class="ykt-panel">\n  <style>\n    #ykt-presentation-panel .slide-thumb.active {\n      outline: 2px solid #3b82f6;\n      outline-offset: 2px;\n    }\n    .pdf-progress {\n      display: flex;\n      align-items: center;\n      gap: 10px;\n      padding: 6px 12px;\n      background: #f0f4ff;\n      border-radius: 6px;\n      margin-top: 6px;\n    }\n    .pdf-progress-bar {\n      flex: 1;\n      height: 8px;\n      background: #dbeafe;\n      border-radius: 4px;\n      overflow: hidden;\n    }\n    .pdf-progress-fill {\n      height: 100%;\n      width: 0%;\n      background: linear-gradient(90deg, #3b82f6, #6366f1);\n      border-radius: 4px;\n      transition: width 0.2s ease;\n    }\n    .pdf-progress-text {\n      font-size: 12px;\n      font-weight: 600;\n      color: #3b82f6;\n      min-width: 36px;\n      text-align: right;\n    }\n    /* 题目页筛选开关 / 跟随当前页开关 */\n    #ykt-filter-problems,\n    #ykt-follow-current {\n      border: 1px solid var(--ykt-border-strong, #ccc);\n      background: #f7f8fa;\n      border-radius: 6px;\n      cursor: pointer;\n      padding: 4px 10px;\n      font-size: 12px;\n      color: var(--ykt-fg, #222);\n    }\n    #ykt-filter-problems.active,\n    #ykt-follow-current.active {\n      background: #1d63df;\n      border-color: #1d63df;\n      color: #fff;\n    }\n  </style>\n  <div class="panel-header">\n    <h3>课件查看</h3>\n    <div class="panel-controls">\n      <button id="ykt-follow-current" title="选中项自动跟随课堂翻页；手动选择页面会脱离跟随">🎯 跟随当前页</button>\n      <button id="ykt-filter-problems" title="只显示带题目的页面，再次点击恢复全部">📝 只看题目页</button>\n      <button id="ykt-download-pdf">整册下载(PDF)</button>\n      <button id="ykt-import-history" title="从历史课堂报告导入课件并导出 PDF">📥 历史课件</button>\n      <span class="close-btn" id="ykt-presentation-close"><i class="fas fa-times"></i></span>\n    </div>\n    <div id="ykt-pdf-progress" class="pdf-progress" style="display:none">\n      <div class="pdf-progress-bar">\n        <div id="ykt-pdf-progress-fill" class="pdf-progress-fill"></div>\n      </div>\n      <span id="ykt-pdf-progress-text" class="pdf-progress-text">0%</span>\n      <button id="ykt-pdf-cancel" title="取消导出" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:13px;padding:0 2px;">✕</button>\n    </div>\n  </div>\n\n  <div class="panel-body">\n    <div class="panel-left">\n      <div id="ykt-presentation-list" class="presentation-list"></div>\n    </div>\n    <div class="panel-right">\n      <div id="ykt-slide-view" class="slide-view">\n        <div class="slide-cover">\n          <div class="empty-message">选择左侧的幻灯片查看详情</div>\n        </div>\n        <div id="ykt-problem-view" class="problem-view"></div>\n      </div>\n    </div>\n  </div>\n</div>\n';
  // src/core/idb-cache.js
  // PDF 导出图片缓存：下载的 dataURL 落 IndexedDB，刷新/中断后重导可断点续传。
  // key = 图片 URL 去掉 query（签名 token 会过期轮换，path 部分才是稳定身份）。
    const DB_NAME = "yks-pdf-cache";
  const STORE = "images";
  let _dbPromise = null;
  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          try {
            req.result.createObjectStore(STORE);
          } catch {}
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("idb open failed"));
        req.onblocked = () => reject(new Error("idb blocked"));
      } catch (e) {
        reject(e);
      }
    });
    // 打开失败只记一次，后续调用直接走已 reject 的 promise
        _dbPromise.catch(() => {});
    return _dbPromise;
  }
  /** 缓存 key：去 query/hash（token 过期不阻命中），data:/blob: 不缓存 */  function imageCacheKey(url) {
    const u = String(url || "");
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return null;
    return u.split("?")[0].split("#")[0];
  }
  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result?.v ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      log.dbg("[PDF][cache] get 失败（降级为无缓存）:", e?.message);
      return null;
    }
  }
  async function idbSet(key, dataUrl) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORE).put({
          v: dataUrl,
          t: Date.now()
        }, key);
      });
    } catch (e) {
      // 配额满等场景静默降级——缓存是优化项不是功能项
      log.warn("[PDF][cache] 写入失败:", e?.message);
    }
  }
  async function idbDel(key) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORE).delete(key);
      });
    } catch {}
  }
  // src/core/pdf-export.js
  // 公共 PDF 导出：页面尺寸跟随图片实际宽高比（零白边），GM_xhr 下载图片绕 CORS
  /** 让出事件循环：phase-2 的同步编码循环必须定期 yield，否则主线程阻塞 → 进度不 paint、关闭/取消按钮失灵。
   *  用 MessageChannel 而非 setTimeout(0)：后台标签页里定时器被节流到 1s+（实测 yield 一次 ~4s，
   *  158 页拖到 10min+），MessageChannel 走任务队列不受定时器节流影响。
   *  且距上次 yield <32ms 时直接跳过——前台页全速跑，不为一页一次的调度开销买单。 */  const _yieldCh = new MessageChannel;
  let _yieldResolve = null;
  _yieldCh.port1.onmessage = () => {
    const r = _yieldResolve;
    _yieldResolve = null;
    r?.();
  };
  let _lastYield = 0;
  const yieldFrame = () => {
    const now = performance.now();
    if (now - _lastYield < 32) return Promise.resolve();
    _lastYield = now;
    return new Promise(r => {
      _yieldResolve = r;
      _yieldCh.port2.postMessage(0);
    });
  };
  /**
   * 从图片列表构建并下载 PDF（横屏 PPT 出横屏页，页面比例=图片比例）
   * @param {string[]} urls   图片 URL（支持带签名的 CDN 链接 / dataURL）
   * @param {string} title    文件名（自动清理非法字符）
   * @param {Object} [opts]   { onProgress(info), dedupHash: boolean, signal: {aborted},
   *                          imageTimeoutMs: 单图下载+解码超时（默认 30s，超时计 failed 跳过） }
   *                          onProgress 收到 { cur, total, pct, skipped, failed, pages, text }
   * @returns {Promise<{pages:number, skipped:number, failed:number}>}
   *          pages   = 实际写入 PDF 的页数
   *          skipped = 内容级重复被跳过的页数
   *          failed  = 图片下载/加载失败被跳过的页数
   *          （两者分开统计——此前混在一起导致"去重 n 页"数字不可信）
   */  async function exportImagesToPdf(urls, title, opts = {}) {
    if (!urls || !urls.length) throw new Error("没有可导出的页面");
    const jsPDF = (await ensureJsPDF())?.jsPDF;
    if (!jsPDF) throw new Error("jsPDF 未加载成功");
    const onProgress = opts.onProgress || (() => {});
    const total = urls.length;
    const imageTimeoutMs = opts.imageTimeoutMs || 3e4;
    const checkAbort = () => {
      if (opts.signal?.aborted) throw new Error("已取消");
    };
    let doc = null;
    let pages = 0;
    let skipped = 0;
    let failed = 0;
    const sigSet = new Set;
 // 已收录页的内容签名（精确匹配判重）
        const _prof = {
      page: 0,
      grey: 0,
      jspdf: 0,
      progress: 0,
      yield: 0
    };
 // 分段耗时（临时诊断）
        const CONCURRENCY = 5;
    // 阶段1：并发预下载全部图片（带进度），避免逐张串行等待
        onProgress({
      cur: 0,
      total: total,
      pct: 0,
      skipped: 0,
      failed: 0,
      pages: 0,
      text: "并发下载图片中…"
    });
    const items = new Array(total).fill(null);
 // { img, dataUrl }
        let doneCount = 0;
    let cacheHits = 0;
    let nextIdx = 0;
    async function worker() {
      for (;;) {
        checkAbort();
        const i = nextIdx++;
        if (i >= total) return;
        try {
          items[i] = await loadImageWithCache(urls[i], imageTimeoutMs);
          if (items[i].fromCache) cacheHits++;
        } catch (e) {
          log.warn("[PDF] 第", i + 1, "页图片加载失败，跳过:", e?.message);
          items[i] = null;
        }
        doneCount++;
        const hitTxt = cacheHits ? `（缓存命中 ${cacheHits}）` : "";
        onProgress({
          cur: doneCount,
          total: total,
          pct: Math.round(doneCount / total * 60),
          skipped: skipped,
          failed: failed,
          pages: pages,
          text: `已下载 ${doneCount}/${total} 张${hitTxt}`
        });
      }
    }
    await Promise.all(Array.from({
      length: Math.min(CONCURRENCY, total)
    }, worker));
    checkAbort();
    // 阶段2：顺序去重 + 生成 PDF（每页 yield 一帧 + try/catch，单页失败不拖垮全册、UI 不冻结）
        for (let i = 0; i < total; i++) {
      checkAbort();
      const it = items[i];
      items[i] = null;
 // 尽早释放位图内存（145+ 页时 decoded bitmap 累计可达 GB 级）
            if (!it) {
        failed++;
 // 下载/解码失败，与"内容重复"区分开
                onProgress({
          cur: i + 1,
          total: total,
          pct: 60 + Math.round((i + 1) / total * 38),
          skipped: skipped,
          failed: failed,
          pages: pages,
          text: `第${i + 1}/${total}页下载失败，已跳过`
        });
        await yieldFrame();
        continue;
      }
      const {img: img, dataUrl: dataUrl} = it;
      const _t0 = performance.now();
      try {
        // 内容级去重：8x8 块均值签名精确匹配（Set O(1)）。
        // 沙箱里 TypedArray 逐元素读 ~1µs，任何 O(n) 逐页对比都是 O(n²) 灾难（158 页实测 ~10min）；
        // 精确签名判重覆盖真实重复场景（同图重推/模板重复页），漏判仅多收几页、绝不丢内容
        if (opts.dedupHash) {
          let dup = false;
          const _tg = performance.now();
          try {
            const sig = toSig(img);
            if (sigSet.has(sig)) dup = true; else sigSet.add(sig);
          } catch {/* 去重失败不阻断 */}
          _prof.grey += performance.now() - _tg;
          if (dup) {
            skipped++;
            onProgress({
              cur: i + 1,
              total: total,
              pct: 60 + Math.round((i + 1) / total * 38),
              skipped: skipped,
              failed: failed,
              pages: pages,
              text: `第${i + 1}/${total}页重复，已跳过`
            });
            const _ty = performance.now();
            await yieldFrame();
            _prof.yield += performance.now() - _ty;
            continue;
          }
        }
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) {
          failed++;
          log.warn("[PDF] 第", i + 1, "页图片尺寸为 0，跳过");
          const _ty = performance.now();
          await yieldFrame();
          _prof.yield += performance.now() - _ty;
          continue;
        }
        const fmt = [ iw, ih ];
        const orient = iw >= ih ? "landscape" : "portrait";
        const _td = performance.now();
        if (!doc) doc = new jsPDF({
          unit: "pt",
          format: fmt,
          orientation: orient
        }); else doc.addPage(fmt, orient);
        // 优先内嵌原始字节（JPEG dataURL 零重编码，体积小一个量级）；
        // webp 等无法内嵌的格式：先转 JPEG 再嵌——addImage(img,'PNG') 是全尺寸 PNG 重编码，
        // 实测每张 ~4s（158 页≈10min），转 JPEG 后编码快数倍且 PDF 体积小一个量级
                const imgFmt = formatOfDataUrl(dataUrl);
        if (imgFmt) doc.addImage(dataUrl, imgFmt, 0, 0, iw, ih); else doc.addImage(imgToJpeg(img, iw, ih), "JPEG", 0, 0, iw, ih);
        _prof.jspdf += performance.now() - _td;
        pages++;
        const _tp = performance.now();
        onProgress({
          cur: i + 1,
          total: total,
          pct: 60 + Math.round((i + 1) / total * 38),
          skipped: skipped,
          failed: failed,
          pages: pages,
          text: `${pages} 页已收录`
        });
        _prof.progress += performance.now() - _tp;
      } catch (e) {
        // 单页异常（如 canvas 污染 SecurityError）计 failed 继续，不让全册陪葬
        failed++;
        log.warn("[PDF] 第", i + 1, "页写入 PDF 失败，跳过:", e?.message);
        onProgress({
          cur: i + 1,
          total: total,
          pct: 60 + Math.round((i + 1) / total * 38),
          skipped: skipped,
          failed: failed,
          pages: pages,
          text: `第${i + 1}/${total}页写入失败，已跳过`
        });
      } finally {
        try {
          img.src = "";
        } catch {}
 // 释放解码位图
            }
      _prof.page += performance.now() - _t0;
      if ((i + 1) % 20 === 0) {
        const _s = i + 1 + ":" + JSON.stringify({
          v: 3,
          page: Math.round(_prof.page),
          grey: Math.round(_prof.grey),
          jspdf: Math.round(_prof.jspdf),
          progress: Math.round(_prof.progress),
          yield: Math.round(_prof.yield)
        });
        log.dbg("[PDF][prof] 页累计ms:", _s);
        try {
          localStorage.setItem("yksProf", (localStorage.getItem("yksProf") || "") + _s + "\n");
        } catch {}
        _prof.page = _prof.grey = _prof.jspdf = _prof.progress = _prof.yield = 0;
      }
      const _ty2 = performance.now();
      await yieldFrame();
      _prof.yield += performance.now() - _ty2;
    }
    if (!doc) throw new Error("所有页面图片下载失败，未生成 PDF");
    onProgress({
      cur: total,
      total: total,
      pct: 100,
      skipped: skipped,
      failed: failed,
      pages: pages,
      text: "保存中..."
    });
    const safe = String(title || "课件").replace(/[\\/:*?"<>|]/g, "_");
    doc.save(`${safe}.pdf`);
    return {
      pages: pages,
      skipped: skipped,
      failed: failed
    };
  }
  /** 8×8 块均值内容签名（用于内容级去重，精确匹配）。
   *  注意：油猴沙箱世界里 TypedArray 逐元素读写比主世界慢 ~50-100 倍（实测 ~1µs/元素），
   *  所以：1) 页面 realm 的 ImageData.data 先整块 set() 拷进沙箱数组，再逐元素读；
   *       2) 128×72 缩略 + 隔点采样 + Uint32 一次读 4 字节，逐元素操作压到 ~1 万次/页。 */  function toSig(img) {
    const W = 128, H = 72;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", {
      willReadFrequently: true
    });
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const local = new Uint8ClampedArray(d.length);
    local.set(d);
 // 一次原生块拷贝，避免逐元素跨 realm 读
        const u32 = new Uint32Array(local.buffer);
 // 1 次读 4 字节
        const B = 8, bw = W / B, bh = H / B;
 // 8×8 分块
        const blockSum = new Float64Array(B * B);
    const blockCnt = new Float64Array(B * B);
    for (let p = 0; p < W * H; p += 2) {
      // 隔点采样（去重精度足够）
      const px = u32[p];
 // RGBA little-endian
            const lum = (px & 255) * .299 + (px >> 8 & 255) * .587 + (px >> 16 & 255) * .114 | 0;
      const x = p % W, y = p / W | 0;
      const b = (y / bh | 0) * B + (x / bw | 0);
      blockSum[b] += lum;
      blockCnt[b]++;
    }
    let sig = "";
    for (let b = 0; b < B * B; b++) {
      const m = blockCnt[b] ? blockSum[b] / blockCnt[b] : 0;
      sig += (m >> 3).toString(36)[0];
 // 32 级量化（0-255 → 0-31 → '0'..'v'）
        }
    return sig;
  }
  /** 位图 → JPEG dataURL（webp 等不可内嵌格式的降级路径；白底兜底透明像素） */  function imgToJpeg(img, w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", .85);
  }
  /** dataURL 的 mime → jsPDF 格式（仅 jpeg/png 可安全内嵌原字节；其余返回 null 走 canvas 重编码） */  function formatOfDataUrl(dataUrl) {
    const m = /^data:image\/(\w+)/i.exec(String(dataUrl || ""));
    const t = m?.[1]?.toLowerCase();
    if (t === "jpeg" || t === "jpg") return "JPEG";
    if (t === "png") return "PNG";
    return null;
  }
  /** GM_xhr 转 dataURL 后加载 Image（绕开 OSS CORS 限制） */  async function loadImageViaGM(src, timeoutMs) {
    let url = src;
    if (!src.startsWith("data:")) 
    // GM 下载失败不再直载跨域原图——canvas 污染会让 addImage/toGrey256 抛 SecurityError
    url = await fetchAsDataURL(src, Math.min(timeoutMs, 2e4));
    const img = await loadImageEl(url, timeoutMs);
    return {
      img: img,
      dataUrl: url.startsWith("data:") ? url : null
    };
  }
  /** 断点续传：IndexedDB 缓存优先，命中直接解码；未命中走 GM 下载并写缓存。
   *  缓存条目解码失败视为损坏——删掉重下，不让坏数据永久挡路。 */  async function loadImageWithCache(src, timeoutMs) {
    const key = imageCacheKey(src);
    if (key) {
      const cached = await idbGet(key);
      if (cached) try {
        const img = await loadImageEl(cached, timeoutMs);
        return {
          img: img,
          dataUrl: cached,
          fromCache: true
        };
      } catch {
        log.warn("[PDF][cache] 缓存条目损坏，重新下载:", key.slice(-60));
        idbDel(key);
      }
    }
    const r = await loadImageViaGM(src, timeoutMs);
    if (key && r.dataUrl) idbSet(key, r.dataUrl);
 // 后台写，失败不影响导出
        return {
      ...r,
      fromCache: false
    };
  }
  /** Image 元素加载 + 解码超时兜底（onload/onerror 都可能不触发） */  function loadImageEl(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const img = new Image;
      const timer = setTimeout(() => {
        try {
          img.src = "";
        } catch {}
        reject(new Error("图片解码超时"));
      }, timeoutMs);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Image 加载失败"));
      };
      img.src = url;
    });
  }
  // src/core/history-capture.js
  // 历史课件收集器：在 student-v3 报告页自动运行
  // 流程：等课件卡片渲染 → 点击缩略图打开全页预览 → DOM 收集全部 slide 图 URL
  //      → 去重排序 → 直接生成横屏 PDF 下载 → 通过 GM_setValue 通知主页面 → 关闭标签页
    const RESULT_KEY_PREFIX = "ykt-history-result:";
  const PROGRESS_KEY_PREFIX = "ykt-history-progress:";
  /** 收集页内的可见状态条（进度对本页用户可见） */  function statusEl(text, pct) {
    let el = document.getElementById("yks-history-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "yks-history-status";
      el.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;background:#1d63df;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:420px;font-family:system-ui,sans-serif;";
      document.body?.appendChild(el);
    }
    el.innerHTML = `<b>📥 YuketangStudio 收集器</b><div style="margin-top:4px">${text || ""}</div>` + (pct != null ? `<div style="margin-top:6px;background:rgba(255,255,255,.25);border-radius:4px;overflow:hidden"><div style="height:6px;width:${pct}%;background:#fff;border-radius:4px;transition:width .3s"></div></div>` : "");
    return el;
  }
  /** 是否处于 student-v3 报告页（收集器的工作现场）。
   *  只有脚本自己打开的收集页（URL 带 #yks-collect 标记）才自动执行——
   *  用户手动浏览报告页不应被劫持点击/下载/关页。 */  function isStudentV3Page() {
    return /\/v2\/web\/student-v3\//.test(window.location.pathname) && /yks-collect/.test(window.location.hash);
  }
  /** 本次收集 runId（importHistoryLesson 生成在 URL hash 里），用于区分旧 run 残留的写值 */  function collectRunId() {
    return (window.location.hash.match(/yks-collect-(\w+)/) || [])[1] || null;
  }
  /** 收集全部 slide 图 URL：读 currentSrc/src/data-src（懒加载图可能还没挂 src），
   *  过滤放宽为 /slide/<id>/ + 图片扩展名（不再硬性要求 token 参数） */  function collectSlideUrls() {
    const uniq = new Map;
 // key: cover数字_时间戳（命名漂移时退化为完整 URL）-> {n, url, order}
        let order = 0;
    let filteredSlideLike = 0;
    for (const img of document.querySelectorAll("img")) {
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (!src.includes("/slide/")) continue;
      if (!/\.(png|jpe?g|webp)(\?|#|$)/i.test(src)) {
        filteredSlideLike++;
        continue;
      }
      const m = src.match(/\/slide\/(\d+)\/cover(\d+)_(\d+)\.(\w+)/);
      const key = m ? `${m[1]}_${m[2]}_${m[3]}` : src;
      const prev = uniq.get(key);
      const n = m ? parseInt(m[2], 10) : 0;
      if (!prev) uniq.set(key, {
        n: n,
        url: src,
        order: order++
      }); else if (n > prev.n) {
        prev.url = src;
        prev.n = n;
      }
    }
    if (filteredSlideLike) log.warn("[YKS-History] 有", filteredSlideLike, "个 /slide/ URL 因扩展名不匹配被过滤");
    // 按 DOM 出现顺序排序（lightbox 顺序即页序）
        return [ ...uniq.values() ].sort((a, b) => a.order - b.order).map(x => x.url);
  }
  /** 页面上声明的总页数（「共N页」「x/N」等），用于收集结果比对告警 */  function expectedPageCount() {
    try {
      const text = document.querySelector(".module_ppt")?.innerText || "";
      const m = text.match(/共\s*(\d+)\s*页/) || text.match(/(\d+)\s*页/) || text.match(/\b1\s*\/\s*(\d+)\b/);
      return m ? parseInt(m[1], 10) : null;
    } catch {
      return null;
    }
  }
  /** 从 URL 提取 lessonId（student-v3/{classId}/{lessonId}/{activityId}） */  function parseStudentV3Ids() {
    const m = window.location.pathname.match(/\/v2\/web\/student-v3\/(\d+)\/(\d+)\/(\d+)/);
    return m ? {
      classId: m[1],
      lessonId: m[2],
      activityId: m[3]
    } : null;
  }
  /**
   * 在 v3 页面执行收集。由 index.js 在匹配页面时调用（fire-and-forget）。
   */  async function runHistoryCapture() {
    const ids = parseStudentV3Ids();
    if (!ids) return;
    const {lessonId: lessonId} = ids;
    const runId = collectRunId();
    log.dbg("[YKS-History] 开始收集历史课件:", ids, "runId:", runId);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const gmSet = (key, val) => {
      try {
        if (typeof GM_setValue === "function") GM_setValue(key, val);
      } catch {}
    };
    // 入口心跳：主页面据此知道收集页已活（而不是静默等超时）
        gmSet(PROGRESS_KEY_PREFIX + lessonId, {
      runId: runId,
      phase: "start",
      text: "收集页已启动",
      ts: Date.now()
    });
    try {
      statusEl("等待课件卡片渲染…");
      // 1. 等待课件卡片渲染（最长 30s）
            let card = null;
      for (let i = 0; i < 30; i++) {
        card = document.querySelector(".module_ppt .swiper_box img, .module_ppt .ppt_info_box");
        if (card) break;
        await sleep(1e3);
      }
      if (!card) throw new Error("课件卡片未渲染（可能该课堂无课件）");
      // 2. 取标题
            const title = (document.querySelector(".ppt_name")?.textContent || "历史课件").trim();
      statusEl(`已找到课件「${title}」，打开全页预览…`);
      // 3. 点击缩略图打开全页预览；懒加载兜底：反复滚动容器+重扫，直到 img 计数稳定
            const thumb = document.querySelector(".module_ppt .swiper_box img") || document.querySelector(".module_ppt img");
      if (thumb) {
        thumb.click();
        let lastCount = -1, stable = 0;
        for (let i = 0; i < 45; i++) {
          await sleep(1e3);
          // 触发懒加载：把所有可疑滚动容器拉到底
                    for (const sc of document.querySelectorAll('.swiper_box, [class*="lightbox"], [class*="preview"], [class*="viewer"]')) try {
            sc.scrollTop = sc.scrollHeight;
          } catch {}
          try {
            window.scrollTo(0, document.body?.scrollHeight || 0);
          } catch {}
          const n = collectSlideUrls().length;
          statusEl(`预览渲染中…已发现 ${n} 页`);
          if (n === lastCount) {
            if (++stable >= 3) break;
          } else {
            stable = 0;
            lastCount = n;
          }
        }
      } else log.warn("[YKS-History] 未找到缩略图入口，直接收集现有 DOM");
      // 4. 收集全部 slide 图 URL（去重：按文件名主体，保留清晰度最高的版本）
            const urls = collectSlideUrls();
      const expected = expectedPageCount();
      log.dbg("[YKS-History] 收集到", urls.length, "页，页面声明总页数:", expected);
      if (expected && urls.length < expected) log.warn(`[YKS-History] 收集页数(${urls.length})少于页面声明(${expected})，PDF 可能缺页`);
      statusEl(`已收集 ${urls.length} 页图片，开始下载并生成 PDF…`, 2);
      if (!urls.length) throw new Error("未收集到任何 slide 图片");
      // 5. 逐张下载 + 内容级去重 + 生成横屏 PDF；进度实时上报主页面（节流 ≥150ms）
            let lastReport = 0;
      const report = (info, force = false) => {
        const now = Date.now();
        if (force || now - lastReport > 150) {
          lastReport = now;
          gmSet(PROGRESS_KEY_PREFIX + lessonId, {
            ...info,
            runId: runId,
            title: title,
            phase: "pdf",
            ts: now
          });
        }
        const bits = [];
        if (info.skipped) bits.push(`去重 ${info.skipped} 页`);
        if (info.failed) bits.push(`失败 ${info.failed} 页`);
        statusEl(`下载并生成 PDF：${info.text || ""}${bits.length ? ` · ${bits.join(" · ")}` : ""}`, info.pct);
        log.dbg("[YKS-History] PDF", info.pct + "%", info.text, bits.join(" "));
      };
      const {pages: pages, skipped: skipped, failed: failed} = await exportImagesToPdf(urls, title, {
        dedupHash: true,
        onProgress: report
      });
      // 6. 通知主页面（结果存 GM 存储，主页面监听变更；带 runId 防旧 run 串扰）
            const result = {
        ok: true,
        lessonId: lessonId,
        runId: runId,
        title: title,
        pages: pages,
        skipped: skipped,
        failed: failed,
        total: urls.length,
        expectedTotal: expected,
        ts: Date.now()
      };
      gmSet(RESULT_KEY_PREFIX + lessonId, result);
      const tail = [ `${pages} 页` ];
      if (skipped) tail.push(`去重 ${skipped} 页`);
      if (failed) tail.push(`失败 ${failed} 页`);
      if (expected && urls.length < expected) tail.push(`⚠️ 仅收集到 ${urls.length}/${expected} 页`);
      statusEl(`✅ 完成！PDF 已开始下载（${tail.join("，")}）`, 100);
      log.dbg("[YKS-History] 完成:", result);
      // 7. 关闭收集页（脚本开的 tab 才走到这里——isStudentV3Page 已用 hash 标记把关）
            setTimeout(() => {
        try {
          window.close();
        } catch {}
      }, 4e3);
    } catch (e) {
      log.err("[YKS-History] 失败:", e);
      statusEl(`❌ 收集失败：${String(e?.message || e).slice(0, 120)}`, 100);
      const result = {
        ok: false,
        lessonId: lessonId,
        runId: runId,
        error: String(e?.message || e),
        ts: Date.now()
      };
      gmSet(RESULT_KEY_PREFIX + lessonId, result);
      gmSet(PROGRESS_KEY_PREFIX + lessonId, {
        runId: runId,
        phase: "error",
        text: String(e?.message || e).slice(0, 80),
        ts: Date.now()
      });
    }
  }
  /**
   * 主页面调用：打开 v3 页收集并等待结果
   * @param {string} classId   班级 ID
   * @param {Object} activity  logs API 的条目 { id: activityId, courseware_id: lessonId, title }
   * @returns {Promise<{ok, title, pages}>}
   */  async function importHistoryLesson(classId, activity, opts = {}) {
    const lessonId = String(activity.courseware_id);
    const activityId = String(activity.id);
    const resultKey = RESULT_KEY_PREFIX + lessonId;
    const progressKey = PROGRESS_KEY_PREFIX + lessonId;
    // runId：区分本次 run 与上一次超时残留收集 tab 的写值（旧 run 的回报直接丢弃）
        const runId = Math.random().toString(36).slice(2, 10);
    // 清旧结果与进度
        if (typeof GM_setValue === "function") {
      GM_setValue(resultKey, null);
      GM_setValue(progressKey, null);
    }
    // #yks-collect-<runId> 标记：收集器只在这种脚本开的 tab 里自动运行（并在完成后自动关闭）
        const url = `${location.origin}/v2/web/student-v3/${classId}/${lessonId}/${activityId}#yks-collect-${runId}`;
    if (typeof GM_openInTab !== "function") throw new Error("GM_openInTab 不可用");
    // GM4/Violentmonkey 返回 Promise——await 兼容两种签名，否则 collectTab.close 静默无效
        const collectTab = await Promise.resolve(GM_openInTab(url, {
      active: true,
      insert: true
    }));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // 优先走 GM_addValueChangeListener 实时推送（收集页写值即回调），
    // 拿到进度不再依赖轮询间隔，快速下载时不会丢帧。
    // 监听不可用时退化为轮询（下面的 while 循环）。
        let done = null;
    let lastProgressTs = -1;
    let lastActivity = Date.now();
 // 任何匹配的 progress/result 写值都刷新——停滞检测用
        const listenerIds = [];
    const handleProgress = p => {
      try {
        if (!p || p.runId !== runId || p.ts === lastProgressTs) return;
        lastProgressTs = p.ts;
        lastActivity = Date.now();
        opts.onProgress?.(p);
      } catch (e) {
        log.warn("[History] onProgress 回调异常:", e?.message);
      }
    };
    const handleResult = r => {
      try {
        if (!r || !r.ts || r.runId !== runId) return;
        lastActivity = Date.now();
        if (!done) done = r;
      } catch (e) {
        log.warn("[History] handleResult 异常:", e?.message);
      }
    };
    if (typeof GM_addValueChangeListener === "function") try {
      const id1 = GM_addValueChangeListener(progressKey, (_n, _o, nv) => handleProgress(nv));
      if (id1 != null) listenerIds.push(id1);
      const id2 = GM_addValueChangeListener(resultKey, (_n, _o, nv) => handleResult(nv));
      if (id2 != null) listenerIds.push(id2);
    } catch (e) {
      log.warn("[History] 变更监听不可用，退回轮询:", e?.message);
      // 半程注册成功的也要清掉，否则旧监听器持有已 detach 的 bar 引用
            if (typeof GM_removeValueChangeListener === "function") for (const id of listenerIds) try {
        GM_removeValueChangeListener(id);
      } catch {}
      listenerIds.length = 0;
    }
    // 墙钟超时而非迭代次数——本页可能因收集 tab active:true 被切到后台，
    // setTimeout 被节流到 ~1min/次，用计数会让"180s 超时"实际拖成数小时
        const HEARTBEAT_TIMEOUT = 12e4;
 // 120s 无任何进展 → 判收集页已死
        const ABSOLUTE_TIMEOUT = 15 * 60 * 1e3;
 // 绝对上限 15min（大册导出本身可能很久）
        const t0 = Date.now();
    try {
      while (!done) {
        await sleep(1e3);
        if (typeof GM_getValue === "function") {
          handleProgress(GM_getValue(progressKey));
          handleResult(GM_getValue(resultKey));
        }
        if (done) break;
        if (Date.now() - lastActivity > HEARTBEAT_TIMEOUT) throw new Error("收集页超过 120s 无进展，可能已卡死——请检查新开的收集标签页");
        if (Date.now() - t0 > ABSOLUTE_TIMEOUT) throw new Error("收集超时（15min）——请确认打开的页面里课件正常显示");
      }
      return done;
    } finally {
      // 释放监听器，避免同一页面多次导入后回调累积
      if (typeof GM_removeValueChangeListener === "function") for (const id of listenerIds) try {
        GM_removeValueChangeListener(id);
      } catch {}
      // 完成/失败后关闭收集页（GM_openInTab 返回的 tab 对象支持 close）
            try {
        collectTab?.close?.();
      } catch {}
      setTimeout(() => {
        try {
          collectTab?.close?.();
        } catch {}
      }, 1500);
    }
  }
  /**
   * 主页面调用：拉取某班级的全部课堂列表（自动翻页，不再局限于前 50 条）
   * @param {string} classId
   * @returns {Promise<Array>} [{ id, courseware_id, title, attend_status, create_time }]
   */  async function fetchClassActivities(classId) {
    const PAGE_SIZE = 50;
    const MAX_PAGES = 20;
 // 上限 1000 条，防死循环
        const all = [];
    const seen = new Set;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`/v2/api/web/logs/learn/${classId}?actype=-1&page=${page}&offset=${PAGE_SIZE}&sort=-1`, {
        credentials: "include"
      });
      if (!res.ok) throw new Error(`课堂列表请求失败：HTTP ${res.status}`);
      const j = await res.json();
      const acts = j?.data?.activities || [];
      if (!acts.length) break;
      let added = 0;
      for (const a of acts) {
        if (a.type !== 14 || !a.courseware_id) continue;
 // 14 = 课堂
                const key = `${a.id}:${a.courseware_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(a);
        added++;
      }
      // 本页没有新增（或不足一页）说明已到末尾
            if (added === 0 || acts.length < PAGE_SIZE) break;
    }
    return all;
  }
  /** 从当前页面路径提取 classId（含桌面版与移动版 /m/v2 课程日志页） */  function currentClassId() {
    const path = window.location.pathname;
    const m = path.match(/\/studentLog\/(\d+)/) || path.match(/\/student-lesson-report\/(\d+)/) || path.match(/\/student-v3\/(\d+)/) || path.match(/\/m\/v\d\/course\/[^/]+\/logs\/(\d+)\/(\d+)/);
 // 移动版：/logs/{courseId}/{classId}
        return m ? m[2] || m[1] : null;
  }
  let mounted$5 = false;
  let host;
  let staticReportReady = false;
 //已结束课程
    let followCurrent = true;
 // 跟随课堂翻页：true=选中项自动跟随当前页；用户手动点缩略图后脱离
    function findSlideAcrossPresentations(idStr) {
    for (const [, pres] of repo.presentations) {
      const arr = pres?.slides || [];
      const hit = arr.find(s => String(s.id) === idStr);
      if (hit) return hit;
    }
    return null;
  }
  const L = (...a) => log.dbg("[presentation]", ...a);
  const W = (...a) => log.warn("[presentation]", ...a);
  function $$2(sel) {
    return document.querySelector(sel);
  }
  /** —— 运行时自愈：把 repo.slides 的数字键迁移为字符串键 —— */  function normalizeRepoSlidesKeys(tag = "presentation.mount") {
    try {
      if (!repo || !repo.slides || !(repo.slides instanceof Map)) {
        W("normalizeRepoSlidesKeys: repo.slides 不是 Map");
        return;
      }
      const beforeKeys = Array.from(repo.slides.keys());
      const nums = beforeKeys.filter(k => typeof k === "number");
      let moved = 0;
      for (const k of nums) {
        const v = repo.slides.get(k);
        const ks = String(k);
        if (!repo.slides.has(ks)) {
          repo.slides.set(ks, v);
          moved++;
        }
        // 保留旧键以防其他模块还在用数字键；仅打印提示
            }
      const afterSample = Array.from(repo.slides.keys()).slice(0, 8);
      L(`[normalizeRepoSlidesKeys@${tag}] 总键=${beforeKeys.length}，数字键=${nums.length}，迁移为字符串=${moved}，sample=`, afterSample);
    } catch (e) {
      W("normalizeRepoSlidesKeys error:", e);
    }
  }
  // Map 查找
    function getSlideByAny(id) {
    const sid = id == null ? null : String(id);
    if (!sid) return {
      slide: null,
      hit: "none"
    };
    if (repo.slides.has(sid)) return {
      slide: repo.slides.get(sid),
      hit: "string"
    };
    const cross = findSlideAcrossPresentations(sid);
    if (cross) {
      repo.slides.set(sid, cross);
      return {
        slide: cross,
        hit: "cross-fill"
      };
    }
    return {
      slide: null,
      hit: "miss"
    };
  }
  function getSlideImageUrl(slide) {
    if (!slide) return "";
    // Prefer original image fields, then fallback-compatible fields.
        return slide.coverAlt || slide.cover || slide.image || slide.thumbnail || "";
  }
  function getCurrentSlideId() {
    return repo.currentSlideId != null ? String(repo.currentSlideId) : null;
  }
  function isStudentLessonReportPage() {
    return /\/v2\/web\/student-lesson-report\//.test(window.location.pathname);
  }
  function extractCoverIndex(url) {
    try {
      const m = decodeURIComponent(url).match(/cover(\d+)[_.]/i);
      if (m) return parseInt(m[1], 10);
    } catch {}
    return null;
  }
  function getSlidesDocument() {
    if (document.querySelector("#content-page-wrap")) return document;
    for (let i = 0; i < window.frames.length; i++) try {
      const d = window.frames[i].document;
      if (d && d.querySelector("#content-page-wrap")) {
        log.dbg("[presentation][static-report] 在子 frame 中找到了 content-page-wrap");
        return d;
      }
    } catch (e) {}
    log.dbg("[presentation][static-report] 所有 frame 中都没有 content-page-wrap，退回顶层 document");
    return document;
  }
  function collectStaticSlideURLsFromDom() {
    const urls = new Set;
    const doc = getSlidesDocument();
    const candidates = doc.querySelectorAll("section.slides-list img, .slides-list img," + "div.slide-item img," + 'img[alt="cover"]');
    log.dbg("[presentation][static-report] DOM 候选 img 数量 =", candidates.length);
    candidates.forEach(img => {
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src) return;
      // 任意 *.yuketang.cn 子域的 /slide/<id>/ 图都算（此前写死 thu-private-qn，其他学校漏收）
            if (/\.yuketang\.cn\/slide\/\d+\//i.test(src) && /\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(src)) urls.add(src);
    });
    const arr = [ ...urls ];
    log.dbg("[presentation][static-report] DOM 收集到 slide URL：", arr);
    return arr;
  }
  function ensureStaticReportPresentation() {
    if (!isStudentLessonReportPage()) return false;
    const pid = `static:${window.location.pathname}`;
    // 如果已经注入过，就不再重复扫描 & 打印日志，直接返回 false
        if (staticReportReady && repo.presentations.has(pid)) return false;
    const urlsFromDom = collectStaticSlideURLsFromDom();
    const urls = Array.from(new Set([ ...urlsFromDom ]));
    if (!urls.length) {
      log.dbg("[presentation][static-report] 依然没有发现任何 slide URL");
      return false;
    }
    const withIndex = urls.map((u, i) => ({
      u: u,
      idx: extractCoverIndex(u) ?? i + 1
    }));
    withIndex.sort((a, b) => a.idx - b.idx);
    const slides = withIndex.map(({u: u, idx: idx}) => {
      const id = `static-${idx}`;
      return {
        id: id,
        index: idx,
        title: `第 ${idx} 页`,
        thumbnail: u,
        image: u,
        problem: null
      };
    });
    const titleFromPage = document.querySelector(".lesson-title, .title, h1, .header-title")?.textContent?.trim() || "静态课件（报告页）";
    const presentation = {
      id: pid,
      title: titleFromPage,
      slides: slides
    };
    const existed = repo.presentations.has(pid);
    repo.presentations.set(pid, presentation);
    let filled = 0;
    for (const s of slides) {
      const sid = String(s.id);
      if (!repo.slides.has(sid)) {
        repo.slides.set(sid, s);
        filled++;
      }
    }
    if (!repo.currentPresentationId) repo.currentPresentationId = pid;
    staticReportReady = true;
 // ★ 标记为已完成
        log.dbg("[presentation][static-report] 已注入/更新 presentation", {
      pid: pid,
      title: presentation.title,
      slideCount: slides.length,
      newSlidesFilled: filled,
      existed: existed,
      sample: slides.slice(0, 3).map(s => s.image)
    });
    return true;
  }
  function mountPresentationPanel() {
    if (mounted$5) return host;
    normalizeRepoSlidesKeys("presentation.mount");
    const wrapper = document.createElement("div");
    wrapper.innerHTML = tpl$5;
    document.body.appendChild(wrapper.firstElementChild);
    host = document.getElementById("ykt-presentation-panel");
    // 面板嵌在 shell 里——关闭=通知 shell 收起
        $$2("#ykt-presentation-close")?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("ykt:close-shell")));
    // 题目页筛选开关（原「题目列表」功能的替代：点一下只看题目页，再点恢复全部）
        const filterBtn = $$2("#ykt-filter-problems");
    const syncFilterBtn = () => filterBtn?.classList.toggle("active", !!ui.config.filterProblemsOnly);
    syncFilterBtn();
    filterBtn?.addEventListener("click", () => {
      ui.config.filterProblemsOnly = !ui.config.filterProblemsOnly;
      ui.saveConfig();
      syncFilterBtn();
      ui.toast(ui.config.filterProblemsOnly ? "只显示带题目的页面" : "显示全部页面", 1500);
      L("切换 filterProblemsOnly =", ui.config.filterProblemsOnly);
      updatePresentationList();
    });
    // 跟随当前页开关：开启时选中项自动跟随课堂翻页；手动点缩略图会脱离
        const followBtn = $$2("#ykt-follow-current");
    const syncFollowBtn = () => followBtn?.classList.toggle("active", followCurrent);
    syncFollowBtn();
    followBtn?.addEventListener("click", () => {
      followCurrent = !followCurrent;
      syncFollowBtn();
      ui.toast(followCurrent ? "已跟随课堂翻页" : "已脱离跟随（点「回到当前页」恢复）", 1500);
      if (followCurrent) {
        updateFollowHighlight();
        updateSlideView();
      }
    });
    // 课堂翻页时（Vue watcher）：跟随模式把 repo 当前页推进到老师展示的页，再联动高亮与大图
        waitForVueReady().then(() => {
      watchMainPageChange(slideId => {
        const sid = slideId == null ? null : String(slideId);
        L("课堂翻页事件", {
          slideId: sid,
          followCurrent: followCurrent
        });
        if (!sid) return;
        if (followCurrent) {
          repo.currentSlideId = sid;
          // 同步所属课件——跨课件翻页时右侧大图/选中态才不会指错课件
                    for (const [pid, pres] of repo.presentations) if ((pres?.slides || []).some(s => String(s.id) === sid)) {
            repo.currentPresentationId = String(pid);
            break;
          }
          updateFollowHighlight();
          updateSlideView();
        } else renderFollowBadge();
      });
    }).catch(e => W("Vue 初始化失败，跟随功能降级:", e));
    $$2("#ykt-download-pdf")?.addEventListener("click", downloadPresentationPDF);
    $$2("#ykt-import-history")?.addEventListener("click", openHistoryImporter);
    mounted$5 = true;
    L("mountPresentationPanel 完成");
    // shell 切到本 tab 时刷新列表（课件数据可能晚于挂载到达）
        host.__yksOnShow = () => updatePresentationList();
    // 收起/切走时中止进行中的整册导出（否则用户以为关了其实还在跑）
        host.__yksOnHide = () => {
      pdfAbortCtrl?.abort();
    };
    return host;
  }
  /** 跟随高亮：把 active 标到当前页缩略图上并滚动到可见 */  function updateFollowHighlight() {
    const listEl = document.getElementById("ykt-presentation-list");
    if (!listEl) return;
    const currentIdStr = getCurrentSlideId();
    if (!currentIdStr) return;
    let active = null;
    for (const t of listEl.querySelectorAll(".slide-thumb")) {
      const isActive = t.dataset.slideId === currentIdStr;
      t.classList.toggle("active", isActive);
      if (isActive) active = t;
    }
    active?.scrollIntoView({
      block: "nearest",
      behavior: "smooth"
    });
    L("跟随高亮", {
      currentIdStr: currentIdStr
    });
  }
  /** 面板顶部的小徽标：非跟随模式下提示当前课堂页码 */  function renderFollowBadge() {
    const btn = document.getElementById("ykt-follow-current");
    if (!btn) return;
    // 按钮文案由 CSS/结构固定，这里不做额外渲染（跟随状态在按钮 active 类上）
    }
  function updatePresentationList() {
    mountPresentationPanel();
    try {
      if (isStudentLessonReportPage()) ensureStaticReportPresentation();
    } catch (e) {
      W("[static-report] 检测/注入失败：", e);
    }
    if (!window.__ykt_static_dom_mo) {
      window.__ykt_static_dom_mo = true;
      let times = 0;
      const mo = new MutationObserver(() => {
        if (!isStudentLessonReportPage()) return;
        if (++times > 20) return;
        log.dbg("[presentation][static-report] DOM 变更，尝试重新收集 slide URL (times =", times, ")");
        const injected = ensureStaticReportPresentation();
        if (injected) {
          log.dbg("[presentation][static-report] DOM 中已找到 slide，停止监听并刷新面板");
          try {
            mo.disconnect();
          } catch (e) {}
          updatePresentationList();
        }
      });
      const rootSelector = "#content-page-wrap > div > aside > div.left-panel-scroll > div.left-panel-tab-content > div > section.slides-list";
      let target = document.querySelector(rootSelector) || document.querySelector("section.slides-list") || document.body;
      log.dbg("[presentation][static-report] MutationObserver 监听目标：", {
        useBody: target === document.body,
        hasSlidesList: target !== document.body
      });
      mo.observe(target, {
        childList: true,
        subtree: true
      });
    }
    const listEl = document.getElementById("ykt-presentation-list");
    if (!listEl) {
      W("updatePresentationList: 缺少容器");
      return;
    }
    listEl.innerHTML = "";
    if (repo.presentations.size === 0) {
      listEl.innerHTML = '<p class="no-presentations">暂无课件记录</p>';
      W("无 presentations");
      return;
    }
    // 课件按 presentation_id 收集、无法可靠归属到课堂——此前按 URL lessonId 过滤是无效逻辑（恒等于全量），删掉
        const presentationsToShow = repo.presentations;
    L("展示课件数量=", presentationsToShow.size);
    try {
      let filled = 0, total = 0;
      for (const [, pres] of presentationsToShow) {
        const arr = pres?.slides || [];
        total += arr.length;
        for (const s of arr) {
          const sid = String(s.id);
          if (!repo.slides.has(sid)) {
            repo.slides.set(sid, s);
            filled++;
          }
        }
      }
      const sample = Array.from(repo.slides.keys()).slice(0, 8);
      L("[hydrate slides → repo.slides]", {
        filled: filled,
        totalVisibleSlides: total,
        sampleKeys: sample
      });
    } catch (e) {
      W("hydrate repo.slides 失败：", e);
    }
    for (const [id, presentation] of presentationsToShow) {
      const cont = document.createElement("div");
      cont.className = "presentation-container";
      const titleEl = document.createElement("div");
      titleEl.className = "presentation-title";
      // 课件标题来自服务端——不用 innerHTML 注入
            const titleSpan = document.createElement("span");
      titleSpan.textContent = presentation.title || `课件 ${id}`;
      const dlIcon = document.createElement("i");
      dlIcon.className = "fas fa-download download-btn";
      dlIcon.title = "下载课件";
      titleEl.appendChild(titleSpan);
      titleEl.appendChild(dlIcon);
      cont.appendChild(titleEl);
      titleEl.querySelector(".download-btn")?.addEventListener("click", e => {
        e.stopPropagation();
        L("点击下载课件", {
          presId: String(presentation.id)
        });
        downloadPresentation(presentation);
      });
      const slidesWrap = document.createElement("div");
      slidesWrap.className = "slide-thumb-list";
      const slides = presentation.slides || [];
      const showProblemsOnly = !!ui.config.filterProblemsOnly;
      const slidesToShow = showProblemsOnly ? slides.filter(s => s.problem) : slides;
      const currentIdStr = repo.currentSlideId != null ? String(repo.currentSlideId) : null;
      L("渲染课件缩略图", {
        presId: String(presentation.id),
        slidesTotal: slides.length,
        slidesShown: slidesToShow.length,
        currentSlideId: currentIdStr
      });
      for (const s of slidesToShow) {
        const presIdStr = String(presentation.id);
        const slideIdStr = String(s.id);
        const thumb = document.createElement("div");
        thumb.className = "slide-thumb";
        thumb.dataset.slideId = slideIdStr;
        if (currentIdStr && slideIdStr === currentIdStr) thumb.classList.add("active");
        if (s.problem) {
          const pid = String(s.problem.problemId);
          const status = repo.problemStatus.get(pid);
          if (status) thumb.classList.add("unlocked");
          if (s.problem.result) thumb.classList.add("answered");
        }
        thumb.addEventListener("click", () => {
          // 用户手动选择 → 脱离跟随模式
          if (followCurrent) {
            followCurrent = false;
            document.getElementById("ykt-follow-current")?.classList.remove("active");
          }
          repo.currentPresentationId = presIdStr;
          repo.currentSlideId = slideIdStr;
          slidesWrap.querySelectorAll(".slide-thumb.active").forEach(el => el.classList.remove("active"));
          thumb.classList.add("active");
          updateSlideView();
          if (!repo.slides.has(slideIdStr)) {
            const cross = findSlideAcrossPresentations(slideIdStr);
            if (cross) {
              repo.slides.set(slideIdStr, cross);
              L("click-fill repo.slides <- cross", {
                slideIdStr: slideIdStr
              });
            }
          }
          const detail = {
            slideId: slideIdStr,
            presentationId: presIdStr
          };
          window.dispatchEvent(new CustomEvent("ykt:presentation:slide-selected", {
            detail: detail
          }));
          actions.navigateTo(presIdStr, slideIdStr);
        });
        const img = document.createElement("img");
        if (presentation.width && presentation.height) img.style.aspectRatio = `${presentation.width}/${presentation.height}`;
        img.src = s.thumbnail || "";
        img.alt = s.title || `第 ${s.page ?? ""} 页`;
        img.onerror = function() {
          W("缩略图加载失败，移除该项", {
            slideIdStr: slideIdStr,
            src: img.src
          });
          if (thumb.parentNode) thumb.parentNode.removeChild(thumb);
        };
        const idx = document.createElement("span");
        idx.className = "slide-index";
        idx.textContent = s.index ?? "";
        thumb.appendChild(img);
        thumb.appendChild(idx);
        slidesWrap.appendChild(thumb);
      }
      cont.appendChild(slidesWrap);
      listEl.appendChild(cont);
    }
  }
  function downloadPresentation(presentation) {
    repo.currentPresentationId = String(presentation.id);
    L("downloadPresentation -> 设置 currentPresentationId", repo.currentPresentationId);
    downloadPresentationPDF();
  }
  function updateSlideView() {
    mountPresentationPanel();
    const slideView = $$2("#ykt-slide-view");
    const problemView = $$2("#ykt-problem-view");
    slideView.querySelector(".slide-cover")?.classList.add("hidden");
    problemView.innerHTML = "";
    const curId = getCurrentSlideId();
    const lookup = getSlideByAny(curId);
    L("updateSlideView", {
      curId: curId,
      lookupHit: lookup.hit,
      hasInMap: !!lookup.slide
    });
    if (!curId || !lookup.slide) {
      // 无选中页（或 slide 数据未到达）：重建空态，避免残留上一次渲染的封面图
      if (!curId) W("updateSlideView: 无当前页"); else W("updateSlideView: 根据 curId 未取到 slide", {
        curId: curId
      });
      slideView.innerHTML = "";
      const emptyCover = document.createElement("div");
      emptyCover.className = "slide-cover";
      const em = document.createElement("div");
      em.className = "empty-message";
      em.textContent = "选择左侧的幻灯片查看详情";
      emptyCover.appendChild(em);
      slideView.appendChild(emptyCover);
      slideView.appendChild(problemView);
      return;
    }
    const slide = lookup.slide;
    const cover = document.createElement("div");
    cover.className = "slide-cover";
    const img = document.createElement("img");
    // 不要设 crossOrigin=anonymous：OSS 无 CORS 头时图片直接拒绝加载；
    // 展示场景不需要读像素，污染问题只在 PDF 导出时由 GM_xhr 绕开
        img.src = getSlideImageUrl(slide);
    img.alt = slide.title || "";
    cover.appendChild(img);
    if (slide.problem) {
      const prob = slide.problem;
      const box = document.createElement("div");
      box.className = "problem-box";
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "problem-box-close";
      closeBtn.title = "关闭题干浮框";
      closeBtn.setAttribute("aria-label", "关闭题干浮框");
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", ev => {
        ev.stopPropagation();
        box.remove();
      });
      box.appendChild(closeBtn);
      const head = document.createElement("div");
      head.className = "problem-head";
      head.textContent = prob.body || `题目 ${prob.problemId}`;
      box.appendChild(head);
      if (Array.isArray(prob.options) && prob.options.length) {
        const opts = document.createElement("div");
        opts.className = "problem-options";
        prob.options.forEach(o => {
          const li = document.createElement("div");
          li.className = "problem-option";
          li.textContent = `${o.key}. ${o.value}`;
          opts.appendChild(li);
        });
        box.appendChild(opts);
      }
      problemView.appendChild(box);
    }
    slideView.innerHTML = "";
    slideView.appendChild(cover);
    slideView.appendChild(problemView);
  }
  /** 历史课件导入：列出该班级全部课堂 → 多选 → 逐个自动收集导出 PDF */  async function openHistoryImporter() {
    // 防重复：已有浮层先关掉（多次点击会叠加）
    [ ...document.querySelectorAll("div") ].filter(d => d.style?.cssText?.includes("rgba(0,0,0,.45)") && (d.innerText || "").includes("历史课堂")).forEach(d => d.remove());
    const classId = currentClassId();
    if (!classId) return ui.toast("请先进入课程的「学习日志」页（含班级 ID），再使用历史课件导入");
    ui.toast("正在获取课堂列表…");
    let activities;
    try {
      activities = await fetchClassActivities(classId);
    } catch (e) {
      return ui.toast("获取课堂列表失败：" + (e?.message || e));
    }
    // 排除正在进行中的课堂（is_finished=false）：数据不完整且导出无意义
        const ongoing = activities.filter(a => a.is_finished === false);
    activities = activities.filter(a => a.is_finished !== false);
    if (ongoing.length) ui.toast(`已排除 ${ongoing.length} 个进行中的课堂`, 2500);
    if (!activities.length) return ui.toast(ongoing.length ? "该班级只有进行中的课堂，暂无可导入" : "该班级没有可导入的课堂");
    // 构建多选浮层
        const mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999999;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#fff;border-radius:10px;max-width:520px;max-height:70vh;overflow:auto;padding:16px 20px;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.25);";
    box.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:10px">📥 选择要导入的历史课堂（可多选）</div>`;
    const chosen = new Set;
    const rowEls = [];
    // 选中态高亮：选中行加背景+边框色（解决选中/未选中看不出区别）
        const paintRow = row => {
      const cb = row.querySelector("input");
      row.style.background = cb.checked ? "#eff6ff" : "#fff";
      row.style.borderColor = cb.checked ? "#1d63df" : "#e5e7eb";
    };
    for (const a of activities) {
      const d = new Date(a.create_time || 0);
      const t = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const row = document.createElement("label");
      row.style.cssText = "padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#fff;";
      // 课堂标题来自服务端——不用 innerHTML 注入
            const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.id = a.id;
      cb.style.cssText = "flex:0 0 auto;width:16px;height:16px;accent-color:#1d63df;cursor:pointer";
      const titleSpan = document.createElement("span");
      titleSpan.style.flex = "1";
      titleSpan.textContent = a.title || "未命名课堂";
      const timeSpan = document.createElement("span");
      timeSpan.style.cssText = "color:#607190;white-space:nowrap";
      timeSpan.textContent = `${t}${a.attend_status ? " ✅" : ""}`;
      row.appendChild(cb);
      row.appendChild(titleSpan);
      row.appendChild(timeSpan);
      cb.addEventListener("change", () => {
        if (cb.checked) chosen.add(a); else chosen.delete(a);
        paintRow(row);
        downloadBtn.textContent = chosen.size ? `⬇️ 下载选中 (${chosen.size})` : "⬇️ 下载选中";
        downloadBtn.style.opacity = chosen.size ? "1" : ".5";
      });
      rowEls.push(row);
      box.appendChild(row);
    }
    // 全选/清空
        const selectBar = document.createElement("div");
    selectBar.style.cssText = "display:flex;gap:8px;margin:6px 0;";
    const mkSel = (text, all) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "flex:1;padding:5px;border:1px solid #e5e7eb;border-radius:6px;background:#f7f8fa;cursor:pointer;font-size:12px;";
      b.addEventListener("click", () => {
        chosen.clear();
        for (const row of rowEls) {
          const cb = row.querySelector("input");
          cb.checked = all;
          if (all) {
            const a = activities.find(x => String(x.id) === cb.dataset.id);
            if (a) chosen.add(a);
          }
          paintRow(row);
        }
        downloadBtn.textContent = chosen.size ? `⬇️ 下载选中 (${chosen.size})` : "⬇️ 下载选中";
        downloadBtn.style.opacity = chosen.size ? "1" : ".5";
      });
      return b;
    };
    selectBar.appendChild(mkSel("全选", true));
    selectBar.appendChild(mkSel("清空", false));
    box.appendChild(selectBar);
    // 下载按钮
        const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "⬇️ 下载选中";
    downloadBtn.style.cssText = "width:100%;padding:9px;border:none;border-radius:8px;background:#1d63df;color:#fff;font-size:14px;font-weight:600;cursor:pointer;opacity:.5;";
    downloadBtn.addEventListener("click", async () => {
      const list = [ ...chosen ];
      if (!list.length) return ui.toast("请先勾选要下载的课堂", 2e3);
      mask.remove();
      const bar = showImportProgressBar(`批量 ${list.length} 个课堂`);
      const okList = [], failList = [];
      for (let i = 0; i < list.length; i++) {
        if (bar.cancelled) {
          failList.push("（用户取消，剩余未导入）");
          break;
        }
        const a = list[i];
        bar.update(Math.round(i / list.length * 100), `(${i + 1}/${list.length}) ${a.title || "未命名课堂"} · 打开收集页…`);
        try {
          const r = await importHistoryLesson(classId, a, {
            onProgress: p => {
              if (p.phase === "error") {
                bar.update(Math.round((i + .9) / list.length * 100), `(${i + 1}/${list.length}) ${p.text || "失败"}`);
                return;
              }
              // 混合进度：前 i 个已完成 + 当前课件的 pct
                            const overall = Math.round((i + (p.pct || 0) / 100) / list.length * 100);
              const bits = [];
              if (p.skipped) bits.push(`去重 ${p.skipped}`);
              if (p.failed) bits.push(`失败 ${p.failed}`);
              bar.update(overall, `(${i + 1}/${list.length}) ${p.text || ""}${bits.length ? ` · ${bits.join("，")}` : ""}`);
            }
          });
          if (r?.ok) {
            okList.push(r.title || a.title || "未命名");
            const warnBit = r.expectedTotal && r.total < r.expectedTotal ? ` ⚠️仅${r.total}/${r.expectedTotal}页` : "";
            ui.toast(`✅「${r.title || a.title}」完成：${r.pages} 页${r.skipped ? `（去重 ${r.skipped}）` : ""}${warnBit}`, 2500);
          } else failList.push(`${a.title || "未命名"}：${r?.error || "未知错误"}`);
        } catch (e) {
          failList.push(`${a.title || "未命名"}：${e?.message || e}`);
        }
      }
      // 汇总（失败明细必须可见——否则部分失败被静默吞掉）
            const summary = [ `完成 ${okList.length} 个，失败 ${failList.length} 个` ];
      if (failList.length) {
        summary.push(`失败明细：${failList.join("；")}`);
        log.warn("[History] 批量导入失败明细:", failList);
      }
      if (failList.length) bar.fail(summary.join("  ").slice(0, 400)); else bar.done(`✅ 批量导入完成：${summary[0]}`);
      ui.toast(summary[0], 4e3);
    });
    box.appendChild(downloadBtn);
    const closeBtn = document.createElement("div");
    closeBtn.textContent = "取消";
    closeBtn.style.cssText = "text-align:center;color:#607190;cursor:pointer;padding:8px 0 2px;";
    closeBtn.addEventListener("click", () => mask.remove());
    box.appendChild(closeBtn);
    mask.appendChild(box);
    document.body.appendChild(mask);
  }
  /** 全局导入进度条（固定左下角工具栏上方，独立于面板生命周期） */  function showImportProgressBar(title) {
    document.getElementById("ykt-import-progress")?.remove();
    const bar = document.createElement("div");
    bar.id = "ykt-import-progress";
    bar.style.cssText = "position:fixed;left:15px;bottom:60px;z-index:99999998;background:#fff;border:1px solid #c7d2fe;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:10px 14px;width:340px;font-size:13px;";
    bar.innerHTML = `\n    <div style="font-weight:600;margin-bottom:6px;color:#1d63df;display:flex;justify-content:space-between;align-items:center">\n      <span>📥 正在导入「${title}」</span>\n      <span class="ip-close" title="取消" style="cursor:pointer;color:#c0392b;font-size:14px;padding:0 2px">✕</span>\n    </div>\n    <div style="display:flex;align-items:center;gap:8px">\n      <div style="flex:1;height:8px;background:#dbeafe;border-radius:4px;overflow:hidden">\n        <div class="ip-fill" style="height:100%;width:0%;background:#1d63df;border-radius:4px;transition:width .3s"></div>\n      </div>\n      <span class="ip-pct" style="min-width:36px;text-align:right;color:#607190">0%</span>\n    </div>\n    <div class="ip-text" style="margin-top:5px;color:#607190;font-size:12px">正在打开收集页…</div>`;
    document.body.appendChild(bar);
    const api = {
      cancelled: false,
      update(pct, text) {
        const f = bar.querySelector(".ip-fill");
        if (f) f.style.width = `${pct}%`;
        const p = bar.querySelector(".ip-pct");
        if (p) p.textContent = `${pct}%`;
        const t = bar.querySelector(".ip-text");
        if (t) t.textContent = text;
      },
      done(text) {
        const f = bar.querySelector(".ip-fill");
        if (f) f.style.width = "100%";
        const t = bar.querySelector(".ip-text");
        if (t) {
          t.textContent = text;
          t.style.color = "#059669";
        }
        setTimeout(() => bar.remove(), 3e4);
      },
      fail(text) {
        // 失败结果保留 30s——用户切回来还能看到失败痕迹与原因
        const t = bar.querySelector(".ip-text");
        if (t) {
          t.textContent = "❌ " + text;
          t.style.color = "#c0392b";
        }
        setTimeout(() => bar.remove(), 3e4);
      }
    };
    bar.querySelector(".ip-close")?.addEventListener("click", () => {
      api.cancelled = true;
      api.update(0, "正在取消…（当前课堂会跑完本次等待）");
    });
    return api;
  }
  let pdfAbortCtrl = null;
 // 进行中的整册导出（取消按钮/关面板时中止）
    async function downloadPresentationPDF() {
    let pid = repo.currentPresentationId != null ? String(repo.currentPresentationId) : null;
    // 回退：用户没点过缩略图/课件标题时，自动选用列表里的课件（通常只有一份），
    // 而不是让他「请先选择」再点一次——37 页都收好了却导不出，纯属多一步
        if (!pid || !repo.presentations.has(pid)) {
      const first = repo.presentations.entries().next();
      if (first.done) return ui.toast("当前没有可导出的课件（等课件加载后重试）");
      pid = first.value[0];
      repo.currentPresentationId = pid;
      L("downloadPresentationPDF: 自动回退到课件", {
        pid: pid
      });
    }
    const pres = repo.presentations.get(pid);
    if (!pres || !Array.isArray(pres.slides) || pres.slides.length === 0) return ui.toast("未找到该课件的页面");
    // 整册导出：不受「只看题目页」筛选影响（筛选只作用于浏览列表）
        const slides = pres.slides;
    if (slides.length === 0) return ui.toast("该课件没有页面");
    // 进度条元素
        const progressEl = document.getElementById("ykt-pdf-progress");
    const progressFill = document.getElementById("ykt-pdf-progress-fill");
    const progressText = document.getElementById("ykt-pdf-progress-text");
    const cancelBtn = document.getElementById("ykt-pdf-cancel");
    const showProgress = (pct, text) => {
      if (progressEl) progressEl.style.display = "flex";
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (progressText) progressText.textContent = text || `${pct}%`;
    };
    const hideProgress = () => {
      if (progressEl) progressEl.style.display = "none";
    };
    // 整册导出委托公共 pdf-export：并发下载、GM_xhr 绕 CORS、内容级去重
        const urls = slides.map(getSlideImageUrl).filter(Boolean);
    if (!urls.length) return ui.toast("该课件没有可用页面图片");
    // 取消支持：✕ 按钮 + 关面板（__yksOnHide）都中止导出
        pdfAbortCtrl = new AbortController;
    const onCancel = () => {
      pdfAbortCtrl?.abort();
    };
    cancelBtn?.addEventListener("click", onCancel, {
      once: true
    });
    // 停滞看门狗：45s 没有任何进度回调 → 提示可能卡死（用户不再面对无声定格）
        let lastProgressAt = Date.now();
    const stallTimer = setInterval(() => {
      const stall = Math.round((Date.now() - lastProgressAt) / 1e3);
      if (stall > 45 && progressText) progressText.textContent = `已停滞 ${stall}s（可能在解码大图或网络挂起，可点 ✕ 取消）`;
    }, 5e3);
    try {
      const {pages: pages, skipped: skipped, failed: failed} = await exportImagesToPdf(urls, pres.title || `课件-${pid}`, {
        dedupHash: true,
        signal: pdfAbortCtrl.signal,
        onProgress: info => {
          lastProgressAt = Date.now();
          showProgress(info.pct ?? 0, info.text || `${info.pct ?? 0}%`);
        }
      });
      const bits = [ `${pages} 页` ];
      if (skipped) bits.push(`去重 ${skipped}`);
      if (failed) bits.push(`失败 ${failed}`);
      ui.toast(`PDF 生成完成（${bits.join("，")}）`, 2500);
    } catch (e) {
      if (pdfAbortCtrl.signal.aborted) ui.toast("已取消导出", 2e3); else ui.toast(`导出 PDF 失败：${e?.message || e}`, 5e3);
    } finally {
      clearInterval(stallTimer);
      cancelBtn?.removeEventListener("click", onCancel);
      pdfAbortCtrl = null;
      setTimeout(hideProgress, 1500);
    }
  }
  var tpl$4 = '<div id="ykt-active-problems-panel" class="ykt-active-wrapper">\n  <div id="ykt-active-problems" class="active-problems"></div>\n</div>\n';
  let mounted$4 = false;
  let root$4;
  function $$1(sel) {
    return document.querySelector(sel);
  }
  function mountActiveProblemsPanel() {
    if (mounted$4) return root$4;
    const wrap = document.createElement("div");
    wrap.innerHTML = tpl$4;
    document.body.appendChild(wrap.firstElementChild);
    root$4 = document.getElementById("ykt-active-problems-panel");
    mounted$4 = true;
    setInterval(() => updateActiveProblems(), 1e3);
    return root$4;
  }
  function updateActiveProblems() {
    mountActiveProblemsPanel();
    const box = $$1("#ykt-active-problems");
    // 没有任何状态时直接跳过 DOM 重建（每秒重扫问题集，空转不值得）
        if (repo.problemStatus.size === 0) {
      if (root$4.style.display !== "none") {
        box.innerHTML = "";
        root$4.style.display = "none";
      }
      return;
    }
    const now = Date.now();
    const items = [];
    repo.problemStatus.forEach((status, pid) => {
      const p = repo.problems.get(String(pid));
      if (!p || p.result) return;
      // endTime 可能是 null（不限时）或基于服务端时钟（clockOffset 修正）
            const hasDeadline = Number.isFinite(status.endTime);
      const remain = hasDeadline ? Math.max(0, Math.floor((status.endTime - (now + (status.clockOffset || 0))) / 1e3)) : null;
      if (hasDeadline && remain <= 0) {
        log.dbg(`[雨课堂助手][INFO][ActiveProblems] 题目 ${pid} 倒计时已结束，移除卡片`);
        return;
      }
      items.push({
        status: status,
        pid: pid,
        p: p,
        remain: remain,
        hasDeadline: hasDeadline
      });
    });
    if (!items.length) {
      if (root$4.style.display !== "none") {
        box.innerHTML = "";
        root$4.style.display = "none";
      }
      return;
    }
    box.innerHTML = "";
    for (const {status: status, pid: pid, p: p, remain: remain, hasDeadline: hasDeadline} of items) {
      const card = document.createElement("div");
      card.className = "active-problem-card";
      const title = document.createElement("div");
      title.className = "ap-title";
      title.textContent = (p.body || `题目 ${pid}`).slice(0, 80);
      card.appendChild(title);
      const info = document.createElement("div");
      info.className = "ap-info";
      info.textContent = hasDeadline ? `剩余 ${remain}s` : "进行中（不限时）";
      card.appendChild(info);
      const bar = document.createElement("div");
      bar.className = "ap-actions";
      const go = document.createElement("button");
      go.textContent = "查看";
      go.onclick = () => actions.navigateTo(status.presentationId, status.slideId);
      bar.appendChild(go);
      const ai = document.createElement("button");
      ai.textContent = "AI 解答";
      ai.onclick = () => window.dispatchEvent(new CustomEvent("ykt:open-ai"));
      bar.appendChild(ai);
      card.appendChild(bar);
      box.appendChild(card);
    }
    root$4.style.display = "";
  }
  var tpl$3 = '<div id="ykt-shell-panel" class="ykt-panel ykt-shell">\n  <style>\n    #ykt-shell-panel { display: none; flex-direction: column;\n      width: min(760px, calc(100vw - 48px));       /* 窄窗口不溢出 */\n      height: min(78vh, calc(100vh - 140px));      /* 留出工具栏与边距 */\n      max-height: calc(100vh - 120px);\n      padding: 0; }\n    #ykt-shell-panel.visible { display: flex; }\n    .ykt-shell-header { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--ykt-border, #ddd); }\n    .ykt-shell-header .shell-title { font-weight: 600; font-size: 14px; color: var(--ykt-accent, #1d63df); flex: 1; }\n    .ykt-shell-header .shell-close { cursor: pointer; color: #607190; padding: 2px 6px; }\n    .ykt-shell-header .shell-close:hover { color: #222; }\n    .ykt-shell-body { flex: 1; display: flex; min-height: 0; }\n    .ykt-shell-tabs { width: 118px; border-right: 1px solid var(--ykt-border, #ddd); padding: 8px 6px; display: flex; flex-direction: column; gap: 2px; background: #f7f9fc; }\n    .ykt-shell-tab { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 8px; cursor: pointer; color: #44506b; font-size: 13px; user-select: none; }\n    .ykt-shell-tab:hover { background: #eaeffa; }\n    .ykt-shell-tab.active { background: var(--ykt-accent, #1d63df); color: #fff; }\n    .ykt-shell-tab i { width: 16px; text-align: center; }\n    /* 窄屏（手机/Mac 分屏）：侧栏转顶部图标条，内容区占满宽度 */\n    @media (max-width: 560px) {\n      .ykt-shell-body { flex-direction: column; }\n      .ykt-shell-tabs { width: 100%; flex-direction: row; border-right: none; border-bottom: 1px solid var(--ykt-border, #ddd); padding: 6px; gap: 4px; overflow-x: auto; }\n      .ykt-shell-tab { flex: 1 0 auto; flex-direction: column; gap: 3px; padding: 6px 8px; font-size: 11px; justify-content: center; }\n      .ykt-shell-tab i { width: auto; font-size: 15px; }\n      .ykt-shell-tab span { white-space: nowrap; }\n      #ykt-shell-panel { width: calc(100vw - 16px); height: calc(100vh - 120px); }\n      .ykt-shell-header { padding: 8px 10px; }\n    }\n    .ykt-shell-content { flex: 1; overflow: hidden; position: relative; display: flex; }\n    /* 迁移进来的原面板：从 fixed 弹窗变为 tab 内容。\n       display 交给面板自身规则（chat 需 flex，其余 block），shell 只负责： */\n    #ykt-shell-content > .ykt-panel {\n      position: static !important;\n      width: 100% !important; max-height: none !important; height: 100% !important;\n      border: none !important; box-shadow: none !important; border-radius: 0 !important;\n      overflow: hidden;               /* 滚动交给内部区域，避免双层滚动条 */\n    }\n    /* 对话类面板：log 区在 shell 内撑满可用高度，消除底部空白 */\n    #ykt-shell-content #ykt-chat-log,\n    #ykt-shell-content #ykt-ai-log { flex: 1 1 auto; max-height: none; min-height: 120px; }\n    #ykt-shell-content #ykt-chat-panel .panel-body,\n    #ykt-shell-content #ykt-ai-answer-panel .panel-body { flex: 1; min-height: 0; }\n    /* 课件面板在 shell 内填满：两列各自滚动，不再受独立弹窗的 72vh 限制 */\n    #ykt-shell-content #ykt-presentation-panel .panel-body { height: 100%; grid-template-columns: minmax(220px, 300px) 1fr; }\n    #ykt-shell-content #ykt-presentation-panel .panel-left,\n    #ykt-shell-content #ykt-presentation-panel .panel-right { max-height: none; height: 100%; overflow: auto; position: static; }\n    #ykt-shell-content #ykt-presentation-panel .slide-view { max-height: none; height: auto; min-height: 240px; }\n    /* 设置面板在 shell 内整体滚动 */\n    #ykt-shell-content #ykt-settings-panel { overflow: auto; }\n    /* 窄屏（手机）：课件面板单列堆叠、工具栏按钮换行、输入区自适应 */\n    @media (max-width: 560px) {\n      #ykt-shell-content #ykt-presentation-panel .panel-body { grid-template-columns: 1fr; height: auto; }\n      #ykt-shell-content #ykt-presentation-panel .panel-left,\n      #ykt-shell-content #ykt-presentation-panel .panel-right { height: auto; max-height: none; }\n      #ykt-presentation-panel .panel-controls { flex-wrap: wrap; gap: 6px; }\n      #ykt-presentation-panel .panel-header { flex-wrap: wrap; }\n      .ykt-chat-inputbar, .ykt-ai-inputbar { flex-wrap: nowrap; }\n      #ykt-chat-input, #ykt-ai-input { min-width: 0; }\n      #ykt-chat-send, #ykt-ai-send { padding: 7px 10px; }\n      /* 触控目标放大到 ≥40px（移动端可点性） */\n      .close-btn, #ykt-chat-plus { min-width: 40px; min-height: 40px; display: inline-flex; align-items: center; justify-content: center; }\n      #ykt-chat-clear, #ykt-ai-clear { min-height: 36px; }\n      .ykt-shell-tab { min-height: 44px; }\n    }\n    /* 非当前 tab 的面板无条件隐藏（压过面板自身 ID 样式） */\n    #ykt-shell-content > .ykt-panel:not(.active-tab) { display: none !important; }\n  </style>\n  <div class="ykt-shell-header">\n    <span class="shell-title"><i class="fas fa-briefcase"></i> YuketangStudio</span>\n    <span class="shell-close" id="ykt-shell-close"><i class="fas fa-times"></i></span>\n  </div>\n  <div class="ykt-shell-body">\n    <div class="ykt-shell-tabs" id="ykt-shell-tabs"></div>\n    <div class="ykt-shell-content" id="ykt-shell-content"></div>\n  </div>\n</div>\n';
  var tpl$2 = '<div id="ykt-chat-panel" class="ykt-panel">\n  <style>\n    #ykt-chat-panel { display: none; flex-direction: column; }\n    #ykt-chat-panel.visible { display: flex; }\n    #ykt-chat-panel .panel-header { display: flex; align-items: center; gap: 8px; }\n    #ykt-chat-panel .panel-header h3 { margin: 0; flex: 1; }\n    #ykt-chat-log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; min-height: 240px; max-height: 52vh; }\n    .ykt-chat-msg { max-width: 92%; border-radius: 10px; padding: 8px 10px; font-size: 13px; line-height: 1.55; }\n    .ykt-chat-msg.user { align-self: flex-end; background: #1d63df; color: #fff; border-bottom-right-radius: 2px; }\n    .ykt-chat-msg.user img { max-width: 220px; max-height: 130px; border-radius: 6px; display: block; margin-top: 6px; }\n    .ykt-chat-msg.ai { align-self: flex-start; background: #f2f4f8; color: var(--ykt-fg, #222); border-bottom-left-radius: 2px; }\n    .ykt-chat-msg.ai p { margin: 0 0 6px; }\n    .ykt-chat-msg.ai p:last-child { margin-bottom: 0; }\n    .ykt-chat-msg.ai details { margin-bottom: 6px; }\n    .ykt-chat-msg.ai summary { cursor: pointer; color: #607190; font-size: 12px; user-select: none; }\n    .ykt-chat-msg.ai .reasoning-body { color: #607190; font-size: 12px; white-space: pre-wrap; border-left: 3px solid #d8dee9; padding-left: 8px; margin: 4px 0; max-height: 160px; overflow-y: auto; }\n    #ykt-chat-ctx { padding: 4px 10px; font-size: 12px; color: #607190; display: flex; align-items: center; gap: 8px; }\n    #ykt-chat-ctx img { height: 34px; border-radius: 4px; border: 1px solid #ddd; }\n    .ykt-chat-inputbar { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--ykt-border, #ddd); align-items: flex-end; }\n    #ykt-chat-input { flex: 1; resize: none; font-size: 13px; padding: 6px 8px; border: 1px solid var(--ykt-border-strong, #ccc); border-radius: 6px; font-family: inherit; }\n    #ykt-chat-input:focus { outline: none; border-color: var(--ykt-accent, #1d63df); }\n    #ykt-chat-send { padding: 7px 14px; border: none; border-radius: 6px; background: var(--ykt-accent, #1d63df); color: #fff; cursor: pointer; }\n    #ykt-chat-send:disabled { opacity: .5; cursor: not-allowed; }\n    #ykt-chat-clear { padding: 3px 8px; font-size: 12px; }\n    #ykt-chat-plus { width: 30px; height: 30px; border: 1px dashed var(--ykt-border-strong, #ccc); border-radius: 6px; background: #f7f8fa; cursor: pointer; font-size: 16px; color: #607190; flex: 0 0 auto; }\n    #ykt-chat-plus:hover { border-color: var(--ykt-accent, #1d63df); color: var(--ykt-accent, #1d63df); }\n    /* 附件预览条 */\n    #ykt-chat-atts { display: none; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--ykt-border, #ddd); }\n    #ykt-chat-atts .att { position: relative; width: 56px; height: 42px; border-radius: 4px; overflow: hidden; border: 1px solid #ddd; }\n    #ykt-chat-atts .att img { width: 100%; height: 100%; object-fit: cover; display: block; }\n    #ykt-chat-atts .att .rm { position: absolute; top: 0; right: 0; width: 16px; height: 16px; line-height: 14px; text-align: center; background: rgba(0,0,0,.6); color: #fff; cursor: pointer; font-size: 11px; border-radius: 0 0 0 4px; }\n    /* 加号菜单 */\n    #ykt-chat-plus-menu { position: fixed; z-index: 10000001; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); padding: 6px; display: none; flex-direction: column; min-width: 160px; }\n    #ykt-chat-plus-menu button { border: none; background: transparent; text-align: left; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }\n    #ykt-chat-plus-menu button:hover { background: #eef3ff; }\n    .ykt-chat-msg .muted { color: #607190; font-size: 12px; }\n    .ykt-chat-msg.user .ykt-chat-warn { margin-top: 6px; font-size: 12px; background: rgba(255,255,255,.18); border-radius: 4px; padding: 3px 6px; }\n  </style>\n  <div class="panel-header">\n    <h3>💬 PPT 对话</h3>\n    <button id="ykt-chat-clear">清空会话</button>\n    <span class="close-btn" id="ykt-chat-close"><i class="fas fa-times"></i></span>\n  </div>\n  <div class="panel-body" style="display:flex;flex-direction:column;padding:0;">\n    <div id="ykt-chat-log"></div>\n    <div id="ykt-chat-atts"></div>\n    <div id="ykt-chat-ctx"><label><input type="checkbox" id="ykt-chat-attach" checked> 每条消息附带当前 PPT 页</label><span id="ykt-chat-ctx-thumb"></span></div>\n    <div class="ykt-chat-inputbar">\n      <button id="ykt-chat-plus" title="添加 PPT 页面或图片">＋</button>\n      <textarea id="ykt-chat-input" rows="2" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>\n      <button id="ykt-chat-send">发送</button>\n    </div>\n    <input type="file" id="ykt-chat-file" accept="image/*" multiple style="display:none">\n    <div id="ykt-chat-plus-menu">\n      <button id="ykt-chat-plus-slides">📑 选择 PPT 页面</button>\n      <button id="ykt-chat-plus-upload">🖼 上传图片</button>\n    </div>\n  </div>\n</div>\n';
  // src/ui/panels/chat.js
  // PPT 多轮对话面板：截取/读取当前 PPT 页 + 连续追问，思考链折叠显示，流式输出
    let mounted$3 = false;
  let root$3;
  let history = [];
 // OpenAI 格式消息
    let streaming = false;
 // 防并发发送
    let abortCtrl = null;
  const systemPrompt = () => String(ui?.config?.systemPromptChat || "").trim() || DEFAULT_SYSTEM_PROMPT_CHAT;
  function $sel(sel) {
    return root$3.querySelector(sel);
  }
  function mountChatPanel() {
    if (mounted$3) return root$3;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = tpl$2;
    document.body.appendChild(wrapper.firstElementChild);
    root$3 = document.getElementById("ykt-chat-panel");
    // 面板嵌在 shell 里——关闭=通知 shell 收起（__yksOnHide 会中止流式）
        $sel("#ykt-chat-close").addEventListener("click", () => window.dispatchEvent(new CustomEvent("ykt:close-shell")));
    $sel("#ykt-chat-clear").addEventListener("click", () => {
      abortStreaming("清空会话");
      history = [];
      renderHistory();
      addBubble("ai", mdToHtml("会话已清空。可以重新开始提问（如需新 PPT 上下文，直接发送即可）。"));
    });
    const $input = $sel("#ykt-chat-input");
    const $send = $sel("#ykt-chat-send");
    $send.addEventListener("click", () => sendCurrent());
    $input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendCurrent();
      }
    });
    // ── 加号菜单：选 PPT 页面 / 上传图片 ──
        const $plus = $sel("#ykt-chat-plus");
    const $menu = $sel("#ykt-chat-plus-menu");
    const $file = $sel("#ykt-chat-file");
    const hideMenu = () => {
      if ($menu) $menu.style.display = "none";
    };
    $plus?.addEventListener("click", e => {
      e.stopPropagation();
      if (!$menu) return;
      const on = $menu.style.display === "flex";
      $menu.style.display = on ? "none" : "flex";
      if (!on) {
        const r = $plus.getBoundingClientRect();
        $menu.style.left = `${r.left}px`;
        $menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
        $menu.style.top = "auto";
      }
    });
    document.addEventListener("click", e => {
      if ($menu && !$menu.contains(e.target) && e.target !== $plus) hideMenu();
    });
    $sel("#ykt-chat-plus-upload")?.addEventListener("click", () => {
      hideMenu();
      $file?.click();
    });
    $file?.addEventListener("change", e => {
      for (const f of e.target.files || []) {
        const reader = new FileReader;
        reader.onload = () => {
          addAttachment(reader.result);
        };
        reader.readAsDataURL(f);
      }
      $file.value = "";
    });
    $sel("#ykt-chat-plus-slides")?.addEventListener("click", () => {
      hideMenu();
      openSlidePicker();
    });
    // shell 生命周期钩子：切到本 tab 刷新上下文缩略图，切走/关闭时中止流式
        root$3.__yksOnShow = () => {
      refreshCtxThumb();
    };
    root$3.__yksOnHide = () => abortStreaming("面板已隐藏");
    warmupRichAssets();
    mounted$3 = true;
    return root$3;
  }
  // ---------------- 当前 PPT 页获取（共享模块 slide-image.js） ----------------
    async function refreshCtxThumb() {
    const span = $sel("#ykt-chat-ctx-thumb");
    span.textContent = "⏳";
    const {dataUrl: dataUrl, source: source, reason: reason} = await resolveCurrentSlideImage();
    if (dataUrl) {
      span.innerHTML = "";
      const img = document.createElement("img");
      img.src = dataUrl;
      img.title = source === "repo" ? "当前 PPT 页（来自课件数据）" : "当前 PPT 页（来自页面）";
      span.appendChild(img);
    } else span.textContent = `（未取到 PPT：${reason || "未知原因"}）`;
  }
  // ---------------- 渲染 ----------------
    function addBubble(kind, htmlOrNode) {
    const $log = $sel("#ykt-chat-log");
    const div = document.createElement("div");
    div.className = `ykt-chat-msg ${kind}`;
    if (typeof htmlOrNode === "string") div.innerHTML = htmlOrNode; else div.appendChild(htmlOrNode);
    $log.appendChild(div);
    $log.scrollTop = $log.scrollHeight;
    return div;
  }
  function renderHistory() {
    const $log = $sel("#ykt-chat-log");
    $log.innerHTML = "";
    for (const m of history) {
      if (m.role === "system") continue;
      const text = (Array.isArray(m.content) ? m.content : []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const imgs = (Array.isArray(m.content) ? m.content : []).filter(c => c.type === "image_url").map(c => c.image_url.url);
      const div = document.createElement("div");
      div.className = `ykt-chat-msg ${m.role === "user" ? "user" : "ai"}`;
      if (m.role === "user") {
        div.textContent = text || "（图片）";
        for (const src of imgs) {
          const img = document.createElement("img");
          img.src = src;
          div.appendChild(img);
        }
      } else div.innerHTML = mdToHtml(text);
      $log.appendChild(div);
    }
    $log.scrollTop = $log.scrollHeight;
  }
  /** 把历史中除最近 N 张外的图片替换为占位符，控制 token */  function trimOldImages(keep = 1) {
    const imgMsgs = [];
    for (const m of history) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      const imgIdx = m.content.map((c, i) => c.type === "image_url" ? i : -1).filter(i => i >= 0);
      if (imgIdx.length) imgMsgs.push({
        m: m,
        imgIdx: imgIdx
      });
    }
    for (const {m: m, imgIdx: imgIdx} of imgMsgs.slice(0, Math.max(0, imgMsgs.length - keep))) for (const i of imgIdx) m.content[i] = {
      type: "text",
      text: "[此前的 PPT 页图片已省略]"
    };
  }
  // ---------------- 发送 ----------------
  /** 中止正在进行的流式请求（清空会话 / 关闭面板 / 发送新消息时调用） */  function abortStreaming(reason = "已取消") {
    if (abortCtrl) try {
      abortCtrl.abort(reason);
    } catch {/* 旧浏览器不支持带参 abort */}
  }
  // ---------------- 附件（手动添加的 PPT 页 / 上传图片） ----------------
    let attachments = [];
 // dataURL 列表
    function addAttachment(dataUrl) {
    if (!dataUrl) return;
    attachments.push(dataUrl);
    renderAttachments();
  }
  function removeAttachment(i) {
    attachments.splice(i, 1);
    renderAttachments();
  }
  function renderAttachments() {
    const box = $sel("#ykt-chat-atts");
    if (!box) return;
    box.innerHTML = "";
    box.style.display = attachments.length ? "flex" : "none";
    attachments.forEach((src, i) => {
      const d = document.createElement("div");
      d.className = "att";
      const img = document.createElement("img");
      img.src = src;
      const rm = document.createElement("span");
      rm.className = "rm";
      rm.textContent = "×";
      rm.title = "移除";
      rm.addEventListener("click", () => removeAttachment(i));
      d.appendChild(img);
      d.appendChild(rm);
      box.appendChild(d);
    });
  }
  /** PPT 页面多选浮层：从所有已收集课件里挑页，确认后加入附件 */  function openSlidePicker() {
    const slides = [];
    for (const [, pres] of repo.presentations) for (const s of pres?.slides || []) {
      const url = slideImageUrl(s);
      if (url) slides.push({
        slide: s,
        url: url,
        presTitle: pres.title || ""
      });
    }
    if (!slides.length) return ui.toast?.("暂无可选的 PPT 页面（先在课堂里翻页收集）", 2500);
    const mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999999;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#fff;border-radius:10px;max-width:640px;max-height:76vh;overflow:auto;padding:14px 16px;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.25);";
    box.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px">📑 选择 PPT 页面（点击多选）</div>`;
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;";
    const picked = new Set;
    for (const {slide: slide, url: url} of slides) {
      const cell = document.createElement("div");
      cell.style.cssText = "border:2px solid #e5e7eb;border-radius:6px;overflow:hidden;cursor:pointer;position:relative;";
      const img = document.createElement("img");
      img.src = url;
      img.style.cssText = "width:100%;height:80px;object-fit:cover;display:block;";
      const idx = document.createElement("span");
      idx.textContent = slide.index ?? "";
      idx.style.cssText = "position:absolute;top:2px;left:2px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:1px 5px;border-radius:3px;";
      cell.appendChild(img);
      cell.appendChild(idx);
      cell.addEventListener("click", () => {
        if (picked.has(cell)) {
          picked.delete(cell);
          cell.style.borderColor = "#e5e7eb";
        } else {
          picked.add(cell);
          cell.style.borderColor = "#1d63df";
        }
        confirmBtn.textContent = picked.size ? `✓ 添加 ${picked.size} 张` : "✓ 添加";
      });
      grid.appendChild(cell);
      cell.__url = url;
    }
    box.appendChild(grid);
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "✓ 添加";
    confirmBtn.style.cssText = "width:100%;margin-top:10px;padding:8px;border:none;border-radius:8px;background:#1d63df;color:#fff;font-weight:600;cursor:pointer;";
    confirmBtn.addEventListener("click", async () => {
      mask.remove();
      const cells = [ ...grid.children ].filter(c => picked.has(c));
      ui.toast?.(`正在获取 ${cells.length} 张页面图片…`, 2e3);
      for (const c of cells) try {
        const dataUrl = await fetchAsDataURL(c.__url);
        if (dataUrl) addAttachment(dataUrl);
      } catch (e) {
        log.warn("[Chat] 附件图片获取失败:", e?.message);
      }
      ui.toast?.("已加入附件，发送时一并传给 AI", 2e3);
    });
    box.appendChild(confirmBtn);
    const cancel = document.createElement("div");
    cancel.textContent = "取消";
    cancel.style.cssText = "text-align:center;color:#607190;cursor:pointer;padding:8px 0 2px;";
    cancel.addEventListener("click", () => mask.remove());
    box.appendChild(cancel);
    mask.appendChild(box);
    document.body.appendChild(mask);
  }
  async function sendCurrent() {
    if (streaming) return;
    const $input = $sel("#ykt-chat-input");
    const text = $input.value.trim();
    if (!text) {
      ui.toast?.("先输入问题");
      return;
    }
    const attach = $sel("#ykt-chat-attach")?.checked;
    streaming = true;
    $sel("#ykt-chat-send").disabled = true;
    try {
      const content = [ {
        type: "text",
        text: text
      } ];
      let attachFailed = "";
      if (attach) {
        const pending = addBubble("user", "⏳ 正在获取当前 PPT…");
        const {dataUrl: dataUrl, reason: reason} = await resolveCurrentSlideImage();
        pending.remove();
        if (dataUrl) content.push({
          type: "image_url",
          image_url: {
            url: dataUrl
          }
        }); else 
        // 明确告知用户本条没有附图，而不是静默降级
        attachFailed = reason || "未取到当前 PPT 页";
      }
      // 手动附件（加号添加的 PPT 页 / 上传图片）
            for (const att of attachments) content.push({
        type: "image_url",
        image_url: {
          url: att
        }
      });
      history.push({
        role: "user",
        content: content
      });
      trimOldImages(1);
      const userBubble = addBubble("user", escapeHtml(text));
      // 把附带的 PPT 截图也画进气泡（AI 实际收到了，之前只显示文本）
            for (const c of content) if (c.type === "image_url") {
        const img = document.createElement("img");
        img.src = c.image_url.url;
        img.alt = "当前 PPT 页";
        userBubble.appendChild(img);
      }
      if (attachFailed) {
        const warn = document.createElement("div");
        warn.className = "ykt-chat-warn";
        warn.textContent = `⚠️ ${attachFailed}——本条为纯文本提问`;
        userBubble.appendChild(warn);
      }
      $input.value = "";
      attachments = [];
 // 附件随消息发出，清空待下次添加
            renderAttachments();
      // AI 气泡（流式）
            const aiBubble = addBubble("ai", "<em>思考中…</em>");
      const acc = {
        content: "",
        reasoning: ""
      };
      let raf = 0;
      let phase = "waiting";
 // waiting → thinking → answering
            const paint = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          // 阶段推进：thinking = 有思考无正文；answering = 正文开始
                    if (phase !== "answering" && acc.content) phase = "answering"; else if (phase === "waiting" && acc.reasoning) phase = "thinking";
          const thinking = phase === "thinking";
          // 思考阶段自动展开流式滚动；正文开始自动折叠展示正文
                    aiBubble.innerHTML = (acc.reasoning ? `<details ${thinking ? "open" : ""}><summary>💭 思考过程${thinking ? "（进行中…）" : "（点击展开）"}</summary><div class="reasoning-body"></div></details>` : "") + (acc.content ? mdToHtml(acc.content) : thinking ? "" : "<em>…</em>");
          const rBody = aiBubble.querySelector(".reasoning-body");
          if (rBody) {
            rBody.textContent = acc.reasoning;
            rBody.scrollTop = rBody.scrollHeight;
          }
          const $log = $sel("#ykt-chat-log");
          $log.scrollTop = $log.scrollHeight;
        });
      };
      abortCtrl = new AbortController;
      const res = await agnesChat({
        messages: [ {
          role: "system",
          content: systemPrompt()
        }, ...history ],
        stream: true,
        thinking: true,
        signal: abortCtrl.signal,
        // 与 AI 解答面板一致：走当前激活的 AI Profile，而不是只吃开发者模式配置
        override: getOverride() || void 0,
        onDelta: d => {
          acc.content += d;
          paint();
        },
        onReasoning: d => {
          acc.reasoning += d;
          paint();
        }
      });
      acc.content = res.content || acc.content;
      acc.reasoning = res.reasoning || acc.reasoning;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
 // 防止挂起的 paint 覆盖 renderRich 成果
            aiBubble.innerHTML = (acc.reasoning ? `<details><summary>💭 思考过程（点击展开）</summary><div class="reasoning-body">${escapeHtml(acc.reasoning)}</div></details>` : "") + (acc.content ? mdToHtml(acc.content) : '<span class="err">（空回复）</span>');
      renderRich(aiBubble);
      history.push({
        role: "assistant",
        content: acc.content || "（无内容）"
      });
    } catch (e) {
      const emsg = String(e?.message || "");
      const isTimeout = /timeout|超时/i.test(emsg);
      const aborted = e?.name === "AbortError" && !isTimeout || /abort|cancel/i.test(emsg);
      if (aborted) addBubble("ai", '<span class="muted">（已取消）</span>'); else addBubble("ai", `<span class="err">出错了：${escapeHtml(e?.message || String(e))}</span><br/><small>提示：到设置里检查 API 配置是否正确。</small>`);
    } finally {
      streaming = false;
      abortCtrl = null;
      $sel("#ykt-chat-send").disabled = false;
      $sel("#ykt-chat-log").scrollTop = $sel("#ykt-chat-log").scrollHeight;
    }
  }
  var tpl$1 = '<div id="ykt-settings-panel" class="ykt-panel">\n  <div class="panel-header">\n    <h3>YuketangStudio 设置</h3>\n    <div class="setting-actions">\n        <button id="ykt-btn-settings-save">保存设置</button>\n        <button id="ykt-btn-settings-reset" color="red">重置为默认</button>\n    </div>\n    <span class="close-btn" id="ykt-settings-close"><i class="fas fa-times"></i></span>\n  </div>\n\n  <div class="panel-body">\n    <div class="settings-content">\n      <div class="setting-group">\n      <h4>AI配置</h4>\n\n        \x3c!-- 当前 profile 选择 --\x3e\n        <div class="setting-item">\n          <label for="ykt-ai-profile-select">当前配置：</label>\n          <select id="ykt-ai-profile-select"></select>\n          <button id="ykt-ai-profile-add">新增配置</button>\n          <button id="ykt-ai-profile-del" color="red">删除当前</button>\n        </div>\n\n        \x3c!-- 预设模板 --\x3e\n        <div class="setting-item">\n          <label for="ykt-ai-preset-select">快速预设：</label>\n          <select id="ykt-ai-preset-select">\n            <option value="">-- 选择预设模板 --</option>\n            <option value="longcat-flash">LongCat Flash (通用对话)</option>\n            <option value="longcat-omni">LongCat Omni (多模态) [测试中]</option>\n            <option value="longcat-thinking">LongCat Thinking (深度思考)</option>\n            <option value="kimi">Kimi (Moonshot)</option>\n            <option value="openai">OpenAI GPT-4o</option>\n            <option value="deepseek">DeepSeek</option>\n          </select>\n          <small>选择预设后自动填充配置，仍需手动输入 API Key</small>\n        </div>\n\n        \x3c!-- 具体配置字段：针对当前 profile --\x3e\n        <div class="setting-item">\n          <label for="ykt-ai-profile-name">名称:</label>\n          <input type="text" id="ykt-ai-profile-name" placeholder="例如：Kimi 8k / OpenAI GPT-4o">\n        </div>\n\n        <div class="setting-item">\n          <label for="ykt-ai-base-url">URL:</label>\n          <input type="text" id="ykt-ai-base-url" placeholder="https://api.moonshot.cn/...">\n          <small>兼容 OpenAI 协议的服务端，例如 api.openai.com / api.moonshot.cn / 自建代理。</small>\n        </div>\n\n        <div class="setting-item">\n          <label for="kimi-api-key">API Key:</label>\n          <input type="password" id="kimi-api-key" placeholder="输入当前配置的 API Key">\n        </div>\n\n        <div class="setting-item">\n          <label for="ykt-ai-model">文本模型 ID:</label>\n          <input type="text" id="ykt-ai-model" placeholder="例如：moonshot-v1-8k / gpt-4o-mini">\n        </div>\n\n        <div class="setting-item">\n          <label for="ykt-ai-vision-model">图像模型 ID:</label>\n          <input type="text" id="ykt-ai-vision-model" placeholder="默认不填则与文本模型相同">\n        </div>\n      </div>\n\n      <div class="setting-group">\n        <h4>UI设置</h4>\n          <div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-ui-tex">\n            <span class="checkmark"></span>\n            渲染LaTeX格式的公式\n          </label>\n        </div>\n      </div>\n\n      <div class="setting-group">\n        <h4>自动作答设置</h4>\n        <div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-input-auto-join">\n            <span class="checkmark"></span>\n            自动进入课堂\n          </label>\n          <small>默认自动进入“正在上课”的课堂。</small>\n        </div>\n        <div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-input-auto-join-auto-answer">\n            <span class="checkmark"></span>\n            对于自动进入的课堂，默认使用自动答题\n          </label>\n          <small>仅对“自动进入”的课堂生效，不会影响手动进入课堂的行为。</small>\n        </div>\n        <div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-input-auto-answer">\n            <span class="checkmark"></span>\n            启用自动作答\n          </label>\n        </div>\n        <div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-input-fallback-answer">\n            <span class="checkmark"></span>\n            无 API Key 时提交兜底答案\n          </label>\n          <small>危险：未配置 AI 时自动作答会提交占位答案（选择题为 A）。默认关闭，宁缺答不误答。</small>\n        </div>\n        <div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-input-ai-auto-analyze">\n            <span class="checkmark"></span>\n            打开 AI 页面时自动分析\n          </label>\n          <small>开启后，进入“AI 解答”面板即自动向 AI 询问当前题目</small>\n        </div>\n        <div class="setting-item">\n          <label for="ykt-input-answer-delay">作答延迟时间 (秒):</label>\n          <input type="number" id="ykt-input-answer-delay" min="1" max="60">\n          <small>题目出现后等待多长时间开始作答</small>\n        </div>\n        <div class="setting-item">\n          <label for="ykt-input-random-delay">随机延迟范围 (秒):</label>\n          <input type="number" id="ykt-input-random-delay" min="0" max="30">\n          <small>在基础延迟基础上随机增加的时间范围</small>\n        </div><div class="setting-item">\n          <label class="checkbox-label">\n            <input type="checkbox" id="ykt-ai-pick-main-first">\n            <span class="checkmark"></span>\n            主界面优先（未勾选则课件浏览优先）\n          </label>\n          <small>仅在普通打开 AI 面板（ykt:open-ai）时生效；从“提问当前PPT”跳转保持最高优先。</small>\n        </div>\n      </div>\n\n      <div class="setting-group">\n        <h4>习题提醒</h4>\n        <div class="setting-item">\n          <label for="ykt-input-notify-duration">弹窗持续时间 (秒):</label>\n          <input type="number" id="ykt-input-notify-duration" min="2" max="60" />\n          <small>习题出现时，弹窗在屏幕上的停留时长</small>\n        </div>\n        <div class="setting-item">\n          <label for="ykt-input-notify-volume">提醒音量 (0-100):</label>\n          <input type="number" id="ykt-input-notify-volume" min="0" max="100" />\n          <small>用于提示音的音量大小；建议 30~80</small>\n        </div>\n        <div class="setting-item">\n          <button id="ykt-btn-test-notify">测试习题提醒</button>\n        </div>\n        <div class="setting-item">\n          <label>自定义提示音（其一即可）</label>\n          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">\n            <input type="file" id="ykt-input-notify-audio-file" accept="audio/*" />\n            <input type="text" id="ykt-input-notify-audio-url" placeholder="或粘贴在线音频 URL（http/https/data:）" style="min-width:260px"/>\n            <button id="ykt-btn-apply-audio-url">应用URL</button>\n            <button id="ykt-btn-preview-audio">预览</button>\n            <button id="ykt-btn-clear-audio">清除自定义音频</button>\n          </div>\n          <small id="ykt-tip-audio-name" style="display:block;opacity:.8;margin-top:6px"></small>\n          <small>说明：文件将本地存储为 data URL（默认上限 2MB）。URL 需支持跨域访问；若被浏览器拦截自动播放，请先点击“预览”以授权音频播放。</small>\n        </div>\n      </div>\n\n      <div class="setting-group">\n        <h4>提示词设置</h4>\n        <div class="setting-item" style="flex-direction:column;align-items:stretch">\n          <label>PPT对话提示词（鼓励生动形象与可视化）：</label>\n          <textarea id="ykt-prompt-chat" rows="6" style="font-size:12px;line-height:1.5;border:1px solid var(--ykt-border-strong);border-radius:6px;padding:6px;font-family:inherit;"></textarea>\n          <button id="ykt-prompt-chat-reset" style="align-self:flex-start;margin-top:4px">恢复默认</button>\n        </div>\n        <div class="setting-item" style="flex-direction:column;align-items:stretch">\n          <label>AI解答提示词（优先快速、准确给答案）：</label>\n          <textarea id="ykt-prompt-ai" rows="6" style="font-size:12px;line-height:1.5;border:1px solid var(--ykt-border-strong);border-radius:6px;padding:6px;font-family:inherit;"></textarea>\n          <button id="ykt-prompt-ai-reset" style="align-self:flex-start;margin-top:4px">恢复默认</button>\n        </div>\n        <small>留空 = 使用内置默认提示词；修改后自动保存并立即生效（下一次对话使用）。</small>\n      </div>\n\n      <div class="setting-group">\n        <div class="setting-item" style="display:flex;align-items:center;gap:8px">\n          <input type="password" id="ykt-devmode-pass" placeholder="解锁码" style="width:120px">\n          <button id="ykt-devmode-btn" style="padding:3px 10px">解锁</button>\n          <small id="ykt-devmode-hint" style="opacity:.55"></small>\n        </div>\n      </div>\n    </div>\n  </div>\n</div>\n';
  // settings.js (new version)
    let mounted$2 = false;
  let root$2;
  // ---- AI Profile helpers ----
  // 预设模板只填 baseUrl/model，API Key 一律留空由用户自己填。
  // （上游曾在此硬编码作者自己的 key，已清除——不要把任何真实 key 提交进仓库）
    const AI_PRESETS = {
    "longcat-flash": {
      name: "LongCat Flash",
      baseUrl: "https://api.longcat.chat/openai",
      model: "LongCat-Flash-Chat",
      visionModel: "LongCat-Flash-Omni-2603"
    },
    "longcat-omni": {
      name: "LongCat Omni",
      baseUrl: "https://api.longcat.chat/openai",
      model: "LongCat-Flash-Omni-2603",
      visionModel: "LongCat-Flash-Omni-2603"
    },
    "longcat-thinking": {
      name: "LongCat Thinking",
      baseUrl: "https://api.longcat.chat/openai",
      model: "LongCat-Flash-Thinking-2601",
      visionModel: "LongCat-Flash-Thinking-2601"
    },
    kimi: {
      name: "Kimi",
      baseUrl: "https://api.moonshot.cn",
      model: "moonshot-v1-8k",
      visionModel: "moonshot-v1-8k-vision-preview"
    },
    openai: {
      name: "OpenAI GPT-4o",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o-mini",
      visionModel: "gpt-4o"
    },
    deepseek: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      visionModel: "deepseek-chat"
    }
  };
  function ensureAIProfiles(configAI) {
    if (!configAI) return;
    // 只有 kimiApiKey 时创建第一个 profile
        if (!Array.isArray(configAI.profiles) || configAI.profiles.length === 0) {
      const legacyKey = configAI.kimiApiKey || configAI.apiKey || storage.get("kimiApiKey") || "";
      configAI.profiles = [ {
        id: "default",
        name: "Kimi",
        baseUrl: "https://api.moonshot.cn/v1/chat/completions",
        apiKey: legacyKey,
        model: "moonshot-v1-8k",
        visionModel: "moonshot-v1-8k-vision-preview"
      } ];
      configAI.activeProfileId = "default";
    }
    if (!configAI.activeProfileId) configAI.activeProfileId = configAI.profiles[0].id;
  }
  // ------------------------------
    function mountSettingsPanel() {
    if (mounted$2) return root$2;
    // 注入 HTML
        root$2 = document.createElement("div");
    root$2.innerHTML = tpl$1;
    document.body.appendChild(root$2.firstElementChild);
    root$2 = document.getElementById("ykt-settings-panel");
    const aiCfg = ui.config.ai || (ui.config.ai = {});
    ensureAIProfiles(aiCfg);
    // === 获取所有 AI Profile 相关的 DOM ===
        const $profileSelect = root$2.querySelector("#ykt-ai-profile-select");
    const $profileAdd = root$2.querySelector("#ykt-ai-profile-add");
    const $profileDel = root$2.querySelector("#ykt-ai-profile-del");
    const $presetSelect = root$2.querySelector("#ykt-ai-preset-select");
    const $profileName = root$2.querySelector("#ykt-ai-profile-name");
    const $baseUrl = root$2.querySelector("#ykt-ai-base-url");
    const $api = root$2.querySelector("#kimi-api-key");
    const $model = root$2.querySelector("#ykt-ai-model");
    const $visionModel = root$2.querySelector("#ykt-ai-vision-model");
    // === 其他 UI 原有字段 ===
        const $auto = root$2.querySelector("#ykt-input-auto-answer");
    const $fallbackAns = root$2.querySelector("#ykt-input-fallback-answer");
    const $autoJoin = root$2.querySelector("#ykt-input-auto-join");
    const $autoJoinAutoAnswer = root$2.querySelector("#ykt-input-auto-join-auto-answer");
    const $autoAnalyze = root$2.querySelector("#ykt-input-ai-auto-analyze");
    const $delay = root$2.querySelector("#ykt-input-answer-delay");
    const $rand = root$2.querySelector("#ykt-input-random-delay");
    const $priority = root$2.querySelector("#ykt-ai-pick-main-first");
    const $notifyDur = root$2.querySelector("#ykt-input-notify-duration");
    const $notifyVol = root$2.querySelector("#ykt-input-notify-volume");
    const $iftex = root$2.querySelector("#ykt-ui-tex");
    const $audioFile = root$2.querySelector("#ykt-input-notify-audio-file");
    const $audioUrl = root$2.querySelector("#ykt-input-notify-audio-url");
    const $applyUrl = root$2.querySelector("#ykt-btn-apply-audio-url");
    const $preview = root$2.querySelector("#ykt-btn-preview-audio");
    const $clear = root$2.querySelector("#ykt-btn-clear-audio");
    const $audioName = root$2.querySelector("#ykt-tip-audio-name");
    // Profile UI
        function refreshProfileSelect() {
      const ai = ui.config.ai;
      $profileSelect.innerHTML = "";
      ai.profiles.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        if (p.id === ai.activeProfileId) opt.selected = true;
        $profileSelect.appendChild(opt);
      });
    }
    function loadProfileToForm(profileId) {
      const p = ui.config.ai.profiles.find(x => x.id === profileId);
      if (!p) return;
      ui.config.ai.activeProfileId = p.id;
      $profileName.value = p.name || "";
      $baseUrl.value = p.baseUrl || "";
      $api.value = p.apiKey || "";
      $model.value = p.model || "";
      $visionModel.value = p.visionModel || "";
    }
    // 初始化 Profile 下拉框
        refreshProfileSelect();
    loadProfileToForm(ui.config.ai.activeProfileId);
    // === 提示词设置（空 = 内置默认；可编辑可恢复） ===
        const $promptChat = root$2.querySelector("#ykt-prompt-chat");
    const $promptAI = root$2.querySelector("#ykt-prompt-ai");
    const fillPrompts = () => {
      if ($promptChat) $promptChat.value = String(ui.config.systemPromptChat ?? "").trim() || DEFAULT_SYSTEM_PROMPT_CHAT;
      if ($promptAI) $promptAI.value = String(ui.config.systemPromptAI ?? "").trim() || DEFAULT_SYSTEM_PROMPT_AI;
    };
    const savePrompts = () => {
      if ($promptChat) ui.config.systemPromptChat = $promptChat.value.trim() === DEFAULT_SYSTEM_PROMPT_CHAT.trim() ? "" : $promptChat.value;
      if ($promptAI) ui.config.systemPromptAI = $promptAI.value.trim() === DEFAULT_SYSTEM_PROMPT_AI.trim() ? "" : $promptAI.value;
      ui.saveConfig();
    };
    // 编辑即暂存（blur 由通用自动保存覆盖不了 textarea value 判空逻辑，这里显式处理）
        $promptChat?.addEventListener("change", savePrompts);
    $promptAI?.addEventListener("change", savePrompts);
    // 恢复默认 = 直接填入默认值并落盘（空串 → 运行时走内置常量）
        root$2.querySelector("#ykt-prompt-chat-reset")?.addEventListener("click", () => {
      ui.config.systemPromptChat = "";
      ui.saveConfig();
      if ($promptChat) $promptChat.value = DEFAULT_SYSTEM_PROMPT_CHAT;
      ui.toast("PPT对话提示词已恢复默认", 2e3);
    });
    root$2.querySelector("#ykt-prompt-ai-reset")?.addEventListener("click", () => {
      ui.config.systemPromptAI = "";
      ui.saveConfig();
      if ($promptAI) $promptAI.value = DEFAULT_SYSTEM_PROMPT_AI;
      ui.toast("AI解答提示词已恢复默认", 2e3);
    });
    // 初始填充（后续切 tab 由 syncFormFromConfig 统一刷新）
        fillPrompts();
    // === 解锁入口（低调：仅一行，位于设置最底部） ===
        const DEV_PROFILE_ID = "agnes-dev";
    const $devPass = root$2.querySelector("#ykt-devmode-pass");
    const $devBtn = root$2.querySelector("#ykt-devmode-btn");
    const $devHint = root$2.querySelector("#ykt-devmode-hint");
    function refreshDevHint() {
      const cfg = getDevConfig();
      if (cfg) {
        $devPass.placeholder = "已解锁";
        $devHint.textContent = "";
        $devBtn.textContent = "已解锁";
        $devBtn.disabled = true;
      } else {
        $devPass.placeholder = "解锁码";
        $devHint.textContent = "";
        $devBtn.textContent = "解锁";
        $devBtn.disabled = false;
      }
    }
    function applyDevProfile(devCfg) {
      const ai = ui.config.ai;
      ensureAIProfiles(ai);
      let p = ai.profiles.find(x => x.id === DEV_PROFILE_ID);
      if (!p) {
        p = {
          id: DEV_PROFILE_ID
        };
        ai.profiles.push(p);
      }
      Object.assign(p, {
        name: devCfg.name || "Agnes Dev",
        baseUrl: devCfg.baseUrl,
        apiKey: devCfg.apiKey,
        model: devCfg.model,
        visionModel: devCfg.visionModel || devCfg.model
      });
      if (devCfg.reasoningEffort) p.reasoningEffort = devCfg.reasoningEffort;
      ai.activeProfileId = DEV_PROFILE_ID;
      ui.saveConfig();
      syncFormFromConfig();
 // 解锁后表单立即显示新配置（此前要重开页面才刷新）
        }
    $devBtn?.addEventListener("click", async () => {
      const pass = ($devPass?.value || "").trim();
      if (!pass) {
        ui.toast?.("请输入解锁码");
        return;
      }
      $devBtn.disabled = true;
      const originalText = $devBtn.textContent;
      $devBtn.textContent = "校验中…";
 // 310k 迭代约 1~2 秒，给个反馈
            try {
        const devCfg = await unlockDevMode(pass);
        applyDevProfile(devCfg);
        $devPass.value = "";
        refreshDevHint();
        ui.toast?.(`解锁成功：${devCfg.name || "内置配置"} 已启用`);
      } catch (e) {
        ui.toast?.("解锁失败：" + (e?.message || e));
        $devBtn.textContent = originalText;
      } finally {
        refreshDevHint();
      }
    });
    $devPass?.addEventListener("keydown", e => {
      if (e.key === "Enter") $devBtn?.click();
    });
    refreshDevHint();
    // 切换 profile
        $profileSelect.addEventListener("change", () => {
      loadProfileToForm($profileSelect.value);
    });
    // 预设选择
        $presetSelect.addEventListener("change", () => {
      const presetKey = $presetSelect.value;
      if (!presetKey) return;
      const preset = AI_PRESETS[presetKey];
      if (!preset) return;
      $profileName.value = preset.name;
      $baseUrl.value = preset.baseUrl;
      $model.value = preset.model;
      $visionModel.value = preset.visionModel;
      if (preset.apiKey) {
        $api.value = preset.apiKey;
        ui.toast(`已应用预设: ${preset.name}，API Key 已自动填充`, 3e3);
      } else ui.toast(`已应用预设: ${preset.name}，请填写 API Key`, 3e3);
      $presetSelect.value = "";
      scheduleAutoSave();
 // 预设也走自动保存
        });
    // 添加 profile
        $profileAdd.addEventListener("click", () => {
      const id = `p_${Date.now().toString(36)}`;
      const newP = {
        id: id,
        name: "新配置",
        baseUrl: "",
        // 留空让用户填——写死半成品 URL 容易原样保存出 404
        apiKey: "",
        model: "",
        visionModel: ""
      };
      ui.config.ai.profiles.push(newP);
      ui.config.ai.activeProfileId = id;
      refreshProfileSelect();
      loadProfileToForm(id);
    });
    // 删除 profile
        $profileDel.addEventListener("click", () => {
      const ai = ui.config.ai;
      if (ai.profiles.length <= 1) {
        ui.toast("至少保留一个配置", 2500);
        return;
      }
      const id = ai.activeProfileId;
      ai.profiles = ai.profiles.filter(p => p.id !== id);
      ai.activeProfileId = ai.profiles[0].id;
      refreshProfileSelect();
      loadProfileToForm(ai.activeProfileId);
    });
    // 初始化表单（后续所有刷新统一走 syncFormFromConfig）
        syncFormFromConfig();
    // 保存按钮
        root$2.querySelector("#ykt-btn-settings-save").addEventListener("click", () => commitForm());
    // ===== 表单 → config 的唯一写入路径（保存按钮与自动保存共用，避免两套逻辑漂移） =====
        function commitForm({silent: silent = false} = {}) {
      const ai = ui.config.ai;
      const pid = ai.activeProfileId;
      const p = ai.profiles.find(x => x.id === pid);
      if (p) {
        p.name = $profileName.value.trim() || p.name;
        p.baseUrl = $baseUrl.value.trim() || p.baseUrl;
        p.apiKey = $api.value.trim();
        p.model = $model.value.trim() || p.model;
        p.visionModel = $visionModel.value.trim() || p.visionModel;
        const curOpt = $profileSelect.querySelector(`option[value="${p.id}"]`);
        if (curOpt) curOpt.textContent = p.name || p.id;
      }
      if (p) {
        ai.kimiApiKey = p.apiKey;
 // 兼容旧字段
                storage.set("kimiApiKey", p.apiKey);
      }
      ui.config.autoJoinEnabled = !!$autoJoin.checked;
      ui.config.autoAnswerOnAutoJoin = !!$autoJoinAutoAnswer.checked;
      ui.config.autoAnswer = !!$auto.checked;
      ui.config.autoAnswerFallbackDefault = !!$fallbackAns?.checked;
      ui.config.aiAutoAnalyze = !!$autoAnalyze.checked;
      ui.config.autoAnswerDelay = Math.max(1e3, (+$delay.value || 0) * 1e3);
      ui.config.autoAnswerRandomDelay = Math.max(0, (+$rand.value || 0) * 1e3);
      ui.config.iftex = !!$iftex.checked;
      ui.config.aiSlidePickPriority = !!$priority.checked;
      ui.config.notifyPopupDuration = Math.max(2e3, (+$notifyDur.value || 0) * 1e3);
      ui.config.notifyVolume = Math.max(0, Math.min(1, (+$notifyVol.value || 60) / 100));
      ui.saveConfig();
      ui.updateAutoAnswerBtn();
      if (!silent) ui.toast("设置已保存");
      return p;
    }
    // 自动保存：失焦/变更即落盘（此前必须先点"保存设置"，关掉面板改动就丢）
    // 用 blur（捕获阶段）而非每次 input，避免边打字边写存储
        let autoSaveTimer = 0;
    const scheduleAutoSave = () => {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        try {
          commitForm({
            silent: true
          });
        } catch (e) {
          log.warn("[Settings] 自动保存失败", e);
        }
      }, 300);
    };
    const AUTO_SAVE_SELECTOR = 'input[type="text"], input[type="password"], input[type="number"], textarea, select, input[type="checkbox"]';
    root$2.addEventListener("change", e => {
      if (e.target?.matches?.(AUTO_SAVE_SELECTOR) && e.target.closest(".settings-content")) scheduleAutoSave();
    });
    root$2.addEventListener("focusout", e => {
      if (e.target?.matches?.('input[type="text"], input[type="password"], input[type="number"], textarea') && e.target.closest(".settings-content")) scheduleAutoSave();
    });
    /** 从 config 反向刷新所有表单（解锁开发者模式、切 tab、重置后调用） */    function syncFormFromConfig() {
      ensureAIProfiles(ui.config.ai);
      refreshProfileSelect();
      loadProfileToForm(ui.config.ai.activeProfileId);
      $autoJoin.checked = !!ui.config.autoJoinEnabled;
      $autoJoinAutoAnswer.checked = !!ui.config.autoAnswerOnAutoJoin;
      $auto.checked = !!ui.config.autoAnswer;
      if ($fallbackAns) $fallbackAns.checked = !!ui.config.autoAnswerFallbackDefault;
      $autoAnalyze.checked = !!ui.config.aiAutoAnalyze;
      $iftex.checked = !!ui.config.iftex;
      $delay.value = Math.floor((ui.config.autoAnswerDelay || 3e3) / 1e3);
      $rand.value = Math.floor((ui.config.autoAnswerRandomDelay || 1500) / 1e3);
      $priority.checked = ui.config.aiSlidePickPriority !== false;
      $notifyDur.value = Math.floor((ui.config.notifyPopupDuration || 5e3) / 1e3);
      $notifyVol.value = Math.round(100 * (ui.config.notifyVolume ?? .6));
      $audioName.textContent = ui.config.customNotifyAudioName ? `当前：${ui.config.customNotifyAudioName}` : "当前：使用内置“叮-咚”提示音";
      fillPrompts();
    }
    // 暴露给面板外部（shell 切换 tab 时重新同步，避免显示陈旧值）
        root$2.__yksOnShow = syncFormFromConfig;
 // shell 切 tab 时刷新表单
    //--------------------------------------
    //            重置为默认
    //--------------------------------------
        root$2.querySelector("#ykt-btn-settings-reset").addEventListener("click", () => {
      if (!confirm("确定要重置为默认设置吗？")) return;
      Object.assign(ui.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
      ensureAIProfiles(ui.config.ai);
      syncFormFromConfig();
      storage.set("kimiApiKey", "");
      ui.saveConfig();
      ui.updateAutoAnswerBtn();
      ui.toast("设置已重置");
    });
    // 音频设置
        const MAX_SIZE = 2 * 1024 * 1024;
    if ($audioFile) $audioFile.addEventListener("change", e => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > MAX_SIZE) {
        ui.toast("音频文件过大（>2MB）", 3e3);
        return;
      }
      const reader = new FileReader;
      reader.onload = () => {
        const src = reader.result;
        ui.setCustomNotifyAudio({
          src: src,
          name: f.name
        });
        $audioName.textContent = `当前：${f.name}`;
        ui._playNotifySound(ui.config.notifyVolume);
        ui.toast("已应用自定义提示音");
      };
      reader.readAsDataURL(f);
    });
    if ($applyUrl) $applyUrl.addEventListener("click", () => {
      const url = ($audioUrl.value || "").trim();
      if (!url) return ui.toast("请输入音频URL");
      if (!/^https?:\/\/|^data:audio\//i.test(url)) {
        ui.toast("URL 必须以 http/https 或 data:audio/ 开头");
        return;
      }
      ui.setCustomNotifyAudio({
        src: url,
        name: ""
      });
      $audioName.textContent = "当前：（自定义URL）";
      ui._playNotifySound(ui.config.notifyVolume);
      ui.toast("已应用自定义音频URL");
    });
    if ($preview) $preview.addEventListener("click", () => {
      ui._playNotifySound(ui.config.notifyVolume);
    });
    if ($clear) $clear.addEventListener("click", () => {
      ui.setCustomNotifyAudio({
        src: "",
        name: ""
      });
      $audioName.textContent = "当前：使用内置“叮-咚”提示音";
      ui.toast("已清除自定义音频");
    });
    // 测试提醒
        const $btnTest = root$2.querySelector("#ykt-btn-test-notify");
    if ($btnTest) $btnTest.addEventListener("click", () => {
      const mockProblem = {
        problemId: "TEST-001",
        body: "【测试题】这是一个测试提醒",
        options: []
      };
      ui.notifyProblem(mockProblem, {
        thumbnail: null
      });
    });
    // 关闭按钮：面板嵌在 shell 里，关闭=收起整个 shell
        root$2.querySelector("#ykt-settings-close").addEventListener("click", () => window.dispatchEvent(new CustomEvent("ykt:close-shell")));
    mounted$2 = true;
    return root$2;
  }
  var tpl = '<div id="ykt-tutorial-panel" class="ykt-panel">\n  <div class="panel-header">\n    <h3>YuketangStudio 使用教程</h3>\n    <span class="close-btn" id="ykt-tutorial-close"><i class="fas fa-times"></i></span>\n  </div>\n\n  <div class="panel-body">\n    <div class="tutorial-content">\n      <h4>版本</h4>\n      <p class="ykt-tutorial-version">…</p>\n\n      <h4>项目介绍</h4>\n      <p>YuketangStudio 是一个为雨课堂提供辅助功能的工具：PPT 提取导出、答题提醒、AI 解答、PPT 多轮对话。</p>\n      <p>项目仓库：<a href="https://github.com/RayMorTwinkle/YuketangStudio" target="_blank" rel="noopener">GitHub</a></p>\n      <p>安装：本脚本通过源码构建分发，未上架任何脚本市场，安装方式见仓库 README。</p>\n\n      <h4>主面板</h4>\n      <p>点击工具栏左侧第一个按钮（<i class="fas fa-briefcase"></i>）打开主面板，左侧标签切换功能：</p>\n      <ul>\n        <li><b>💬 PPT对话</b>：像聊天一样对任何一页课件连续追问。左下 <b>＋</b> 可选择多张 PPT 页面或上传图片一起问；AI 回复中的 mermaid 流程图、表格、公式、HTML 片段会直接渲染成图。思考过程流式展开，正文出现后自动折叠。</li>\n        <li><b>🤖 AI解答</b>：自动识别当前题目页，题干文本 + 课件截图一起发给 AI。<b>输入留空点发送 = 解答此页</b>；输入内容则针对题目追问。提示词可在设置里自定义。</li>\n        <li><b>📑 课件</b>：「🎯 跟随当前页」默认开启——选中项自动跟着老师翻页；手动点缩略图会脱离跟随，点按钮恢复。「📝 只看题目页」筛选题目页。「整册下载(PDF)」永远导出全部页面（横屏零白边）。「📥 历史课件」支持多选批量下载往期课堂。</li>\n        <li><b>⚙️ 设置</b>：AI 配置、自动作答与提醒参数、提示词编辑（可恢复默认）。</li>\n        <li><b>❓ 教程</b>：本页。</li>\n      </ul>\n\n      <h4>工具栏快捷开关</h4>\n      <ul>\n        <li><i class="fas fa-briefcase"></i> <b>主面板</b>：打开/关闭主面板。</li>\n        <li><i class="fas fa-bell"></i> <b>习题提醒</b>：新习题出现时弹窗+提示音（蓝色=开启）。</li>\n        <li><i class="fas fa-magic-wand-sparkles"></i> <b>自动作答</b>：切换自动作答（蓝色=开启）。</li>\n      </ul>\n\n      <h4>小技巧</h4>\n      <ul>\n        <li>AI 回复里出现 <b>```mermaid</b> 代码块会自动渲染成图；故意不写围栏的流程图文本也会被识别渲染。</li>\n        <li>排查问题时在控制台执行 <code>localStorage.setItem(\'yksDebug\',\'1\')</code> 后刷新，可看到全量日志。</li>\n        <li>历史课件批量下载时单节课失败不会中断整批，结束后有成功/失败汇总。</li>\n      </ul>\n\n      <h4>注意事项</h4>\n      <p>1) 仅供学习参考，请独立思考；</p>\n      <p>2) AI 解答需要调用 LLM API，注意费用；</p>\n      <p>3) AI 答案不保证正确；</p>\n      <p>4) 自动作答有风险，谨慎开启。</p>\n\n      <h4>致谢与反馈</h4>\n      <p>本项目基于 <a href="https://github.com/ZaytsevZY/yuketang-helper-auto" target="_blank" rel="noopener">ZaytsevZY/yuketang-helper-auto</a> 重构而来。</p>\n      <p>问题反馈：<a href="https://github.com/RayMorTwinkle/YuketangStudio/issues" target="_blank" rel="noopener">GitHub Issues</a></p>\n    </div>\n  </div>\n</div>\n';
  // src/ui/panels/tutorial.js
    let mounted$1 = false;
  let root$1;
  function $(sel) {
    return document.querySelector(sel);
  }
  function mountTutorialPanel() {
    if (mounted$1) return root$1;
    const host = document.createElement("div");
    // 注入构建版本号（"0.3.0" 由 rollup 从 package.json 替换，单一来源）
        host.innerHTML = tpl.replace('class="ykt-tutorial-version">…<', `class="ykt-tutorial-version">${"0.3.0"}<`);
    document.body.appendChild(host.firstElementChild);
    root$1 = document.getElementById("ykt-tutorial-panel");
    // 面板嵌在 shell 里——关闭=通知 shell 收起
        $("#ykt-tutorial-close")?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("ykt:close-shell")));
    mounted$1 = true;
    return root$1;
  }
  // src/ui/panels/shell.js
  // 主面板壳：把原先各自独立的功能面板统一迁入 tab 化布局
  // 面板 DOM 迁移（appendChild 移动）保留其内部事件与逻辑，只重置外观样式
    let mounted = false;
  let root;
  let activeTab = "chat";
  const TABS = [ {
    id: "chat",
    icon: "fa-comments",
    label: "PPT对话",
    panelId: "ykt-chat-panel",
    mount: () => mountChatPanel()
  }, {
    id: "ai",
    icon: "fa-robot",
    label: "AI解答",
    panelId: "ykt-ai-answer-panel",
    mount: () => mountAIPanel()
  }, {
    id: "pres",
    icon: "fa-file-powerpoint",
    label: "课件",
    panelId: "ykt-presentation-panel",
    mount: () => mountPresentationPanel()
  }, {
    id: "settings",
    icon: "fa-gear",
    label: "设置",
    panelId: "ykt-settings-panel",
    mount: () => mountSettingsPanel()
  }, {
    id: "tutorial",
    icon: "fa-question-circle",
    label: "教程",
    panelId: "ykt-tutorial-panel",
    mount: () => mountTutorialPanel()
  } ];
  function mountShell() {
    if (mounted) return root;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = tpl$3;
    document.body.appendChild(wrapper.firstElementChild);
    root = document.getElementById("ykt-shell-panel");
    // 挂载并迁移各功能面板
        const content = root.querySelector("#ykt-shell-content");
    const tabsEl = root.querySelector("#ykt-shell-tabs");
    for (const t of TABS) {
      try {
        t.mount();
      } catch (e) {
        log.warn("[Shell] mount fail", t.id, e);
      }
      const panel = document.getElementById(t.panelId);
      if (panel) content.appendChild(panel);
 // DOM 移动，事件保留
            const tab = document.createElement("div");
      tab.className = "ykt-shell-tab";
      tab.dataset.tab = t.id;
      tab.innerHTML = `<i class="fas ${t.icon}"></i><span>${t.label}</span>`;
      tab.addEventListener("click", () => switchTo(t.id));
      tabsEl.appendChild(tab);
    }
    root.querySelector("#ykt-shell-close").addEventListener("click", () => showShell(false));
    // 子面板内部关闭按钮统一广播这个事件（面板不知道自己嵌在 shell 里）
        window.addEventListener("ykt:close-shell", () => showShell(false));
    mounted = true;
    return root;
  }
  /** 当前激活的面板元素（用于生命周期钩子） */  function currentPanel() {
    return root?.querySelector("#ykt-shell-content > .ykt-panel.active-tab") || null;
  }
  /** 打开/关闭主面板 */  function showShell(visible = true, tabId = null) {
    if (!mounted) mountShell();
    root.classList.toggle("visible", visible);
    // 工具栏按钮态跟着真实可见性走
        document.getElementById("ykt-btn-shell")?.classList.toggle("active", !!visible);
    if (visible) switchTo(tabId || activeTab); else currentPanel()?.__yksOnHide?.();
 // 收起时给激活面板一次清理机会（中止流式等）
    }
  /** 切换 tab：面板互斥显示（active 面板补 visible class 以激活自身布局，其余移除） */  function switchTo(tabId) {
    if (!mounted) mountShell();
    const t = TABS.find(x => x.id === tabId) || TABS[0];
    activeTab = t.id;
    for (const tab of root.querySelectorAll(".ykt-shell-tab")) tab.classList.toggle("active", tab.dataset.tab === t.id);
    const content = root.querySelector("#ykt-shell-content");
    for (const panel of content.querySelectorAll(":scope > .ykt-panel")) {
      const isActive = panel.id === t.panelId;
      if (!isActive && panel.classList.contains("active-tab")) panel.__yksOnHide?.();
 // 切走之前激活的面板（中止它的流式请求等）
            panel.classList.toggle("active-tab", isActive);
      panel.classList.toggle("visible", isActive);
    }
    // 面板被激活时允许它从 config 重新同步（设置面板刷新表单、AI 面板刷新页面状态）
        const activePanel = content.querySelector(`:scope > #${t.panelId}`);
    activePanel?.__yksOnShow?.();
  }
  /** ui-api 统一入口：visible=true 打开主面板并切到 tab；false 关闭主面板 */  function openTab(tabId, visible = true) {
    if (!mounted) mountShell();
    if (visible) showShell(true, tabId); else showShell(false);
  }
  /** 仅在目标 tab 已是当前 tab 时切换开/关，否则打开并切过去 */  function toggleTab(tabId) {
    if (!mounted) mountShell();
    const isOpen = root.classList.contains("visible");
    if (isOpen && activeTab === tabId) showShell(false); else showShell(true, tabId);
  }
  // src/ui/ui-api.js
    const _config = Object.assign({}, DEFAULT_CONFIG, storage.get("config", {}));
  // Object.assign 是浅拷贝——嵌套的 ai 若来自 DEFAULT_CONFIG 会与默认配置共享引用，
  // 深合并一份，避免写 _config.ai 污染 DEFAULT_CONFIG（影响设置页「重置」）
    if (typeof _config.ai !== "object" || !_config.ai) _config.ai = {};
  _config.ai = Object.assign({}, DEFAULT_CONFIG.ai, _config.ai);
  _config.ai.kimiApiKey = storage.get("kimiApiKey", _config.ai.kimiApiKey);
  _config.TYPE_MAP = _config.TYPE_MAP || PROBLEM_TYPE_MAP;
  if (typeof _config.autoJoinEnabled === "undefined") _config.autoJoinEnabled = false;
  if (typeof _config.autoAnswerOnAutoJoin === "undefined") _config.autoAnswerOnAutoJoin = true;
  if (typeof _config.iftex === "undefined") _config.iftex = true;
  if (typeof _config.notifyProblems === "undefined") _config.notifyProblems = true;
  if (typeof _config.notifyPopupDuration === "undefined") _config.notifyPopupDuration = 5e3;
  if (typeof _config.notifyVolume === "undefined") _config.notifyVolume = .6;
  if (typeof _config.customNotifyAudioSrc === "undefined") _config.customNotifyAudioSrc = "";
  if (typeof _config.customNotifyAudioName === "undefined") _config.customNotifyAudioName = "";
  _config.autoJoinEnabled = !!_config.autoJoinEnabled;
  _config.autoAnswerOnAutoJoin = !!_config.autoAnswerOnAutoJoin;
  function saveConfig() {
    try {
      storage.set("config", {
        ...this.config,
        autoJoinEnabled: !!this.config.autoJoinEnabled,
        autoAnswerOnAutoJoin: !!this.config.autoAnswerOnAutoJoin
      });
    } catch (e) {
      log.warn("[ui.saveConfig] failed", e);
    }
  }
  // 面板层级管理
    let currentZIndex = 1e7;
  function enableNotifyDrag(wrapper, handle, bringToFront) {
    if (!wrapper || !handle) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    const onPointerMove = ev => {
      if (!dragging) return;
      // 上下边界也要钳制——否则可拖到视口外再也拉不回来
            const nextLeft = Math.max(8, Math.min(window.innerWidth - wrapper.offsetWidth - 8, originLeft + ev.clientX - startX));
      const nextTop = Math.max(8, Math.min(window.innerHeight - wrapper.offsetHeight - 8, originTop + ev.clientY - startY));
      wrapper.style.left = `${nextLeft}px`;
      wrapper.style.top = `${nextTop}px`;
      wrapper.style.right = "auto";
      wrapper.style.bottom = "auto";
    };
    const stopDrag = () => {
      dragging = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
    handle.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.("button, a, input, textarea, select")) return;
      const rect = wrapper.getBoundingClientRect();
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      wrapper.style.left = `${rect.left}px`;
      wrapper.style.top = `${rect.top}px`;
      wrapper.style.right = "auto";
      wrapper.style.bottom = "auto";
      bringToFront?.(wrapper);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDrag);
      window.addEventListener("pointercancel", stopDrag);
      ev.preventDefault();
    });
  }
  const ui = {
    get config() {
      return _config;
    },
    saveConfig: saveConfig,
    updatePresentationList: updatePresentationList,
    updateSlideView: updateSlideView,
    askAIForCurrent: askAIForCurrent,
    updateActiveProblems: updateActiveProblems,
    // 提升面板层级的辅助函数
    _bringToFront(panelElement) {
      // notify 弹层创建后立即调用，此时 classList 还没有 visible——不能把它当前置条件
      if (panelElement) {
        currentZIndex += 1;
        panelElement.style.zIndex = currentZIndex;
      }
    },
    // 面板显示函数：统一走主面板 Shell 的 tab 切换（visible=false 关闭整个主面板）
    showPresentationPanel(visible = true) {
      openTab("pres", visible);
    },
    showAIPanel(visible = true) {
      openTab("ai", visible);
    },
    showChatPanel(visible = true) {
      openTab("chat", visible);
    },
    toggleSettingsPanel() {
      toggleTab("settings");
    },
    toggleTutorialPanel() {
      toggleTab("tutorial");
    },
    // 在 index.js 初始化时挂载一次
    _mountAll() {
      // 独立弹层（不进主面板）
      mountActiveProblemsPanel();
      // Shell 会依次 mount 全部功能面板并把它们的 DOM 迁入 tab 内容区
            mountShell();
      window.addEventListener("ykt:open-ai", () => this.showAIPanel(true));
      window.addEventListener("ykt:open-chat", () => this.showChatPanel(true));
    },
    // 题目提醒
    notifyProblem(problem, slide) {
      try {
        // 1) 原生通知（如果可用，备用，不阻碍自定义弹窗）
        try {
          this.nativeNotify?.({
            title: "雨课堂习题提示",
            text: this.getProblemDetail(problem),
            image: slide?.thumbnail || null,
            timeout: Math.max(2e3, +this.config.notifyPopupDuration || 5e3)
          });
        } catch {}
        // 2) 自定义悬浮弹窗
                const wrapper = document.createElement("div");
        wrapper.className = "ykt-problem-notify";
        // 内联样式，避免依赖外部CSS
                Object.assign(wrapper.style, {
          position: "fixed",
          right: "20px",
          bottom: "24px",
          maxWidth: "380px",
          background: "rgba(20,20,20,0.92)",
          color: "#fff",
          borderRadius: "12px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          padding: "14px 16px",
          display: "flex",
          gap: "12px",
          alignItems: "flex-start",
          zIndex: String(++currentZIndex),
          fontSize: "14px",
          lineHeight: "1.5",
          backdropFilter: "blur(2px)",
          border: "1px solid rgba(255,255,255,0.06)",
          cursor: "default"
        });
        // 缩略图（可选）
                if (slide?.thumbnail) {
          const img = document.createElement("img");
          img.src = slide.thumbnail;
          Object.assign(img.style, {
            width: "56px",
            height: "56px",
            objectFit: "cover",
            borderRadius: "8px",
            flex: "0 0 auto"
          });
          wrapper.appendChild(img);
        }
        const body = document.createElement("div");
        body.style.flex = "1 1 auto";
        const head = document.createElement("div");
        Object.assign(head.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          marginBottom: "6px",
          cursor: "move",
          userSelect: "none",
          touchAction: "none"
        });
        const title = document.createElement("div");
        title.textContent = "习题已发布";
        Object.assign(title.style, {
          fontWeight: "600",
          fontSize: "15px",
          flex: "1 1 auto"
        });
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "x";
        Object.assign(closeBtn.style, {
          border: "none",
          background: "transparent",
          color: "#fff",
          opacity: "0.7",
          fontSize: "18px",
          lineHeight: "18px",
          cursor: "pointer",
          padding: "0 4px",
          marginLeft: "4px",
          flex: "0 0 auto"
        });
        closeBtn.addEventListener("mouseenter", () => closeBtn.style.opacity = "1");
        closeBtn.addEventListener("mouseleave", () => closeBtn.style.opacity = "0.7");
        const detail = document.createElement("pre");
        detail.textContent = this.getProblemDetail(problem);
        Object.assign(detail.style, {
          whiteSpace: "pre-wrap",
          margin: 0,
          fontFamily: "inherit",
          opacity: "0.92",
          maxHeight: "220px",
          overflow: "auto"
        });
        head.appendChild(title);
        head.appendChild(closeBtn);
        body.appendChild(head);
        body.appendChild(detail);
        wrapper.appendChild(body);
        document.body.appendChild(wrapper);
        this._bringToFront(wrapper);
        const timeout = Math.max(2e3, +this.config.notifyPopupDuration || 5e3);
        const timer = setTimeout(() => wrapper.remove(), timeout);
        closeBtn.onclick = () => {
          clearTimeout(timer);
          wrapper.remove();
        };
        enableNotifyDrag(wrapper, head, el => this._bringToFront(el));
        this._playNotifySound(+this.config.notifyVolume || .6);
      } catch (e) {
        log.warn("[雨课堂助手][WARN][ui.notifyProblem] failed:", e);
      }
    },
    // 播放自定义提示音  
    _playNotifySound(volume = .6) {
      const src = (this.config.customNotifyAudioSrc || "").trim();
      if (src) try {
        if (!this.__notifyAudioEl) {
          this.__notifyAudioEl = new Audio;
          this.__notifyAudioEl.preload = "auto";
        }
        const el = this.__notifyAudioEl;
        el.pause();
        // 若用户更换了音频，或首次设置，更新 src
                if (el.src !== src) el.src = src;
        el.volume = Math.max(0, Math.min(1, volume));
        el.currentTime = 0;
        const p = el.play();
        // 失败时回退
                if (p && typeof p.catch === "function") p.catch(() => this._playNotifyTone(volume));
        return;
      } catch (e) {
        log.warn("[雨课堂助手][WARN] custom audio failed, fallback to tone:", e);
        // 回退到合成音
            }
      this._playNotifyTone(volume);
    },
    // 简易提示音：两个音高的短促“叮-咚”
    _playNotifyTone(volume = .6) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext);
        const now = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = Math.max(0, Math.min(1, volume));
        master.connect(ctx.destination);
        const tone = (freq, t0, dur = .12) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, t0);
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(1, t0 + .01);
          gain.gain.exponentialRampToValueAtTime(.001, t0 + dur);
          osc.connect(gain);
          gain.connect(master);
          osc.start(t0);
          osc.stop(t0 + dur + .02);
        };
        tone(880, now);
 // A5
                tone(1318.51, now + .16);
 // E6
        // 自动关闭
                setTimeout(() => ctx.close(), 500);
      } catch {}
    },
    // 供设置页调用：写入/清除自定义提示音
    setCustomNotifyAudio({src: src, name: name}) {
      this.config.customNotifyAudioSrc = src || "";
      this.config.customNotifyAudioName = name || "";
      this.saveConfig();
    },
    getProblemDetail(problem) {
      if (!problem) return "题目未找到";
      const lines = [ problem.body || "" ];
      if (Array.isArray(problem.options)) lines.push(...problem.options.map(({key: key, value: value}) => `${key}. ${value}`));
      return lines.join("\n");
    },
    toast: toast,
    nativeNotify: gm.notify,
    // 主面板
    showShellPanel(visible = true) {
      showShell(visible);
    },
    // Buttons 状态
    updateAutoAnswerBtn() {
      const el = document.getElementById("ykt-btn-auto-answer");
      if (!el) return;
      if (_config.autoAnswer) el.classList.add("active"); else el.classList.remove("active");
    }
  };
  function sleep(ms) {
    return new Promise(r => setTimeout(r, Math.max(0, ms | 0)));
  }
  function calcAutoWaitMs() {
    const base = Math.max(0, ui?.config?.autoAnswerDelay ?? 0);
    const rand = Math.max(0, ui?.config?.autoAnswerRandomDelay ?? 0);
    return base + (rand ? Math.floor(Math.random() * rand) : 0);
  }
  function shouldAutoAnswerForLesson_(lessonId) {
    if (ui?.config?.autoAnswer) return true;
    if (!lessonId) return false;
    if (repo?.autoJoinedLessons?.has(lessonId) && ui?.config?.autoAnswerOnAutoJoin) return true;
    if (repo?.forceAutoAnswerLessons?.has(lessonId)) return true;
    return false;
  }
  const DEFAULT_HEADERS = () => ({
    "Content-Type": "application/json",
    xtbz: "ykt",
    "X-Client": "h5",
    Authorization: "Bearer " + (typeof localStorage !== "undefined" ? localStorage.getItem("Authorization") : "")
  });
  /**
   * Low-level POST helper using XMLHttpRequest to align with site requirements.
   * @param {string} url
   * @param {object} data
   * @param {Record<string,string>} headers
   * @returns {Promise<any>}
   */  function xhrPost(url, data, headers) {
    return new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest;
        xhr.open("POST", url);
        for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
        // 必须给所有终止态一个 rejection——超时不设回调会让 Promise 永远挂起
        // （外层 answering 标志随之卡死，题目再也答不了）
                xhr.timeout = 2e4;
        xhr.ontimeout = () => reject(new Error("提交超时（20s）"));
        xhr.onabort = () => reject(new Error("请求被中止"));
        xhr.onload = () => {
          try {
            const resp = JSON.parse(xhr.responseText);
            if (resp && typeof resp === "object") resolve(resp); else reject(new Error("解析响应失败"));
          } catch {
            reject(new Error("解析响应失败"));
          }
        };
        xhr.onerror = () => reject(new Error("网络请求失败"));
        xhr.send(JSON.stringify(data));
      } catch (e) {
        reject(e);
      }
    });
  }
  /**
   * POST /api/v3/lesson/problem/answer
   * Mirrors the 1.16.1 logic (no UI). Returns {code, data, msg, ...} on success code===0.
   * @param {{problemId:number, problemType:number}} problem
   * @param {any} result
   * @param {{headers?:Record<string,string>, dt?:number}} [options]
   */  async function answerProblem(problem, result, options = {}) {
    const url = "/api/v3/lesson/problem/answer";
    const headers = {
      ...DEFAULT_HEADERS(),
      ...options.headers || {}
    };
    const payload = {
      problemId: problem.problemId,
      problemType: problem.problemType,
      dt: options.dt ?? Date.now(),
      result: result
    };
    const resp = await xhrPost(url, payload, headers);
    if (resp.code === 0) return resp;
    throw new Error(`${resp?.msg || "服务器返回错误"} (${resp?.code})`);
  }
  /**
   * POST /api/v3/lesson/problem/retry
   * Expects server to echo success ids in data.success (as in v1.16.1).
   * @param {{problemId:number, problemType:number}} problem
   * @param {any} result
   * @param {number} dt - simulated answer time (epoch ms)
   * @param {{headers?:Record<string,string>}} [options]
   */  async function retryAnswer(problem, result, dt, options = {}) {
    const url = "/api/v3/lesson/problem/retry";
    const headers = {
      ...DEFAULT_HEADERS(),
      ...options.headers || {}
    };
    const payload = {
      problems: [ {
        problemId: problem.problemId,
        problemType: problem.problemType,
        dt: dt,
        result: result
      } ]
    };
    const resp = await xhrPost(url, payload, headers);
    if (resp.code !== 0) throw new Error(`${resp?.msg || "服务器返回错误"} (${resp?.code})`);
    const okList = resp?.data?.success || [];
    // 服务端可能返回数字 id——统一字符串比较，避免类型不一致误判失败
        if (!Array.isArray(okList) || !okList.map(String).includes(String(problem.problemId))) throw new Error("服务器未返回成功信息");
    return resp;
  }
  /**
   * High-level orchestrator: answer first; if deadline has passed, optionally retry.
   * This is the module adaptation of the 1.16.1 userscript submit flow.
   *
   * @param {{problemId:number, problemType:number}} problem
   * @param {any} result
   * @param {Object} submitOptions
   * @param {number} [submitOptions.startTime] - unlock time (epoch ms). Required for retry path.
   * @param {number} [submitOptions.endTime]   - deadline (epoch ms). If now >= endTime -> retry path.
   * @param {boolean} [submitOptions.forceRetry=false] - when past deadline, directly use retry without prompting.
   * @param {number} [submitOptions.retryDtOffsetMs=2000] - dt = startTime + offset when retrying.
   * @param {Record<string,string>} [submitOptions.headers] - extra/override headers.
   * @returns {Promise<{'route':'answer'|'retry', resp:any}>}
   * @param {number|string} [submitOptions.lessonId] - 所属课堂；缺省时将使用 repo.currentLessonId
   * @param {boolean} [submitOptions.autoGate=true]  - 是否启用“自动进入课堂/默认自动答题”的判定（向后兼容，默认开启）
   * @param {number} [submitOptions.waitMs]          - 覆盖自动等待时间；未提供时按设置计算
   */  async function submitAnswer(problem, result, submitOptions = {}) {
    const startTime = submitOptions?.startTime;
    const endTime = submitOptions?.endTime;
    const forceRetry = submitOptions?.forceRetry ?? false;
    const retryDtOffsetMs = submitOptions?.retryDtOffsetMs ?? 2e3;
    const headers = submitOptions?.headers;
    const autoGate = submitOptions?.autoGate ?? true;
    const waitMs = submitOptions?.waitMs;
    const lessonIdFromOpts = submitOptions && "lessonId" in submitOptions ? submitOptions.lessonId : void 0;
    // 统一拿 lessonId
        const lessonId = lessonIdFromOpts ?? repo?.currentLessonId ?? null;
    // endTime 是服务端时钟（unlock 时记了 clockOffset）——判过期/限时都要换算回服务端时间轴
        const psEarly = repo?.problemStatus?.get?.(String(problem.problemId));
    const clockOffset = Number.isFinite(psEarly?.clockOffset) ? psEarly.clockOffset : 0;
    const serverNow = () => Date.now() + clockOffset;
    if (autoGate && shouldAutoAnswerForLesson_(lessonId)) {
      const ms = typeof waitMs === "number" ? Math.max(0, waitMs) : calcAutoWaitMs();
      if (ms > 0) {
        const guard = typeof endTime === "number" ? Math.max(0, endTime - serverNow() - 80) : ms;
        await sleep(Math.min(ms, guard));
      }
    }
    const now = serverNow();
    const pastDeadline = typeof endTime === "number" && Number.isFinite(endTime) && now >= endTime;
    if (pastDeadline || forceRetry) {
      log.dbg("[雨课堂助手][DEBUG][answer] >>> 进入补交分支判断");
      log.dbg("problemId:", problem.problemId);
      log.dbg("pastDeadline:", pastDeadline, "(now=", now, ", endTime=", endTime, ")");
      log.dbg("forceRetry:", forceRetry);
      log.dbg("传入 startTime:", startTime, "传入 endTime:", endTime);
      const ps = repo?.problemStatus?.get?.(String(problem.problemId));
      log.dbg("从 repo.problemStatus 获取:", ps);
      const st = Number.isFinite(startTime) ? startTime : ps?.startTime;
      const et = Number.isFinite(endTime) ? endTime : ps?.endTime;
      log.dbg("最终用于 retry 的 st=", st, " et=", et);
      // 计算 dt
            const off = Math.max(0, retryDtOffsetMs);
      let dt;
      if (Number.isFinite(st)) {
        dt = st + off;
        log.dbg("补交 dt = startTime + offset =", dt);
      } else if (Number.isFinite(et)) {
        dt = Math.max(0, et - Math.max(off, 5e3));
        log.dbg("补交 dt = near endTime window =", dt);
      } else {
        dt = Date.now() - off;
        log.dbg("补交 dt = fallback =", dt);
      }
      log.dbg(">>> 即将调用 retryAnswer()");
      try {
        const resp = await retryAnswer(problem, result, dt, {
          headers: headers
        });
        log.dbg("[雨课堂助手][INFO][answer] 补交成功 (/retry)", {
          problemId: problem.problemId,
          dt: dt,
          pastDeadline: pastDeadline,
          forceRetry: forceRetry
        });
        return {
          route: "retry",
          resp: resp
        };
      } catch (e) {
        log.err("[雨课堂助手][ERR][answer] 补交失败 (/retry)：", e);
        log.err("[雨课堂助手][ERR][answer] 失败参数：", {
          st: st,
          et: et,
          dt: dt,
          pastDeadline: pastDeadline,
          forceRetry: forceRetry
        });
        throw e;
      }
    }
    const resp = await answerProblem(problem, result, {
      headers: headers,
      dt: now
    });
    return {
      route: "answer",
      resp: resp
    };
  }
  // src/ai/openai.js
  // OpenAI 兼容协议封装：queryAI（纯文本）/ queryAIVision（图文，可选两步 pipeline）
  // 将后端 problemType 数字映射为 Step1/Step2 使用的 question_type 字符串
  // 约定：
  // 1 -> single_choice   （单选）
  // 2 -> multiple_choice （多选）
  // 3 -> single_choice   （投票题按单选处理）
  // 4 -> fill_in         （填空题）
  // 5 -> subjective      （主观题 / 简答题）
    function mapProblemTypeToQuestionType(problemType) {
    if (problemType == null) return null;
    const n = Number(problemType);
    switch (n) {
     case 1:
      return "single_choice";

     case 2:
      return "multiple_choice";

     case 3:
      return "single_choice";

     case 4:
      return "fill_in";

     case 5:
      return "subjective";

     default:
      return null;
    }
  }
  function getActiveProfile(aiCfg) {
    const cfg = aiCfg || {};
    const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
    if (!profiles.length) {
      const legacyKey = cfg.kimiApiKey;
      if (!legacyKey) return null;
      return {
        id: "legacy",
        name: "Kimi Legacy",
        baseUrl: "https://api.moonshot.cn/v1/chat/completions",
        apiKey: legacyKey,
        model: "moonshot-v1-8k",
        visionModel: "moonshot-v1-8k-vision-preview"
      };
    }
    const activeId = cfg.activeProfileId;
    const p = profiles.find(p => p.id === activeId) || profiles[0];
    // 不原地改 profile（p 是 config 里的对象）——补默认 baseUrl 走浅拷贝
        return {
      ...p,
      baseUrl: p.baseUrl || "https://api.moonshot.cn/v1/chat/completions"
    };
  }
  function makeChatUrl(profile) {
    let base = (profile.baseUrl || "https://api.moonshot.cn/v1/chat/completions").replace(/\/+$/, "");
    if (!base.includes("/chat/completions")) if (base.includes("/v1")) base += "/chat/completions"; else if (base.includes("/openai")) base += "/v1/chat/completions"; else base += "/v1/chat/completions";
    return base;
  }
  // -----------------------------------------------
  // Unified Prompt blocks for Text & Vision
  // -----------------------------------------------
    const BASE_SYSTEM_PROMPT = [ "1) 任何时候优先遵循【用户输入（优先级最高）】中的明确要求；", "2) 当输入是课件页面（PPT）图像或题干文本时，先判断是否存在“明确题目”；", "3) 若存在明确题目，则输出以下格式的内容：", "   单选：格式要求：\n答案: [单个字母]\n解释: [选择理由]\n\n注意：只选一个，如A", "   多选：格式要求：\n答案: [多个字母用顿号分开]\n解释: [选择理由]\n\n注意：格式如A、B、C", "   投票：格式要求：\n答案: [单个字母]\n解释: [选择理由]\n\n注意：只选一个选项，如A", "   填空/主观题: 格式要求：答案: [直接给出答案内容]，解释: [补充说明]", "4) 若识别不到明确题目，直接使用回答用户输入的问题", "3) 如果PROMPT格式不正确，或者你只接收了图片，输出：", "   STATE: NO_PROMPT", "   SUMMARY: <介绍页面/上下文的主要内容>" ].join("\n");
  // Vision 补充：识别题型与版面元素的步骤说明
    const VISION_GUIDE = [ "【视觉识别要求】", "A. 先判断是否为题目页面（是否有题干/选项/空格/问句等）", "B. 若是题目，尝试提取题干、选项与关键信息；", "C. 否则参考用户输入回答" ].join("\n");
  // 通用 OpenAI 协议聊天请求封装（用于 Vision 两步调用）
    function chatCompletion(profile, payload, debugLabel = "[AI OpenAI]", timeoutMs = 6e4) {
    const url = makeChatUrl(profile);
    return new Promise((resolve, reject) => {
      gm.xhr({
        method: "POST",
        url: url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${profile.apiKey}`
        },
        data: JSON.stringify(payload),
        timeout: timeoutMs,
        onload: res => {
          try {
            log.dbg(`[雨课堂助手]${debugLabel} Status:`, res.status);
            log.dbg(`[雨课堂助手]${debugLabel} Response:`, res.responseText);
            if (res.status !== 200) {
              let errorMessage = `AI 请求失败: ${res.status}`;
              try {
                const errorData = JSON.parse(res.responseText);
                if (errorData.error?.message) errorMessage += ` - ${errorData.error.message}`;
                if (errorData.error?.code) errorMessage += ` (${errorData.error.code})`;
              } catch {
                errorMessage += ` - ${res.responseText}`;
              }
              reject(new Error(errorMessage));
              return;
            }
            const data = JSON.parse(res.responseText);
            resolve(data);
          } catch (e) {
            log.err(`[雨课堂助手]${debugLabel} 解析响应失败:`, e);
            reject(new Error(`解析API响应失败: ${e.message}`));
          }
        },
        onerror: err => {
          log.err(`[雨课堂助手]${debugLabel} 网络请求失败:`, err);
          reject(new Error("网络请求失败"));
        },
        ontimeout: () => reject(new Error(`AI 请求超时（${Math.round(timeoutMs / 1e3)}s）`))
      });
    });
  }
  async function singleStepVisionCall(profile, cleanBase64List, textPrompt, options = {}) {
    const visionModel = profile.visionModel || profile.model;
    const timeoutMs = options.timeout || 6e4;
    const visionTextHeader = [ "【融合模式说明】你将看到一张课件/PPT截图与可选的附加文本。", VISION_GUIDE ].join("\n");
    const imageBlocks = [];
    for (const b64 of cleanBase64List) imageBlocks.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${b64}`
      }
    });
    const messages = [ {
      role: "system",
      content: BASE_SYSTEM_PROMPT
    }, {
      role: "user",
      content: [ ...imageBlocks, {
        type: "text",
        text: [ visionTextHeader, "【用户输入（优先级最高）】", textPrompt || "（无）" ].join("\n")
      } ]
    } ];
    const data = await chatCompletion(profile, {
      model: visionModel,
      messages: messages,
      temperature: .3
    }, "[AI OpenAI Vision 单步]", timeoutMs);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI返回内容为空");
    log.dbg("[AI OpenAI Vision] 成功获取回答(单步)");
    return content;
  }
  /**
   * 通用 OpenAI 协议 Vision 模型（图像+文本）
   */  async function queryAIVision(imageBase64, textPrompt, aiCfg, options = {}) {
    const profile = getActiveProfile(aiCfg);
    if (!profile || !profile.apiKey) throw new Error("请先在设置中配置 AI API Key");
    // ===== 兼容单图 / 多图 =====
        const inputList = Array.isArray(imageBase64) ? imageBase64 : [ imageBase64 ];
    const cleanBase64List = inputList.filter(Boolean).map(x => String(x).replace(/^data:image\/[^;]+;base64,/, "")).filter(x => !!x);
    if (cleanBase64List.length === 0) throw new Error("图像数据格式错误");
    const visionModel = profile.visionModel || profile.model;
    const textModel = profile.model;
    const hasSeparateTextModel = !!textModel && textModel !== visionModel;
    const {disableTwoStep: disableTwoStep = false, twoStepDebug: twoStepDebug = false, timeout: timeoutMs = 6e4, problemType: problemType = null} = options || {};
    // -------- 0. 如果只有 VLM（或者显式关闭两步），回退到单步逻辑 --------
        if (!hasSeparateTextModel || disableTwoStep) {
      if (twoStepDebug) log.dbg("[雨课堂助手][INFO][vision] use single-step vision", {
        hasSeparateTextModel: hasSeparateTextModel,
        disableTwoStep: disableTwoStep
      });
      return singleStepVisionCall(profile, cleanBase64List, textPrompt, {
        timeout: timeoutMs
      });
    }
    if (twoStepDebug) log.dbg("[雨课堂助手][INFO][vision] use TWO-STEP pipeline", {
      visionModel: visionModel,
      textModel: textModel
    });
    // ===================== Step 1: Vision 抽结构化题目 =====================
        const STEP1_SYSTEM_PROMPT = `\n你是一个“题目结构化助手”。你将看到课件截图和可选的附加文本，请从中提取出清晰的题目结构，并以 JSON 格式输出。\n\n你不仅要识别文字（类似 OCR），还要理解图片里的内容（例如物体、颜色、形状、数量、相对位置等），并把这些与题目有关的信息转化为题干或补充说明的一部分。\n\n【题型识别优先级】\n1. 如果页面上出现了明确的题型标签文字，如：\n   - "单选题"、"多选题"、"投票题"、"填空题"、"主观题" 等，\n   请优先根据这些标签设置 question_type：\n   - 单选题 / 投票题 -> "single_choice"\n   - 多选题         -> "multiple_choice"\n   - 填空题         -> "fill_in"\n   - 主观题 / 简答题 / 论述题 -> "subjective"\n2. 当没有明显题型标签时，再根据题干语义和版面结构推断题型。\n\n【选项字母规则】\n- 只有在页面上出现了清晰的选项字母（通常为 "A."、"B."、"C."、"D." 等）并跟随选项内容时，才能将 question_type 设为 "single_choice" 或 "multiple_choice"（或投票题对应的 "single_choice"）。\n- 如果没有任何 A/B/C/D 这种选项字母，而问题又需要开放性自由回答，请优先将 question_type 设为 "subjective"。\n\n请尽量识别：\n- question_type: "single_choice" | "multiple_choice" | "fill_in" | "subjective" | "visual_only" | "unknown"\n- stem: 题干文本（如果题干主要依赖图片，请用自然语言描述图片中与题目相关的内容，可保留数学公式信息）\n- options: 一个对象，键为 "A"、"B"、"C"、"D" 等，值为选项内容文字（若不是选择题可为空对象）\n- image_facts: （可选）一个字符串数组，列出与解题有关的关键图像事实，例如 ["图中是一根黄色的香蕉", "背景是白色"]。\n- requires_image_for_solution: 布尔值。如果即使你尽力用文字描述图片，仍然很难仅凭文字保证答对（例如复杂几何图形或高度依赖精确位置关系的题目），请设为 true；如果你的文字描述已经足够让人类或文字模型解题，请设为 false。\n\n输出示例（仅示例，不是固定模板）：\n{\n  "question_type": "single_choice",\n  "stem": "根据图片中的水果，选择它的颜色。",\n  "options": {\n    "A": "红色",\n    "B": "黄色",\n    "C": "蓝色",\n    "D": "绿色"\n  },\n  "image_facts": [\n    "图片中是一根黄色的香蕉，背景为白色"\n  ],\n  "requires_image_for_solution": false\n}\n\n如果无法识别题目或截图并非题目，请尽量给出你能看到的内容，但仍然保持上述 JSON 结构（字段缺省时可以用 null、空对象或空数组）。\n仅输出 JSON，不要任何额外文字。\n`.trim();
    const step1Messages = [ {
      role: "system",
      content: STEP1_SYSTEM_PROMPT
    }, {
      role: "user",
      content: [ ...cleanBase64List.map(b64 => ({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${b64}`
        }
      })), textPrompt ? {
        type: "text",
        text: `【辅助文本】\n${textPrompt}`
      } : {
        type: "text",
        text: "【辅助文本】（无额外文本，仅根据截图识别题目）"
      } ]
    } ];
    let structuredQuestion;
    try {
      const data1 = await chatCompletion(profile, {
        model: visionModel,
        messages: step1Messages,
        temperature: .1
      }, "[AI OpenAI Vision Step1]", timeoutMs);
      const content1 = data1.choices?.[0]?.message?.content || "";
      if (twoStepDebug) log.dbg("[雨课堂助手][DEBUG][vision-step1] raw content:", content1);
      const jsonMatch = content1.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("no JSON found in step1 result");
      structuredQuestion = JSON.parse(jsonMatch[0]);
    } catch (err) {
      log.warn("[雨课堂助手][WARN][vision-step1] failed, fallback to single-step", err);
      return singleStepVisionCall(profile, cleanBase64List, textPrompt, {
        timeout: timeoutMs
      });
    }
    if (!structuredQuestion || !structuredQuestion.stem) {
      log.warn("[雨课堂助手][WARN][vision-step1] invalid structuredQuestion, fallback");
      return singleStepVisionCall(profile, cleanBase64List, textPrompt, {
        timeout: timeoutMs
      });
    }
    if (twoStepDebug) log.dbg("[雨课堂助手][INFO][vision-step1] structuredQuestion:", structuredQuestion);
    // ========= 题型合并逻辑：后端 problemType 优先，其次 VLM 推断，全部缺失则回退 subjective =========
        const backendQuestionType = mapProblemTypeToQuestionType(problemType);
    const vlmQuestionType = structuredQuestion.question_type || null;
    let finalQuestionType = backendQuestionType || vlmQuestionType || null;
    // 如果 VLM 返回的是 unknown / visual_only 这类不太可用的类型，也当成“缺失”
        if (finalQuestionType === "unknown" || finalQuestionType === "visual_only") finalQuestionType = null;
    // 当后端和 VLM 都没有给出可用题型时，统一回退为主观题
        if (!finalQuestionType) finalQuestionType = "subjective";
    if (twoStepDebug) log.dbg("[雨课堂助手][INFO][vision-step1] questionType merged:", {
      problemType: problemType,
      backendQuestionType: backendQuestionType,
      vlmQuestionType: vlmQuestionType,
      finalQuestionType: finalQuestionType
    });
    // 如果模型明确表示“必须依赖原始图像才能解题”，则回退到单步 Vision，避免纯文本推理丢失关键信息
        if (structuredQuestion.requires_image_for_solution === true) {
      log.warn("[雨课堂助手][INFO][vision] step1 says image is essential, fallback to single-step");
      return singleStepVisionCall(profile, cleanBase64List, textPrompt, {
        timeout: timeoutMs
      });
    }
    // ===================== Step 2: Text 模型纯文本推理解题 =====================
        const {stem: stem, options: sqOptions = {}, image_facts: image_facts = []} = structuredQuestion;
    let solvePrompt = "你是一个严谨的解题助手，请根据下面的题目进行推理解答：\n\n";
    solvePrompt += `【题干】\n${stem}\n\n`;
    const optionKeys = Object.keys(sqOptions);
    if (optionKeys.length > 0) {
      solvePrompt += "【选项】\n";
      for (const key of optionKeys) solvePrompt += `${key}. ${sqOptions[key]}\n`;
      solvePrompt += "\n";
    }
    solvePrompt += "请逐步推理，推理结果按以下格式输出：\n";
    if (finalQuestionType === "single_choice") solvePrompt += "答案: [单个大写字母]\n解释: [简要说明你的推理过程]\n"; else if (finalQuestionType === "multiple_choice") solvePrompt += "答案: [多个大写字母，用顿号分隔，如 A、C、D]\n解释: [简要说明你的推理过程]\n"; else if (finalQuestionType === "fill_in") solvePrompt += "答案: [直接给出需要填入的内容，多个空用逗号分隔]\n解释: [简要说明你的推理过程]\n"; else if (finalQuestionType === "subjective") solvePrompt += "答案: [完整回答]\n解释: [可选的补充说明]\n";
    // 将图像关键信息一并提供给文本模型，用于弥补完全无图像输入的劣势
        if (Array.isArray(image_facts) && image_facts.length > 0) {
      solvePrompt += "【图像关键信息】\n";
      for (const fact of image_facts) if (typeof fact === "string" && fact.trim()) solvePrompt += `- ${fact.trim()}\n`;
      solvePrompt += "\n";
    }
    const step2Messages = [ {
      role: "system",
      content: "你是一个解题助手，请严格按照用户指定的输出格式作答，尽量保证答案正确。"
    }, {
      role: "user",
      content: [ {
        type: "text",
        text: solvePrompt
      } ]
    } ];
    try {
      const data2 = await chatCompletion(profile, {
        model: textModel,
        messages: step2Messages,
        temperature: .2
      }, "[AI OpenAI Vision Step2]", timeoutMs);
      const content2 = data2.choices?.[0]?.message?.content || "";
      if (!content2) throw new Error("AI返回内容为空");
      if (twoStepDebug) log.dbg("[雨课堂助手][INFO][vision-step2] final content:", content2);
      return content2;
    } catch (err) {
      log.warn("[雨课堂助手][WARN][vision-step2] failed, fallback to single-step", err);
      return singleStepVisionCall(profile, cleanBase64List, textPrompt, {
        timeout: timeoutMs
      });
    }
  }
  // src/ui/panels/auto-answer-popup.js
  // 显示自动作答成功弹窗
    function showAutoAnswerPopup(problem, aiAnswer, cfg = {}) {
    // 避免重复
    const existed = document.getElementById("ykt-auto-answer-popup");
    if (existed) existed.remove();
    const popup = document.createElement("div");
    popup.id = "ykt-auto-answer-popup";
    popup.className = "auto-answer-popup";
    popup.innerHTML = `\n    <div class="popup-content">\n      <div class="popup-header">\n        <h4><i class="fas fa-robot"></i> AI自动作答成功</h4>\n        <span class="close-btn" title="关闭"><i class="fas fa-times"></i></span>\n      </div>\n      <div class="popup-body">\n        <div class="popup-row popup-answer">\n          <div class="label">AI分析结果：</div>\n          <div class="content">${escapeHtml(aiAnswer || "无AI回答").replace(/\n/g, "<br>")}</div>\n        </div>\n      </div>\n    </div>\n  `;
    document.body.appendChild(popup);
    // 关闭按钮
        popup.querySelector(".close-btn")?.addEventListener("click", () => popup.remove());
    // 点击遮罩关闭
        popup.addEventListener("click", e => {
      if (e.target === popup) popup.remove();
    });
    // 自动关闭
        const ac = ui.config?.autoAnswerPopup || {};
    const autoClose = cfg.autoClose ?? ac.autoClose ?? true;
    const autoDelay = cfg.autoCloseDelay ?? ac.autoCloseDelay ?? 4e3;
    if (autoClose) setTimeout(() => {
      if (popup.parentNode) popup.remove();
    }, autoDelay);
    // 入场动画
        requestAnimationFrame(() => popup.classList.add("visible"));
  }
  function cleanProblemBody(body, problemType, TYPE_MAP) {
    if (!body) return "";
    const typeLabel = TYPE_MAP[problemType];
    if (!typeLabel) return body;
    // 去除题目开头的类型标识，如 "填空题：" "单选题：" 等
        const pattern = new RegExp(`^${typeLabel}[：:\\s]+`, "i");
    return body.replace(pattern, "").trim();
  }
  // 改进的融合模式 prompt 格式化函数
    function formatProblemForVision(problem, TYPE_MAP, hasTextInfo = false) {
    const problemType = TYPE_MAP[problem.problemType] || "题目";
    let basePrompt = hasTextInfo ? `结合文本信息和图片内容分析${problemType}，按格式回答：` : `观察图片内容，识别${problemType}并按格式回答：`;
    if (hasTextInfo && problem.body) {
      // ✅ 清理题目内容
      const cleanBody = cleanProblemBody(problem.body, problem.problemType, TYPE_MAP);
      basePrompt += `\n\n【文本信息】\n题目：${cleanBody}`;
      if (problem.options?.length) {
        basePrompt += "\n选项：";
        for (const o of problem.options) basePrompt += `\n${o.key}. ${o.value}`;
      }
      basePrompt += "\n\n若图片内容与文本冲突，以图片为准。";
    }
    // 根据题目类型添加具体格式要求
        switch (problem.problemType) {
     case 1:
      // 单选题
      basePrompt += `\n\n格式要求：\n答案: [单个字母]\n解释: [选择理由]\n\n注意：只选一个，如A`;
      break;

     case 2:
      // 多选题
      basePrompt += `\n\n格式要求：\n答案: [多个字母用顿号分开]\n解释: [选择理由]\n\n注意：格式如A、B、C`;
      break;

     case 3:
      // 投票题
      basePrompt += `\n\n格式要求：\n答案: [单个字母]\n解释: [选择理由]\n\n注意：只选一个选项`;
      break;

     case 4:
      // 填空题
      basePrompt += `\n\n这是一道填空题。\n\n重要说明：\n- 题目内容已经处理，不含"填空题"等字样\n- 观察图片和文本，找出需要填入的内容\n- 答案中不要出现任何题目类型标识\n\n格式要求：\n答案: [直接给出填空内容]\n解释: [简要说明]\n\n示例：\n答案: 氧气,葡萄糖\n解释: 光合作用的产物\n\n多个填空用逗号分开`;
      break;

     case 5:
      // 主观题
      basePrompt += `\n\n格式要求：\n答案: [完整回答]\n解释: [补充说明]\n\n注意：直接回答，不要重复题目`;
      break;

     default:
      basePrompt += `\n\n格式要求：\n答案: [你的答案]\n解释: [详细解释]`;
    }
    return basePrompt;
  }
  // 改进的答案解析函数
    function parseAIAnswer(problem, aiAnswer) {
    try {
      // 哨兵优先：AI 按要求输出 STATE: NO_PROMPT（页面无题目）时绝不能当答案提交——
      // 此前它会落到首行兜底，被选择题分支提取出字母乱答
      if (/^\s*STATE\s*:/im.test(String(aiAnswer || "")) || /\bNO_PROMPT\b/i.test(String(aiAnswer || ""))) {
        log.warn("[雨课堂助手][WARN][parseAIAnswer] 检测到 STATE 哨兵/NO_PROMPT，判为无题目，不解析答案");
        return null;
      }
      const lines = String(aiAnswer || "").split("\n");
      let answerLine = "";
      let answerIdx = -1;
      // 先定位“答案:”所在行
            for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("答案:") || line.includes("答案：")) {
          answerLine = line.replace(/答案[:：]\s*/, "").trim();
          answerIdx = i;
          break;
        }
      }
      // === 对填空题和主观题，允许多行答案 ===
            if ((problem.problemType === 4 || problem.problemType === 5) && answerIdx >= 0) {
        const block = [];
        // 当前行如果有内容，先收进去
                if (answerLine) block.push(answerLine);
        // 继续向下收集，直到遇到“解释:”或文本结束
                for (let i = answerIdx + 1; i < lines.length; i++) {
          const l = lines[i];
          if (/^\s*解释[:：]/.test(l)) break;
          block.push((l || "").trimEnd());
        }
        const merged = block.join("\n").trim();
        if (merged) answerLine = merged;
      }
      // 如果仍然没有任何答案内容，退回到第一行兜底——
      // 但首行兜底对选择题太危险（"The answer is B" 会提取出 T），只允许「整行就是选项字母」的形态
            if (!answerLine) {
        const first = (lines[0] || "").trim();
        const isChoice = [ 1, 2, 3 ].includes(problem.problemType);
        if (isChoice) {
          if (/^[A-Z](\s*[,，、.·]\s*[A-Z])*[.。]?\s*$/.test(first)) answerLine = first;
          // 否则 answerLine 留空 → 各分支自然解析失败返回 null
                } else answerLine = first;
      }
      log.dbg("[雨课堂助手][INFO][parseAIAnswer] 题目类型:", problem.problemType, "原始答案行:", answerLine);
      switch (problem.problemType) {
       case 1:
 // 单选题
               case 3:
        {
          // 投票题
          let m = answerLine.match(/[ABCDEFGHIJKLMNOPQRSTUVWXYZ]/);
          if (m) {
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 单选/投票解析结果:", [ m[0] ]);
            return [ m[0] ];
          }
          const chineseMatch = answerLine.match(/选择?([ABCDEFGHIJKLMNOPQRSTUVWXYZ])/);
          if (chineseMatch) {
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 单选/投票中文解析结果:", [ chineseMatch[1] ]);
            return [ chineseMatch[1] ];
          }
          log.dbg("[雨课堂助手][INFO][parseAIAnswer] 单选/投票解析失败");
          return null;
        }

       case 2:
        {
          // 多选题
          if (answerLine.includes("、")) {
            const options = answerLine.split("、").map(s => s.trim().match(/[ABCDEFGHIJKLMNOPQRSTUVWXYZ]/)).filter(m => m).map(m => m[0]);
            if (options.length > 0) {
              const result = [ ...new Set(options) ].sort();
              log.dbg("[雨课堂助手][INFO][parseAIAnswer] 多选顿号解析结果:", result);
              return result;
            }
          }
          if (answerLine.includes(",") || answerLine.includes("，")) {
            const options = answerLine.split(/[,，]/).map(s => s.trim().match(/[ABCDEFGHIJKLMNOPQRSTUVWXYZ]/)).filter(m => m).map(m => m[0]);
            if (options.length > 0) {
              const result = [ ...new Set(options) ].sort();
              log.dbg("[雨课堂助手][INFO][parseAIAnswer] 多选逗号解析结果:", result);
              return result;
            }
          }
          const letters = answerLine.match(/[ABCDEFGHIJKLMNOPQRSTUVWXYZ]/g);
          if (letters && letters.length > 1) {
            const result = [ ...new Set(letters) ].sort();
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 多选连续解析结果:", result);
            return result;
          }
          if (letters && letters.length === 1) {
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 多选单个解析结果:", letters);
            return letters;
          }
          log.dbg("[雨课堂助手][INFO][parseAIAnswer] 多选解析失败");
          return null;
        }

       case 4:
        {
          // 填空题
          let cleanAnswer = answerLine.replace(/^(填空题|简答题|问答题|题目|答案是?)[:：\s]*/gi, "").trim();
          log.dbg("[雨课堂助手][INFO][parseAIAnswer] 清理后答案:", cleanAnswer);
          // 如果清理后还包含这些词，继续清理
                    if (/填空题|简答题|问答题|题目/i.test(cleanAnswer)) {
            cleanAnswer = cleanAnswer.replace(/填空题|简答题|问答题|题目/gi, "").trim();
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 二次清理后:", cleanAnswer);
          }
          // 剥掉首尾的非文字字符（引号、括号、句号等）
                    cleanAnswer = cleanAnswer.replace(/^[^\w\u4e00-\u9fa5]+/, "").replace(/[^\w\u4e00-\u9fa5]+$/, "");
          // 多空只按逗号/分号拆——不按空格（"New York" 这类含空格答案会被切碎）
          // 且始终返回数组：填空题端点吃的是多空数组，{content,pics} 是主观题的形状
                    const blanks = cleanAnswer.split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
          if (blanks.length) {
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 填空解析结果:", blanks);
            return blanks;
          }
          log.dbg("[雨课堂助手][INFO][parseAIAnswer] 填空解析失败");
          return null;
        }

       case 5:
        {
          // 主观题
          const content = answerLine.replace(/^(主观题|论述题)[:：\s]*/i, "").trim();
          if (content) {
            const result = {
              content: content,
              pics: []
            };
            log.dbg("[雨课堂助手][INFO][parseAIAnswer] 主观题解析结果:", result);
            return result;
          }
          log.dbg("[雨课堂助手][INFO][parseAIAnswer] 主观题解析失败");
          return null;
        }

       default:
        log.dbg("[雨课堂助手][INFO][parseAIAnswer] 未知题目类型:", problem.problemType);
        return null;
      }
    } catch (e) {
      log.err("[雨课堂助手][ERR][parseAIAnswer] 解析失败", e);
      return null;
    }
  }
  // src/capture/screenshoot.js
    async function captureProblemScreenshot() {
    try {
      const html2canvas = await ensureHtml2Canvas();
      const el = document.querySelector(".ques-title") || document.querySelector(".problem-body") || 
      // 移动版 student/v3：题目卡片在时间线 feed 中
      document.querySelector('.timeline-item [class*="problem"], .timeline-item [class*="ques"], .timeline__problem') || document.querySelector(".ppt-inner") || document.querySelector(".ppt-courseware-inner") || 
      // 移动版兜底：时间线最新一张卡片（老师刚推送的内容）
      [ ...document.querySelectorAll(".student__timeline .timeline-item, .J_cards .timeline-item") ].pop() || null;
      // 不再退回 document.body——把整页截图当题目图发给 AI 既浪费 token 又误导模型
            if (!el) {
        log.warn("[captureProblemScreenshot] 页面上找不到题目/PPT 容器，放弃截图");
        return null;
      }
      return await html2canvas(el, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#ffffff",
        scale: 1,
        width: Math.min(el.scrollWidth, 1200),
        height: Math.min(el.scrollHeight, 800)
      });
    } catch (e) {
      log.err("[captureProblemScreenshot] failed", e);
      return null;
    }
  }
  /**
   * 获取指定幻灯片的截图
   * @param {string} slideId - 幻灯片ID
   * @returns {Promise<string|null>} base64图片数据
   */  async function captureSlideImage(slideId) {
    try {
      log.dbg("[captureSlideImage] 获取幻灯片图片:", slideId);
      const slide = repo.slides.get(String(slideId));
      if (!slide) {
        log.err("[captureSlideImage] 找不到幻灯片:", slideId);
        return null;
      }
      // 使用 cover 或 coverAlt 图片URL
            const imageUrl = slide.coverAlt || slide.cover || slide.image || slide.thumbnail;
      if (!imageUrl) {
        log.err("[captureSlideImage] 幻灯片没有图片URL");
        return null;
      }
      log.dbg("[captureSlideImage] 图片URL:", imageUrl);
      // 下载图片并转换为base64
            const base64 = await downloadImageAsBase64(imageUrl);
      if (!base64) {
        log.err("[captureSlideImage] 下载图片失败");
        return null;
      }
      log.dbg("[captureSlideImage] ✅ 成功获取图片, 大小:", Math.round(base64.length / 1024), "KB");
      return base64;
    } catch (e) {
      log.err("[captureSlideImage] 失败:", e);
      return null;
    }
  }
  /**
   * 下载图片并转换为base64
   * @param {string} url - 图片URL
   * @returns {Promise<string|null>}
   */  async function downloadImageAsBase64(url) {
    // 首选 GM_xhr → dataURL：无视 OSS CORS（crossOrigin=anonymous 在无 CORS 头的域上直接加载失败）
    try {
      const dataUrl = await fetchAsDataURL(url);
      const b64 = String(dataUrl || "").split(",")[1] || "";
      if (b64) return b64;
    } catch (e) {
      log.warn("[downloadImageAsBase64] fetchAsDataURL 失败，退回 Image+canvas:", e?.message);
    }
    return new Promise(resolve => {
      try {
        const img = new Image;
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const base64 = canvas.toDataURL("image/jpeg", .8).split(",")[1];
            if (base64.length > 1e6) {
              log.dbg("[雨课堂助手][INFO][downloadImageAsBase64] 图片过大，进行压缩...");
              const compressed = canvas.toDataURL("image/jpeg", .5).split(",")[1];
              log.dbg("[雨课堂助手][INFO][downloadImageAsBase64] 压缩后大小:", Math.round(compressed.length / 1024), "KB");
              resolve(compressed);
            } else resolve(base64);
          } catch (e) {
            log.err("[雨课堂助手][ERR][downloadImageAsBase64] Canvas处理失败:", e);
            resolve(null);
          }
        };
        img.onerror = e => {
          log.err("[雨课堂助手][ERR][downloadImageAsBase64] 图片加载失败:", e);
          resolve(null);
        };
        img.src = url;
      } catch (e) {
        log.err("[雨课堂助手][ERR][downloadImageAsBase64] 失败:", e);
        resolve(null);
      }
    });
  }
  // 原有的 captureProblemForVision
    async function captureProblemForVision() {
    try {
      log.dbg("[captureProblemForVision] 开始截图...");
      const canvas = await captureProblemScreenshot();
      if (!canvas) {
        log.err("[captureProblemForVision] 截图失败");
        return null;
      }
      log.dbg("[captureProblemForVision] 截图成功，转换为base64...");
      const base64 = canvas.toDataURL("image/jpeg", .8).split(",")[1];
      log.dbg("[captureProblemForVision] base64 长度:", base64.length);
      if (base64.length > 1e6) {
        log.dbg("[captureProblemForVision] 图片过大，进行压缩...");
        const smallerBase64 = canvas.toDataURL("image/jpeg", .5).split(",")[1];
        log.dbg("[captureProblemForVision] 压缩后长度:", smallerBase64.length);
        return smallerBase64;
      }
      return base64;
    } catch (e) {
      log.err("[captureProblemForVision] failed", e);
      return null;
    }
  }
  // src/net/xhr-interceptor.js
    function installXHRInterceptor() {
    class MyXHR extends XMLHttpRequest {
      static handlers=[];
      static addHandler(h) {
        this.handlers.push(h);
      }
      open(method, url, async) {
        const parsed = new URL(url, location.href);
        for (const h of this.constructor.handlers) h(this, method, parsed);
        return super.open(method, url, async ?? true);
      }
      intercept(cb) {
        let payload;
        const rawSend = this.send;
        this.send = body => {
          payload = body;
          return rawSend.call(this, body);
        };
        this.addEventListener("load", () => {
          try {
            cb(JSON.parse(this.responseText), payload);
          } catch {}
        });
      }
    }
    function detectEnvironmentAndAdaptAPI() {
      const hostname = location.hostname;
      if (hostname === "www.yuketang.cn") {
        log.dbg("[xhr] 检测到标准雨课堂环境");
        return "standard";
      }
      if (hostname === "pro.yuketang.cn") {
        log.dbg("[xhr] 检测到荷塘雨课堂环境");
        return "pro";
      }
      if (hostname === "changjiang.yuketang.cn") {
        log.dbg("[xhr] 检测到长江雨课堂环境");
        return "changjiang";
      }
      log.dbg("[xhr] 未知环境:", hostname);
      return "unknown";
    }
    // 环境探测：结果暂未参与分支，仅用于日志标记当前站点
        detectEnvironmentAndAdaptAPI();
    MyXHR.addHandler((xhr, method, url) => {
      const pathname = url.pathname || "";
      log.dbg("[xhr] 请求:", method, pathname, url.search);
      // 课件：精确路径或包含关键字
            if (pathname === "/api/v3/lesson/presentation/fetch" || pathname.includes("presentation") && pathname.includes("fetch")) {
        log.dbg("[雨课堂助手][INFO] 拦截课件请求");
        xhr.intercept(resp => {
          const id = url.searchParams.get("presentation_id");
          log.dbg("[雨课堂助手][INFO] 课件响应:", resp);
          if (resp && (resp.code === 0 || resp.success)) actions.onPresentationLoaded(id, resp.data || resp.result);
        });
        return;
      }
      // 答题
            if (pathname === "/api/v3/lesson/problem/answer" || pathname.includes("problem") && pathname.includes("answer")) {
        log.dbg("[雨课堂助手][INFO] 拦截答题请求");
        xhr.intercept((resp, payload) => {
          try {
            const {problemId: problemId, result: result} = JSON.parse(payload || "{}");
            if (resp && (resp.code === 0 || resp.success)) actions.onAnswerProblem(problemId, result);
          } catch (e) {
            log.err("[雨课堂助手][ERR] 解析答题响应失败:", e);
          }
        });
        return;
      }
      if (url.pathname === "/api/v3/lesson/problem/retry") {
        xhr.intercept((resp, payload) => {
          try {
            // retry 请求体是 { problems: [{ problemId, result, ...}] }
            const body = JSON.parse(payload || "{}");
            const first = Array.isArray(body?.problems) ? body.problems[0] : null;
            if (resp?.code === 0 && first?.problemId) actions.onAnswerProblem(first.problemId, first.result);
          } catch {}
        });
        return;
      }
      if (pathname.includes("/api/")) log.dbg("[雨课堂助手][WARN] 其他API:", method, pathname);
    });
    gm.uw.XMLHttpRequest = MyXHR;
  }
  // ===== 自动进入课堂所需的最小 API 封装 =====
    async function getOnLesson() {
    const origin = location.origin;
    const same = p => new URL(p, origin).toString();
    const candidates = [ same("/api/v3/classroom/on-lesson"), same("/mooc-api/v1/lms/classroom/on-lesson"), same("/apiv3/classroom/on-lesson") ];
    const tries = [];
    let finalList = [];
    let lastErr = null;
    for (const url of candidates) {
      const item = {
        url: url,
        ok: false,
        status: 0,
        note: ""
      };
      try {
        const r = await fetch(url, {
          credentials: "include"
        });
        item.status = r.status;
        if (!r.ok) {
          item.note = `HTTP ${r.status}`;
          tries.push(item);
          continue;
        }
        const text = await r.text();
        // 打个缩略，避免把整段 JSON 打爆
                item.bodySnippet = text.slice(0, 300);
        let j = {};
        try {
          j = JSON.parse(text);
        } catch (_) {
          item.note = "JSON parse failed";
        }
        const list = j?.data?.onLessonClassrooms || j?.result || j?.data || [];
        item.parsedLength = Array.isArray(list) ? list.length : -1;
        if (Array.isArray(list) && list.length) {
          item.ok = true;
          tries.push(item);
          finalList = list;
          break;
        } else {
          item.note ||= "empty list";
          tries.push(item);
        }
      } catch (e) {
        item.note = e && e.message || "fetch error";
        tries.push(item);
        lastErr = e;
      }
    }
    // 调试信息
        try {
      log.dbg(`%c[getOnLesson] host=%s  result=%s  candidates=%d`, "color:#09f", location.hostname, finalList.length ? `OK(${finalList.length})` : "EMPTY", candidates.length);
      tries.forEach((t, i) => {
        log.dbg(`#${i + 1}`, {
          url: t.url,
          ok: t.ok,
          status: t.status,
          note: t.note,
          parsedLength: t.parsedLength,
          bodySnippet: t.bodySnippet
        });
      });
      if (!finalList.length && lastErr) log.warn("[getOnLesson] last error:", lastErr);
    } catch {}
    return finalList;
  }
  // src/net/xhr-interceptor.js
    async function checkinClass(lessonId, opts = {}) {
    const origin = location.origin;
    const same = p => new URL(p, origin).toString();
    const classroomId = opts?.classroomId;
    const headers = {
      "content-type": "application/json",
      xtbz: "ykt"
    };
    // 针对不同网关，使用各自的 payload 形态
        const candidates = [ {
      url: same("/api/v3/lesson/checkin"),
      payload: {
        lessonId: lessonId,
        ...classroomId ? {
          classroomId: classroomId
        } : {}
      },
      // v3: 驼峰
      name: "v3-same"
    }, {
      url: "https://pro.yuketang.cn/api/v3/lesson/checkin",
      payload: {
        lessonId: lessonId,
        ...classroomId ? {
          classroomId: classroomId
        } : {}
      },
      name: "v3-pro"
    }, {
      url: "https://www.yuketang.cn/api/v3/lesson/checkin",
      payload: {
        lessonId: lessonId,
        ...classroomId ? {
          classroomId: classroomId
        } : {}
      },
      name: "v3-www"
    }, {
      url: same("/mooc-api/v1/lms/lesson/checkin"),
      payload: {
        lesson_id: lessonId,
        ...classroomId ? {
          classroom_id: classroomId
        } : {}
      },
      // 旧网关：蛇形
      name: "mooc-same"
    }, {
      url: same("/apiv3/lesson/checkin"),
      payload: {
        lessonId: lessonId,
        ...classroomId ? {
          classroomId: classroomId
        } : {}
      },
      name: "apiv3-same"
    } ];
    const tries = [];
    let lastErr;
    for (const cand of candidates) {
      const item = {
        url: cand.url,
        name: cand.name,
        status: 0,
        note: ""
      };
      try {
        const resp = await fetch(cand.url, {
          method: "POST",
          credentials: "include",
          headers: headers,
          body: JSON.stringify(cand.payload)
        });
        item.status = resp.status;
        const text = await resp.text().catch(() => "");
        item.bodySnippet = text.slice(0, 300);
        if (!resp.ok) {
          item.note = `HTTP ${resp.status}`;
          // 如果 400/401/403，继续试下一条
                    tries.push(item);
          continue;
        }
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          item.note = "JSON parse failed";
        }
        const token = data?.data?.lessonToken || data?.result?.lessonToken || data?.lessonToken;
        const setAuth = resp.headers.get("Set-Auth") || resp.headers.get("set-auth") || null;
        item.note = token ? "OK" : "no token in body";
        tries.push(item);
        if (token) {
          try {
            log.dbg("%c[checkinClass] OK %s", "color:#0a0", cand.name);
            log.dbg("payload:", cand.payload);
            log.dbg("setAuth:", !!setAuth);
          } catch {}
          return {
            token: token,
            setAuth: setAuth,
            raw: data
          };
        }
      } catch (e) {
        item.note = e.message || "fetch error";
        tries.push(item);
        lastErr = e;
      }
    }
    try {
      log.dbg("%c[checkinClass] FAILED host=%s", "color:#f33", location.hostname);
      log.dbg("lessonId:", lessonId, "classroomId:", classroomId);
      tries.forEach((t, i) => log.dbg(`#${i + 1}`, t));
      if (lastErr) log.warn("lastErr:", lastErr);
    } catch {}
    // 抛给上层，由上层走“直跳 lesson 页”的兜底逻辑；带上各候选的状态方便排查
        const summary = tries.map(t => `${t.name}:${t.status || t.note}`).join(" | ");
    throw new Error(`checkinClass 全部候选失败（${summary || "无响应"}）`);
  }
  // src/ui/toolbar.js
  // 精简版工具栏：主面板开关 + 提醒/自动作答快捷开关（其余功能全部收进主面板 tab）
  /**
   * 是否处于雨课堂移动版（功能受限，需引导用户切桌面版）。
   * 判据：路径为 /m/...，或服务端重定向时把 next 写成移动入口（/web/?next=/m/v2）
   */  function isMobileVersionPage() {
    const path = window.location.pathname;
    if (/\/m\/v\d|\/m\/?($|\?)/.test(path)) return true;
    try {
      const next = new URLSearchParams(window.location.search).get("next") || "";
      if (/^\/m\//.test(next)) return true;
    } catch {}
    return false;
  }
  /** 移动端（窄屏或触屏）判定 */  function isNarrowDevice() {
    try {
      if (window.matchMedia?.("(max-width: 560px)").matches) return true;
      if (navigator.maxTouchPoints > 0 && window.innerWidth <= 820) return true;
    } catch {}
    return false;
  }
  function showSwitchToDesktopGuide() {
    if (document.getElementById("ykt-desktop-guide")) return;
    // 用户点过「直接前往桌面版」但又被弹回移动版 → 浏览器桌面模式不彻底（UA-CH 泄露）
        const retried = (() => {
      try {
        return sessionStorage.getItem("yktDesktopRetry") === "1";
      } catch {
        return false;
      }
    })();
    const tip = document.createElement("div");
    tip.id = "ykt-desktop-guide";
    tip.style.cssText = [ "position:fixed", "left:8px", "right:8px", "bottom:8px", "z-index:10000002", "background:#fff8e1", "color:#7a4f01", "border:1px solid #f0c36d", "border-radius:8px", "padding:10px 12px", "font-size:12px", "line-height:1.5", "box-shadow:0 4px 16px rgba(0,0,0,.12)" ].join(";");
    if (!retried) tip.innerHTML = `\n      <div style="font-weight:600;margin-bottom:4px">⚠️ 当前是雨课堂「移动版」，功能受限</div>\n      <div>请点浏览器菜单（<b>···</b>）→ 勾选 <b>请求桌面网站</b> → 然后访问 <b>changjiang.yuketang.cn/v2/web/index</b> 登录使用。</div>\n      <div style="margin-top:6px;display:flex;gap:8px">\n        <button id="ykt-guide-goto" style="flex:1;padding:6px;border:none;border-radius:6px;background:#1d63df;color:#fff;font-size:12px">直接前往桌面版</button>\n        <button id="ykt-guide-close" style="padding:6px 10px;border:1px solid #e2c98b;border-radius:6px;background:transparent;color:#7a4f01;font-size:12px">知道了</button>\n      </div>`; else 
    // 二次引导：此浏览器的桌面模式不彻底，推荐 Firefox
    tip.innerHTML = `\n      <div style="font-weight:600;margin-bottom:4px">⚠️ 此浏览器的「桌面模式」不彻底，雨课堂仍识别为手机</div>\n      <div>原因：Edge 安卓的桌面模式不会修改 <code>Sec-CH-UA-Mobile</code> 请求头，雨课堂服务端据此强制跳回移动版。<b>推荐改用 Firefox 安卓版</b>（它的桌面模式会连同请求头一起切换，已验证可行）：</div>\n      <div style="margin:6px 0">1. 应用商店安装 <b>Firefox</b><br/>2. Firefox 内安装 <b>篡改猴</b> 扩展（addons.mozilla.org 搜 Tampermonkey）<br/>3. 安装本脚本 → 菜单勾选 <b>桌面版网站</b> → 访问雨课堂</div>\n      <div style="margin-top:6px;display:flex;gap:8px">\n        <button id="ykt-guide-firefox" style="flex:1;padding:6px;border:none;border-radius:6px;background:#ff7139;color:#fff;font-size:12px">获取 Firefox</button>\n        <button id="ykt-guide-copy" style="padding:6px 10px;border:1px solid #e2c98b;border-radius:6px;background:transparent;color:#7a4f01;font-size:12px">复制桌面版网址</button>\n        <button id="ykt-guide-close" style="padding:6px 10px;border:1px solid #e2c98b;border-radius:6px;background:transparent;color:#7a4f01;font-size:12px">关闭</button>\n      </div>`;
    document.body.appendChild(tip);
    tip.querySelector("#ykt-guide-goto")?.addEventListener("click", () => {
      try {
        sessionStorage.setItem("yktDesktopRetry", "1");
      } catch {}
      window.location.href = "/v2/web/index";
    });
    tip.querySelector("#ykt-guide-firefox")?.addEventListener("click", () => {
      window.open("https://www.mozilla.org/firefox/android/", "_blank");
    });
    tip.querySelector("#ykt-guide-copy")?.addEventListener("click", e => {
      const btn = e.target;
      navigator.clipboard?.writeText("https://changjiang.yuketang.cn/v2/web/index").then(() => {
        btn.textContent = "已复制";
        setTimeout(() => {
          btn.textContent = "复制桌面版网址";
        }, 1500);
      }).catch(() => {
        ui.toast?.("复制失败，请手动输入 changjiang.yuketang.cn/v2/web/index");
      });
    });
    tip.querySelector("#ykt-guide-close")?.addEventListener("click", () => tip.remove());
  }
  function installToolbar() {
    const bar = document.createElement("div");
    bar.id = "ykt-helper-toolbar";
    bar.innerHTML = `\n    <span id="ykt-btn-shell" class="btn" title="YuketangStudio 主面板"><i class="fas fa-briefcase"></i></span>\n    <span id="ykt-btn-bell" class="btn" title="习题提醒"><i class="fas fa-bell"></i></span>\n    <span id="ykt-btn-auto-answer" class="btn" title="自动作答"><i class="fas fa-magic-wand-sparkles"></i></span>\n  `;
    document.body.appendChild(bar);
    // 移动版页面：给出「切桌面版」引导（脚本虽已注入，但页面本身功能受限）。
    // 课堂页不弹——跟随/课件/AI 在 /m/v2/lesson 已可用，全宽引导条上课期间太吵
        if (isMobileVersionPage() && !/\/lesson\//.test(location.pathname)) {
      log.warn("[toolbar] 检测到雨课堂移动版，已显示桌面版引导");
      showSwitchToDesktopGuide();
    }
    // 初始激活态
        if (ui.config.notifyProblems) bar.querySelector("#ykt-btn-bell")?.classList.add("active");
    ui.updateAutoAnswerBtn();
    // 主面板——读 shell 真实可见性（按钮态由 showShell 统一同步，避免两处状态漂移）
        bar.querySelector("#ykt-btn-shell")?.addEventListener("click", () => {
      const shellVisible = !!document.getElementById("ykt-shell-panel")?.classList.contains("visible");
      ui.showShellPanel?.(!shellVisible);
    });
    // 习题提醒开关
        bar.querySelector("#ykt-btn-bell")?.addEventListener("click", () => {
      ui.config.notifyProblems = !ui.config.notifyProblems;
      ui.saveConfig();
      ui.toast(`习题提醒：${ui.config.notifyProblems ? "开" : "关"}`);
      bar.querySelector("#ykt-btn-bell")?.classList.toggle("active", ui.config.notifyProblems);
    });
    // 自动作答开关
        bar.querySelector("#ykt-btn-auto-answer")?.addEventListener("click", () => {
      ui.config.autoAnswer = !ui.config.autoAnswer;
      ui.saveConfig();
      ui.toast(`自动作答：${ui.config.autoAnswer ? "开" : "关"}`);
      ui.updateAutoAnswerBtn();
    });
  }
  // src/state/actions.js
    let _autoLoopStarted = false;
  let _autoJoinStarted = false;
  let _autoOnLessonClickStarted = false;
  let _autoOnLessonClickInProgress = false;
  let _routerHooked = false;
  // 无AI默认答案生成
    function makeDefaultAnswer(problem) {
    switch (problem.problemType) {
     case 1:
 // 单选
           case 2:
 // 多选
           case 3:
      // 投票
      return [ "A" ];

     case 4:
      // 填空
      // 按需求示例返回 [" 1"]（保留前导空格）
      return [ " 1" ];

     case 5:
      // 主观/问答
      return {
        content: "略",
        pics: []
      };

     default:
      // 兜底：按单选处理
      return [ "A" ];
    }
  }
  function hasActiveAIProfile(aiCfg) {
    const cfg = aiCfg || {};
    const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
    if (profiles.length > 0) {
      const activeId = cfg.activeProfileId;
      const p = profiles.find(x => x.id === activeId) || profiles[0];
      return !!(p && p.apiKey);
    }
    // 兼容旧版
        return !!cfg.kimiApiKey;
  }
  // 融合模式自动答题
    async function handleAutoAnswerInternal(problem) {
    const status = repo.problemStatus.get(String(problem.problemId));
    if (!status || status.answering || problem.result) {
      log.dbg("[AutoAnswer] 跳过：", {
        hasStatus: !!status,
        answering: status?.answering,
        hasResult: !!problem.result
      });
      return;
    }
    // endTime 为 null 表示不限时；判过期用服务端时钟（clockOffset 修正本地偏差）
        const serverNow = Date.now() + (status.clockOffset || 0);
    if (status.endTime != null && serverNow >= status.endTime) {
      log.dbg("[雨课堂助手][WARN][AutoAnswer] 跳过：已超时");
      return;
    }
    status.answering = true;
    try {
      log.dbg("[雨课堂助手][INFO][AutoAnswer] =================================");
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 开始自动答题");
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 题目ID:", problem.problemId);
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 题目类型:", PROBLEM_TYPE_MAP[problem.problemType]);
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 题目内容:", problem.body?.slice(0, 50) + "...");
      if (!hasActiveAIProfile(ui.config.ai)) {
        // 无 API Key 时默认跳过（宁缺答不误答）；用户在设置里显式开启才提交兜底答案
        if (!ui.config.autoAnswerFallbackDefault) {
          status.answering = false;
          log.warn("[雨课堂助手][WARN][AutoAnswer] 未配置 API Key，跳过自动作答（可在设置开启「无 Key 提交兜底答案」）");
          return ui.toast("未配置 API Key，已跳过自动作答", 3e3);
        }
        const parsed = makeDefaultAnswer(problem);
        log.dbg("[雨课堂助手][WARN][AutoAnswer] 无 API Key，使用本地默认答案:", JSON.stringify(parsed));
        // 提交答案（根据时限自动选择 answer/retry 逻辑）
                await submitAnswer(problem, parsed, {
          startTime: status.startTime,
          endTime: status.endTime,
          forceRetry: false,
          autoGate: false,
          // 延时已在 autoAnswerTime 调度阶段做过
          lessonId: repo.currentLessonId
        });
        // 更新状态与UI
                actions.onAnswerProblem(problem.problemId, parsed);
        status.done = true;
        status.answering = false;
        ui.toast("使用默认答案完成作答（未配置 API Key）", 3e3);
        showAutoAnswerPopup(problem, "（本地默认答案：无 API Key）");
        log.dbg("[雨课堂助手][INFO][AutoAnswer] 默认答案提交流程结束");
        return;
 // 提前返回，避免继续走图像+AI流程
            }
      const slideId = status.slideId;
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 题目所在幻灯片:", slideId);
      log.dbg("[雨课堂助手][INFO][AutoAnswer] =================================");
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 使用融合模式分析（文本+幻灯片图片）...");
      let imageBase64 = await captureSlideImage(slideId);
      // 如果获取幻灯片图片失败，回退到DOM截图
            if (!imageBase64) {
        log.dbg("[雨课堂助手][WARN][AutoAnswer] 无法获取幻灯片图片，尝试使用DOM截图...");
        const fallbackImage = await captureProblemForVision();
        if (!fallbackImage) {
          status.answering = false;
          log.err("[雨课堂助手][ERR][AutoAnswer] 所有截图方法都失败");
          return ui.toast("无法获取题目图像，跳过自动作答", 3e3);
        }
        imageBase64 = fallbackImage;
        log.dbg("[雨课堂助手][INFO][AutoAnswer] DOM截图成功");
      } else log.dbg("[雨课堂助手][INFO][AutoAnswer] 幻灯片图片获取成功");
      // 构建提示
            const hasTextInfo = problem.body && problem.body.trim();
      const textPrompt = formatProblemForVision(problem, PROBLEM_TYPE_MAP, hasTextInfo);
      // 调用 AI（带题型提示，解析器按题型取答案形状）
            ui.toast("AI 正在分析题目...", 2e3);
      const aiAnswer = await queryAIVision(imageBase64, textPrompt, ui.config.ai, {
        problemType: problem.problemType
      });
      log.dbg("[雨课堂助手][INFO][AutoAnswer] AI回答:", aiAnswer);
      // 解析答案
            const parsed = parseAIAnswer(problem, aiAnswer);
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 解析结果:", parsed);
      if (!parsed) {
        status.answering = false;
        log.err("[雨课堂助手][ERR][AutoAnswer] 解析失败，AI回答格式不正确");
        return ui.toast("无法解析AI答案，请检查格式", 3e3);
      }
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 准备提交答案:", JSON.stringify(parsed));
      // 提交答案
            await submitAnswer(problem, parsed, {
        startTime: status.startTime,
        endTime: status.endTime,
        forceRetry: false,
        autoGate: false,
        // 延时已在 autoAnswerTime 调度阶段做过
        lessonId: repo.currentLessonId
      });
      log.dbg("[雨课堂助手][INFO][AutoAnswer] 提交成功");
      // 更新状态
            actions.onAnswerProblem(problem.problemId, parsed);
      status.done = true;
      status.answering = false;
      ui.toast(`自动作答完成`, 3e3);
      showAutoAnswerPopup(problem, aiAnswer);
    } catch (e) {
      log.err("[雨课堂助手][ERR][AutoAnswer] 失败:", e);
      log.err("[雨课堂助手][ERR][AutoAnswer] 错误堆栈:", e.stack);
      status.answering = false;
      ui.toast(`自动作答失败: ${e.message}`, 4e3);
    }
  }
  const actions = {
    onFetchTimeline(timeline) {
      for (const piece of timeline) if (piece.type === "problem") this.onUnlockProblem(piece);
    },
    onPresentationLoaded(id, data) {
      repo.setPresentation(id, data);
      const pres = repo.presentations.get(String(id));
      for (const slide of pres.slides) {
        repo.upsertSlide(slide);
        if (slide.problem) {
          repo.upsertProblem(slide.problem);
          repo.pushEncounteredProblem(slide.problem, slide, id);
        }
      }
      // 课件晚于 unlockproblem 到达时，重放暂存的解锁事件
            this._replayPendingUnlocks();
      ui.updatePresentationList();
    },
    /** 重放暂存的 unlockproblem（课件 XHR 晚于 WS 到达的竞态） */
    _replayPendingUnlocks() {
      if (!repo.pendingUnlocks.length) return;
      const list = repo.pendingUnlocks.splice(0);
      for (const d of list) {
        const ok = repo.problems.has(String(d.prob)) && repo.slides.has(String(d.sid));
        if (ok) {
          this.onUnlockProblem(d);
          continue;
        }
        // 仍未命中→限次放回队列（课件永不到达时防止队列无限膨胀）
                if ((d._tries = (d._tries || 0) + 1) < 3) repo.pendingUnlocks.push(d); else log.warn("[onUnlockProblem] 重放多次仍未命中，丢弃:", d.prob);
      }
      // 队列还有剩余→再过 3s 重试一轮（课件 XHR 可能仍在路上）
            if (repo.pendingUnlocks.length) {
        clearTimeout(this._unlockRetryTimer);
        this._unlockRetryTimer = setTimeout(() => this._replayPendingUnlocks(), 3e3);
      }
    },
    onUnlockProblem(data) {
      const problem = repo.problems.get(String(data.prob));
      const slide = repo.slides.get(String(data.sid));
      if (!problem || !slide) {
        // WS 的 unlockproblem 可能先于课件 XHR 到达——暂存重放，而不是直接丢
        log.dbg("[雨课堂助手][DBG][onUnlockProblem] 题目或幻灯片尚未就绪，暂存待重放:", {
          prob: data.prob,
          sid: data.sid
        });
        if (repo.pendingUnlocks.length >= 20) repo.pendingUnlocks.shift();
        repo.pendingUnlocks.push(data);
        clearTimeout(this._unlockRetryTimer);
        this._unlockRetryTimer = setTimeout(() => this._replayPendingUnlocks(), 3e3);
        return;
      }
      log.dbg("[雨课堂助手][DBG][onUnlockProblem] 题目解锁");
      log.dbg("[雨课堂助手][DBG][onUnlockProblem] 题目ID:", data.prob);
      log.dbg("[雨课堂助手][DBG][onUnlockProblem] 幻灯片ID:", data.sid);
      log.dbg("[雨课堂助手][DBG][onUnlockProblem] 课件ID:", data.pres);
      const dt = Number.isFinite(+data.dt) ? +data.dt : Date.now();
      const limitS = Number(data.limit);
      // clockOffset = 服务端时钟 - 本地时钟：endTime 基于服务端时间轴，判过期时必须换算
            const clockOffset = dt - Date.now();
      const prev = repo.problemStatus.get(String(data.prob));
      const status = {
        presentationId: data.pres,
        slideId: String(data.sid),
        startTime: dt,
        endTime: Number.isFinite(limitS) && limitS > 0 ? dt + 1e3 * limitS : null,
        // null = 不限时
        clockOffset: clockOffset,
        done: !!problem.result,
        autoAnswerTime: null,
        answering: !!prev?.answering
      };
      repo.problemStatus.set(String(data.prob), status);
      const serverNow = Date.now() + clockOffset;
      if (status.endTime != null && serverNow > status.endTime || problem.result) {
        log.dbg("[雨课堂助手][WARN][onUnlockProblem] 题目已过期或已作答，跳过");
        return;
      }
      if (ui.config.notifyProblems) ui.notifyProblem(problem, slide);
      if (ui.config.autoAnswer) {
        const delay = ui.config.autoAnswerDelay + randInt(0, ui.config.autoAnswerRandomDelay);
        status.autoAnswerTime = Date.now() + delay;
        log.dbg(`[雨课堂助手][INFO][onUnlockProblem] 将在 ${Math.floor(delay / 1e3)} 秒后自动作答`);
        ui.toast(`将在 ${Math.floor(delay / 1e3)} 秒后使用融合模式自动作答`, 3e3);
      }
      ui.updateActiveProblems();
    },
    onLessonFinished() {
      ui.nativeNotify({
        title: "下课提示",
        text: "当前课程已结束",
        timeout: 5e3
      });
    },
    onAnswerProblem(problemId, result) {
      const p = repo.problems.get(String(problemId));
      if (p) {
        p.result = result;
        const i = repo.encounteredProblems.findIndex(e => String(e.problemId) === String(problemId));
        if (i !== -1) repo.encounteredProblems[i].result = result;
      }
    },
    async handleAutoAnswer(problem) {
      return handleAutoAnswerInternal(problem);
    },
    async submit(problem, content) {
      const result = this.parseManual(problem.problemType, content);
      if (!result || Array.isArray(result) && !result.length) return ui.toast("答案为空或无法识别（选择题为选项字母，填空每空一行/逗号分隔）", 2500);
      await submitAnswer(problem, result, {
        lessonId: repo.currentLessonId,
        autoGate: false
      });
      this.onAnswerProblem(problem.problemId, result);
    },
    parseManual(problemType, content) {
      switch (problemType) {
       // 选择/投票：只取选项字母（防混入空格/标点被当成答案提交）
        case 1:
       case 2:
       case 3:
        return (String(content).toUpperCase().match(/[A-Z]/g) || []).sort();

        // 填空：按行或逗号/分号分多空
               case 4:
        return String(content).split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean);

       case 5:
        return {
          content: content,
          pics: []
        };

       default:
        return null;
      }
    },
    navigateTo(presId, slideId) {
      repo.currentPresentationId = presId;
      repo.currentSlideId = slideId;
      ui.updateSlideView();
      ui.showPresentationPanel(true);
    },
    /** 从 URL 刷新当前课堂 id（fullscreen/student v3 与移动版 /m/v2/lesson/* 都认；SPA 路由变化时重取） */
    _syncLessonIdFromURL() {
      const m = location.pathname.match(/\/lesson\/(?:fullscreen|student)\/v3\/([^/]+)/) || location.pathname.match(/\/m\/v\d+\/lesson\/[^/]+\/([^/]+)/);
      const id = m ? m[1] : null;
      if (id !== repo.currentLessonId) {
        repo.currentLessonId = id;
        if (id) {
          log.dbg(`[雨课堂助手][DBG] 检测到课堂页面 lessonId: ${id}`);
          repo.loadStoredPresentations();
        }
      }
    },
    launchLessonHelper() {
      this._syncLessonIdFromURL();
      if (typeof window.GM_getTab === "function" && typeof window.GM_saveTab === "function" && repo.currentLessonId) window.GM_getTab(tab => {
        tab.type = "lesson";
        tab.lessonId = repo.currentLessonId;
        window.GM_saveTab(tab);
      });
      this.maybeStartAutoJoin();
      this.installRouterRearm();
      // 移动版课堂页（/m/v2/lesson/*、/lesson/student/v3）：XHR 拦截器在这些页面
      // 抓不到课件数据，Vue store 的 lessonTimelineSlides/cards 是唯一来源——
      // 周期性镜像进 repo（老师翻页会追加条目；幂等 upsert）
            if (/\/lesson\//.test(location.pathname)) {
        const sync = () => {
          try {
            syncMobileSlidesIntoRepo();
          } catch {}
        };
        sync();
        setInterval(sync, 4e3);
      }
    },
    startAutoAnswerLoop() {
      if (_autoLoopStarted) return;
      _autoLoopStarted = true;
      setInterval(() => {
        const now = Date.now();
        repo.problemStatus.forEach((status, pid) => {
          if (status.autoAnswerTime !== null && now >= status.autoAnswerTime) {
            const problem = repo.problems.get(pid);
            if (problem && !problem.result) {
              status.autoAnswerTime = null;
              handleAutoAnswerInternal(problem);
            }
          }
        });
      }, 500);
    },
    // 自动进入课堂
    startAutoJoinLoop() {
      if (_autoJoinStarted) return;
      _autoJoinStarted = true;
      repo.autoJoinRunning = true;
      const loop = async () => {
        if (!repo.autoJoinRunning) return;
        try {
          const list = await getOnLesson();
          // 期望结构：每项至少含 { lessonId, status }，其中 status==1 表示正在上课
                    for (const it of list) {
            const lessonId = it.lessonId || it.lesson_id || it.id;
            const status = it.status;
            if (!lessonId || status !== 1) continue;
            if (repo.isLessonConnected(lessonId)) continue;
 // 已有连接
                        log.dbg("[雨课堂助手][INFO][AutoJoin] 检测到正在上课的课堂，准备进入:", lessonId);
            try {
              const {token: token} = await checkinClass(lessonId);
              if (!token) {
                log.warn("[雨课堂助手][WARN][AutoJoin] 未获取到 lessonToken，跳过:", lessonId);
                continue;
              }
              connectOrAttachLessonWS({
                lessonId: lessonId,
                auth: token
              });
              // 标记该课堂为“自动进入”
                            repo.markLessonAutoJoined(lessonId, true);
              if (ui.config.autoAnswerOnAutoJoin) repo.forceAutoAnswerLessons.add(lessonId);
            } catch (e) {
              log.err("[雨课堂助手][ERR][AutoJoin] 进入课堂失败:", lessonId, e);
            }
          }
        } catch (e) {
          log.err("[雨课堂助手][ERR][AutoJoin] 拉取正在上课失败:", e);
        } finally {
          setTimeout(loop, 5e3);
        }
      };
      loop();
    },
    stopAutoJoinLoop() {
      repo.autoJoinRunning = false;
    },
    /** 统一判断并启动自动加入链路（可多次调用，内部防重） */
    maybeStartAutoJoin() {
      if (!ui.config.autoJoinEnabled) return;
      this.startAutoJoinLoop();
      this.startAutoClickOnOnLessonBar();
    },
    /** 前端路由变化时，重新检查并挂载自动加入 */
    installRouterRearm() {
      if (_routerHooked) return;
      _routerHooked = true;
      const uw = gm && gm.uw ? gm.uw : window.unsafeWindow || window;
      const rearm = () => {
        // 重置一次“onlesson 点击守卫”的进行中标记，避免被卡住
        _autoOnLessonClickInProgress = false;
        // SPA 路由可能切到别的课堂——重新从 URL 取 lessonId 并重载本地课件
                this._syncLessonIdFromURL();
        // 每次路由变更都尝试启动（内部有防重，所以安全）
                this.maybeStartAutoJoin();
      };
      const wrap = (obj, key) => {
        const orig = obj[key];
        obj[key] = function(...args) {
          const ret = orig.apply(this, args);
          try {
            rearm();
          } catch {}
          return ret;
        };
      };
      wrap(uw.history, "pushState");
      wrap(uw.history, "replaceState");
      uw.addEventListener("popstate", rearm);
      uw.addEventListener("visibilitychange", () => {
        if (!document.hidden) rearm();
      });
    },
    // ===== 自动点击“正在上课”条：无需预先拿 lesson_id，复用官方路由逻辑 =====
    startAutoClickOnOnLessonBar() {
      if (_autoOnLessonClickStarted) return;
      // 仅在非课堂页（首页/课表页等）生效；先判断再置标志——
      // 否则课堂页提前 return 会把标志钉死，从课堂退回首页后功能再也装不上
            if (/\/lesson\//.test(location.pathname)) return;
      _autoOnLessonClickStarted = true;
      const uw = gm && gm.uw ? gm.uw : window.unsafeWindow || window;
      async function tryApiJumpFirst() {
        if (_autoOnLessonClickInProgress) return false;
        _autoOnLessonClickInProgress = true;
        try {
          const list = await getOnLesson();
 // ← 强化后的版本
                    const arr = Array.isArray(list) ? list : [];
          // A) 严格：status===1
                    let on = arr.find(x => x?.status === 1 && (x.lessonId || x.lesson_id || x.id));
          // B) 回退：没有严格匹配，但有 lessonId 就用第一条
                    if (!on) {
            const withId = arr.find(x => x && (x.lessonId || x.lesson_id || x.id));
            if (withId) {
              log.warn("[雨课堂助手][WARN][AutoJoin][API] 没有 status===1，但存在 lessonId，使用回退项：", {
                status: withId.status,
                keys: Object.keys(withId || {}),
                sample: withId
              });
              on = withId;
            }
          }
          if (!on) {
            // 详细日志：环境、主机、列表长度与前 3 项
            try {
              log.warn("[雨课堂助手][ERR][AutoJoin][API] EMPTY on-lesson list", {
                host: location.hostname,
                path: location.pathname,
                length: Array.isArray(list) ? list.length : -1,
                sample: Array.isArray(list) ? list.slice(0, 3) : list
              });
            } catch {}
            _autoOnLessonClickInProgress = false;
            return false;
          }
          const lessonId = on.lessonId || on.lesson_id || on.id;
          let target = null;
          if (lessonId) {
            // 移动版入口跳 student/v3（移动端的课堂页），桌面跳 fullscreen/v3
            const onMobile = isMobileVersionPage() || isNarrowDevice();
            target = onMobile ? `/lesson/student/v3/${lessonId}` : `/lesson/fullscreen/v3/${lessonId}`;
          } else target = `/v2/web/lesson/${lessonId}`;
          if (location.pathname === target) {
            _autoOnLessonClickInProgress = false;
            return true;
          }
          location.assign(target);
          return true;
        } catch (e) {
          log.warn("[雨课堂助手][ERR][AutoJoin][API] 跳转失败：", e, {
            host: location.hostname,
            path: location.pathname
          });
          _autoOnLessonClickInProgress = false;
          return false;
        }
      }
      function attachGuardAndTrigger(root = uw.document) {
        const bar = root.querySelector(".onlesson .jump_lesson__bar");
        if (!bar || bar.__ykt_guard_bound__) return false;
        if (_autoOnLessonClickInProgress) return false;
        bar.__ykt_guard_bound__ = true;
        log.dbg("[雨课堂助手][INFO][AutoJoin][DOM] 发现 onlesson 条，接管点击（捕获阶段）");
        const handler = async ev => {
          ev.preventDefault();
          ev.stopImmediatePropagation?.();
          ev.stopPropagation();
          if (_autoOnLessonClickInProgress) return;
          // 延时阶梯：考虑 WS 刚推完 banner 但接口还没更新
                    const delays = [ 0, 250, 600, 1200, 2e3, 3e3 ];
          for (const d of delays) {
            if (d) await new Promise(r => setTimeout(r, d));
            if (await tryApiJumpFirst()) return;
          }
          log.warn("[雨课堂助手][WARN][AutoJoin][DOM] on-lesson 接口仍为空，放弃本次点击");
          try {
            log.dbg("%c[AutoJoin][DOM] on-lesson 仍为空，放弃本次点击", "color:#f60");
            log.dbg("env:", {
              host: location.hostname,
              path: location.pathname,
              href: location.href
            });
            log.dbg("retryDelays(ms):", delays);
            log.dbg("hint:", "可能是域/路径不匹配、会话未带上、或 WS/接口不同步导致。请展开上方 [getOnLesson] 折叠日志查看每个候选 URL 的状态与响应片段。");
          } catch {}
        };
        bar.addEventListener("click", handler, {
          capture: true
        });
        // 触发一次我们自己的 click（优先进入捕获处理器）
                try {
          const W = bar.ownerDocument?.defaultView || uw;
          const ClickEvt = W.MouseEvent || uw.MouseEvent;
          bar.dispatchEvent(new ClickEvt("click", {
            bubbles: true,
            cancelable: true,
            view: W
          }));
        } catch (e) {
          // 兜底：部分环境对 MouseEvent 构造器有限制
          try {
            bar.click();
          } catch (_) {}
        }
        return true;
      }
      // A) 首选：直接 API 跳转（若此时就能拿到 on-lesson，就不必等 DOM）
            tryApiJumpFirst().then(ok => {
        if (ok) return;
        // B) DOM 渲染后接管点击
                if (attachGuardAndTrigger()) return;
        const mo = new uw.MutationObserver(() => {
          if (attachGuardAndTrigger()) {
            mo.disconnect();
            return;
          }
        });
        mo.observe(uw.document.documentElement, {
          childList: true,
          subtree: true
        });
        // MO 挂太久是页面级性能开销——30s 内没等到 onlesson 条就放弃
                setTimeout(() => {
          try {
            mo.disconnect();
          } catch {}
        }, 3e4);
      });
    }
  };
  // src/net/ws-interceptor.js
    function installWSInterceptor() {
    // 环境识别（标准/荷塘/长江/未知），主要用于日志和后续按需适配
    function detectEnvironmentAndAdaptAPI() {
      const hostname = location.hostname;
      let envType = "unknown";
      if (hostname === "www.yuketang.cn") {
        envType = "standard";
        log.dbg("[雨课堂助手][INFO] 检测到标准雨课堂环境");
      } else if (hostname === "pro.yuketang.cn") {
        envType = "pro";
        log.dbg("[雨课堂助手][INFO] 检测到荷塘雨课堂环境");
      } else if (hostname === "changjiang.yuketang.cn") {
        envType = "changjiang";
        log.dbg("[雨课堂助手][INFO] 检测到长江雨课堂环境");
      } else log.dbg("[雨课堂助手][INFO] 未知环境:", hostname);
      return envType;
    }
    class MyWebSocket extends WebSocket {
      static handlers=[];
      static addHandler(h) {
        this.handlers.push(h);
      }
      constructor(url, protocols) {
        super(url, protocols);
        const parsed = new URL(url, location.href);
        for (const h of this.constructor.handlers) h(this, parsed);
      }
      intercept(cb) {
        const raw = this.send;
        this.send = data => {
          try {
            cb(JSON.parse(data));
          } catch {}
          return raw.call(this, data);
        };
      }
      listen(cb) {
        this.addEventListener("message", e => {
          try {
            cb(JSON.parse(e.data));
          } catch {}
        });
      }
    }
    MyWebSocket.addHandler((ws, url) => {
      const envType = detectEnvironmentAndAdaptAPI();
      log.dbg("[雨课堂助手][INFO] 拦截WebSocket通信 - 环境:", envType);
      log.dbg("[雨课堂助手][INFO] WebSocket连接尝试:", url.href);
      // 更宽松的路径匹配
            const wsPath = url.pathname || "";
      const isRainClassroomWS = wsPath === "/wsapp/" || wsPath.includes("/ws") || wsPath.includes("/websocket") || url.href.includes("websocket");
      if (!isRainClassroomWS) {
        log.dbg("[雨课堂助手][ERR] 非雨课堂WebSocket:", wsPath);
        return;
      }
      log.dbg("[雨课堂助手][INFO] 检测到雨课堂WebSocket连接:", wsPath);
      // 发送侧拦截（可用于调试）
            ws.intercept(message => {
        log.dbg("[雨课堂助手][INFO] WebSocket发送:", message);
      });
      // 接收侧统一分发
            ws.listen(dispatchWSMessage);
    });
    gm.uw.WebSocket = MyWebSocket;
  }
  /** WS 消息统一分发：页面侧被拦截的连接与脚本自建（auto-join）连接共用 */  function dispatchWSMessage(message) {
    try {
      log.dbg("[雨课堂助手][INFO] WebSocket接收:", message);
      switch (message.op) {
       case "fetchtimeline":
        log.dbg("[雨课堂助手][INFO] 收到时间线:", message.timeline);
        actions.onFetchTimeline(message.timeline);
        break;

       case "unlockproblem":
        log.dbg("[雨课堂助手][INFO] 收到解锁问题:", message.problem);
        actions.onUnlockProblem(message.problem);
        break;

       case "lessonfinished":
        log.dbg("[雨课堂助手][INFO] 课程结束");
        actions.onLessonFinished();
        break;

       default:
        log.dbg("[雨课堂助手][WARN] 未知WebSocket操作:", message.op, message);
      }
      // 监听后端传递的url
            const url = function findUrl(obj) {
        if (!obj || typeof obj !== "object") return null;
        if (typeof obj.url === "string") return obj.url;
        if (Array.isArray(obj)) for (const it of obj) {
          const u = findUrl(it);
          if (u) return u;
        } else for (const k in obj) {
          const v = obj[k];
          if (v && typeof v === "object") {
            const u = findUrl(v);
            if (u) return u;
          }
        }
        return null;
      }(message);
      if (url) {
        window.dispatchEvent(new CustomEvent("ykt:url-change", {
          detail: {
            url: url,
            raw: message
          }
        }));
        repo.currentSelectedUrl = url;
        log.dbg("[雨课堂助手][INFO] 当前选择 URL:", url);
      }
    } catch (e) {
      log.dbg("[雨课堂助手][ERR] 解析WebSocket消息失败", e, message);
    }
  }
  // ===== 主动为某个课堂建立/复用 WebSocket 连接 =====
    function connectOrAttachLessonWS({lessonId: lessonId, auth: auth}) {
    if (!lessonId || !auth) {
      log.warn("[雨课堂助手][WARN] 缺少 lessonId 或 auth，放弃建链");
      return null;
    }
    if (repo.isLessonConnected(lessonId)) return repo.lessonSockets.get(lessonId);
    // 根据当前域名选择 ws 地址（标准/荷塘/长江跟随当前域）
        const host = `wss://${location.hostname}/wsapp/`;
    const ws = new WebSocket(host);
    ws.addEventListener("open", () => {
      try {
        const hello = {
          op: "hello",
          // userid 可选：尽力获取，获取不到也不阻断流程
          userid: getUserIdSafe(),
          role: "student",
          auth: auth,
          // 关键：lessonToken
          lessonid: lessonId
        };
        ws.send(JSON.stringify(hello));
        log.dbg("[雨课堂助手][INFO][AutoJoin] 已发送 hello 握手:", hello);
      } catch (e) {
        log.err("[雨课堂助手][INFO][AutoJoin] 发送 hello 失败:", e);
      }
    });
    // 自建连接也要吃消息流——否则自动进入的课堂永远收不到 unlockproblem
        ws.addEventListener("message", e => {
      try {
        dispatchWSMessage(JSON.parse(e.data));
      } catch {}
    });
    ws.addEventListener("close", () => {
      log.dbg("[雨课堂助手][WARN][AutoJoin] 课堂 WS 关闭:", lessonId);
      // 清掉死连接——否则 isLessonConnected 仍返回旧 socket，断线后永远不会重连
            if (repo.lessonSockets.get(lessonId) === ws) repo.lessonSockets.delete(lessonId);
      repo.listeningLessons.delete(lessonId);
    });
    ws.addEventListener("error", e => {
      log.err("[雨课堂助手][ERR][AutoJoin] 课堂 WS 错误:", lessonId, e);
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
    return;
  }
  (function interceptFetch() {
    if (window.__YKT_FETCH_PATCHED__) return;
    window.__YKT_FETCH_PATCHED__ = true;
    const rawFetch = window.fetch;
    window.fetch = async function(...args) {
      const [input] = args;
      const url = typeof input === "string" ? input : input?.url || "";
      // === (1) 打印调试日志，可观察哪些接口走 fetch ===
            if (url.includes("lesson") || url.includes("slide") || url.includes("problem")) log.dbg("[雨课堂助手][INFO][fetch-interceptor] 捕获请求:", url);
      const resp = await rawFetch.apply(this, args);
      try {
        // === (2) 只拦截 Rain Classroom 的 JSON 接口（错误响应/非 JSON 不必克隆解析） ===
        if (resp.ok && (resp.headers.get("content-type") || "").includes("json") && (url.includes("/lesson") || url.includes("/presentation") || url.includes("/slides") || url.includes("/problem"))) {
          const cloned = resp.clone();
          const text = await cloned.text();
          // 这里不能直接 resp.json()，否则流会被消费；必须 clone()
                    const json = JSON.parse(text);
          // === (3) 关键：提取 slides 并灌入 repo.slides ===
                    if (json && json.data && json.data.slides) {
            const slides = json.data.slides;
            let filled = 0;
            for (const s of slides) {
              const sid = String(s.id);
              if (!repo.slides.has(sid)) {
                repo.slides.set(sid, s);
                filled++;
              }
            }
            log.dbg(`雨课堂助手][INFO][fetch-interceptor] 已填充 slides ${filled}/${slides.length}`);
          }
        }
      } catch (e) {
        log.warn("[雨课堂助手][ERR][fetch-interceptor] 解析响应失败:", e);
      }
      return resp;
 // 一定要返回原始 Response
        };
    log.dbg("[雨课堂助手][INFO][fetch-interceptor] fetch() 已被拦截");
  })();
  var css = '/* ===== 通用 & 修复 ===== */\n#watermark_layer { display: none !important; visibility: hidden !important; }\n.hidden { display: none !important; }\n\n:root{\n  --ykt-z: 10000000;\n  --ykt-border: #ddd;\n  --ykt-border-strong: #ccc;\n  --ykt-bg: #fff;\n  --ykt-fg: #222;\n  --ykt-muted: #607190;\n  --ykt-accent: #1d63df;\n  --ykt-hover: #1e3050;\n  --ykt-shadow: 0 10px 30px rgba(0,0,0,.18);\n}\n\n/* ===== 工具栏 ===== */\n#ykt-helper-toolbar{\n  position: fixed; z-index: calc(var(--ykt-z) + 1);\n  left: 15px; bottom: 15px;\n  /* 移除固定宽度，让内容自适应 */\n  height: 36px; padding: 5px;\n  display: flex; gap: 6px; align-items: center;\n  background: var(--ykt-bg);\n  border: 1px solid var(--ykt-border-strong);\n  border-radius: 4px;\n  box-shadow: 0 1px 4px 3px rgba(0,0,0,.1);\n}\n\n#ykt-helper-toolbar .btn{\n  display: inline-block; padding: 4px; cursor: pointer;\n  color: var(--ykt-muted); line-height: 1;\n}\n#ykt-helper-toolbar .btn:hover{ color: var(--ykt-hover); }\n#ykt-helper-toolbar .btn.active{ color: var(--ykt-accent); }\n\n/* 手机/窄屏：工具栏改为纵向贴左，按钮放大到可触控尺寸 */\n@media (max-width: 560px) {\n  #ykt-helper-toolbar{\n    left: 8px; bottom: 8px;\n    flex-direction: column;\n    height: auto; padding: 4px;\n  }\n  #ykt-helper-toolbar .btn{\n    width: 40px; height: 40px;\n    display: inline-flex; align-items: center; justify-content: center;\n    font-size: 17px;\n  }\n}\n\n/* ===== 面板通用样式 ===== */\n.ykt-panel{\n  position: fixed; right: 20px; bottom: 60px;\n  width: min(560px, calc(100vw - 48px));   /* 窄窗口不溢出 */\n  max-height: min(72vh, calc(100vh - 140px)); overflow: auto;\n  background: var(--ykt-bg); color: var(--ykt-fg);\n  border: 1px solid var(--ykt-border-strong); border-radius: 8px;\n  box-shadow: var(--ykt-shadow);\n  display: none;\n  /* 提高z-index，确保后打开的面板在最上层 */\n  z-index: var(--ykt-z);\n}\n.ykt-panel.visible{ \n  display: block; \n  /* 动态提升z-index */\n  z-index: calc(var(--ykt-z) + 10);\n}\n\n.panel-header{\n  display: flex; align-items: center; justify-content: space-between;\n  gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--ykt-border);\n}\n.panel-header h3{ margin: 0; font-size: 16px; font-weight: 600; }\n.panel-body{ padding: 10px 12px; }\n.close-btn{ cursor: pointer; color: var(--ykt-muted); }\n.close-btn:hover{ color: var(--ykt-hover); }\n\n/* ===== 设置面板 (#ykt-settings-panel) ===== */\n#ykt-settings-panel .settings-content{ display: flex; flex-direction: column; gap: 14px; }\n#ykt-settings-panel .setting-group{ border: 1px dashed var(--ykt-border); border-radius: 6px; padding: 10px; }\n#ykt-settings-panel .setting-group h4{ margin: 0 0 8px 0; font-size: 14px; }\n#ykt-settings-panel .setting-item{ display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }\n#ykt-settings-panel label{ font-size: 13px; }\n#ykt-settings-panel input[type="text"],\n#ykt-settings-panel input[type="number"]{\n  height: 30px; border: 1px solid var(--ykt-border-strong);\n  border-radius: 4px; padding: 0 8px; min-width: 160px; max-width: 100%;\n  box-sizing: border-box; flex: 1 1 160px;\n}\n#ykt-settings-panel small{ color: #666; }\n#ykt-settings-panel .setting-actions{ display: flex; gap: 8px; margin-top: 6px; }\n#ykt-settings-panel button{\n  height: 30px; padding: 0 12px; border-radius: 6px;\n  border: 1px solid var(--ykt-border-strong); background: #f7f8fa; cursor: pointer;\n}\n#ykt-settings-panel button:hover{ background: #eef3ff; border-color: var(--ykt-accent); }\n\n/* 自定义复选框（与手写脚本一致的视觉语义） */\n#ykt-settings-panel .checkbox-label{ position: relative; padding-left: 26px; cursor: pointer; user-select: none; }\n#ykt-settings-panel .checkbox-label input{ position: absolute; opacity: 0; cursor: pointer; height: 0; width: 0; }\n#ykt-settings-panel .checkbox-label .checkmark{\n  position: absolute; left: 0; top: 50%; transform: translateY(-50%);\n  height: 16px; width: 16px; border:1px solid var(--ykt-border-strong); border-radius: 3px; background: #fff;\n}\n#ykt-settings-panel .checkbox-label input:checked ~ .checkmark{\n  background: var(--ykt-accent); border-color: var(--ykt-accent);\n}\n#ykt-settings-panel .checkbox-label .checkmark:after{\n  content: ""; position: absolute; display: none;\n  left: 5px; top: 1px; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);\n}\n#ykt-settings-panel .checkbox-label input:checked ~ .checkmark:after{ display: block; }\n\n/* ===== AI 解答面板 (#ykt-ai-answer-panel) =====\n   气泡的 markdown 排版样式见文件底部（作用于 .ykt-ai-msg.ai / .ykt-chat-msg.ai） */\n\n/* ===== 课件浏览面板 (#ykt-presentation-panel) ===== */\n#ykt-presentation-panel{ width: 900px; }\n#ykt-presentation-panel .panel-controls{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n#ykt-presentation-panel .panel-body{\n  display: grid; grid-template-columns: 300px 1fr; gap: 10px;\n}\n#ykt-presentation-panel .panel-left,\n#ykt-presentation-panel .panel-right{\n  display: flex;\n  flex-direction: column;\n}\n#ykt-presentation-panel .presentation-list{\n  border: 1px solid var(--ykt-border);\n  border-radius: 8px;\n  background: #fff;\n  padding: 10px;\n  box-sizing: border-box;\n}\n#ykt-presentation-panel .presentation-title{\n  font-weight: 600; padding: 6px 0; border-bottom: 1px solid var(--ykt-border);\n}\n#ykt-presentation-panel .slide-thumb-list{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }\n#ykt-presentation-panel .slide-thumb{\n  position: relative; border: 1px solid var(--ykt-border); border-radius: 6px; background: #fafafa;\n  min-height: 60px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 4px; text-align: center;\n}\n#ykt-presentation-panel .slide-thumb:hover{ border-color: var(--ykt-accent); background: #eef3ff; }\n#ykt-presentation-panel .slide-thumb img{ max-width: 100%; max-height: 120px; object-fit: contain; display: block; }\n#ykt-presentation-panel .slide-index {\n  position: absolute; top: 4px; left: 4px; z-index: 2;               \n  padding: 2px 6px; border-radius: 4px; font-size: 12px; line-height: 1;\n  background: rgba(0, 0, 0, 0.6); color: #fff; pointer-events: none;\n}\n#ykt-presentation-panel .slide-view{\n  position: relative; border: 1px solid var(--ykt-border); border-radius: 8px; min-height: 360px; background: #fff; overflow: hidden;\n}\n#ykt-presentation-panel .slide-cover{ display: flex; align-items: center; justify-content: center; min-height: 360px; }\n#ykt-presentation-panel .slide-cover img{ max-width: 100%; max-height: 100%; object-fit: contain; display: block; }\n#ykt-presentation-panel .problem-box{\n  position: absolute; left: 12px; right: 12px; bottom: 12px;\n  background: rgba(255,255,255,.96); border: 1px solid var(--ykt-border);\n  border-radius: 8px; padding: 10px; box-shadow: 0 6px 18px rgba(0,0,0,.12);\n}\n#ykt-presentation-panel .problem-head{ font-weight: 600; margin-bottom: 6px; padding-right: 28px; }\n#ykt-presentation-panel .problem-box-close{\n  position: absolute; top: 6px; right: 6px;\n  width: 22px; height: 22px; border-radius: 999px;\n  border: 1px solid var(--ykt-border-strong);\n  background: #fff; color: #555;\n  cursor: pointer; font-size: 16px; line-height: 18px;\n  padding: 0;\n}\n#ykt-presentation-panel .problem-box-close:hover{ color: #111; border-color: var(--ykt-accent); }\n#ykt-presentation-panel .problem-options{ display: grid; grid-template-columns: 1fr; gap: 4px; }\n#ykt-presentation-panel .problem-option{ padding: 6px 8px; border: 1px solid var(--ykt-border); border-radius: 6px; background: #fafafa; }\n\n\n\n/* ===== 活动题目列表（右下角小卡片） ===== */\n#ykt-active-problems-panel.ykt-active-wrapper{\n  position: fixed; right: 20px; bottom: 60px; z-index: var(--ykt-z);\n}\n#ykt-active-problems{ display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow: auto; }\n#ykt-active-problems .active-problem-card{\n  position: relative;\n  width: 320px; background: #fff; border: 1px solid var(--ykt-border);\n  border-radius: 8px; box-shadow: var(--ykt-shadow); padding: 10px;\n}\n#ykt-active-problems .ap-close{\n  position: absolute; top: 6px; right: 6px;\n  width: 20px; height: 20px; border-radius: 999px;\n  border: 1px solid var(--ykt-border-strong);\n  background: #fff; color: #555;\n  cursor: pointer; padding: 0; font-size: 14px; line-height: 16px;\n}\n#ykt-active-problems .ap-close:hover{ color: #111; border-color: var(--ykt-accent); }\n#ykt-active-problems .ap-title{ font-weight: 600; margin-bottom: 4px; }\n#ykt-active-problems .ap-info{ color: #666; font-size: 12px; margin-bottom: 8px; }\n#ykt-active-problems .ap-actions{ display: flex; gap: 8px; }\n#ykt-active-problems .ap-actions button{\n  height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--ykt-border-strong); background: #f7f8fa; cursor: pointer;\n}\n#ykt-active-problems .ap-actions button:hover{ background: #eef3ff; border-color: var(--ykt-accent); }\n\n/* ===== 教程面板 (#ykt-tutorial-panel) ===== */\n#ykt-tutorial-panel .tutorial-content h4{ margin: 8px 0 6px; }\n#ykt-tutorial-panel .tutorial-content p,\n#ykt-tutorial-panel .tutorial-content li{ line-height: 1.5; }\n#ykt-tutorial-panel .tutorial-content a{ color: var(--ykt-accent); text-decoration: none; }\n#ykt-tutorial-panel .tutorial-content a:hover{ text-decoration: underline; }\n\n/* ===== 小屏适配 ===== */\n@media (max-width: 1200px){\n  #ykt-presentation-panel{ width: 760px; }\n  #ykt-presentation-panel .panel-body{ grid-template-columns: 260px 1fr; }\n}\n@media (max-width: 900px){\n  .ykt-panel{ right: 12px; left: 12px; width: auto; }\n  #ykt-presentation-panel{ width: auto; }\n  #ykt-presentation-panel .panel-body{ grid-template-columns: 1fr; }\n}\n\n/* ===== 自动作答成功弹窗 ===== */\n.auto-answer-popup{\n  position: fixed; inset: 0; z-index: calc(var(--ykt-z) + 2);\n  background: rgba(0,0,0,.2);\n  display: flex; align-items: flex-end; justify-content: flex-end;\n  opacity: 0; transition: opacity .18s ease;\n}\n.auto-answer-popup.visible{ opacity: 1; }\n\n.auto-answer-popup .popup-content{\n  width: min(560px, 96vw);\n  background: #fff; border: 1px solid var(--ykt-border-strong);\n  border-radius: 10px; box-shadow: var(--ykt-shadow);\n  margin: 16px; overflow: hidden;\n}\n\n.auto-answer-popup .popup-header{\n  display: flex; align-items: center; justify-content: space-between;\n  gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--ykt-border);\n}\n.auto-answer-popup .popup-header h4{ margin: 0; font-size: 16px; }\n.auto-answer-popup .close-btn{ cursor: pointer; color: var(--ykt-muted); }\n.auto-answer-popup .close-btn:hover{ color: var(--ykt-hover); }\n\n.auto-answer-popup .popup-body{ padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }\n.auto-answer-popup .popup-row{ display: grid; grid-template-columns: 56px 1fr; gap: 8px; align-items: start; }\n.auto-answer-popup .label{ color: #666; font-size: 12px; line-height: 1.8; }\n.auto-answer-popup .content{ white-space: normal; word-break: break-word; }\n\n/* ===== 1.16.6: 课件浏览面板：固定右侧详细视图，左侧独立滚动 ===== */\n#ykt-presentation-panel {\n  --ykt-panel-max-h: 72vh;           /* 与 .ykt-panel 的最大高度保持一致 */\n}\n\n/* 两列布局：左列表 + 右详细视图 */\n#ykt-presentation-panel .panel-body{\n  display: grid;\n  grid-template-columns: minmax(200px, 300px) 1fr;\n  gap: 12px;\n  overflow: hidden;\n  align-items: start;\n}\n\n/* 左侧：只让左列滚动，限制在面板可视高度内 */\n#ykt-presentation-panel .panel-left{\n  max-height: var(--ykt-panel-max-h);\n  overflow: auto;\n  min-width: 0;\n  align-self: stretch;\n}\n\n/* 右侧：粘性定位为“固定”，始终在面板可视区内 */\n#ykt-presentation-panel .panel-right{\n  position: sticky;\n  top: 0;                            \n  align-self: start;\n  gap: 12px;\n}\n\n/* 右侧详细视图自身也限制高度并允许内部滚动 */\n#ykt-presentation-panel .slide-view{\n  max-height: var(--ykt-panel-max-h);\n  overflow: auto;\n  border: 1px solid var(--ykt-border);\n  border-radius: 8px;\n  background: #fff;\n}\n\n/* 小屏自适配：堆叠布局时取消 sticky，避免遮挡 */\n@media (max-width: 900px){\n  #ykt-presentation-panel .panel-body{\n    grid-template-columns: 1fr;\n  }\n  #ykt-presentation-panel .panel-right{\n    position: static;\n  }\n}\n\n\n\n/* ===== Markdown 排版样式 =====\n   作用对象：AI 解答面板（.ykt-ai-msg.ai）与 PPT 对话面板（.ykt-chat-msg.ai）的 AI 气泡。\n   注意：渲染产物里没有 .ai-answer 容器——旧选择器全部落空，是本文件历史遗留的死规则 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) {\n  white-space: normal;\n  line-height: 1.6;\n  font-size: 14px;\n}\n\n/* 段落和标题间距 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) p { margin: 8px 0; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h1,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h2,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h3,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h4,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h5,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h6 {\n  margin: 12px 0 6px;\n  line-height: 1.35;\n  font-weight: 600;\n}\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h1 { font-size: 20px; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h2 { font-size: 18px; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h3 { font-size: 16px; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h4 { font-size: 15px; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h5,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) h6 { font-size: 14px; }\n\n/* 链接 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) a {\n  text-decoration: underline;\n  cursor: pointer;\n}\n\n/* 引用块 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) blockquote {\n  margin: 8px 0;\n  padding: 6px 10px;\n  border-left: 3px solid rgba(0,0,0,0.2);\n  background: rgba(0,0,0,0.03);\n}\n\n/* 水平线 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) hr {\n  border: 0;\n  border-top: 1px solid rgba(0,0,0,0.15);\n  margin: 10px 0;\n}\n\n/* 代码块与行内代码 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) pre.ykt-md-code {\n  margin: 8px 0;\n  padding: 10px;\n  overflow: auto;\n  border: 1px solid rgba(0,0,0,0.15);\n  border-radius: 6px;\n  background: #f7f8fa;\n}\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) pre.ykt-md-code code {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;\n  font-size: 12px;\n}\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) code.ykt-md-inline {\n  padding: 1px 4px;\n  border: 1px solid rgba(0,0,0,0.15);\n  border-radius: 4px;\n  background: #f7f8fa;\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;\n  font-size: 12px;\n}\n\n/* 列表 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) ul,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) ol {\n  margin: 6px 0 6px 22px;\n}\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) ul { list-style: disc; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) ol { list-style: decimal; }\n\n/* 表格 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) table {\n  border-collapse: collapse;\n  margin: 8px 0;\n  width: 100%;\n  max-width: 100%;\n}\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) th,\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) td {\n  border: 1px solid rgba(0,0,0,0.15);\n  padding: 6px 8px;\n  text-align: left;\n}\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) thead th {\n  background: rgba(0,0,0,0.05);\n  font-weight: 600;\n}\n\n/* 适配深色 */\n@media (prefers-color-scheme: dark) {\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) blockquote {\n    border-left-color: rgba(255,255,255,0.35);\n    background: rgba(255,255,255,0.06);\n  }\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) pre.ykt-md-code,\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) code.ykt-md-inline {\n    background: #111418;\n    border-color: rgba(255,255,255,0.2);\n  }\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) hr { border-top-color: rgba(255,255,255,0.2); }\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) th,\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) td { border-color: rgba(255,255,255,0.2); }\n  :where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) thead th { background: rgba(255,255,255,0.08); }\n}\n\n/* MathJax tex 排版：作用在 AI 气泡上 */\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai).tex-enabled svg { vertical-align: middle; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai).tex-enabled .MathJax { line-height: 1; }\n:where(.ykt-chat-msg.ai, .ykt-ai-msg.ai) .mjx-svg { color: currentColor; }\n';
  // src/ui/styles.js
    function injectStyles() {
    gm.addStyle(css);
  }
  // src/index.js
    (function loadFA() {
    // document-start 极早期 document.head 可能尚未解析出来（手动 CDP 注入/异常时序），需兜底
    const target = document.head || document.documentElement || document;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css";
    target.appendChild(link);
  })();
  /** 用户正在页面里输入时，不要刷新打断 */  function userIsTyping() {
    try {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) return true;
    } catch {}
    return false;
  }
  function maybeAutoReloadOnMount() {
    try {
      // 脚本在 DOM ready 之后才挂载时，重载一次让 XHR/WS 拦截器尽早生效。
      // 用 sessionStorage 防无限循环。
      const key = "__ykt_helper_auto_reload_once__";
      if (document.readyState === "loading") return false;
      if (!window.sessionStorage) return false;
      if (window.sessionStorage.getItem(key) === "1") return false;
      window.sessionStorage.setItem(key, "1");
      log.info("Late mount detected; reloading once to arm interceptors.");
      window.setTimeout(() => window.location.reload(), 50);
      return true;
    } catch {
      return false;
    }
  }
  function startPeriodicReload(opts = {}) {
    try {
      const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 5 * 60 * 1e3;
      const onlyWhenHidden = opts.onlyWhenHidden !== false;
      const skipLessonPages = opts.skipLessonPages !== false;
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
      window.setInterval(() => {
        try {
          // 课堂/报告页永不刷新（会被打断）
          if (skipLessonPages && /\/lesson\/|\/student-lesson-report\/|\/student-v3\//.test(window.location.pathname)) {
            log.dbg("skip reload: lesson/report page");
            return;
          }
          // 任意助手面板打开时不刷新，避免打断用户操作（PDF导出、AI对话等）
                    if (document.querySelector(".ykt-panel.visible")) {
            log.dbg("skip reload: panel open");
            return;
          }
          // 页面可见时不刷新（用户在看着这个页面，刷新会造成明显干扰）
                    if (onlyWhenHidden && !document.hidden) {
            log.dbg("skip reload: page visible");
            return;
          }
          // 用户正在输入时不刷新
                    if (userIsTyping()) {
            log.dbg("skip reload: user typing");
            return;
          }
          log.info("Periodic reload triggered to avoid zombie session.");
          window.location.reload();
        } catch (e) {
          log.err("periodic reload tick failed", e);
        }
      }, intervalMs);
    } catch {}
  }
  /** document.body 尚未出现时延迟挂载（document-start 注入/移动版 SPA 时序） */  function whenBodyReady(fn) {
    if (document.body) {
      fn();
      return;
    }
    const timer = setInterval(() => {
      if (document.body) {
        clearInterval(timer);
        fn();
      }
    }, 50);
    setTimeout(() => clearInterval(timer), 15e3);
  }
  (function main() {
    if (maybeAutoReloadOnMount()) return;
    // 仅在页面隐藏时刷新，且间隔放宽到 3 分钟：
    // 此前是 1 分钟 + 页面可见也刷新，是「面板莫名消失 / 脚本好像失效」的根源
        startPeriodicReload({
      intervalMs: 3 * 60 * 1e3,
      onlyWhenHidden: true,
      skipLessonPages: true
    });
    // 样式/图标
        injectStyles();
    // 挂 UI（单步失败不拖垮其余步骤）
        whenBodyReady(() => {
      try {
        ui._mountAll?.();
      } catch (e) {
        log.err("[mount] panels failed", e);
      }
      try {
        installToolbar();
      } catch (e) {
        log.err("[mount] toolbar failed", e);
      }
    });
    // 再装网络拦截
        installWSInterceptor();
    installXHRInterceptor();
    // 启动自动作答轮询
        actions.startAutoAnswerLoop();
    // 更新课件加载
        actions.launchLessonHelper();
    // 历史课件收集器：student-v3 报告页自动执行（配合课件面板的「历史课件」导入）
        if (isStudentV3Page()) runHistoryCapture().catch(e => log.err("[History] 启动失败", e));
  })();
})();
