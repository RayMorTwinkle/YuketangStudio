import tpl from './presentation.html';
import { ui } from '../ui-api.js';
import { repo } from '../../state/repo.js';
import { actions } from '../../state/actions.js';
import { exportImagesToPdf } from '../../core/pdf-export.js';
import { importHistoryLesson, fetchClassActivities, currentClassId } from '../../core/history-capture.js';
import { log } from '../../core/log.js';
import { waitForVueReady, watchMainPageChange } from '../../core/vuex-helper.js';

let mounted = false;
let host;
let staticReportReady = false; //已结束课程
let followCurrent = true;      // 跟随课堂翻页：true=选中项自动跟随当前页；用户手动点缩略图后脱离

function findSlideAcrossPresentations(idStr) {
  for (const [, pres] of repo.presentations) { const arr = pres?.slides || []; const hit = arr.find(s => String(s.id) === idStr); if (hit) return hit; }
  return null;
}

const L = (...a) => log.dbg('[presentation]', ...a);
const W = (...a) => log.warn('[presentation]', ...a);

function $(sel) { return document.querySelector(sel); }

/** —— 运行时自愈：把 repo.slides 的数字键迁移为字符串键 —— */
function normalizeRepoSlidesKeys(tag = 'presentation.mount') {
  try {
    if (!repo || !repo.slides || !(repo.slides instanceof Map)) {
      W('normalizeRepoSlidesKeys: repo.slides 不是 Map');
      return;
    }
    const beforeKeys = Array.from(repo.slides.keys());
    const nums = beforeKeys.filter(k => typeof k === 'number');
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
    W('normalizeRepoSlidesKeys error:', e);
  }
}

// Map 查找
function getSlideByAny(id) {
  const sid = id == null ? null : String(id);
  if (!sid) return { slide: null, hit: 'none' };
  if (repo.slides.has(sid)) return { slide: repo.slides.get(sid), hit: 'string' };
  const cross = findSlideAcrossPresentations(sid);
  if (cross) { repo.slides.set(sid, cross); return { slide: cross, hit: 'cross-fill' }; }
  return { slide: null, hit: 'miss' };
}

function getSlideImageUrl(slide) {
  if (!slide) return '';
  // Prefer original image fields, then fallback-compatible fields.
  return slide.coverAlt || slide.cover || slide.image || slide.thumbnail || '';
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
  if (document.querySelector('#content-page-wrap')) {
    return document;
  }
  for (let i = 0; i < window.frames.length; i++) {
    try {
      const d = window.frames[i].document;
      if (d && d.querySelector('#content-page-wrap')) {
        log.dbg('[presentation][static-report] 在子 frame 中找到了 content-page-wrap');
        return d;
      }
    } catch (e) {
    }
  }

  log.dbg('[presentation][static-report] 所有 frame 中都没有 content-page-wrap，退回顶层 document');
  return document;
}

function collectStaticSlideURLsFromDom() {
  const urls = new Set();

  const doc = getSlidesDocument();
  const candidates = doc.querySelectorAll(
    'section.slides-list img, .slides-list img,' +
    'div.slide-item img,' +
    'img[alt="cover"]'
  );

  log.dbg('[presentation][static-report] DOM 候选 img 数量 =', candidates.length);

  candidates.forEach((img) => {
    const src = img.currentSrc || img.src || img.getAttribute('src') || '';
    if (!src) return;

    // 任意 *.yuketang.cn 子域的 /slide/<id>/ 图都算（此前写死 thu-private-qn，其他学校漏收）
    if (/\.yuketang\.cn\/slide\/\d+\//i.test(src) &&
        /\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(src)) {
      urls.add(src);
    }
  });

  const arr = [...urls];
  log.dbg('[presentation][static-report] DOM 收集到 slide URL：', arr);
  return arr;
}


function ensureStaticReportPresentation() {
  if (!isStudentLessonReportPage()) return false;

  const pid = `static:${window.location.pathname}`;

  // 如果已经注入过，就不再重复扫描 & 打印日志，直接返回 false
  if (staticReportReady && repo.presentations.has(pid)) {
    return false;
  }

  const urlsFromDom = collectStaticSlideURLsFromDom();
  const urls = Array.from(new Set([...urlsFromDom]));

  if (!urls.length) {
    log.dbg('[presentation][static-report] 依然没有发现任何 slide URL');
    return false;
  }

  const withIndex = urls.map((u, i) => ({ u, idx: extractCoverIndex(u) ?? (i + 1) }));
  withIndex.sort((a, b) => a.idx - b.idx);

  const slides = withIndex.map(({ u, idx }) => {
    const id = `static-${idx}`;
    return { id, index: idx, title: `第 ${idx} 页`, thumbnail: u, image: u, problem: null };
  });

  const titleFromPage =
    document.querySelector('.lesson-title, .title, h1, .header-title')?.textContent?.trim() ||
    '静态课件（报告页）';

  const presentation = { id: pid, title: titleFromPage, slides };
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

  staticReportReady = true; // ★ 标记为已完成

  log.dbg('[presentation][static-report] 已注入/更新 presentation', {
    pid,
    title: presentation.title,
    slideCount: slides.length,
    newSlidesFilled: filled,
    existed,
    sample: slides.slice(0, 3).map(s => s.image)
  });

  return true;
}


export function mountPresentationPanel() {
  if (mounted) return host;

  normalizeRepoSlidesKeys('presentation.mount');

  const wrapper = document.createElement('div');
  wrapper.innerHTML = tpl;
  document.body.appendChild(wrapper.firstElementChild);
  host = document.getElementById('ykt-presentation-panel');

  // 关闭统一走 shell 右上角 ✕（面板自带 X 已删，见 html）

  // 题目页筛选开关（原「题目列表」功能的替代：点一下只看题目页，再点恢复全部）
  const filterBtn = $('#ykt-filter-problems');
  const syncFilterBtn = () => filterBtn?.classList.toggle('active', !!ui.config.filterProblemsOnly);
  syncFilterBtn();
  filterBtn?.addEventListener('click', () => {
    ui.config.filterProblemsOnly = !ui.config.filterProblemsOnly;
    ui.saveConfig();
    syncFilterBtn();
    ui.toast(ui.config.filterProblemsOnly ? '只显示带题目的页面' : '显示全部页面', 1500);
    L('切换 filterProblemsOnly =', ui.config.filterProblemsOnly);
    updatePresentationList();
  });

  // 跟随当前页开关：开启时选中项自动跟随课堂翻页；手动点缩略图会脱离
  const followBtn = $('#ykt-follow-current');
  const syncFollowBtn = () => followBtn?.classList.toggle('active', followCurrent);
  syncFollowBtn();
  followBtn?.addEventListener('click', () => {
    followCurrent = !followCurrent;
    syncFollowBtn();
    ui.toast(followCurrent ? '已跟随课堂翻页' : '已脱离跟随（点「回到当前页」恢复）', 1500);
    if (followCurrent) {
      updateFollowHighlight();
      updateSlideView();
    }
  });

  // 课堂翻页时（Vue watcher）：跟随模式把 repo 当前页推进到老师展示的页，再联动高亮与大图
  waitForVueReady().then(() => {
    watchMainPageChange((slideId) => {
      const sid = slideId == null ? null : String(slideId);
      L('课堂翻页事件', { slideId: sid, followCurrent });
      if (!sid) return;
      if (followCurrent) {
        repo.currentSlideId = sid;
        // 同步所属课件——跨课件翻页时右侧大图/选中态才不会指错课件
        for (const [pid, pres] of repo.presentations) {
          if ((pres?.slides || []).some(s => String(s.id) === sid)) {
            repo.currentPresentationId = String(pid);
            break;
          }
        }
        updateFollowHighlight();
        updateSlideView();
      } else {
        renderFollowBadge();
      }
    });
  }).catch(e => W('Vue 初始化失败，跟随功能降级:', e));

  $('#ykt-download-pdf')?.addEventListener('click', downloadPresentationPDF);
  $('#ykt-import-history')?.addEventListener('click', openHistoryImporter);

  mounted = true;
  L('mountPresentationPanel 完成');
  // shell 切到本 tab 时刷新列表（课件数据可能晚于挂载到达）
  host.__yksOnShow = () => updatePresentationList();
  // 不中止导出：切 tab/收起壳时 PDF 继续在后台生成（不刷新页面就不丢进度）
  host.__yksOnHide = () => {};
  return host;
}

/** 跟随高亮：把 active 标到当前页缩略图上并滚动到可见 */
function updateFollowHighlight() {
  const listEl = document.getElementById('ykt-presentation-list');
  if (!listEl) return;
  const currentIdStr = getCurrentSlideId();
  if (!currentIdStr) return;
  let active = null;
  for (const t of listEl.querySelectorAll('.slide-thumb')) {
    const isActive = t.dataset.slideId === currentIdStr;
    t.classList.toggle('active', isActive);
    if (isActive) active = t;
  }
  active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  L('跟随高亮', { currentIdStr });
}

/** 面板顶部的小徽标：非跟随模式下提示当前课堂页码 */
function renderFollowBadge() {
  const btn = document.getElementById('ykt-follow-current');
  if (!btn) return;
  // 按钮文案由 CSS/结构固定，这里不做额外渲染（跟随状态在按钮 active 类上）
}

export function showPresentationPanel(visible = true) {
  mountPresentationPanel();
  host.classList.toggle('visible', !!visible);
  if (visible) {
    updatePresentationList();}
  L('showPresentationPanel', { visible });
}

export function updatePresentationList() {
  mountPresentationPanel();

  try {
    if (isStudentLessonReportPage()) {
      ensureStaticReportPresentation();
    }
  } catch (e) {
    W('[static-report] 检测/注入失败：', e);
  }

  if (!window.__ykt_static_dom_mo) {
    window.__ykt_static_dom_mo = true;
    let times = 0;

    const mo = new MutationObserver(() => {
      if (!isStudentLessonReportPage()) { try { mo.disconnect(); } catch {} return; }
      if (++times > 20) { try { mo.disconnect(); } catch {} return; }   // 20 次未命中就放弃——不再让 observer 永久空转

      log.dbg('[presentation][static-report] DOM 变更，尝试重新收集 slide URL (times =', times, ')');
      const injected = ensureStaticReportPresentation();
      if (injected) {
        log.dbg('[presentation][static-report] DOM 中已找到 slide，停止监听并刷新面板');
        try { mo.disconnect(); } catch (e) {}
        updatePresentationList();
      }
    });

    const rootSelector = "#content-page-wrap > div > aside > div.left-panel-scroll > div.left-panel-tab-content > div > section.slides-list";
    let target = document.querySelector(rootSelector) || document.querySelector('section.slides-list') || document.body;

    log.dbg('[presentation][static-report] MutationObserver 监听目标：', {
      useBody: target === document.body,
      hasSlidesList: target !== document.body
    });

    mo.observe(target, { childList: true, subtree: true });
  }

  const listEl = document.getElementById('ykt-presentation-list');
  if (!listEl) { W('updatePresentationList: 缺少容器'); return; }

  listEl.innerHTML = '';

  if (repo.presentations.size === 0) {
    listEl.innerHTML = '<p class="no-presentations">暂无课件记录</p>';
    W('无 presentations');
    return;
  }

  // 课件按 presentation_id 收集、无法可靠归属到课堂——此前按 URL lessonId 过滤是无效逻辑（恒等于全量），删掉
  const presentationsToShow = repo.presentations;
  L('展示课件数量=', presentationsToShow.size);

  try {
    let filled = 0, total = 0;
    for (const [, pres] of presentationsToShow) {
      const arr = pres?.slides || [];
      total += arr.length;
      for (const s of arr) {
        const sid = String(s.id);
        if (!repo.slides.has(sid)) { repo.slides.set(sid, s); filled++; }
      }
    }
    const sample = Array.from(repo.slides.keys()).slice(0, 8);
    L('[hydrate slides → repo.slides]', { filled, totalVisibleSlides: total, sampleKeys: sample });
  } catch (e) {
    W('hydrate repo.slides 失败：', e);
  }

  for (const [id, presentation] of presentationsToShow) {
    const cont = document.createElement('div');
    cont.className = 'presentation-container';

    const titleEl = document.createElement('div');
    titleEl.className = 'presentation-title';
    // 课件标题来自服务端——不用 innerHTML 注入
    const titleSpan = document.createElement('span');
    titleSpan.textContent = presentation.title || `课件 ${id}`;
    const dlIcon = document.createElement('i');
    dlIcon.className = 'fas fa-download download-btn';
    dlIcon.title = '下载课件';
    titleEl.appendChild(titleSpan);
    titleEl.appendChild(dlIcon);
    cont.appendChild(titleEl);

    titleEl.querySelector('.download-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      L('点击下载课件', { presId: String(presentation.id) });
      downloadPresentation(presentation);
    });

    const slidesWrap = document.createElement('div');
    slidesWrap.className = 'slide-thumb-list';

    const slides = (presentation.slides || []);
    const showProblemsOnly = !!ui.config.filterProblemsOnly;
    const slidesToShow = showProblemsOnly ? slides.filter(s => s.problem) : slides;

    const currentIdStr = repo.currentSlideId != null ? String(repo.currentSlideId) : null;
    L('渲染课件缩略图', {
      presId: String(presentation.id),
      slidesTotal: slides.length,
      slidesShown: slidesToShow.length,
      currentSlideId: currentIdStr
    });

    for (const s of slidesToShow) {
      const presIdStr = String(presentation.id);
      const slideIdStr = String(s.id);

      const thumb = document.createElement('div');
      thumb.className = 'slide-thumb';
      thumb.dataset.slideId = slideIdStr;

      if (currentIdStr && slideIdStr === currentIdStr) thumb.classList.add('active');

      if (s.problem) {
        const pid = String(s.problem.problemId);
        const status = repo.problemStatus.get(pid);
        if (status) thumb.classList.add('unlocked');
        if (s.problem.result) thumb.classList.add('answered');
      }

      thumb.addEventListener('click', () => {
        // 用户手动选择 → 脱离跟随模式
        if (followCurrent) {
          followCurrent = false;
          document.getElementById('ykt-follow-current')?.classList.remove('active');
        }
        repo.currentPresentationId = presIdStr;
        repo.currentSlideId = slideIdStr;

        slidesWrap.querySelectorAll('.slide-thumb.active').forEach(el => el.classList.remove('active'));
        thumb.classList.add('active');

        updateSlideView();

        if (!repo.slides.has(slideIdStr)) {
          const cross = findSlideAcrossPresentations(slideIdStr); if (cross) { repo.slides.set(slideIdStr, cross); L('click-fill repo.slides <- cross', { slideIdStr }); }
        }

        const detail = { slideId: slideIdStr, presentationId: presIdStr };
        window.dispatchEvent(new CustomEvent('ykt:presentation:slide-selected', { detail }));

        actions.navigateTo(presIdStr, slideIdStr);
      });

      const img = document.createElement('img');
      if (presentation.width && presentation.height) {
        img.style.aspectRatio = `${presentation.width}/${presentation.height}`;
      }
      img.src = s.thumbnail || '';
      img.alt = s.title || `第 ${s.page ?? ''} 页`;
      img.onerror = function () {
        W('缩略图加载失败，移除该项', { slideIdStr, src: img.src });
        if (thumb.parentNode) thumb.parentNode.removeChild(thumb);
      };

      const idx = document.createElement('span');
      idx.className = 'slide-index';
      idx.textContent = s.index ?? '';

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
  L('downloadPresentation -> 设置 currentPresentationId', repo.currentPresentationId);
  downloadPresentationPDF();
}

export function updateSlideView() {
  mountPresentationPanel();
  const slideView = $('#ykt-slide-view');
  const problemView = $('#ykt-problem-view');
  slideView.querySelector('.slide-cover')?.classList.add('hidden');
  problemView.innerHTML = '';

  const curId = getCurrentSlideId();
  const lookup = getSlideByAny(curId);
  L('updateSlideView', { curId, lookupHit: lookup.hit, hasInMap: !!lookup.slide });

  if (!curId || !lookup.slide) {
    // 无选中页（或 slide 数据未到达）：重建空态，避免残留上一次渲染的封面图
    if (!curId) W('updateSlideView: 无当前页');
    else W('updateSlideView: 根据 curId 未取到 slide', { curId });
    slideView.innerHTML = '';
    const emptyCover = document.createElement('div');
    emptyCover.className = 'slide-cover';
    const em = document.createElement('div');
    em.className = 'empty-message';
    em.textContent = '选择左侧的幻灯片查看详情';
    emptyCover.appendChild(em);
    slideView.appendChild(emptyCover);
    slideView.appendChild(problemView);
    return;
  }
  const slide = lookup.slide;

  const cover = document.createElement('div');
  cover.className = 'slide-cover';
  const img = document.createElement('img');
  // 不要设 crossOrigin=anonymous：OSS 无 CORS 头时图片直接拒绝加载；
  // 展示场景不需要读像素，污染问题只在 PDF 导出时由 GM_xhr 绕开
  img.src = getSlideImageUrl(slide);
  img.alt = slide.title || '';
  cover.appendChild(img);

  if (slide.problem) {
    const prob = slide.problem;
    const box = document.createElement('div');
    box.className = 'problem-box';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'problem-box-close';
    closeBtn.title = '关闭题干浮框';
    closeBtn.setAttribute('aria-label', '关闭题干浮框');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      box.remove();
    });
    box.appendChild(closeBtn);

    const head = document.createElement('div');
    head.className = 'problem-head';
    head.textContent = prob.body || `题目 ${prob.problemId}`;
    box.appendChild(head);

    if (Array.isArray(prob.options) && prob.options.length) {
      const opts = document.createElement('div');
      opts.className = 'problem-options';
      prob.options.forEach((o) => {
        const li = document.createElement('div');
        li.className = 'problem-option';
        li.textContent = `${o.key}. ${o.value}`;
        opts.appendChild(li);
      });
      box.appendChild(opts);
    }
    problemView.appendChild(box);
  }

  slideView.innerHTML = '';
  slideView.appendChild(cover);
  slideView.appendChild(problemView);
}

/** 历史课件导入：列出该班级全部课堂 → 多选 → 逐个自动收集导出 PDF */
async function openHistoryImporter() {
  // 防重复：已有浮层先关掉（多次点击会叠加）
  [...document.querySelectorAll('div')].filter(d => d.style?.cssText?.includes('rgba(0,0,0,.45)') && (d.innerText || '').includes('历史课堂')).forEach(d => d.remove());
  const classId = currentClassId();
  if (!classId) {
    return ui.toast('请先进入课程的「学习日志」页（含班级 ID），再使用历史课件导入');
  }
  ui.toast('正在获取课堂列表…');
  let activities;
  try {
    activities = await fetchClassActivities(classId);
  } catch (e) {
    return ui.toast('获取课堂列表失败：' + (e?.message || e));
  }
  // 排除正在进行中的课堂（is_finished=false）：数据不完整且导出无意义
  const ongoing = activities.filter(a => a.is_finished === false);
  activities = activities.filter(a => a.is_finished !== false);
  if (ongoing.length) ui.toast(`已排除 ${ongoing.length} 个进行中的课堂`, 2500);
  if (!activities.length) {
    return ui.toast(ongoing.length ? '该班级只有进行中的课堂，暂无可导入' : '该班级没有可导入的课堂');
  }

  // 构建多选浮层：flex 布局——标题/底部按钮固定，列表区滚动（窄屏下按钮不再被顶出视口）
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999999;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:10px;width:520px;max-width:100%;max-height:76vh;display:flex;flex-direction:column;padding:16px 20px;font-size:13px;box-shadow:0 10px 40px rgba(0,0,0,.25);';
  box.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:10px;flex:0 0 auto">📥 选择要导入的历史课堂（可多选）</div>`;
  const listWrap = document.createElement('div');
  listWrap.style.cssText = 'flex:1 1 auto;overflow:auto;min-height:0;';
  box.appendChild(listWrap);
  // 已下载记录（key: ykt-dl-done:<classId> = [lessonId,...]）——重开浮层时标灰，避免重复下载
  const doneKey = `ykt-dl-done:${classId}`;
  let doneSet = new Set();
  try { doneSet = new Set(typeof GM_getValue === 'function' ? (GM_getValue(doneKey) || []) : []); } catch {}
  const markDone = (lessonId) => {
    if (!lessonId) return;
    doneSet.add(String(lessonId));
    try { if (typeof GM_setValue === 'function') GM_setValue(doneKey, [...doneSet]); } catch {}
  };
  const chosen = new Set();
  const rowEls = [];
  // 选中态高亮：选中行加背景+边框色（解决选中/未选中看不出区别）
  const paintRow = (row) => {
    const cb = row.querySelector('input');
    row.style.background = cb.checked ? '#eff6ff' : '#fff';
    row.style.borderColor = cb.checked ? '#1d63df' : '#e5e7eb';
  };
  for (const a of activities) {
    const d = new Date(a.create_time || 0);
    const t = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const row = document.createElement('label');
    const isDone = doneSet.has(String(a.courseware_id));   // markDone 存的是 courseware_id（lessonId）
    row.style.cssText = 'padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#fff;' + (isDone ? 'opacity:.55;' : '');
    // 课堂标题来自服务端——不用 innerHTML 注入
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.id = a.id;
    cb.style.cssText = 'flex:0 0 auto;width:16px;height:16px;accent-color:#1d63df;cursor:pointer';
    const titleSpan = document.createElement('span');
    titleSpan.style.flex = '1';
    titleSpan.textContent = a.title || '未命名课堂';
    const timeSpan = document.createElement('span');
    timeSpan.style.cssText = 'color:#607190;white-space:nowrap';
    timeSpan.textContent = `${t}${a.attend_status ? ' ✅' : ''}${isDone ? ' ·已下载' : ''}`;
    row.appendChild(cb);
    row.appendChild(titleSpan);
    row.appendChild(timeSpan);
    cb.addEventListener('change', () => {
      if (cb.checked) chosen.add(a); else chosen.delete(a);
      paintRow(row);
      downloadBtn.textContent = chosen.size ? `⬇️ 下载选中 (${chosen.size})` : '⬇️ 下载选中';
      downloadBtn.style.opacity = chosen.size ? '1' : '.5';
    });
    rowEls.push(row);
    listWrap.appendChild(row);
  }
  // 全选/清空
  const selectBar = document.createElement('div');
  selectBar.style.cssText = 'display:flex;gap:8px;margin:6px 0;';
  const mkSel = (text, all) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'flex:1;padding:5px;border:1px solid #e5e7eb;border-radius:6px;background:#f7f8fa;cursor:pointer;font-size:12px;';
    b.addEventListener('click', () => {
      chosen.clear();
      for (const row of rowEls) {
        const cb = row.querySelector('input');
        cb.checked = all;
        if (all) {
          const a = activities.find(x => String(x.id) === cb.dataset.id);
          if (a) chosen.add(a);
        }
        paintRow(row);
      }
      downloadBtn.textContent = chosen.size ? `⬇️ 下载选中 (${chosen.size})` : '⬇️ 下载选中';
      downloadBtn.style.opacity = chosen.size ? '1' : '.5';
    });
    return b;
  };
  selectBar.appendChild(mkSel('全选', true));
  selectBar.appendChild(mkSel('清空', false));
  box.appendChild(selectBar);
  selectBar.style.flex = '0 0 auto';
  // 下载按钮
  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = '⬇️ 下载选中';
  downloadBtn.style.cssText = 'width:100%;padding:9px;border:none;border-radius:8px;background:#1d63df;color:#fff;font-size:14px;font-weight:600;cursor:pointer;opacity:.5;flex:0 0 auto;';
  downloadBtn.addEventListener('click', async () => {
    const list = [...chosen];
    if (!list.length) return ui.toast('请先勾选要下载的课堂', 2000);
    mask.remove();
    // 取消信号：✕ → 二次确认 → abort，正在跑的收集页会被立刻关掉
    const ctrl = new AbortController();
    const bar = showImportProgressBar(`批量 ${list.length} 个课堂`, () => ctrl.abort());
    const okList = [], failList = [];
    let cancelled = false;
    let processed = 0;
    for (let i = 0; i < list.length; i++) {
      if (bar.cancelled) { cancelled = true; break; }
      const a = list[i];
      bar.update(Math.round((i / list.length) * 100), `(${i + 1}/${list.length}) ${a.title || '未命名课堂'} · 打开收集页…`);
      try {
        const r = await importHistoryLesson(classId, a, {
          signal: ctrl.signal,
          onProgress: (p) => {
            if (p.phase === 'error') { bar.update(Math.round(((i + 0.9) / list.length) * 100), `(${i + 1}/${list.length}) ${p.text || '失败'}`); return; }
            // 混合进度：前 i 个已完成 + 当前课件的 pct
            const overall = Math.round(((i + (p.pct || 0) / 100) / list.length) * 100);
            const bits = [];
            if (p.skipped) bits.push(`去重 ${p.skipped}`);
            if (p.failed) bits.push(`失败 ${p.failed}`);
            bar.update(overall, `(${i + 1}/${list.length}) ${p.text || ''}${bits.length ? ` · ${bits.join('，')}` : ''}`);
          },
        });
        processed = i + 1;
        if (r?.ok) {
          okList.push(r.title || a.title || '未命名');
          markDone(a.courseware_id);
          const warnBit = (r.expectedTotal && r.total < r.expectedTotal) ? ` ⚠️仅${r.total}/${r.expectedTotal}页` : '';
          ui.toast(`✅「${r.title || a.title}」完成：${r.pages} 页${r.skipped ? `（去重 ${r.skipped}）` : ''}${warnBit}`, 2500);
        } else {
          failList.push(`${a.title || '未命名'}：${r?.error || '未知错误'}`);
        }
      } catch (e) {
        // 用户主动取消：不计入失败，直接收尾
        if (e?.name === 'AbortError') { cancelled = true; break; }
        failList.push(`${a.title || '未命名'}：${e?.message || e}`);
      }
    }
    if (cancelled) {
      bar.fail(`已取消整批下载：完成 ${okList.length} 个，未下载 ${list.length - processed} 个（已完成的文件保留）`);
      ui.toast(`已取消：完成 ${okList.length} 个，剩余 ${list.length - processed} 个未下载`, 4000);
      notifyDone('已取消批量下载', `完成 ${okList.length} 个，剩余 ${list.length - processed} 个未下载`);
      return;
    }
    // 汇总（失败明细必须可见——否则部分失败被静默吞掉）
    const summary = [`完成 ${okList.length} 个，失败 ${failList.length} 个`];
    if (failList.length) {
      summary.push(`失败明细：${failList.join('；')}`);
      log.warn('[History] 批量导入失败明细:', failList);
    }
    if (failList.length) {
      bar.fail(summary.join('  ').slice(0, 400));
    } else {
      bar.done(`✅ 批量导入完成：${summary[0]}`);
    }
    ui.toast(summary[0], 4000);
    notifyDone('批量下载结束', summary[0]);
  });
  box.appendChild(downloadBtn);
  const closeBtn = document.createElement('div');
  closeBtn.textContent = '取消';
  closeBtn.style.cssText = 'text-align:center;color:#607190;cursor:pointer;padding:8px 0 2px;flex:0 0 auto;';
  closeBtn.addEventListener('click', () => mask.remove());
  box.appendChild(closeBtn);
  mask.appendChild(box);
  document.body.appendChild(mask);
}

/** 长任务结束的系统通知（用户可能已切走；不支持则静默，toast 已覆盖当前界面） */
function notifyDone(title, text) {
  try {
    if (typeof GM_notification === 'function') {
      GM_notification({ title, text, timeout: 8000 });
    }
  } catch { /* 忽略 */ }
}

/** 通用二次确认（脚本内自绘，不依赖 window.confirm——WebView 里它默认返回 false） */
function confirmDialog(title, text, okLabel = '确认取消') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:100000002;display:flex;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;padding:18px 18px 12px;max-width:340px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:14px;color:#1a2233;';
    box.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px">${title}</div>
      <div style="color:#607190;font-size:13px;line-height:1.6">${text}</div>`;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px;';
    const no = document.createElement('button');
    no.textContent = '继续下载';
    no.style.cssText = 'padding:9px 16px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;font-size:14px;color:#44506b;';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.style.cssText = 'padding:9px 16px;border:none;background:#d64545;color:#fff;border-radius:8px;font-size:14px;font-weight:600;';
    const done = (v) => { mask.remove(); resolve(v); };
    no.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    mask.addEventListener('click', (e) => { if (e.target === mask) done(false); });
    bar.appendChild(no); bar.appendChild(ok);
    box.appendChild(bar); mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

/** 全局导入进度条（固定左下角工具栏上方，独立于面板生命周期）
 *  onCancel：用户点 ✕ 并二次确认后调用（用于中止正在跑的收集页） */
function showImportProgressBar(title, onCancel) {
  document.getElementById('ykt-import-progress')?.remove();
  const bar = document.createElement('div');
  bar.id = 'ykt-import-progress';
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:56px;z-index:99999998;background:#fff;border:1px solid #c7d2fe;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.18);padding:10px 12px;font-size:13px;max-width:420px;margin:0 auto;';
  bar.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;color:#1d63df;display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📥 正在导入「${title}」</span>
      <button class="ip-close" title="取消整批下载" style="flex:0 0 auto;width:34px;height:34px;border:none;background:#fdecec;color:#c0392b;border-radius:8px;font-size:16px;line-height:1;cursor:pointer">✕</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;height:8px;background:#dbeafe;border-radius:4px;overflow:hidden">
        <div class="ip-fill" style="height:100%;width:0%;background:#1d63df;border-radius:4px;transition:width .3s"></div>
      </div>
      <span class="ip-pct" style="min-width:36px;text-align:right;color:#607190">0%</span>
    </div>
    <div class="ip-text" style="margin-top:5px;color:#607190;font-size:12px">正在打开收集页…</div>`;
  document.body.appendChild(bar);
  const api = {
    cancelled: false,
    update(pct, text) {
      const f = bar.querySelector('.ip-fill'); if (f) f.style.width = `${pct}%`;
      const p = bar.querySelector('.ip-pct'); if (p) p.textContent = `${pct}%`;
      const t = bar.querySelector('.ip-text'); if (t) t.textContent = text;
    },
    done(text) {
      const f = bar.querySelector('.ip-fill'); if (f) f.style.width = '100%';
      const t = bar.querySelector('.ip-text'); if (t) { t.textContent = text; t.style.color = '#059669'; }
      bar.querySelector('.ip-close')?.remove();
      setTimeout(() => bar.remove(), 30000);
    },
    fail(text) {
      const t = bar.querySelector('.ip-text'); if (t) { t.textContent = '❌ ' + text; t.style.color = '#c0392b'; }
      bar.querySelector('.ip-close')?.remove();
      setTimeout(() => bar.remove(), 30000);
    },
  };
  bar.querySelector('.ip-close')?.addEventListener('click', async () => {
    if (api.cancelled) return;
    const ok = await confirmDialog(
      '取消整批下载？',
      '已下载完成的课堂会保留；正在下载的这个课堂会立即中止（收集页会关闭）。',
    );
    if (!ok) return;
    api.cancelled = true;
    api.update(0, '已取消整批下载');
    const t = bar.querySelector('.ip-text');
    if (t) t.style.color = '#c0392b';
    bar.querySelector('.ip-close')?.remove();
    try { onCancel?.(); } catch {}
  });
  return api;
}

let pdfAbortCtrl = null;   // 进行中的整册导出（取消按钮/关面板时中止）

async function downloadPresentationPDF() {
  // 并发守卫：导出中再点直接提示——否则新 AbortController 覆盖旧的，
  // 旧导出失控且 yield 队列会让双方都概率性挂起
  if (pdfAbortCtrl) return ui.toast('已有导出任务进行中，请先取消或等它完成', 2500);
  let pid = repo.currentPresentationId != null ? String(repo.currentPresentationId) : null;
  // 回退：用户没点过缩略图/课件标题时，自动选用列表里的课件（通常只有一份），
  // 而不是让他「请先选择」再点一次——37 页都收好了却导不出，纯属多一步
  if (!pid || !repo.presentations.has(pid)) {
    const first = repo.presentations.entries().next();
    if (first.done) return ui.toast('当前没有可导出的课件（等课件加载后重试）');
    pid = first.value[0];
    repo.currentPresentationId = pid;
    L('downloadPresentationPDF: 自动回退到课件', { pid });
  }
  const pres = repo.presentations.get(pid);
  if (!pres || !Array.isArray(pres.slides) || pres.slides.length === 0) {
    return ui.toast('未找到该课件的页面');
  }

  // 整册导出：不受「只看题目页」筛选影响（筛选只作用于浏览列表）
  const slides = pres.slides;
  if (slides.length === 0) return ui.toast('该课件没有页面');

  // 进度条元素
  const progressEl = document.getElementById('ykt-pdf-progress');
  const progressFill = document.getElementById('ykt-pdf-progress-fill');
  const progressText = document.getElementById('ykt-pdf-progress-text');
  const cancelBtn = document.getElementById('ykt-pdf-cancel');
  const showProgress = (pct, text) => {
    if (progressEl) progressEl.style.display = 'flex';
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = text || `${pct}%`;
  };
  const hideProgress = () => {
    if (progressEl) progressEl.style.display = 'none';
  };

  // 整册导出委托公共 pdf-export：并发下载、GM_xhr 绕 CORS、内容级去重
  const urls = slides.map(getSlideImageUrl).filter(Boolean);
  if (!urls.length) return ui.toast('该课件没有可用页面图片');

  // 取消支持：✕ 按钮 + 关面板（__yksOnHide）都中止导出
  pdfAbortCtrl = new AbortController();
  const onCancel = () => { pdfAbortCtrl?.abort(); };
  cancelBtn?.addEventListener('click', onCancel, { once: true });

  // 停滞看门狗：45s 没有任何进度回调 → 提示可能卡死（用户不再面对无声定格）
  let lastProgressAt = Date.now();
  const stallTimer = setInterval(() => {
    const stall = Math.round((Date.now() - lastProgressAt) / 1000);
    if (stall > 45 && progressText) {
      progressText.textContent = `已停滞 ${stall}s（可能在解码大图或网络挂起，可点 ✕ 取消）`;
    }
  }, 5000);

  try {
    const { pages, skipped, failed } = await exportImagesToPdf(urls, pres.title || `课件-${pid}`, {
      dedupHash: true,
      signal: pdfAbortCtrl.signal,
      onProgress: (info) => { lastProgressAt = Date.now(); showProgress(info.pct ?? 0, info.text || `${info.pct ?? 0}%`); },
    });
    const bits = [`${pages} 页`];
    if (skipped) bits.push(`去重 ${skipped}`);
    if (failed) bits.push(`失败 ${failed}`);
    ui.toast(`PDF 生成完成（${bits.join('，')}）`, 2500);
  } catch (e) {
    if (pdfAbortCtrl.signal.aborted) ui.toast('已取消导出', 2000);
    else ui.toast(`导出 PDF 失败：${e?.message || e}`, 5000);
  } finally {
    clearInterval(stallTimer);
    cancelBtn?.removeEventListener('click', onCancel);
    pdfAbortCtrl = null;
    setTimeout(hideProgress, 1500);
  }
}
