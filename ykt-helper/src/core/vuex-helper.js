import { log } from './log.js';
const L = (...a) => log.dbg('[雨课堂助手][DBG][vuex-helper]', ...a);
const W = (...a) => log.warn('[雨课堂助手][WARN][vuex-helper]', ...a);
const E = (...a) => log.err('[雨课堂助手][ERR][vuex-helper]', ...a);

export function getVueApp() {
  try {
    const app = document.querySelector('#app')?.__vue__;
    if (!app) W('getVueApp: 找不到 #app.__vue__');
    return app || null;
  } catch (e) {
    E('getVueApp 错误:', e);
    return null;
  }
}

// 统一返回「字符串」，并打印原始类型
export function getCurrentMainPageSlideId() {
  try {
    const app = getVueApp();
    const currSlide = app?.$store?.state?.currSlide;
    if (currSlide) {
      const rawSid = currSlide.sid;
      const sidStr = rawSid == null ? null : String(rawSid);

      log.dbg(
        '[getCurrentMainPageSlideId] 获取到 slideId:',
        sidStr,
        '{type:', currSlide.type, ', problemID:', currSlide.problemID, ', index:', currSlide.index, '}',
        '(raw type:', typeof rawSid, ', raw value:', rawSid, ')'
      );

      return sidStr;
    }

    // 移动版实时课堂（/lesson/student/v3）：store 无 currSlide，
    // 时间线卡片数组 state.cards 中最后一个含 sid 的卡片即最新推送页
    const cards = app?.$store?.state?.cards;
    if (Array.isArray(cards)) {
      for (let i = cards.length - 1; i >= 0; i--) {
        const c = cards[i];
        if (c?.sid != null) {
          const sidStr = String(c.sid);
          log.dbg('[getCurrentMainPageSlideId] 移动版时间线最新页:', sidStr, '{type:', c.type, ', problemID:', c.problemID ?? null, '}');
          return sidStr;
        }
      }
    }

    if (!app) W('getCurrentMainPageSlideId: 找不到 #app.__vue__');
    return null;
  } catch (e) {
    E('getCurrentMainPageSlideId 错误:', e);
    return null;
  }
}

export function watchMainPageChange(callback) {
  const app = getVueApp();
  if (!app || !app.$store) {
    E('watchMainPageChange: 无法获取 Vue 实例或 store');
    return () => {};
  }

  // 移动版实时课堂：监听时间线卡片数量变化（老师推送新页 = 末尾新增幻灯片卡片）
  if (Array.isArray(app.$store.state.cards)) {
    const unwatch = app.$store.watch(
      (s) => (Array.isArray(s.cards) ? s.cards.filter(c => c?.sid != null).length : 0),
      (n, o) => {
        if (n === o) return;
        const newSid = getCurrentMainPageSlideId();
        L('移动版时间线页面切换', { count: n, newSid });
        if (newSid) callback(newSid, null);
      }
    );
    L('已启动移动版时间线页面监听');
    return unwatch;
  }

  const unwatch = app.$store.watch(
    (state) => state.currSlide,
    (ns, os) => {
      const newSid = ns?.sid == null ? null : String(ns.sid);
      const oldSid = os?.sid == null ? null : String(os.sid);
      L('主界面页面切换', {
        oldSid, newSid,
        newType: ns?.type, newProblemID: ns?.problemID, newIndex: ns?.index,
        rawNewSidType: typeof ns?.sid
      });
      if (newSid) callback(newSid, ns);
    },
    { deep: false }
  );
  L('已启动主界面页面切换监听');
  return unwatch;
}

export function waitForVueReady() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const app = getVueApp();
      if (app && app.$store) {
        L('waitForVueReady: ok, elapsed(ms)=', Date.now() - t0);
        resolve(app);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}
