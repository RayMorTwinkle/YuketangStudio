// src/core/update-check.js
// 更新检测：GET api.raymor.top/yuketangstudio/latest（svc 国内渠道元数据）
// 响应 {version, userscript, apk, notes}
//
// 两条使用路径：
//   1) 启动时自动检查（节流 15min，失败静默）→ 有新版弹 GM 通知
//   2) 关于页手动检查（force，返回结构化结果给 UI 渲染）
//
// Tampermonkey 的「自动更新脚本本体」走 userscript.meta.js 里的
// @updateURL/@downloadURL（指向 /dl/userscript），与这里的检测互补：
// TM 负责真正把新版本装进去，这里负责把「当前/最新版本 + 更新说明」展示给人看。
import { gm } from './env.js';
import { storage } from './storage.js';
import { log } from './log.js';

const LATEST_URL = 'https://api.raymor.top/yuketangstudio/latest';
const SITE_URL = 'https://app.raymor.top/yuketangstudio/';
const THROTTLE_MS = 15 * 60 * 1000;

/** 语义化版本比较：a>b → 1；a<b → -1；等 → 0（容忍非数字段） */
export function cmpVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 当前脚本版本（GM_info 优先；无 GM 环境退回构建注入版本） */
export function curVersion() {
  try {
    if (typeof GM_info !== 'undefined' && GM_info.script?.version) return GM_info.script.version;
  } catch {}
  try { return __BUILD_VERSION__; } catch {}
  return '0.0.0';
}

/**
 * 拉取最新版本元数据。
 * @returns {Promise<{ok:boolean, cur:string, latest?:string, hasUpdate?:boolean,
 *                    notes?:string, site?:string, error?:string}>}
 */
export function fetchLatest() {
  const cur = curVersion();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      gm.xhr({
        method: 'GET',
        url: LATEST_URL,
        timeout: 10000,
        onload(r) {
          if (r.status < 200 || r.status >= 300) {
            return done({ ok: false, cur, error: `服务器返回 ${r.status}` });
          }
          try {
            const d = JSON.parse(r.responseText || '{}');
            if (!d?.version) return done({ ok: false, cur, error: '响应缺少版本号' });
            done({
              ok: true,
              cur,
              latest: d.version,
              hasUpdate: cmpVer(d.version, cur) > 0,
              notes: d.notes || '',
              site: SITE_URL,
            });
          } catch {
            done({ ok: false, cur, error: '响应不是合法 JSON' });
          }
        },
        onerror() { done({ ok: false, cur, error: '网络错误，无法连接更新服务器' }); },
        ontimeout() { done({ ok: false, cur, error: '请求超时（10s）' }); },
      });
    } catch (e) {
      done({ ok: false, cur, error: String(e?.message || e) });
    }
  });
}

/**
 * 自动更新检查（启动时调用）：节流 15min，有新版弹 GM 通知，失败静默。
 * 不返回结果——需要结果请用 fetchLatest()。
 */
export function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - (storage.get('update.lastCheck') || 0) < THROTTLE_MS) return;
  storage.set('update.lastCheck', now);
  fetchLatest().then((d) => {
    if (!d.ok) { log.dbg('[update] 检查失败（静默）', d.error); return; }
    if (!d.hasUpdate) { log.dbg(`[update] 已是最新 v${d.cur}`); return; }
    log.dbg(`[update] 发现新版本 v${d.latest}（当前 v${d.cur}）`);
    const text = `雨课堂助手新版本 v${d.latest}（当前 v${d.cur}）${d.notes ? '：' + String(d.notes).slice(0, 40) : ''}`;
    try {
      gm.notify({
        title: 'YuketangStudio 更新',
        text,
        image: '',
        onclick: () => gm.uw.open(SITE_URL, '_blank'),
      });
    } catch (e) { log.dbg('[update] 通知失败', e); }
  });
}
