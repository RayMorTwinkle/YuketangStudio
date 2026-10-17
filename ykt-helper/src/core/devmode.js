// src/core/devmode.js
// 开发者模式：解锁内置的加密 LLM 配置（多解锁码版）
// 加密：AES-256-GCM，密钥由密码 PBKDF2 派生（与 scripts/gen-devmode.js 配套）
// 校验：pwHash = SHA-256(PBKDF2 派生密钥原始字节) —— 校验也挂在慢哈希后，
//       攻击者离线爆破每个候选密码都要跑完全部迭代
// 解锁后所有已解配置缓存到 localStorage（devmode.configs），可共存多个；
// getDevConfig() 返回最后解锁的那个（兼容旧调用方）。
import { DEV_BLOBS } from './devmode-blob.js';
import { storage } from './storage.js';

const enc = new TextEncoder();

const b64ToU8 = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

async function sha256HexBytes(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveBitsAndKey(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const rawBits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  ));
  const key = await crypto.subtle.importKey('raw', rawBits, { name: 'AES-GCM' }, false, ['decrypt']);
  return { rawBits, key };
}

/**
 * 用解锁码解锁配置。遍历全部 blob 试解（hash 匹配 + GCM 解密双重验证）。
 * 成功返回 { cfg, blobIndex } 并加入已解锁缓存；全部不匹配抛「解锁码错误」。
 * @param {string} password
 * @returns {Promise<{cfg: Object, blobIndex: number}>}
 */
export async function unlockDevMode(password) {
  const pw = String(password || '');
  if (!pw) throw new Error('请输入解锁码');

  for (let i = 0; i < DEV_BLOBS.length; i++) {
    const blob = DEV_BLOBS[i];
    const { rawBits, key } = await deriveBitsAndKey(pw, b64ToU8(blob.saltB64), blob.iterations);
    const hash = await sha256HexBytes(rawBits);
    if (hash !== blob.pwHash) continue;   // 不是这个码，试下一个

    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToU8(blob.ivB64) },
        key,
        b64ToU8(blob.ctB64)
      );
    } catch {
      continue;   // hash 撞了但解密失败（理论上不该发生），继续试
    }

    const cfg = JSON.parse(new TextDecoder().decode(plain));
    addDevConfig(cfg, i);
    return { cfg, blobIndex: i };
  }
  throw new Error('解锁码错误');
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
