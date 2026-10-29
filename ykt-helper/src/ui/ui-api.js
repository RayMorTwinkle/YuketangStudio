// src/ui/ui-api.js
import { gm } from '../core/env.js';
import { log } from '../core/log.js';
import { storage } from '../core/storage.js';
import { DEFAULT_CONFIG } from '../core/types.js';
import { repo } from '../state/repo.js';
import { toast } from './toast.js';
import * as AIPanel from './panels/ai.js';
import * as PresPanel from './panels/presentation.js';
import * as ActivePanel from './panels/active-problems.js';
import * as ProblemListPanel from './panels/problem-list.js';
import * as Shell from './panels/shell.js';
import { PROBLEM_TYPE_MAP } from '../core/types.js'
import { normalizeTimestamp, remainingSeconds } from '../core/problem-timing.js'

const _config = Object.assign({}, DEFAULT_CONFIG, storage.get('config', {}));
// Object.assign 是浅拷贝——嵌套的 ai 若来自 DEFAULT_CONFIG 会与默认配置共享引用，
// 深合并一份，避免写 _config.ai 污染 DEFAULT_CONFIG（影响设置页「重置」）
if (typeof _config.ai !== 'object' || !_config.ai) _config.ai = {};
_config.ai = Object.assign({}, DEFAULT_CONFIG.ai, _config.ai);
_config.ai.kimiApiKey = storage.get('kimiApiKey', _config.ai.kimiApiKey);
// 作答延迟/随机延迟：缺失或非法值回落到默认 3s / 2s；合法用户值（含 0 随机）保留
_config.autoAnswerDelay = Number(_config.autoAnswerDelay);
if (!Number.isFinite(_config.autoAnswerDelay) || _config.autoAnswerDelay <= 0) {
  _config.autoAnswerDelay = DEFAULT_CONFIG.autoAnswerDelay;
}
_config.autoAnswerRandomDelay = Number(_config.autoAnswerRandomDelay);
if (!Number.isFinite(_config.autoAnswerRandomDelay) || _config.autoAnswerRandomDelay < 0) {
  _config.autoAnswerRandomDelay = DEFAULT_CONFIG.autoAnswerRandomDelay;
}
_config.TYPE_MAP = _config.TYPE_MAP || PROBLEM_TYPE_MAP;
if (typeof _config.autoJoinEnabled === 'undefined') _config.autoJoinEnabled = false;
if (typeof _config.autoAnswerOnAutoJoin === 'undefined') _config.autoAnswerOnAutoJoin = true;
if (typeof _config.iftex === 'undefined') _config.iftex = true;
if (typeof _config.notifyProblems === 'undefined') _config.notifyProblems = true;           
if (typeof _config.notifyPopupDuration === 'undefined') _config.notifyPopupDuration = 5000; 
if (typeof _config.notifyVolume === 'undefined') _config.notifyVolume = 0.6;                
if (typeof _config.customNotifyAudioSrc === 'undefined') _config.customNotifyAudioSrc = ''; 
if (typeof _config.customNotifyAudioName === 'undefined') _config.customNotifyAudioName = ''; 
_config.autoJoinEnabled = !!_config.autoJoinEnabled;
_config.autoAnswerOnAutoJoin = !!_config.autoAnswerOnAutoJoin;
// AI 图来源。旧配置 aiSlidePickPriority=false（课件浏览优先）迁移成 selected。
if (_config.aiSlideSource !== 'selected' && _config.aiSlideSource !== 'teacher') {
  _config.aiSlideSource = _config.aiSlidePickPriority === false ? 'selected' : 'teacher';
}

function saveConfig() { 
  try {
      storage.set('config', {
        ...this.config,
        autoJoinEnabled: !!this.config.autoJoinEnabled,
        autoAnswerOnAutoJoin: !!this.config.autoAnswerOnAutoJoin,
      });
    } catch (e) { log.warn('[ui.saveConfig] failed', e); }
  // 通知工具栏等轻量 UI 同步（提醒/自动作答角标）
  try { window.dispatchEvent(new CustomEvent('ykt:config:changed')); } catch {}
}

// 面板层级管理
let currentZIndex = 10000000;

function enableNotifyDrag(wrapper, handle, bringToFront) {
  if (!wrapper || !handle) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onPointerMove = (ev) => {
    if (!dragging) return;
    // 上下边界也要钳制——否则可拖到视口外再也拉不回来
    const nextLeft = Math.max(8, Math.min(window.innerWidth - wrapper.offsetWidth - 8, originLeft + ev.clientX - startX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - wrapper.offsetHeight - 8, originTop + ev.clientY - startY));
    wrapper.style.left = `${nextLeft}px`;
    wrapper.style.top = `${nextTop}px`;
    wrapper.style.right = 'auto';
    wrapper.style.bottom = 'auto';
  };

  const stopDrag = () => {
    dragging = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
  };

  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target?.closest?.('button, a, input, textarea, select')) return;
    const rect = wrapper.getBoundingClientRect();
    dragging = true;
    startX = ev.clientX;
    startY = ev.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    wrapper.style.left = `${rect.left}px`;
    wrapper.style.top = `${rect.top}px`;
    wrapper.style.right = 'auto';
    wrapper.style.bottom = 'auto';
    bringToFront?.(wrapper);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    ev.preventDefault();
  });
}

const _recentProblemNotices = new Map();

export const ui = {
  get config() { return _config; },
  saveConfig,

  updatePresentationList: PresPanel.updatePresentationList,
  updateSlideView: PresPanel.updateSlideView,
  askAIForCurrent: AIPanel.askAIForCurrent,
  askAnswer: AIPanel.askAnswer,
  askProblem: AIPanel.askProblem,
  updateActiveProblems: ActivePanel.updateActiveProblems,
  updateProblemList: ProblemListPanel.updateProblemList,

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
    Shell.openTab('pres', visible);
  },

  showAIPanel(visible = true) {
    Shell.openTab('ai', visible);
  },

  showAssignmentsPanel(visible = true) {
    Shell.openTab('assign', visible);
  },

  showChatPanel(visible = true) {
    Shell.openTab('chat', visible);
  },

  toggleSettingsPanel() {
    Shell.toggleTab('settings');
  },

  toggleAboutPanel() {
    Shell.toggleTab('about');
  },

  // 在 index.js 初始化时挂载一次
  _mountAll() {
    // 独立弹层（不进主面板）
    ActivePanel.mountActiveProblemsPanel();
    // Shell 会依次 mount 全部功能面板并把它们的 DOM 迁入 tab 内容区
    Shell.mountShell();
    window.addEventListener('ykt:open-ai', () => this.showAIPanel(true));
    window.addEventListener('ykt:open-chat', () => this.showChatPanel(true));
  },

  // 题目提醒
  notifyProblem(problem, slide) {
    try {
      // 同题 60s 内只提醒一次：WS 可能重复推 unlockproblem，重复弹窗/响铃没有意义
      const notifyPid = String(problem?.problemId ?? problem?.id ?? '');
      const notifyNow = Date.now();
      if (notifyPid) {
        const last = _recentProblemNotices.get(notifyPid);
        if (last && notifyNow - last < 60_000) return;
        _recentProblemNotices.set(notifyPid, notifyNow);
        for (const [k, t] of _recentProblemNotices) {
          if (notifyNow - t > 60_000) _recentProblemNotices.delete(k);
        }
      }
      // 1) 原生通知（如果可用，备用，不阻碍自定义弹窗）
      try {
        this.nativeNotify?.({
          title: '雨课堂习题提示',
          text: this.getProblemDetail(problem),
          image: slide?.thumbnail || null,
          timeout: Math.max(2000, +this.config.notifyPopupDuration || 5000),
        });
      } catch {}

      // 2) 自定义悬浮弹窗
      const wrapper = document.createElement('div');
      wrapper.className = 'ykt-problem-notify';
      const narrow = (() => {
        try {
          return window.matchMedia?.('(max-width: 560px)').matches ||
            (navigator.maxTouchPoints > 0 && window.innerWidth <= 820);
        } catch { return false; }
      })();
      wrapper.classList.toggle('narrow', narrow);
      // 手机端工具栏可能是左下纵向条，也可能被收成窄轨；按它当前真实位置避让。
      let left = narrow ? '64px' : 'auto';
      let right = narrow ? '10px' : '20px';
      let bottom = narrow ? '16px' : '24px';
      if (narrow) {
        try {
          const bar = document.getElementById('ykt-helper-toolbar');
          const barRect = bar?.getBoundingClientRect();
          const barVisible = barRect && barRect.width > 0 && barRect.height > 0
            && getComputedStyle(bar).display !== 'none';
          if (barVisible) {
            if (barRect.height >= barRect.width && barRect.left < window.innerWidth / 2) {
              // 左侧纵向工具栏：弹窗放在工具栏右侧，底边与工具栏对齐
              left = `${Math.ceil(barRect.right + 10)}px`;
              bottom = `${Math.max(12, Math.ceil(window.innerHeight - barRect.bottom))}px`;
            } else if (barRect.top > window.innerHeight / 2) {
              // 底部横向工具栏：弹窗整体抬到工具栏上方
              left = '10px';
              right = '10px';
              bottom = `${Math.ceil(window.innerHeight - barRect.top + 10)}px`;
            }
          }
        } catch { /* 工具栏不可用时使用默认安全边距 */ }
      }
      Object.assign(wrapper.style, {
        position: 'fixed',
        right,
        left,
        bottom,
        maxWidth: narrow ? 'none' : '380px',
        background: 'rgba(20,20,20,0.92)',
        color: '#fff',
        borderRadius: '12px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        padding: '14px 16px',
        display: 'flex',
        gap: '12px',
        alignItems: 'flex-start',
        zIndex: String(++currentZIndex),
        fontSize: '14px',
        lineHeight: '1.5',
        backdropFilter: 'blur(2px)',
        border: '1px solid rgba(255,255,255,0.06)',
        cursor: 'default',
      });

      // 缩略图（可选）
      let thumb = null;
      if (slide?.thumbnail) {
        thumb = document.createElement('img');
        thumb.src = slide.thumbnail;
        thumb.className = 'ykt-notify-thumb';
        Object.assign(thumb.style, {
          width: '56px',
          height: '56px',
          objectFit: 'cover',
          borderRadius: '8px',
          flex: '0 0 auto',
        });
        wrapper.appendChild(thumb);
      }

      const body = document.createElement('div');
      body.className = 'ykt-notify-body';
      body.style.flex = '1 1 auto';
      body.style.minWidth = '0';

      const head = document.createElement('div');
      head.className = 'ykt-notify-head';
      Object.assign(head.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        marginBottom: '6px',
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none',
      });

      const title = document.createElement('div');
      title.textContent = '习题已发布';
      title.className = 'ykt-notify-title';
      Object.assign(title.style, { fontWeight: '600', fontSize: '15px', flex: '1 1 auto' });

      const headActions = document.createElement('div');
      headActions.className = 'ykt-notify-head-actions';
      headActions.style.cssText = 'display:flex;align-items:center;gap:2px;flex:0 0 auto';

      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.textContent = '−';
      collapseBtn.className = 'ykt-notify-collapse';
      collapseBtn.title = '收起提醒';
      collapseBtn.setAttribute('aria-label', '收起提醒');
      Object.assign(collapseBtn.style, {
        border: 'none',
        background: 'transparent',
        color: '#fff',
        opacity: '0.72',
        fontSize: '18px',
        lineHeight: '18px',
        cursor: 'pointer',
        padding: '0 4px',
        flex: '0 0 auto',
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.className = 'ykt-notify-close';
      closeBtn.title = '关闭提醒';
      closeBtn.setAttribute('aria-label', '关闭提醒');
      Object.assign(closeBtn.style, {
        border: 'none',
        background: 'transparent',
        color: '#fff',
        opacity: '0.7',
        fontSize: '18px',
        lineHeight: '18px',
        cursor: 'pointer',
        padding: '0 4px',
        flex: '0 0 auto',
      });
      for (const btn of [collapseBtn, closeBtn]) {
        btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
        btn.addEventListener('mouseleave', () => (btn.style.opacity = btn === collapseBtn ? '0.72' : '0.7'));
      }

      const detail = document.createElement('pre');
      detail.textContent = this.getProblemDetail(problem);
      detail.className = 'ykt-notify-detail';
      Object.assign(detail.style, {
        whiteSpace: 'pre-wrap',
        margin: 0,
        fontFamily: 'inherit',
        opacity: '0.92',
        maxHeight: '220px',
        overflow: 'auto',
      });

      headActions.appendChild(collapseBtn);
      headActions.appendChild(closeBtn);
      head.appendChild(title);
      head.appendChild(headActions);
      body.appendChild(head);
      body.appendChild(detail);

      const pid = String(problem?.problemId ?? problem?.id ?? '');
      const st = pid ? repo.problemStatus.get(pid) : null;
      let aiBtn = null;
      let cd = null;

      // 通知里也能直接进入“这道题”的 AI 解答（显式 task，不依赖当前页）
      if (pid) {
        aiBtn = document.createElement('button');
        aiBtn.type = 'button';
        aiBtn.textContent = 'AI 解答';
        aiBtn.className = 'ykt-notify-ai';
        aiBtn.style.cssText = 'margin-top:10px;padding:5px 12px;border:1px solid rgba(255,255,255,.35);border-radius:6px;background:rgba(255,255,255,.12);color:#fff;cursor:pointer;font-size:12px';
        aiBtn.onclick = () => { wrapper.remove(); AIPanel.askProblem?.(pid).catch((e) => log.warn('[notify] askProblem failed', e)); };
        body.appendChild(aiBtn);
      }

      // 实时倒计时：用服务端时钟（clockOffset）换算，每秒刷新
      const endTime = normalizeTimestamp(st?.endTime ?? problem?.endTime);
      if (endTime != null) {
        cd = document.createElement('div');
        cd.className = 'ykt-notify-countdown';
        cd.style.cssText = 'margin-top:8px;font-size:12px;opacity:.85;font-variant-numeric:tabular-nums';
        body.appendChild(cd);
        const offset = Number(st?.clockOffset) || 0;
        const tick = () => {
          const remain = remainingSeconds(endTime, offset);
          const mm = String(Math.floor(remain / 60)).padStart(2, '0');
          const ss = String(remain % 60).padStart(2, '0');
          cd.textContent = remain > 0 ? `⏱ 剩余 ${mm}:${ss}` : '⏱ 已结束';
          if (remain <= 0) { clearInterval(cd.__t); cd.__t = null; }
        };
        cd.__t = setInterval(tick, 1000);
        tick();
      }

      wrapper.appendChild(body);

      document.body.appendChild(wrapper);
      this._bringToFront(wrapper);

      const timeout = Math.max(2000, +this.config.notifyPopupDuration || 5000);
      let timer = 0;
      let collapsed = false;
      const armTimer = () => {
        clearTimeout(timer);
        if (collapsed) return;
        timer = setTimeout(() => wrapper.remove(), timeout);
      };
      const setCollapsed = (on) => {
        collapsed = !!on;
        wrapper.classList.toggle('collapsed', collapsed);
        if (thumb) thumb.style.display = collapsed ? 'none' : '';
        detail.style.display = collapsed ? 'none' : '';
        if (aiBtn) aiBtn.style.display = collapsed ? 'none' : '';
        title.textContent = collapsed ? '习题提醒（已收起）' : '习题已发布';
        collapseBtn.textContent = collapsed ? '＋' : '−';
        collapseBtn.title = collapsed ? '展开提醒' : '收起提醒';
        collapseBtn.setAttribute('aria-label', collapsed ? '展开提醒' : '收起提醒');
        wrapper.style.maxWidth = collapsed ? '260px' : (narrow ? 'none' : '380px');
        if (collapsed) clearTimeout(timer);
        else armTimer();
      };
      collapseBtn.onclick = (e) => {
        e.stopPropagation();
        setCollapsed(!collapsed);
      };
      wrapper.addEventListener('click', (e) => {
        if (collapsed && !e.target.closest('button')) setCollapsed(false);
      });
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        wrapper.remove();
      };
      const oldRemove = wrapper.remove.bind(wrapper);
      wrapper.remove = () => {
        clearTimeout(timer);
        if (cd?.__t) clearInterval(cd.__t);
        oldRemove();
      };
      armTimer();
      enableNotifyDrag(wrapper, head, (el) => this._bringToFront(el));

      const notifyVolume = Number(this.config.notifyVolume);
      this._playNotifySound(Number.isFinite(notifyVolume) ? notifyVolume : 0.6);
    } catch (e) {
      log.warn('[雨课堂助手][WARN][ui.notifyProblem] failed:', e);
    }
  },

  // 播放自定义提示音  
  _playNotifySound(volume = 0.6) {
    const src = (this.config.customNotifyAudioSrc || '').trim();
    if (src) {
      try {
        if (!this.__notifyAudioEl) {
          this.__notifyAudioEl = new Audio();
          this.__notifyAudioEl.preload = 'auto';
        }
        const el = this.__notifyAudioEl;
        el.pause();
        // 若用户更换了音频，或首次设置，更新 src
        if (el.src !== src) el.src = src;
        el.volume = Math.max(0, Math.min(1, volume));
        el.currentTime = 0;
        const p = el.play();
        // 失败时回退
        if (p && typeof p.catch === 'function') {
          p.catch(() => this._playNotifyTone(volume));
        }
        return;
      } catch (e) {
        log.warn('[雨课堂助手][WARN] custom audio failed, fallback to tone:', e);
        // 回退到合成音
      }
    }
    this._playNotifyTone(volume);
  },

  // 简易提示音：两个音高的短促“叮-咚”
  _playNotifyTone(volume = 0.6) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = Math.max(0, Math.min(1, volume));
      master.connect(ctx.destination);

      const tone = (freq, t0, dur = 0.12) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(1, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      };
      tone(880, now);           // A5
      tone(1318.51, now + 0.16); // E6
      // 自动关闭
      setTimeout(() => ctx.close(), 500);
    } catch {}
  },

  // 供设置页调用：写入/清除自定义提示音
  setCustomNotifyAudio({ src, name }) {
    this.config.customNotifyAudioSrc = src || '';
    this.config.customNotifyAudioName = name || '';
    this.saveConfig();
  },

  getProblemDetail(problem) {
    if (!problem) return '题目未找到';
    const lines = [problem.body || ''];
    if (Array.isArray(problem.options)) {
      lines.push(...problem.options.map(({ key, value }) => `${key}. ${value}`));
    }
    return lines.join('\n');
  },

  toast,
  nativeNotify: gm.notify,

  // 主面板
  showShellPanel(visible = true) {
    Shell.showShell(visible);
  },

  // Buttons 状态
  updateAutoAnswerBtn() {
    const el = document.getElementById('ykt-btn-auto-answer');
    if (!el) return;
    if (_config.autoAnswer) el.classList.add('active'); else el.classList.remove('active');
  },
};

/**
 * 复制文本：优先 Clipboard API，失败回退 execCommand。
 * Android WebView / 非安全上下文里 navigator.clipboard 可能不可用。
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到回退分支 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
