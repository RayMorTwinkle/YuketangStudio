// Origin-scoped Android message channel. Native code additionally rejects subframes.
(function () {
  'use strict';
  if (window !== window.top || !window.__yktNativeChannel || window.YktBridge) return;
  var channel = window.__yktNativeChannel;
  var pending = new Map();
  var shared = Object.create(null);
  function request(method, args, callback) {
    var id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    if (callback) pending.set(id, callback);
    channel.postMessage(JSON.stringify({ id: id, method: method, args: args || [] }));
    return id;
  }
  channel.onmessage = function (event) {
    var response;
    try { response = JSON.parse(event.data); } catch (_) { return; }
    if (response.event === 'value') {
      if (response.json == null) delete shared[response.name];
      else shared[response.name] = response.json;
      if (window.__yktBridgeValue) window.__yktBridgeValue(response.name, response.json);
      return;
    }
    var callback = pending.get(response.id);
    pending.delete(response.id);
    if (callback) callback(response.result, response.error);
  };
  var api = {};
  ['sharedSet', 'sharedDelete', 'stopBackgroundRuntime', 'setBackgroundRuntimeStrong',
    'reportRuntime', 'openCollect', 'closeCollect', 'openAboutAndUpdate', 'copyText',
    'notify', 'downloadStart', 'downloadChunk', 'downloadEnd', 'log'].forEach(function (method) {
    api[method] = function () { request(method, Array.from(arguments)); };
  });
  ['startBackgroundRuntime', 'getBackgroundRuntimeState', 'isBatteryOptimizationIgnored',
    'requestBatteryOptimization'].forEach(function (method) {
    api[method] = function () {
      var args = Array.from(arguments);
      return new Promise(function (resolve, reject) {
        request(method, args, function (value, error) { if (error) reject(new Error(error)); else resolve(value); });
      });
    };
  });
  api.sharedGet = function (name) { return shared[name]; };
  api.fetchRequest = function (method, url, headers, body, binary, callbackId) {
    var id = request('fetchRequest', [method, url, headers, body, binary], function (value, error) {
      var cb = window[callbackId];
      if (cb) cb(!error && !!value && value.ok, value ? value.status : 0,
        value ? value.body : '', error || (value && value.error) || '');
    });
    return { abort: function () { pending.delete(id); request('cancelRequest', [id]); } };
  };
  window.YktBridge = api;
  request('sharedSnapshot', [], function (values) {
    if (!values) return;
    shared = values;
    for (var key of Object.keys(values)) {
      // Existing same-origin storage wins over an older in-memory snapshot.
      if (localStorage.getItem('__ykt_gm:' + key) === null && window.__yktBridgeValue) {
        window.__yktBridgeValue(key, values[key]);
      }
    }
  });
})();
