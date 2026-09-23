import { log } from './log.js';
import { gm } from './env.js';
const L = (...a) => log.dbg('[雨课堂助手][DBG][vuex-helper]', ...a);
const W = (...a) => log.warn('[雨课堂助手][WARN][vuex-helper]', ...a);
const E = (...a) => log.err('[雨课堂助手][ERR][vuex-helper]', ...a);

let _vueMissWarned = false;

export function getVueApp() {
  try {
    // 页面 Vue 实例的 expando（__vue__）挂在主世界 DOM 上——沙箱 document 读不到，
    // 必须经 unsafeWindow（gm.uw）拿主世界的 document
    const doc = gm.uw?.document || document;
    const el = doc.querySelector('#app');
    const app = el?.__vue__ || el?.__vue_app__ || null;
    if (!app) {
      if (!_vueMissWarned) { _vueMissWarned = true; W('getVueApp: 找不到 #app.__vue__（静默重试中，直到 waitForVueReady 超时）'); }
      return null;
    }
    _vueMissWarned = false;
    return app;
  } catch (e) {
    E('getVueApp 错误:', e);
    return null;
  }
}

/** Vue2 是 app.$store；Vue3 挂在 app.config.globalProperties.$store */
function getStore(app) {
  return app?.$store || app?.config?.globalProperties?.$store || null;
}

// 统一返回「字符串」，并打印原始类型
export function getCurrentMainPageSlideId() {
  try {
    const app = getVueApp();
    const store = getStore(app);
    const currSlide = store?.state?.currSlide;
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
    const cards = store?.state?.cards;
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
  const store = getStore(app);
  if (!app || !store) {
    E('watchMainPageChange: 无法获取 Vue 实例或 store');
    return () => {};
  }

  // 移动版实时课堂：watch「最后一个含 sid 卡片的 sid 值」——
  // 不能只 watch 数量：数量不变的重发/回跳也需要触发
  if (Array.isArray(store.state?.cards)) {
    const lastSid = (s) => {
      const arr = s.cards;
      if (!Array.isArray(arr)) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.sid != null) return String(arr[i].sid);
      }
      return null;
    };
    const unwatch = store.watch(lastSid, (n, o) => {
      if (!n || n === o) return;
      L('移动版时间线页面切换', { newSid: n });
      callback(n, null);
    });
    L('已启动移动版时间线页面监听');
    return unwatch;
  }

  const unwatch = store.watch(
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

export function waitForVueReady(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const app = getVueApp();
      if (app && getStore(app)) {
        L('waitForVueReady: ok, elapsed(ms)=', Date.now() - t0);
        resolve(app);
      } else if (Date.now() - t0 >= timeoutMs) {
        W(`waitForVueReady: ${timeoutMs}ms 内未等到 Vue store，放弃（跟随/识别功能降级）`);
        resolve(null);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}
