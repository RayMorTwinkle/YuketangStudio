// src/core/env.js
// 离线内嵌依赖（.txt 经 rollup string plugin 以字符串打进 dist）：jsdelivr/cdnjs 断连时脚本仍能工作。
// 一律动态 import()——node 端 npm test 直接跑源码不认识 .txt 扩展，静态 import 会炸；
// 必须用字面量路径（import(变量) rollup 解析不了会原样保留导致运行时爆炸）；
// rollup inlineDynamicImports 会把字面量动态 import 同步打进 bundle，不产生额外请求。
const VENDOR = {
  katex:      () => import('../vendor/katex.min.js.txt').then(m => m.default),
  katexAuto:  () => import('../vendor/katex-auto-render.min.js.txt').then(m => m.default),
  marked:     () => import('../vendor/marked.min.js.txt').then(m => m.default),
  purify:     () => import('../vendor/purify.min.js.txt').then(m => m.default),
  mermaid:    () => import('../vendor/mermaid.min.js.txt').then(m => m.default),
  jspdf:      () => import('../vendor/jspdf.umd.min.js.txt').then(m => m.default),
  h2c:        () => import('../vendor/html2canvas.min.js.txt').then(m => m.default),
  cssKatex:   () => import('../vendor/katex.inline.css.txt').then(m => m.default),
  cssFA:      () => import('../vendor/fontawesome.inline.css.txt').then(m => m.default),
};
export const gm = {
  notify(opt) {
    if (typeof window.GM_notification === 'function') window.GM_notification(opt);
  },
  addStyle(css) {
    if (typeof window.GM_addStyle === 'function') window.GM_addStyle(css);
    else {
      const s = document.createElement('style');
      s.textContent = css;
      // document-start 早期 head 可能为 null
      const target = document.head || document.documentElement;
      if (target) try { target.appendChild(s); } catch {}
    }
  },
  xhr(opt) {
    if (typeof window.GM_xmlhttpRequest === 'function') return window.GM_xmlhttpRequest(opt);
    throw new Error('GM_xmlhttpRequest is not available');
  },
  uw: window.unsafeWindow || window,
};

export function loadScriptOnce(src, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    // CDN 连接挂死时 onload/onerror 都不会触发——必须有自己的兜底计时
    const timer = setTimeout(() => reject(new Error(`加载超时: ${src}`)), timeoutMs);
    s.onload = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); reject(new Error(`Failed to load: ${src}`)); };
    document.head.appendChild(s);
  });
}

/** 内联注入 <script>（src 打进 dist 的源码字符串）。页面 CSP 可能拦——返回布尔 */
function injectInlineScript(src, globalCheck) {
  const w = gm.uw || window;
  if (globalCheck && globalCheck(w)) return true;
  try {
    const s = document.createElement('script');
    s.textContent = src;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    return !globalCheck || !!globalCheck(w);
  } catch { return false; }
}

/** 离线优先加载：先试内联注入（不走网络），CSP 拦时退回 CDN script src。
 *  inlineSrc 可以是字符串或 async 加载函数（vendor .txt 走动态 import）。 */
async function ensureLib(globalName, check, inlineSrc, cdnUrl) {
  const w = gm.uw || window;
  if (check(w)) return w[globalName];
  // 内联：UMD 库同步执行，成则立即返回
  try {
    const src = typeof inlineSrc === 'function' ? await inlineSrc() : inlineSrc;
    if (src && injectInlineScript(src, check)) return w[globalName];
  } catch { /* vendor 缺失/注入失败 → 走 CDN 兜底 */ }
  // CSP 拦内联 → 退回 CDN
  await loadScriptOnce(cdnUrl);
  if (!check(w)) throw new Error(`${globalName} 未正确加载`);
  return w[globalName];
}

/** GM_xhr 下载任意图片转 dataURL（绕开 CORS；OSS 无跨域头也能拿） */
export function fetchAsDataURL(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(watchdog); fn(v); } };
    // 兜底计时器：部分 GM 实现不支持 timeout 字段 / 未授权域挂起等待用户授权时
    // ontimeout 也不会触发——不能让 Promise 永远 pending
    const watchdog = setTimeout(() => done(reject, new Error(`图片下载超时(${timeoutMs}ms): ${hostOf(url)}`)), timeoutMs + 5000);
    try {
      gm.xhr({
        method: 'GET', url, responseType: 'blob', timeout: timeoutMs,
        onload: (res) => {
          // 回调内任何同步 throw 都会让 Promise 永远 pending——整体包 try
          try {
            if (res.status !== 200) return done(reject, new Error(`图片下载 HTTP ${res.status}: ${hostOf(url)}`));
            let blob = res.response;
            // 兼容返回 ArrayBuffer/string 的 GM 实现
            if (!(blob instanceof Blob)) blob = new Blob([blob || '']);
            const reader = new FileReader();
            reader.onload = () => done(resolve, reader.result);
            reader.onerror = () => done(reject, new Error('图片读取失败'));
            reader.readAsDataURL(blob);
          } catch (e) {
            done(reject, new Error(`图片响应处理失败: ${e?.message || e}`));
          }
        },
        onerror: () => done(reject, new Error(`图片下载失败: ${hostOf(url)}`)),
        ontimeout: () => done(reject, new Error(`图片下载超时: ${hostOf(url)}`)),
        onabort: () => done(reject, new Error(`图片下载中止: ${hostOf(url)}`)),
      });
    } catch (e) {
      done(reject, e);
    }
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url).slice(0, 60); }
}

export async function ensureHtml2Canvas() {
  const h = await ensureLib('html2canvas', w => typeof w.html2canvas === 'function' || typeof w.html2canvas?.default === 'function', VENDOR.h2c, 'https://html2canvas.hertzen.com/dist/html2canvas.min.js');
  return h?.default || h;
}

export async function ensureJsPDF() {
  // jsPDF 由 @require 预置 → 落在沙箱 window；script/inline 注入 → 落在主世界 gm.uw。两处都查
  const pick = () => (window.jspdf?.jsPDF ? window.jspdf : (gm.uw?.jspdf?.jsPDF ? gm.uw.jspdf : null));
  const ready = pick();
  if (ready) return ready;
  await ensureLib('jspdf', w => !!w.jspdf?.jsPDF, VENDOR.jspdf, 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  const after = pick();
  if (!after) throw new Error('jsPDF 未加载成功');
  return after;
}

/** mermaid 按需加载（AI 回复里出现 ```mermaid 块时才拉取） */
export async function ensureMermaid() {
  const m = await ensureLib('mermaid', w => !!w.mermaid?.render, VENDOR.mermaid, 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js');
  try { m.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' }); } catch {}
  return m;
}

/** KaTeX 按需加载（MathJax 不可用的公式渲染兜底；字体已 data-URI 进 css） */
export async function ensureKaTeX() {
  const w = gm.uw || window;
  if (w.katex?.renderToString) return w.katex;
  // css：GM_addStyle 走扩展通道（可绕页面 CSP），字体已 data-URI 内嵌；
  // 同时补 CDN <link>（壳内会本地回源）——内联 style 被 CSP 静默拦时仍可用
  try { gm.addStyle(await VENDOR.cssKatex()); } catch {}
  try {
    if (!document.querySelector('link[data-ykt-katex]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.dataset.yktKatex = '1';
      link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';
      (document.head || document.documentElement).appendChild(link);
    }
  } catch {}
  await ensureLib('katex', x => !!x.katex?.renderToString, VENDOR.katex, 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js');
  const k = w.katex;
  if (!k?.renderToString) throw new Error('KaTeX 未正确加载');
  return k;
}

/** marked（专业 Markdown 解析）按需加载 */
export async function ensureMarked() {
  const w = gm.uw || window;
  if (w.marked?.parse) return w.marked;
  await ensureLib('marked', x => !!x.marked?.parse, VENDOR.marked, 'https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js');
  return w.marked;
}

/** DOMPurify（HTML 清洗）按需加载 */
export async function ensureDOMPurify() {
  const w = gm.uw || window;
  if (w.DOMPurify?.sanitize) return w.DOMPurify;
  await ensureLib('DOMPurify', x => !!x.DOMPurify?.sanitize, VENDOR.purify, 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js');
  return w.DOMPurify;
}

export function randInt(l, r) {
  return l + Math.floor(Math.random() * (r - l + 1));
}

let faDone = false;
/** Font Awesome：GM_addStyle（走扩展通道可绕页面 CSP）+ DOM <style> + CDN <link> 三通道并发。
 *  桌面端教训：页面 CSP 拦 inline <style> 时静默不抛异常，单一 try/catch 回退不可探测——
 *  只能把各通道都打上，谁活下来谁生效（css 等效，重复无副作用）。 */
export function ensureFontAwesome() {
  if (faDone) return;
  faDone = true;
  if ([...document.styleSheets].some(s => s.href?.includes('font-awesome'))) return;
  VENDOR.cssFA().then(css => { try { gm.addStyle(css); } catch {} }).catch(() => {});
  const href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.dataset.yktFa = '1'; link.href = href;
  const target = document.head || document.documentElement;
  if (target) try { target.appendChild(link); } catch {}
}