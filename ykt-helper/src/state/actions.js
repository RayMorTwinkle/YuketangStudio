// src/state/actions.js
import { PROBLEM_TYPE_MAP, DEFAULT_SYSTEM_PROMPT_AI } from '../core/types.js';
import { log } from '../core/log.js';
import { randInt, gm } from '../core/env.js'
import { repo } from './repo.js';
import { ui } from '../ui/ui-api.js';
import { submitAnswer } from '../tsm/answer.js';
import { showAutoAnswerPopup } from '../ui/panels/auto-answer-popup.js';
import { submitProblemAnswer, parseManualAnswer } from '../tsm/submit-flow.js';
import { getOnLesson, checkinClass } from '../net/xhr-interceptor.js';
import { connectOrAttachLessonWS } from '../net/ws-interceptor.js';
import { isMobileVersionPage, isNarrowDevice } from '../ui/toolbar.js';
import { syncMobileSlidesIntoRepo } from '../core/vuex-helper.js';
import { buildClassroomTask } from '../answer/adapters/classroom.js';
import { runAnswer } from '../answer/engine.js';
import { submitAnswerTask } from '../answer/submit.js';
import { displayAnswer } from '../answer/model.js';
import { getOverride } from '../ui/panels/ai.js';
import { captureSlideImage } from '../capture/screenshoot.js';
import { normalizeTimestamp, deadlineFromLimit, isDeadlineReached } from '../core/problem-timing.js';

let _autoLoopStarted = false;
let _autoJoinStarted = false;
let _autoOnLessonClickStarted = false;
let _autoOnLessonClickInProgress = false;
let _routerHooked = false;

/** 取首个非空值（WS payload 字段名有多个变体） */
function firstValue(...vals) {
  return vals.find(v => v !== undefined && v !== null && String(v).trim() !== '');
}

/**
 * 规范化 unlockproblem 的 payload：服务器字段名有多个变体
 * （prob/problemId/problemid、sid/slideId、pres/presentationId），
 * 统一成 { prob, sid, pres, dt, limit, ...rest }，暂存队列也只放规范副本
 */
export function normalizeUnlock(data) {
  const d = data && typeof data === 'object' ? data : {};
  const prob = firstValue(d.prob, d.problemId, d.problemid, d.problem?.problemId, d.problem?.id, d.id);
  const sid = firstValue(d.sid, d.slideId, d.slide?.id);
  const pres = firstValue(d.pres, d.presentationId, d.presentation_id, d.presentation?.id);
  return { ...d, prob, sid, pres, dt: d.dt ?? d.unlockedAt, limit: d.limit ?? d.timeLimit };
}

// 无AI默认答案生成
function makeDefaultAnswer(problem) {
  switch (problem.problemType) {
    case 1: // 单选
    case 2: // 多选
    case 3: // 投票
      return ['A'];
    case 4: // 填空
      // 按需求示例返回 [" 1"]（保留前导空格）
      return [' 1'];
    case 5: // 主观/问答
      return { content: '略', pics: [] };
    default:
      // 兜底：按单选处理
      return ['A'];
  }
}

export function hasActiveAIProfile(aiCfg) {
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

// ---------------- 自动作答（AI 面板 + 工具） ----------------

// 多题同时解锁时串行执行，避免抢同一条 AI 流
let _autoAnswerChain = Promise.resolve();
function enqueueAutoAnswer(fn) {
  const run = _autoAnswerChain.then(fn, fn);
  _autoAnswerChain = run.catch(() => {});
  return run;
}

/**
 * 自动作答：AnswerEngine V2（headless）。
 * - 成功 → 唯一提交入口 submitAnswerTask
 * - 失败 → 不猜答案、不误提交；没有 API Key 时才走本地默认答案
 */
async function handleAutoAnswerInternal(problem) {
  const status = repo.problemStatus.get(String(problem.problemId));
  if (!status || status.answering || problem.result) {
    log.dbg('[AutoAnswer] 跳过：', {
      hasStatus: !!status,
      answering: status?.answering,
      hasResult: !!problem.result,
    });
    return;
  }

  // endTime 为 null 表示不限时；判过期用服务端时钟（clockOffset 修正本地偏差）
  const serverNow = Date.now() + (status.clockOffset || 0);
  if (status.endTime != null && serverNow >= status.endTime) {
    log.dbg('[雨课堂助手][WARN][AutoAnswer] 跳过：已超时');
    return;
  }

  status.answering = true;
  try {
    log.dbg('[雨课堂助手][INFO][AutoAnswer] =================================');
    log.dbg('[雨课堂助手][INFO][AutoAnswer] 开始自动答题（AnswerEngine V2）');
    log.dbg('[雨课堂助手][INFO][AutoAnswer] 题目ID:', problem.problemId);
    log.dbg('[雨课堂助手][INFO][AutoAnswer] 题目类型:', PROBLEM_TYPE_MAP[problem.problemType]);
    log.dbg('[雨课堂助手][INFO][AutoAnswer] 题目内容:', problem.body?.slice(0, 50) + '...');

    // 无 API Key：沿用本地兜底答案逻辑
    if (!hasActiveAIProfile(ui.config.ai)) {
      if (!ui.config.autoAnswerFallbackDefault) {
        status.answering = false;
        log.warn('[雨课堂助手][WARN][AutoAnswer] 未配置 API Key，跳过自动作答（可在设置开启「无 Key 提交兜底答案」）');
        return ui.toast('未配置 API Key，已跳过自动作答', 3000);
      }
      const parsed = makeDefaultAnswer(problem);
      log.dbg('[雨课堂助手][WARN][AutoAnswer] 无 API Key，使用本地默认答案:', JSON.stringify(parsed));

      await submitAnswer(problem, parsed, {
        startTime: status.startTime,
        endTime: status.endTime,
        forceRetry: false,
        autoGate: false,
        lessonId: repo.currentLessonId,
      });

      actions.onAnswerProblem(problem.problemId, parsed);
      status.done = true;
      status.answering = false;

      ui.toast('使用默认答案完成作答（未配置 API Key）', 3000);
      showAutoAnswerPopup(problem, '（本地默认答案：无 API Key）');
      log.dbg('[雨课堂助手][INFO][AutoAnswer] 默认答案提交流程结束');
      return;
    }

    ui.toast('AI 正在分析题目...', 2000);
    const r = await enqueueAutoAnswer(async () => {
      const slide = status.slideId ? repo.slides.get(String(status.slideId)) : null;
      let image = problem.__imageDataUrl || '';
      if (!image && status.slideId) {
        try { image = await captureSlideImage(String(status.slideId)) || ''; } catch { /* ignore */ }
      }
      const task = buildClassroomTask({
        problem,
        slide,
        status,
        lessonId: repo.currentLessonId,
        imageDataUrl: image,
        source: 'classroom',
      });
      if (!task) throw new Error('题目信息不完整，无法自动作答');
      const transport = !task.target.allowSubmit ? 'text' : (ui.config.regexToolCall ? 'regex' : 'tools');
      const run = await runAnswer(task, {
        transport,
        baseSystem: String(ui.config.systemPromptAI || '').trim() || DEFAULT_SYSTEM_PROMPT_AI,
        autoSubmit: true,
        override: getOverride() || undefined,
        stream: false,
        allowLegacyText: false,
      });
      if (!run.ok) return { run, task };
      const submitted = await submitAnswerTask(task, run.answer, { runId: run.runId });
      return { run, task, submitted };
    });

    if (r?.run?.ok && r?.submitted?.route) {
      status.done = true;
      log.dbg('[雨课堂助手][INFO][AutoAnswer] 提交成功:', r.submitted.route);
      ui.toast(r.submitted.route === 'retry' ? '自动作答完成（补交）' : '自动作答完成', 3000);
      showAutoAnswerPopup(problem, displayAnswer(r.run.answer));
      return;
    }

    // 失败：严格失败，不用正文猜字母提交
    const err = r?.run?.error;
    log.warn('[雨课堂助手][WARN][AutoAnswer] 未完成提交:', {
      code: err?.code, message: err?.message, attempts: r?.run?.attempts,
    });
    ui.toast(`自动作答失败：${err?.message || '模型未给出可提交的答案'}`, 4000);
  } catch (e) {
    log.err('[雨课堂助手][ERR][AutoAnswer] 失败:', e);
    log.err('[雨课堂助手][ERR][AutoAnswer] 错误堆栈:', e.stack);
    ui.toast(`自动作答失败: ${e.message}`, 4000);
  } finally {
    status.answering = false;
  }
}

export const actions = {
  onFetchTimeline(timeline) {
    for (const piece of timeline) if (piece.type === 'problem') this.onUnlockProblem(piece);
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
    // 通知 AI 面板重新检测（课件 XHR 晚于面板打开时，状态需要从「解析中」翻绿）
    try {
      window.dispatchEvent(new CustomEvent('ykt:problem:parsed', { detail: { presentationId: String(id) } }));
    } catch {}
  },

  /** 重放暂存的 unlockproblem（课件 XHR 晚于 WS 到达的竞态） */
  _replayPendingUnlocks() {
    if (!repo.pendingUnlocks.length) return;
    const list = repo.pendingUnlocks.splice(0);
    for (const d0 of list) {
      const d = normalizeUnlock(d0);
      const ok = repo.problems.has(String(d.prob)) && repo.slides.has(String(d.sid));
      if (ok) { this.onUnlockProblem(d); continue; }
      // 仍未命中→限次放回队列（课件永不到达时防止队列无限膨胀）
      if ((d._tries = (d._tries || 0) + 1) < 3) repo.pendingUnlocks.push(d);
      else log.warn('[onUnlockProblem] 重放多次仍未命中，丢弃:', d.prob);
    }
    // 队列还有剩余→再过 3s 重试一轮（课件 XHR 可能仍在路上）
    if (repo.pendingUnlocks.length) {
      clearTimeout(this._unlockRetryTimer);
      this._unlockRetryTimer = setTimeout(() => this._replayPendingUnlocks(), 3000);
    }
  },

  onUnlockProblem(data) {
    data = normalizeUnlock(data);
    const problem = repo.problems.get(String(data.prob));
    const slide = repo.slides.get(String(data.sid));
    if (!problem || !slide) {
      // WS 的 unlockproblem 可能先于课件 XHR 到达——暂存重放，而不是直接丢
      log.dbg('[雨课堂助手][DBG][onUnlockProblem] 题目或幻灯片尚未就绪，暂存待重放:', { prob: data.prob, sid: data.sid });
      if (repo.pendingUnlocks.length >= 20) repo.pendingUnlocks.shift();
      repo.pendingUnlocks.push(data);
      clearTimeout(this._unlockRetryTimer);
      this._unlockRetryTimer = setTimeout(() => this._replayPendingUnlocks(), 3000);
      return;
    }

    log.dbg('[雨课堂助手][DBG][onUnlockProblem] 题目解锁');
    log.dbg('[雨课堂助手][DBG][onUnlockProblem] 题目ID:', data.prob);
    log.dbg('[雨课堂助手][DBG][onUnlockProblem] 幻灯片ID:', data.sid);
    log.dbg('[雨课堂助手][DBG][onUnlockProblem] 课件ID:', data.pres);

    // 服务端 dt 可能是秒或毫秒；limit 是秒。统一在这里归一化。
    const dt = normalizeTimestamp(data.dt) ?? Date.now();
    const limitS = Number(data.limit);
    // clockOffset = 服务端时钟 - 本地时钟：endTime 基于服务端时间轴，判过期时必须换算
    const clockOffset = dt - Date.now();
    const prev = repo.problemStatus.get(String(data.prob));
    const status = {
      presentationId: data.pres,
      slideId: String(data.sid),
      startTime: dt,
      endTime: deadlineFromLimit(dt, limitS),   // null = 不限时
      clockOffset,
      done: !!problem.result,
      autoAnswerTime: null,
      answering: !!prev?.answering,   // 重复 unlock 不打断在途作答
    };
    repo.problemStatus.set(String(data.prob), status);

    if (isDeadlineReached(status.endTime, clockOffset) || problem.result) {
      log.dbg('[雨课堂助手][WARN][onUnlockProblem] 题目已过期或已作答，跳过');
      return;
    }

    if (ui.config.notifyProblems) {
      ui.notifyProblem(problem, slide);
    }

    if (ui.config.autoAnswer) {
      const delay = ui.config.autoAnswerDelay + randInt(0, ui.config.autoAnswerRandomDelay);
      status.autoAnswerTime = Date.now() + delay;
      
      log.dbg(`[雨课堂助手][INFO][onUnlockProblem] 将在 ${Math.floor(delay / 1000)} 秒后自动作答`);
      ui.toast(`将在 ${Math.floor(delay / 1000)} 秒后使用融合模式自动作答`, 3000);
    }
    
    ui.updateActiveProblems();
  },

  onLessonFinished() {
    ui.nativeNotify({ title: '下课提示', text: '当前课程已结束', timeout: 5000 });
  },

  onAnswerProblem(problemId, result) {
    const p = repo.problems.get(String(problemId));
    if (p) {
      p.result = result;
      const i = repo.encounteredProblems.findIndex(e => String(e.problemId) === String(problemId));
      if (i !== -1) repo.encounteredProblems[i].result = result;
      ui.updateProblemList?.();
    }
  },

  async handleAutoAnswer(problem) {
    return handleAutoAnswerInternal(problem);
  },

  async submit(problem, content, opts = {}) {
    const result = parseManualAnswer(problem.problemType, content);
    if (!result || (Array.isArray(result) && !result.length)) {
      ui.toast('答案为空或无法识别（选择题为选项字母，填空每空一行/逗号分隔）', 2500);
      return null;
    }
    // 与 AI 工具调用共用同一条提交链路（含过期补交判断与本地状态更新）
    return submitProblemAnswer(problem, result, opts);
  },



  navigateTo(presId, slideId) {
    repo.currentPresentationId = String(presId);
    repo.currentSlideId = String(slideId);
    repo.selectedPresentationId = String(presId);
    repo.selectedSlideId = String(slideId);
    ui.updateSlideView();
    ui.showPresentationPanel(true);
  },

  /** 从 URL 刷新当前课堂 id（fullscreen/student v3 与移动版 /m/v2/lesson/* 都认；SPA 路由变化时重取） */
  _syncLessonIdFromURL() {
    const m = location.pathname.match(/\/lesson\/(?:fullscreen|student)\/v3\/([^/]+)/)
      || location.pathname.match(/\/m\/v\d+\/lesson\/[^/]+\/([^/]+)/);
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

    if (typeof window.GM_getTab === 'function' && typeof window.GM_saveTab === 'function' && repo.currentLessonId) {
      window.GM_getTab((tab) => {
        tab.type = 'lesson';
        tab.lessonId = repo.currentLessonId;
        window.GM_saveTab(tab);
      });
    }
    this.maybeStartAutoJoin();
    this.installRouterRearm();

    // 移动版课堂页（/m/v2/lesson/*、/lesson/student/v3）：XHR 拦截器在这些页面
    // 抓不到课件数据，Vue store 的 lessonTimelineSlides/cards 是唯一来源——
    // 周期性镜像进 repo（老师翻页会追加条目；幂等 upsert）
    if (/\/lesson\//.test(location.pathname)) {
      const sync = () => { try { syncMobileSlidesIntoRepo(); } catch {} };
      sync();
      setInterval(sync, 4000);
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
          if (repo.isLessonConnected(lessonId)) continue; // 已有连接

          log.dbg('[雨课堂助手][INFO][AutoJoin] 检测到正在上课的课堂，准备进入:', lessonId);
          try {
            const { token } = await checkinClass(lessonId);
            if (!token) {
              log.warn('[雨课堂助手][WARN][AutoJoin] 未获取到 lessonToken，跳过:', lessonId);
              continue;
            }
            connectOrAttachLessonWS({ lessonId, auth: token });
            // 标记该课堂为“自动进入”
            repo.markLessonAutoJoined(lessonId, true);
            if (ui.config.autoAnswerOnAutoJoin) {
              repo.forceAutoAnswerLessons.add(lessonId);
            }
          } catch (e) {
            log.err('[雨课堂助手][ERR][AutoJoin] 进入课堂失败:', lessonId, e);
          }
        }
      } catch (e) {
          log.err('[雨课堂助手][ERR][AutoJoin] 拉取正在上课失败:', e);
      } finally {
        setTimeout(loop, 5000);
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
    const uw = (gm && gm.uw) ? gm.uw : (window.unsafeWindow || window);
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
      obj[key] = function (...args) {
        const ret = orig.apply(this, args);
        try { rearm(); } catch {}
        return ret;
      };
    };
    wrap(uw.history, 'pushState');
    wrap(uw.history, 'replaceState');
    uw.addEventListener('popstate', rearm);
    uw.addEventListener('visibilitychange', () => { if (!document.hidden) rearm(); });
  },

  // ===== 自动点击“正在上课”条：无需预先拿 lesson_id，复用官方路由逻辑 =====
  startAutoClickOnOnLessonBar() {
    if (_autoOnLessonClickStarted) return;
    // 仅在非课堂页（首页/课表页等）生效；先判断再置标志——
    // 否则课堂页提前 return 会把标志钉死，从课堂退回首页后功能再也装不上
    if (/\/lesson\//.test(location.pathname)) return;
    _autoOnLessonClickStarted = true;

    const uw = (gm && gm.uw) ? gm.uw : (window.unsafeWindow || window);

    async function tryApiJumpFirst() {
      if (_autoOnLessonClickInProgress) return false;
      _autoOnLessonClickInProgress = true;
      try {
        const list = await getOnLesson();              // ← 强化后的版本
        const arr = Array.isArray(list) ? list : [];
        // A) 严格：status===1
        let on = arr.find(x => (x?.status === 1) && (x.lessonId || x.lesson_id || x.id));
        // B) 回退：没有严格匹配，但有 lessonId 就用第一条
        if (!on) {
          const withId = arr.find(x => (x && (x.lessonId || x.lesson_id || x.id)));
          if (withId) {
            log.warn('[雨课堂助手][WARN][AutoJoin][API] 没有 status===1，但存在 lessonId，使用回退项：', {
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
            log.warn('[雨课堂助手][ERR][AutoJoin][API] EMPTY on-lesson list', {
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
          target = onMobile
            ? `/lesson/student/v3/${lessonId}`
            : `/lesson/fullscreen/v3/${lessonId}`;
        }
        else     target = `/v2/web/lesson/${lessonId}`; 
        if (location.pathname === target) { _autoOnLessonClickInProgress = false; return true; }

        location.assign(target);
        return true;
      } catch (e) {
        log.warn('[雨课堂助手][ERR][AutoJoin][API] 跳转失败：', e, {
          host: location.hostname,
          path: location.pathname
        });
        _autoOnLessonClickInProgress = false;
        return false;
      }
    }

    function attachGuardAndTrigger(root = uw.document) {
      const bar = root.querySelector('.onlesson .jump_lesson__bar');
      if (!bar || bar.__ykt_guard_bound__) return false;
      if (_autoOnLessonClickInProgress) return false;

      bar.__ykt_guard_bound__ = true;
      log.dbg('[雨课堂助手][INFO][AutoJoin][DOM] 发现 onlesson 条，接管点击（捕获阶段）');

      const handler = async (ev) => {
        ev.preventDefault();
        ev.stopImmediatePropagation?.();
        ev.stopPropagation();
        if (_autoOnLessonClickInProgress) return;

        // 延时阶梯：考虑 WS 刚推完 banner 但接口还没更新
        const delays = [0, 250, 600, 1200, 2000, 3000];
        for (const d of delays) {
          if (d) await new Promise(r => setTimeout(r, d));
          if (await tryApiJumpFirst()) return;
        }
        log.warn('[雨课堂助手][WARN][AutoJoin][DOM] on-lesson 接口仍为空，放弃本次点击');
        try {
          log.dbg('%c[AutoJoin][DOM] on-lesson 仍为空，放弃本次点击', 'color:#f60');
          log.dbg('env:', { host: location.hostname, path: location.pathname, href: location.href });
          log.dbg('retryDelays(ms):', delays);
          log.dbg('hint:', '可能是域/路径不匹配、会话未带上、或 WS/接口不同步导致。请展开上方 [getOnLesson] 折叠日志查看每个候选 URL 的状态与响应片段。');

        } catch {}
      };

      bar.addEventListener('click', handler, { capture: true });
      // 触发一次我们自己的 click（优先进入捕获处理器）
      try {
        const W = bar.ownerDocument?.defaultView || uw;
        const ClickEvt = W.MouseEvent || uw.MouseEvent;
        bar.dispatchEvent(new ClickEvt('click', { bubbles: true, cancelable: true, view: W }));
      } catch (e) {
        // 兜底：部分环境对 MouseEvent 构造器有限制
        try { bar.click(); } catch (_) {}
      }
      return true;
    }

    // A) 首选：直接 API 跳转（若此时就能拿到 on-lesson，就不必等 DOM）
    tryApiJumpFirst().then((ok) => {
      if (ok) return;
      // B) DOM 渲染后接管点击
      if (attachGuardAndTrigger()) return;
      const mo = new uw.MutationObserver(() => {
        if (attachGuardAndTrigger()) { mo.disconnect(); return; }
      });
      mo.observe(uw.document.documentElement, { childList: true, subtree: true });
      // MO 挂太久是页面级性能开销——30s 内没等到 onlesson 条就放弃
      setTimeout(() => { try { mo.disconnect(); } catch {} }, 30000);
    });
  },
};