// src/core/image.js
// 图片进入 AI 前的体积控制。
//
// 背景：老版作业/课件题图通常是 900×1440 的 JPEG data URL，单张可能很大；
// 云端代理请求体有 2MB 上限，直接把原图塞进 messages 会导致请求被截断或
// 上游直接忽略图片。这里统一把大于 500KB 的图片压到 500KB 以内再发送。
//
// 只处理 AI 请求消息，不改变用户界面里的原图；压缩结果按 data URL 前缀缓存，
// 避免同一道题在重试/追问时反复压缩。

import { fetchAsDataURL } from './env.js';

const DEFAULT_MAX_BYTES = 500 * 1024;
const DEFAULT_MAX_DIMENSION = 1800;
const CACHE_LIMIT = 12;
const cache = new Map();

/** data URL 的实际图片字节数（base64 的 3/4），不是字符串长度。 */
export function imageDataUrlBytes(dataUrl) {
  const s = String(dataUrl || '');
  if (!/^data:image\//i.test(s)) return 0;
  const comma = s.indexOf(',');
  if (comma < 0 || !/;base64/i.test(s.slice(0, comma))) return 0;
  const b64 = s.slice(comma + 1).replace(/\s+/g, '');
  if (!b64) return 0;
  return Math.floor((b64.length * 3) / 4);
}

export function shouldCompressImage(dataUrl, maxBytes = DEFAULT_MAX_BYTES) {
  return imageDataUrlBytes(dataUrl) > maxBytes;
}

function cacheKey(src) {
  return `${src.length}:${src.slice(0, 64)}:${src.slice(-32)}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function drawToDataUrl(img, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('图片压缩画布不可用');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 把一张 data URL 图片压到 maxBytes 以内。
 * - 已经是小图：原样返回，不重编码
 * - data URL：按尺寸/质量阶梯压缩
 * - http(s) 图片：不在同步链路里猜大小，原样返回（调用方应先用 fetchAsDataURL）
 */
export async function compressImageDataUrl(src, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxDimension = DEFAULT_MAX_DIMENSION,
} = {}) {
  const value = String(src || '');
  if (!value) return value;
  if (imageDataUrlBytes(value) <= maxBytes) return value;
  if (!/^data:image\//i.test(value)) {
    // 远程图先转 dataURL 再判断大小；失败则保持原 URL，交给上游/浏览器。
    if (/^https?:\/\//i.test(value)) {
      try {
        const dataUrl = await fetchAsDataURL(value, 15000);
        if (dataUrl && dataUrl !== value) return compressImageDataUrl(dataUrl, { maxBytes, maxDimension });
      } catch { /* keep original */ }
    }
    return value;
  }

  const key = cacheKey(value);
  if (cache.has(key)) return cache.get(key);
  const task = (async () => {
    const img = await loadImage(value);
    const ow = img.naturalWidth || img.width;
    const oh = img.naturalHeight || img.height;
    if (!ow || !oh) return value;

    let scale = Math.min(1, maxDimension / Math.max(ow, oh));
    let best = value;
    let bestBytes = imageDataUrlBytes(value);
    // 先降尺寸到可接受范围，再逐级降质量；最多 5 轮，避免极端图片卡住。
    for (let round = 0; round < 5; round++) {
      const w = ow * scale;
      const h = oh * scale;
      for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46]) {
        let out;
        try {
          out = drawToDataUrl(img, w, h, quality);
        } catch {
          return best;
        }
        const bytes = imageDataUrlBytes(out);
        if (bytes > 0 && bytes < bestBytes) {
          best = out;
          bestBytes = bytes;
        }
        if (bytes > 0 && bytes <= maxBytes) return out;
      }
      scale *= 0.8;
    }
    return best;
  })().catch(() => value);

  cache.set(key, task);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return task;
}

function cloneMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return { ...m };
    return {
      ...m,
      content: m.content.map((part) => {
        if (!part || part.type !== 'image_url') return { ...part };
        const imageUrl = part.image_url && typeof part.image_url === 'object'
          ? { ...part.image_url }
          : { url: part.image_url };
        return { ...part, image_url: imageUrl };
      }),
    };
  });
}

/**
 * 在发送给上游前统一处理 messages 中的图片。
 * 返回新的 messages，不修改调用方对象；数据 URL 走压缩，http(s) 原样保留。
 */
export async function prepareMessagesForRequest(messages, opts = {}) {
  const cloned = cloneMessages(messages);
  if (!Array.isArray(cloned)) return cloned;
  for (const m of cloned) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || part.type !== 'image_url') continue;
      const url = part.image_url?.url;
      if (!url) continue;
      const compressed = await compressImageDataUrl(url, opts);
      if (compressed && compressed !== url) part.image_url.url = compressed;
    }
  }
  return cloned;
}
