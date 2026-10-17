// src/core/update-check.js
// 每次使用自动检查更新：GET api.raymor.top/yuketangstudio/latest
// （svc 国内渠道元数据，见 ServerX svc/README_DEPLOY.md）
// 响应 {version, userscript, apk, notes}；有新版 → GM 通知（可点击打开官网下载页）。
// 15min 节流防止频繁弹窗；失败静默（不打扰正常使用）。
import { gm } from './env.js';
import { storage } from './storage.js';
import { log } from './log.js';

const LATEST_URL = 'https://api.raymor.top/yuketangstudio/latest';
const SITE_URL = 'https://app.raymor.top/yuketangstudio/';
const THROTTLE_MS = 15 * 60 * 1000;

/** 语义化版本比较：a>b → 1；a<b → -1；等 → 0（容忍非数字段） */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function curVersion() {
  try {
    if (typeof window.GM_info !== 'undefined' && window.GM_info.script?.version) return window.GM_info.script.version;
  } catch {}
  return '0.0.0';
}

/** 自动更新检查。force=true 跳过节流（设置页手动触发用） */
export function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - (storage.get('update.lastCheck') || 0) < THROTTLE_MS) return;
  storage.set('update.lastCheck', now);
  gm.xhr({
    method: 'GET',
    url: LATEST_URL,
    timeout: 8000,
    onload(r) {
      try {
        const d = JSON.parse(r.responseText || '{}');
        const cur = curVersion();
        if (d?.version && cmpVer(d.version, cur) > 0) {
          log.dbg(`[update] 发现新版本 v${d.version}（当前 v${cur}）`);
          const text = `雨课堂助手新版本 v${d.version}（当前 v${cur}）${d.notes ? '：' + String(d.notes).slice(0, 40) : ''}`;
          gm.notify({ title: 'YuketangStudio 更新', text, image: '', onclick: () => gm.uw.open(SITE_URL, '_blank') });
          // GM_notification 不支持的环境降级：至少 console 留痕
          if (typeof window.GM_notification !== 'function') log.dbg('[update]', SITE_URL);
        }
      } catch (e) { log.dbg('[update] 解析 latest 失败', e); }
    },
    onerror() { log.dbg('[update] latest 拉取失败（静默）'); },
    ontimeout() { log.dbg('[update] latest 超时（静默）'); },
  });
}
