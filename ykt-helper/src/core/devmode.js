// src/core/devmode.js
// 开发者模式：解锁内置的加密 LLM 配置
// 加密：AES-256-GCM，密钥由密码 PBKDF2 派生（与 scripts/gen-devmode.js 配套）
// 解锁后配置缓存到 localStorage（同浏览器免重复输入）；换浏览器重新输密码即可
import { DEV_BLOB } from './devmode-blob.js';
import { storage } from './storage.js';

const PW_HASH_PREFIX = 'yks-dm-v1:';
const enc = new TextEncoder();

const b64ToU8 = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const u8ToB64 = (u8) => btoa(String.fromCharCode(...u8));

async function sha256Hex(str) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

/**
 * 用密码解锁内置配置。成功返回配置对象并缓存；失败抛错（不暴露原因细节）。
 * @param {string} password
 * @returns {Promise<Object>} 配置 { name, baseUrl, apiKey, model, visionModel, reasoningEffort }
 */
export async function unlockDevMode(password) {
  const pw = String(password || '');
  if (!pw) throw new Error('请输入密码');

  const hash = await sha256Hex(PW_HASH_PREFIX + pw);
  if (hash !== DEV_BLOB.pwHash) throw new Error('密码错误');

  const key = await deriveKey(pw, b64ToU8(DEV_BLOB.saltB64), DEV_BLOB.iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToU8(DEV_BLOB.ivB64) },
      key,
      b64ToU8(DEV_BLOB.ctB64)
    );
  } catch {
    throw new Error('解密失败（blob 与密码不匹配，请重新生成）');
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
