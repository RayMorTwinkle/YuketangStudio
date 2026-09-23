// src/core/storage.js
// 存储后端优先用 GM_getValue/GM_setValue（脚本私有存储，页面不可见——
// API Key 等敏感配置此前明文落在页面同源 localStorage，同源 XSS/恶意页面脚本可读取）。
// GM 不可用时退回 localStorage；读 GM 未命中时自动把旧 localStorage 值迁移过去。

const hasGMStorage = () =>
  typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

export class StorageManager {
  constructor(prefix) { this.prefix = prefix; }

  get(key, dv = null) {
    const k = this.prefix + key;
    if (hasGMStorage()) {
      try {
        const v = GM_getValue(k, undefined);
        if (v !== undefined) return v;
        // 迁移旧 localStorage 值（只搬一次，搬完删除明文）
        const legacy = localStorage.getItem(k);
        if (legacy != null) {
          try {
            const parsed = JSON.parse(legacy);
            GM_setValue(k, parsed);
            localStorage.removeItem(k);
            return parsed;
          } catch { /* 迁移失败不阻断读取 */ }
        }
        return dv;
      } catch { /* fall through to localStorage */ }
    }
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : dv; }
    catch { return dv; }
  }

  set(key, value) {
    const k = this.prefix + key;
    if (hasGMStorage()) {
      try {
        GM_setValue(k, value);
        localStorage.removeItem(k);   // 清掉可能残留的明文副本
        return;
      } catch { /* fall through */ }
    }
    localStorage.setItem(k, JSON.stringify(value));
  }

  remove(key) {
    const k = this.prefix + key;
    if (hasGMStorage()) { try { GM_setValue(k, undefined); } catch {} }
    localStorage.removeItem(k);
  }

  getMap(key) {
    const arr = this.get(key, []);
    try { return new Map(arr); } catch { return new Map(); }
  }
  setMap(key, map) { this.set(key, [...map]); }
  alterMap(key, fn) { const m = this.getMap(key); fn(m); this.setMap(key, m); }
}

export const storage = new StorageManager('ykt-helper:');
