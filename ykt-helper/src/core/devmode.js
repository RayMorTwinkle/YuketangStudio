// src/core/devmode.js
// 开发者模式：云端解锁码 → svc 验证 → 注入「云端 profile」（LLM 调用走代理）
//
// 2026-10-17 起本地加密 blob（devmode-blob.js）已全部删除：
// 任何持码人都能本地解出上游 key 明文，泄露无法回收——改为服务端代理转发，
// apiKey 永不下发（ServerX svc，见 ServerX/DECISIONS.md D031）。
// 解锁后的配置仍缓存 localStorage（devmode.configs），可共存多个；
// getDevConfig() 返回最后解锁的那个（兼容旧调用方）。
import { storage } from './storage.js';
import { gm } from './env.js';

const UNLOCK_URL = 'https://api.raymor.top/yuketangstudio/unlock/verify';
const CLOUD_BASE = 'https://api.raymor.top/yuketangstudio';

/**
 * 用解锁码解锁云端配置：svc /unlock/verify 验码通过 → 注入云端 profile。
 * apiKey 就是解锁码本身（svc 侧映射到真实上游凭据并限流/吊销）。
 * @returns {Promise<{cfg: Object, blobIndex: number}>}
 */
export async function unlockDevMode(password) {
  const code = password.trim();
  if (!code) throw new Error('解锁码错误');
  const cloud = await tryCloudUnlock(code);
  if (!cloud) throw new Error('解锁码错误或网络不可用');
  addDevConfig(cloud.cfg, -1);
  return { cfg: cloud.cfg, blobIndex: -1 };
}

async function tryCloudUnlock(code) {
  try {
    // gm.xhr 而非 fetch：雨课堂页 → api.raymor.top 跨域，页面 fetch 受 CORS 拦截
    //（svc 侧已放开 * 但 GM_xmlhttpRequest 路径最稳，@connect * 已声明）
    const d = await new Promise((resolve, reject) => {
      gm.xhr({
        method: 'POST',
        url: UNLOCK_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ code }),
        timeout: 10000,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText || '{}')); }
          catch { reject(new Error('bad json')); }
        },
        onerror: reject,
        ontimeout: reject,
      });
    });
    if (!d?.ok) return null;
    return {
      cfg: {
        name: `云端·${d.profile || 'agnes'}`,
        baseUrl: CLOUD_BASE,
        apiKey: code,
        model: '',            // 空 → svc 用该码对应 profile 的默认模型
        _cloud: true,
      },
    };
  } catch {
    return null;            // 网络失败按「码不存在」走错误分支
  }
}

/** 所有已解锁配置（数组，可为空） */
export function getDevConfigs() {
  const v = storage.get('devmode.configs');
  return Array.isArray(v) ? v : [];
}

/** 最后解锁的配置（兼容旧调用方 agnes.js）；一个都没解返回 null */
export function getDevConfig() {
  const all = getDevConfigs();
  return all.length ? all[all.length - 1] : null;
}

/** 解锁后的配置是否已缓存（至少一个） */
export function isDevUnlocked() {
  return getDevConfigs().length > 0;
}

/** 追加一个已解锁配置（去重：同 baseUrl+apiKey 视为同一个） */
function addDevConfig(cfg, blobIndex) {
  const all = getDevConfigs();
  const tag = `${cfg.baseUrl}|${cfg.apiKey}`;
  const idx = all.findIndex(c => `${c.baseUrl}|${c.apiKey}` === tag);
  const entry = { ...cfg, _blobIndex: blobIndex };
  if (idx >= 0) all[idx] = entry; else all.push(entry);
  storage.set('devmode.configs', all);
}

/** 清除全部解锁状态 */
export function clearDevUnlock() {
  storage.remove('devmode.configs');
  storage.remove('devmode.config');   // 旧版遗留 key 一并清
}
