// src/core/env.js
export const gm = {
  notify(opt) {
    if (typeof window.GM_notification === 'function') window.GM_notification(opt);
  },
  addStyle(css) {
    if (typeof window.GM_addStyle === 'function') window.GM_addStyle(css);
    else {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    }
  },
  xhr(opt) {
    if (typeof window.GM_xmlhttpRequest === 'function') return window.GM_xmlhttpRequest(opt);
    throw new Error('GM_xmlhttpRequest is not available');
  },
  uw: window.unsafeWindow || window,
};

export function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

/** GM_xhr 下载任意图片转 dataURL（绕开 CORS；OSS 无跨域头也能拿） */
export function fetchAsDataURL(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    gm.xhr({
      method: 'GET', url, responseType: 'blob', timeout: timeoutMs,
      onload: (res) => {
        if (res.status !== 200) return reject(new Error(`图片下载 HTTP ${res.status}`));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.readAsDataURL(res.response);
      },
      onerror: () => reject(new Error('图片下载失败')),
      ontimeout: () => reject(new Error('图片下载超时')),
    });
  });
}

export async function ensureHtml2Canvas() {
  const w = gm.uw || window;                         
  if (typeof w.html2canvas === 'function') return w.html2canvas;
  await loadScriptOnce('https://html2canvas.hertzen.com/dist/html2canvas.min.js');
  const h2c = w.html2canvas?.default || w.html2canvas;
  if (typeof h2c === 'function') return h2c;
  throw new Error('html2canvas 未正确加载');
}

export async function ensureJsPDF() {
  if (window.jspdf?.jsPDF) return window.jspdf;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  if (!window.jspdf?.jsPDF) throw new Error('jsPDF 未加载成功');
  return window.jspdf;
}

/** mermaid 按需加载（AI 回复里出现 ```mermaid 块时才拉取 CDN） */
export async function ensureMermaid() {
  const w = gm.uw || window;   // 脚本标签注入主世界，属性也挂在主世界——与 ensureJsPDF 同理
  if (w.mermaid?.render) return w.mermaid;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js');
  const m = w.mermaid;
  if (!m?.render) throw new Error('mermaid 未正确加载');
  m.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
  return m;
}

/** marked（专业 Markdown 解析）按需加载（v9：renderer.code(code, lang) 旧签名稳定） */
export async function ensureMarked() {
  const w = gm.uw || window;
  if (w.marked?.parse) return w.marked;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js');
  if (!w.marked?.parse) throw new Error('marked 未正确加载');
  return w.marked;
}

/** DOMPurify（HTML 清洗）按需加载 */
export async function ensureDOMPurify() {
  const w = gm.uw || window;
  if (w.DOMPurify?.sanitize) return w.DOMPurify;
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js');
  if (!w.DOMPurify?.sanitize) throw new Error('DOMPurify 未正确加载');
  return w.DOMPurify;
}

export function randInt(l, r) {
  return l + Math.floor(Math.random() * (r - l + 1));
}

export async function ensureFontAwesome() {
  const href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
  if ([...document.styleSheets].some(s => s.href === href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}