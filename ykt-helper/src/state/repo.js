// src/state/repo.js
import { storage } from '../core/storage.js';

export const repo = {
  presentations: new Map(), // id -> presentation
  // slides / problems / problemStatus 的 key 一律存为字符串（WS/页面数据里 id 可能是数字）
  slides: new Map(),        // slideId -> slide
  problems: new Map(),      // problemId -> problem
  problemStatus: new Map(), // problemId -> {presentationId, slideId, startTime, endTime, done, autoAnswerTime, answering, clockOffset}
  encounteredProblems: [],  // [{problemId, ...ref}]
  pendingUnlocks: [],       // unlockproblem 先于课件 XHR 到达时的暂存队列

  currentPresentationId: null,
  currentSlideId: null,
  // teacherSlideId 跟老师实际翻页；selectedSlideId 跟用户在课件面板的选择。
  // 两者分开后，AI 面板才能明确选择「正在讲的页」还是「课件页选中的页」。
  teacherSlideId: null,
  selectedSlideId: null,
  selectedPresentationId: null,
  currentLessonId: null,
  currentSelectedUrl: null,

  // 按课程分组存储课件
  setPresentation(id, data, { persist = true } = {}) {
    const pid = String(id);
    this.presentations.set(pid, { ...data, id: pid });
    // 班级上传课件走 persist:false：只放内存，不占课堂课件的 5 个持久化槽位
    if (!persist) return;
    const key = this.currentLessonId ? `presentations-${this.currentLessonId}` : 'presentations';
    storage.alterMap(key, (m) => {
      m.set(pid, data);
      // 仍然做容量裁剪
      const max = (storage.get('config', {})?.maxPresentations ?? 5);
      const excess = m.size - max;
      if (excess > 0) [...m.keys()].slice(0, excess).forEach(k => m.delete(k));
    });
  },

  upsertSlide(slide) { this.slides.set(String(slide.id), slide); },
  upsertProblem(prob) { this.problems.set(String(prob.problemId), prob); },

  pushEncounteredProblem(prob, slide, presentationId) {
    if (!this.encounteredProblems.some(p => String(p.problemId) === String(prob.problemId))) {
      this.encounteredProblems.push({
        problemId: prob.problemId,
        problemType: prob.problemType,
        body: prob.body || `题目ID: ${prob.problemId}`,
        options: prob.options || [],
        blanks: prob.blanks || [],
        answers: prob.answers || [],
        slide, presentationId,
      });
    }
  },

  // === 自动进入课堂所需的多“线程”（多课堂）状态 ===
  listeningLessons: new Set(),      // lessonId 的集合，表示已经建立WS监听
  lessonTokens: new Map(),          // lessonId -> lessonToken（/lesson/checkin 返回）
  lessonSockets: new Map(),         // lessonId -> WebSocket 实例
  autoJoinRunning: false,           // 轮询开关
  autoJoinedLessons: new Set(),     // 被“自动进入”的课堂集合（仅标记自动进入建立的连接）
  forceAutoAnswerLessons: new Set(),// 若需要，可以对某些课强制视为“自动答题开启”

  // 载入本课（按课程分组）在本地存储过的课件
  loadStoredPresentations() {
    const keys = ['presentations'];
    if (this.currentLessonId) keys.push(`presentations-${this.currentLessonId}`);
    for (const key of keys) {
      const stored = storage.getMap(key);
      let removedClassCards = false;
      for (const [id, data] of [...stored.entries()]) {
        // 0.9.0 曾把班级课件写进持久化槽位（含无 lesson 的 presentations 键）；
        // 0.9.1 起只放内存，顺手清掉旧数据
        if (data?.source === 'class-card') {
          stored.delete(id);
          removedClassCards = true;
          continue;
        }
        // 有 lesson 时只载入本课键；无 lesson 时载入公共键
        if (key !== 'presentations' || !this.currentLessonId) this.setPresentation(id, data);
      }
      if (removedClassCards) storage.setMap(key, stored);
    }
  },

  /** 清理 0.9.0 遗留在公共 presentations 键里的班级课件（只清这类，不动课堂课件）。 */
  purgeLegacyClassCards() {
    const key = 'presentations';
    const stored = storage.getMap(key);
    let removed = false;
    for (const [id, data] of [...stored.entries()]) {
      if (data?.source === 'class-card') {
        stored.delete(id);
        removed = true;
      }
    }
    if (removed) storage.setMap(key, stored);
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
    if (enabled) this.autoJoinedLessons.add(lessonId);
    else this.autoJoinedLessons.delete(lessonId);
  },
};

try { repo.purgeLegacyClassCards(); } catch { /* storage may be unavailable */ }
