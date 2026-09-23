// src/core/idb-cache.js
// PDF 导出图片缓存：下载的 dataURL 落 IndexedDB，刷新/中断后重导可断点续传。
// key = 图片 URL 去掉 query（签名 token 会过期轮换，path 部分才是稳定身份）。
import { log } from './log.js';

const DB_NAME = 'yks-pdf-cache';
const STORE = 'images';
let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(STORE); } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      req.onblocked = () => reject(new Error('idb blocked'));
    } catch (e) { reject(e); }
  });
  // 打开失败只记一次，后续调用直接走已 reject 的 promise
  _dbPromise.catch(() => {});
  return _dbPromise;
}

/** 缓存 key：去 query/hash（token 过期不阻命中），data:/blob: 不缓存 */
export function imageCacheKey(url) {
  const u = String(url || '');
  if (!u || u.startsWith('data:') || u.startsWith('blob:')) return null;
  return u.split('?')[0].split('#')[0];
}

export async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result?.v ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    log.dbg('[PDF][cache] get 失败（降级为无缓存）:', e?.message);
    return null;
  }
}

export async function idbSet(key, dataUrl) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put({ v: dataUrl, t: Date.now() }, key);
    });
  } catch (e) {
    // 配额满等场景静默降级——缓存是优化项不是功能项
    log.warn('[PDF][cache] 写入失败:', e?.message);
  }
}

export async function idbDel(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(key);
    });
  } catch {}
}

/** 清空图片缓存（设置页/排障用） */
export async function idbClearAll() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).clear();
    });
  } catch (e) {
    log.warn('[PDF][cache] 清空失败:', e?.message);
  }
}
