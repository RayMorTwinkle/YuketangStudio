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
const K_CHANNEL = 'update.channel';

/** 更新渠道：stable（默认）/ beta；只影响检查更新 */
export function getChannel() {
  return storage.get(K_CHANNEL) === 'beta' ? 'beta' : 'stable';
}
export function setChannel(ch) {
  storage.set(K_CHANNEL, ch === 'beta' ? 'beta' : 'stable');
}
function latestUrl(channel) {
  return LATEST_URL + '?channel=' + channel;
}

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
function fetchOne(channel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      gm.xhr({
        method: 'GET',
        url: latestUrl(channel),
        timeout: 10000,
        onload(r) {
          if (r.status < 200 || r.status >= 300) {
            return done({ ok: false, error: `服务器返回 ${r.status}` });
          }
          try {
            const d = JSON.parse(r.responseText || '{}');
            if (!d?.version) return done({ ok: false, error: '响应缺少版本号' });
            done({ ok: true, latest: d.version, notes: d.notes || '', channel });
          } catch {
            done({ ok: false, error: '响应不是合法 JSON' });
          }
        },
        onerror() { done({ ok: false, error: '网络错误，无法连接更新服务器' }); },
        ontimeout() { done({ ok: false, error: '请求超时（10s）' }); },
      });
    } catch (e) {
      done({ ok: false, error: String(e?.message || e) });
    }
  });
}

/**
 * 拉取最新版本元数据。
 * 稳定渠道只查 stable；测试渠道同时查 beta + stable，取版本更高的一边
 * （测试渠道的用户也能收到稳定渠道的更新）。
 */
export async function fetchLatest() {
  const cur = curVersion();
  const ch = getChannel();
  if (ch === 'beta') {
    const [b, s] = await Promise.all([fetchOne('beta'), fetchOne('stable')]);
    if (!b.ok && !s.ok) return { ok: false, cur, error: b.error || s.error || '检查失败' };
    let pick = b.ok ? b : s;
    if (b.ok && s.ok && cmpVer(s.latest, b.latest) > 0) pick = s;
    return {
      ok: true, cur, latest: pick.latest,
      hasUpdate: cmpVer(pick.latest, cur) > 0,
      notes: pick.notes, site: SITE_URL, channel: pick.channel,
    };
  }
  const s = await fetchOne('stable');
  if (!s.ok) return { ok: false, cur, error: s.error };
  return {
    ok: true, cur, latest: s.latest,
    hasUpdate: cmpVer(s.latest, cur) > 0,
    notes: s.notes, site: SITE_URL, channel: 'stable',
  };
}

/**
 * 自动更新检查（启动时调用）：节流 15min，有新版弹 GM 通知，失败静默。
 * 不返回结果——需要结果请用 fetchLatest()。
 */
export function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  // Android 壳的「自动检查更新」策略（彻底关闭 / 暂停 / 跳过版本）
  if (!force && storage.get('update.autoCheck') === false) { log.dbg('[update] 自动检查已关闭'); return; }
  const snoozeUntil = Number(storage.get('update.snoozeUntil')) || 0;
  if (!force && now < snoozeUntil) { log.dbg('[update] 自动检查已暂停'); return; }
  if (!force && now - (storage.get('update.lastCheck') || 0) < THROTTLE_MS) return;
  storage.set('update.lastCheck', now);
  fetchLatest().then((d) => {
    if (!d.ok) { log.dbg('[update] 检查失败（静默）', d.error); return; }
    if (!d.hasUpdate) { log.dbg(`[update] 已是最新 v${d.cur}`); return; }
    // 跳过将来 N 个版本：同一版本只扣一次
    const skip = Number(storage.get('update.skipRemaining')) || 0;
    if (skip > 0) {
      const last = storage.get('update.lastSkippedVersion') || '';
      if (last !== d.latest) {
        storage.set('update.skipRemaining', skip - 1);
        storage.set('update.lastSkippedVersion', d.latest);
      }
      log.dbg(`[update] 跳过 v${d.latest}（剩余 ${Math.max(0, skip - 1)} 个版本）`);
      return;
    }
    log.dbg(`[update] 发现新版本 v${d.latest}（当前 v${d.cur}）`);
    const text = `雨课堂助手新版本 v${d.latest}（当前 v${d.cur}）${d.notes ? '：' + String(d.notes).slice(0, 40) : ''}`;
    try {
      gm.notify({
        title: 'YuketangStudio 更新',
        text,
        image: '',
        // Android 壳：点击通知直接进入「检查更新」弹窗（而不是只把 App 打开）
        action: 'check_update',
        onclick: () => gm.uw.open(SITE_URL, '_blank'),
      });
    } catch (e) { log.dbg('[update] 通知失败', e); }
  });
}
