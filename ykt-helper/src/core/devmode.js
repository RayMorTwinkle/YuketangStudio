// src/core/devmode.js
// 开发者模式：解锁内置的加密 LLM 配置
// 加密：AES-256-GCM，密钥由密码 PBKDF2 派生（与 scripts/gen-devmode.js 配套）
// 校验：pwHash = SHA-256(PBKDF2 派生密钥原始字节) —— 校验也挂在慢哈希后，
//       攻击者离线爆破每个候选密码都要跑完全部迭代
// 解锁后配置缓存到 localStorage（同浏览器免重复输入）；换浏览器重新输密码即可
import { DEV_BLOB } from './devmode-blob.js';
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
 * 用密码解锁内置配置。成功返回配置对象并缓存；失败抛错（不暴露原因细节）。
 * @param {string} password
 * @returns {Promise<Object>} 配置 { name, baseUrl, apiKey, model, visionModel, reasoningEffort }
 */
export async function unlockDevMode(password) {
  const pw = String(password || '');
  if (!pw) throw new Error('请输入解锁码');

  const { rawBits, key } = await deriveBitsAndKey(pw, b64ToU8(DEV_BLOB.saltB64), DEV_BLOB.iterations);
  const hash = await sha256HexBytes(rawBits);
  if (hash !== DEV_BLOB.pwHash) throw new Error('解锁码错误');

  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToU8(DEV_BLOB.ivB64) },
      key,
      b64ToU8(DEV_BLOB.ctB64)
    );
  } catch {
    throw new Error('解密失败（blob 与解锁码不匹配，请重新生成）');
  }

  const cfg = JSON.parse(new TextDecoder().decode(plain));
  setDevUnlocked(cfg);
  return cfg;
}

/** 解锁后的配置是否已缓存 */
export function isDevUnlocked() {
  return !!storage.get('devmode.config');
}

/** 获取解锁的配置（未解锁返回 null） */
export function getDevConfig() {
  return storage.get('devmode.config');
}

function setDevUnlocked(cfg) {
  storage.set('devmode.config', cfg);
}

/** 清除解锁状态（换配置/退出开发者模式用） */
export function clearDevUnlock() {
  storage.remove('devmode.config');
}
