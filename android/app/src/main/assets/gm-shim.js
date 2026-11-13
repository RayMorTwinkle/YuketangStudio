// YuketangStudio Android WebView 壳的 GM_* API shim。
// 在 user.js 之前以 document-start 注入，把油猴 API 映射到：
//   localStorage / fetch / YktBridge（按来源限制的原生消息通道）
// 只实现脚本实际用到的 API；未实现的留 undefined，让脚本走自己的兜底路径。
(function () {
  'use strict';
  if (window.__yktGmShimInstalled) return;
  window.__yktGmShimInstalled = true;

  var bridge = function () { return window.YktBridge; };
  var LS_PREFIX = '__ykt_gm:';

  // ---------- 值监听（跨 WebView 桥广播 + 本页 storage 事件） ----------
  var listeners = {};
  var nextListenerId = 1;
  function fireListeners(name, newValue, remote) {
    var list = listeners[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i].fn(name, list[i].old, newValue, !!remote); } catch (e) {}
    }
  }
  window.__yktBridgeValue = function (name, json) {
    // 来自 Kotlin：另一个 WebView（收集页）写入了共享值
    var v;
    try { v = json == null ? undefined : JSON.parse(json); } catch (e) { v = json; }
    try {
      if (v === undefined) localStorage.removeItem(LS_PREFIX + name);
      else localStorage.setItem(LS_PREFIX + name, JSON.stringify(v));
    } catch (e) {}
    fireListeners(name, v, true);
  };

  // ---------- 存储 ----------
  window.GM_getValue = function (name, dv) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + name);
      if (raw != null) return JSON.parse(raw);
      // 收集页写入的值经桥共享仓库回读（main 页打开收集页后轮询）
      if (bridge() && bridge().sharedGet) {
        var remote = bridge().sharedGet(name);
        if (remote != null) {
          var v = JSON.parse(remote);
          try { localStorage.setItem(LS_PREFIX + name, remote); } catch (e) {}
          return v;
        }
      }
    } catch (e) {}
    return dv;
  };
  window.GM_setValue = function (name, value) {
    var json;
    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { json = 'null'; }
    try {
      if (value === undefined) localStorage.removeItem(LS_PREFIX + name);
      else localStorage.setItem(LS_PREFIX + name, json);
    } catch (e) {}
    if (bridge() && bridge().sharedSet) {
      try { bridge().sharedSet(name, json); } catch (e) {}
    }
    fireListeners(name, value, false);
  };
  window.GM_deleteValue = function (name) {
    try { localStorage.removeItem(LS_PREFIX + name); } catch (e) {}
    if (bridge() && bridge().sharedDelete) { try { bridge().sharedDelete(name); } catch (e) {} }
  };
  window.GM_addValueChangeListener = function (name, fn) {
    var id = nextListenerId++;
    if (!listeners[name]) listeners[name] = [];
    var prev;
    try { prev = GM_getValue(name, undefined); } catch (e) {}
    listeners[name].push({ id: id, fn: fn, old: prev });
    return id;
  };
  window.GM_removeValueChangeListener = function (id) {
    for (var k in listeners) {
      listeners[k] = listeners[k].filter(function (l) { return l.id !== id; });
    }
  };
  // storage 事件：同源页面写入也能触发监听（Android WebView 里同源跨 WebView 不共享 localStorage，
  // 但同 WebView 的跨页导航期间仍有用；桥广播才是主通道）
  try {
    window.addEventListener('storage', function (ev) {
      if (!ev.key || ev.key.indexOf(LS_PREFIX) !== 0) return;
      var name = ev.key.slice(LS_PREFIX.length);
      var nv;
      try { nv = ev.newValue == null ? undefined : JSON.parse(ev.newValue); } catch (e) { nv = ev.newValue; }
      fireListeners(name, nv, true);
    });
  } catch (e) {}

  // ---------- 跨域请求 ----------
  window.GM_xmlhttpRequest = function (opt) {
    opt = opt || {};
    var ctrl = new AbortController();
    var settled = false;
    var nativeHandle = null;
    var callbackId = null;
    var timer = null;
    function finish(kind, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (callbackId) delete window[callbackId];
      if (opt[kind]) opt[kind](value);
    }
    function stop(kind) {
      if (settled) return;
      try { finish(kind, { status: 0 }); }
      finally {
        ctrl.abort();
        if (nativeHandle && nativeHandle.abort) nativeHandle.abort();
      }
    }
    if (opt.timeout) timer = setTimeout(function () { stop('ontimeout'); }, opt.timeout);
    fetch(opt.url, {
      method: opt.method || 'GET', headers: opt.headers || {},
      credentials: 'same-origin', body: opt.data, signal: ctrl.signal,
    }).then(function (res) {
      var rt = opt.responseType;
      var read = rt === 'blob' ? res.blob() : rt === 'arraybuffer' ? res.arrayBuffer()
        : rt === 'json' ? res.json() : res.text();
      return read.then(function (body) {
        var hdrs = {};
        res.headers.forEach(function (v, k) { hdrs[k] = v; });
        finish('onload', { status: res.status, statusText: res.statusText,
          response: body, responseText: typeof body === 'string' ? body : '',
          responseHeaders: hdrs, readyState: 4 });
      });
    }).catch(function (err) {
      if (settled) return;
      if (err && err.name === 'AbortError') { finish('onabort', { status: 0 }); return; }
      if (!bridge() || !bridge().fetchRequest) {
        finish('onerror', { status: 0, error: String(err) });
        return;
      }
      callbackId = '__yktFetchCb' + Math.random().toString(36).slice(2);
      var binary = opt.responseType === 'blob' || opt.responseType === 'arraybuffer';
      window[callbackId] = function (ok, status, body, errMsg) {
        if (settled) return;
        if (!ok) { finish('onerror', { status: status || 0, error: errMsg }); return; }
        try {
          var response = body;
          if (binary) {
            var bytes = Uint8Array.from(atob(body), function (ch) { return ch.charCodeAt(0); });
            response = opt.responseType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
          } else if (opt.responseType === 'json') response = JSON.parse(body);
          finish('onload', { status: status, statusText: '', response: response,
            responseText: binary ? '' : body, responseHeaders: {}, readyState: 4 });
        } catch (e) { finish('onerror', { status: 0, error: String(e) }); }
      };
      try {
        nativeHandle = bridge().fetchRequest(opt.method || 'GET', opt.url,
          JSON.stringify(opt.headers || {}), opt.data || '', binary, callbackId);
      } catch (e) { finish('onerror', { status: 0, error: String(e) }); }
    });
    return { abort: function () { stop('onabort'); } };
  };

  // ---------- 通知 ----------
  window.GM_notification = function (opt) {
    opt = typeof opt === 'string' ? { text: opt } : (opt || {});
    if (bridge() && bridge().notify) {
      try { bridge().notify(opt.title || 'YuketangStudio', opt.text || '', opt.image || '', opt.action || ''); return; } catch (e) {}
    }
    if ('Notification' in window) {
      try {
        if (Notification.permission === 'granted') new Notification(opt.title || 'YuketangStudio', { body: opt.text || '', icon: opt.image });
        else if (Notification.permission !== 'denied') Notification.requestPermission();
      } catch (e) {}
    }
  };

  // ---------- 新标签页（历史课件收集页） ----------
  window.GM_openInTab = function (url /*, options */) {
    if (bridge() && bridge().openCollect) {
      try { bridge().openCollect(String(url)); } catch (e) {}
      return {
        close: function () { try { bridge().closeCollect(); } catch (e) {} },
        closed: false,
      };
    }
    var w = window.open(String(url), '_blank');
    return { close: function () { try { w && w.close(); } catch (e) {} }, closed: false };
  };

  // ---------- 标签页存储（跨页小数据） ----------
  window.GM_getTab = function (cb) {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(LS_PREFIX + '__tab') || '{}'); } catch (e) {}
    if (cb) cb(v);
  };
  window.GM_saveTab = function (obj) {
    try { localStorage.setItem(LS_PREFIX + '__tab', JSON.stringify(obj || {})); } catch (e) {}
  };
  window.GM_getTabs = function (cb) { if (cb) cb({}); };

  // ---------- 其他 ----------
  window.unsafeWindow = window;
  window.GM_addStyle = function (css) {
    var s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };

  // ---------- 下载桥：拦截 a[download] 的 blob/data URL 点击 ----------
  // jsPDF save → FileSaver.saveAs → a.dispatchEvent(clickEvt)（不走 .click()），
  // 所以同时挂 .click() override + document capture 监听两条路，dispatchEvent 也会触发监听。
  function forwardBlobDownload(anchor, done) {
    var href = anchor.href || '';
    var name = anchor.download || 'download';
    fetch(href).then(function (r) { return r.blob(); }).then(function (blob) {
      var fr = new FileReader();
      fr.onload = function () {
        var dataUrl = fr.result || '';
        var b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
        var job = String(Date.now()) + Math.random().toString(36).slice(2, 7);
        try {
          bridge().downloadStart(job, name);
          var CHUNK = 512 * 1024;
          for (var i = 0; i < b64.length; i += CHUNK) {
            bridge().downloadChunk(job, b64.slice(i, i + CHUNK));
          }
          bridge().downloadEnd(job);
        } catch (e) {
          console.warn('[YKT-bridge] 下载转发失败:', e);
        }
        if (done) done();
      };
      fr.readAsDataURL(blob);
    }).catch(function (e) { console.warn('[YKT-bridge] blob 读取失败:', e); if (done) done(); });
  }

  function isDownloadAnchor(a) {
    return a && a.hasAttribute && a.hasAttribute('download') &&
      (/^blob:/i.test(a.href || '') || /^data:/i.test(a.href || '')) &&
      bridge() && bridge().downloadStart;
  }

  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isDownloadAnchor(this)) { forwardBlobDownload(this); return; }
    return origClick.apply(this, arguments);
  };

  // dispatchEvent 路径：FileSaver.saveAs 等直接 dispatchEvent(click)，不走 .click()
  var origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) {
    if (e && e.type === 'click' && this instanceof HTMLAnchorElement && isDownloadAnchor(this)) {
      forwardBlobDownload(this);
      return true;
    }
    return origDispatch.call(this, e);
  };

  // 真实点击兜底：文档内 <a download> 被真戳/程序化触发且冒泡到 document
  document.addEventListener('click', function (e) {
    var a = e.target && (e.target.closest ? e.target.closest('a[download]') : null);
    if (isDownloadAnchor(a)) {
      e.preventDefault();
      e.stopPropagation();
      forwardBlobDownload(a);
    }
  }, true);

  console.log('[YKT-bridge] GM shim 已安装');
})();
