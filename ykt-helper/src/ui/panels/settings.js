// settings.js (new version)
import tpl from './settings.html';
import { log } from '../../core/log.js';
import { escapeHtml } from '../../core/dom.js';
import { ui, copyText } from '../ui-api.js';
import { DEFAULT_CONFIG } from '../../core/types.js';
import { storage } from '../../core/storage.js';
import { unlockDevMode, getDevConfigs } from '../../core/devmode.js';
import * as telemetry from '../../core/telemetry.js';
import { gm } from '../../core/env.js';
import { makeChatUrl } from '../../ai/agnes.js';
import { DEFAULT_SYSTEM_PROMPT_CHAT, DEFAULT_SYSTEM_PROMPT_AI } from '../../core/types.js';

let mounted = false;
let root;

// ---- AI Profile helpers ----

function ensureAIProfiles(configAI) {
  if (!configAI) return;

  // 只有旧版 kimiApiKey 时创建第一个 profile（默认模板：DeepSeek）
  if (!Array.isArray(configAI.profiles) || configAI.profiles.length === 0) {
    const legacyKey = configAI.kimiApiKey || configAI.apiKey || storage.get('kimiApiKey') || '';
    configAI.profiles = [
      {
        id: 'default',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: legacyKey,
        model: 'deepseek-flash',
        visionModel: '',
      },
    ];
    configAI.activeProfileId = 'default';
  }

  if (!configAI.activeProfileId) {
    configAI.activeProfileId = configAI.profiles[0].id;
  }

  // 迁移：thinking 未定义的老配置默认开启（保持原有行为不变）
  for (const p of configAI.profiles) {
    if (typeof p.thinking !== 'boolean') p.thinking = true;
    // 旧版云端 profile 名称（云端·agnes / 云端·xxx）统一改为「云端模型」
    if (p && typeof p.name === 'string' && p.name.startsWith('云端·')) p.name = '云端模型';
  }
}

// ------------------------------

export function mountSettingsPanel() {
  if (mounted) return root;

  // 注入 HTML
  root = document.createElement('div');
  root.innerHTML = tpl;
  document.body.appendChild(root.firstElementChild);
  root = document.getElementById('ykt-settings-panel');

  const aiCfg = ui.config.ai || (ui.config.ai = {});
  ensureAIProfiles(aiCfg);

  // === 获取所有 AI Profile 相关的 DOM ===
  const $profileSelect = root.querySelector('#ykt-ai-profile-select');
  const $profileAdd = root.querySelector('#ykt-ai-profile-add');
  const $profileDel = root.querySelector('#ykt-ai-profile-del');

  const $profileName = root.querySelector('#ykt-ai-profile-name');
  const $baseUrl = root.querySelector('#ykt-ai-base-url');
  const $api = root.querySelector('#kimi-api-key');
  const $model = root.querySelector('#ykt-ai-model');
  const $visionModel = root.querySelector('#ykt-ai-vision-model');
  const $modelFetch = root.querySelector('#ykt-ai-model-fetch');
  const $modelOptions = root.querySelector('#ykt-ai-model-options');
  const $modelHint = root.querySelector('#ykt-ai-model-hint');

  // 云端配置：模型由服务端按渠道分配，禁用模型输入与获取按钮
  function applyCloudModelState() {
    const cloud = /api\.raymor\.top\/yuketangstudio/i.test($baseUrl?.value || '');
    if ($model) {
      $model.disabled = cloud;
      $model.placeholder = cloud ? '云端自动分配' : '例如：deepseek-chat / gpt-4o-mini';
    }
    if ($visionModel) $visionModel.disabled = cloud;
    if ($modelFetch) $modelFetch.style.display = cloud ? 'none' : '';
    if ($modelHint) $modelHint.style.display = cloud ? '' : 'none';
    if (cloud && $modelOptions) $modelOptions.style.display = 'none';
  }
  const $thinking = root.querySelector('#ykt-ai-thinking');
  const $effort = root.querySelector('#ykt-ai-effort');
  const $regex = root.querySelector('#ykt-ai-regex-tool');
  const $apiEye = root.querySelector('#ykt-apikey-eye');
  const $apiTest = root.querySelector('#ykt-apikey-test');
  const $apiTestResult = root.querySelector('#ykt-apikey-test-result');

  // === 其他 UI 原有字段 ===
  const $auto = root.querySelector('#ykt-input-auto-answer');
  const $fallbackAns = root.querySelector('#ykt-input-fallback-answer');
  const $autoJoin = root.querySelector('#ykt-input-auto-join');
  const $autoJoinAutoAnswer = root.querySelector('#ykt-input-auto-join-auto-answer');
  const $autoAnalyze = root.querySelector('#ykt-input-ai-auto-analyze');
  const $delay = root.querySelector('#ykt-input-answer-delay');
  const $rand = root.querySelector('#ykt-input-random-delay');
  const $notifyDur = root.querySelector('#ykt-input-notify-duration');
  const $notifyVol = root.querySelector('#ykt-input-notify-volume');
  const $iftex = root.querySelector('#ykt-ui-tex');

  const $audioFile = root.querySelector('#ykt-input-notify-audio-file');
  const $audioUrl  = root.querySelector('#ykt-input-notify-audio-url');
  const $applyUrl  = root.querySelector('#ykt-btn-apply-audio-url');
  const $preview   = root.querySelector('#ykt-btn-preview-audio');
  const $clear     = root.querySelector('#ykt-btn-clear-audio');
  const $audioName = root.querySelector('#ykt-tip-audio-name');
  const $saveState = root.querySelector('#ykt-settings-save-state');
  const $notifyVolOut = root.querySelector('#ykt-notify-volume-out');

  const setSaveState = (text, kind = 'muted') => {
    if (!$saveState) return;
    $saveState.textContent = text;
    $saveState.dataset.kind = kind;
  };

  // 设置分类导航：在面板内部滚动，不触发整页跳转
  root.querySelectorAll('#ykt-settings-nav a').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = link.getAttribute('href')?.slice(1);
      const target = targetId ? root.querySelector(`#${targetId}`) : null;
      if (!target) return;
      root.querySelectorAll('#ykt-settings-nav a').forEach((x) => x.classList.remove('active'));
      link.classList.add('active');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  root.querySelector('#ykt-settings-nav a')?.classList.add('active');

  const syncVolumeOut = () => {
    if ($notifyVolOut && $notifyVol) $notifyVolOut.textContent = String($notifyVol.value ?? 60);
  };
  $notifyVol?.addEventListener('input', syncVolumeOut);

  // Profile UI
  function refreshProfileSelect() {
    const ai = ui.config.ai;
    $profileSelect.innerHTML = '';
    ai.profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      if (p.id === ai.activeProfileId) opt.selected = true;
      $profileSelect.appendChild(opt);
    });
  }

  function loadProfileToForm(profileId) {
    const p = ui.config.ai.profiles.find(x => x.id === profileId);
    if (!p) return;

    ui.config.ai.activeProfileId = p.id;

    $profileName.value = p.name || '';
    $baseUrl.value = p.baseUrl || '';
    $api.value = p.apiKey || '';
    $model.value = p.model || '';
    $visionModel.value = p.visionModel || '';
    if ($thinking) $thinking.checked = p.thinking !== false;
    if ($effort) $effort.value = p.reasoningEffort || 'medium';
    if ($modelOptions) $modelOptions.style.display = 'none';
    applyCloudModelState();
  }

  // 初始化 Profile 下拉框
  refreshProfileSelect();
  loadProfileToForm(ui.config.ai.activeProfileId);

  // === 提示词设置（空 = 内置默认；可编辑可恢复） ===
  const $promptChat = root.querySelector('#ykt-prompt-chat');
  const $promptAI = root.querySelector('#ykt-prompt-ai');
  const fillPrompts = () => {
    if ($promptChat) $promptChat.value = String(ui.config.systemPromptChat ?? '').trim() || DEFAULT_SYSTEM_PROMPT_CHAT;
    if ($promptAI) $promptAI.value = String(ui.config.systemPromptAI ?? '').trim() || DEFAULT_SYSTEM_PROMPT_AI;
  };
  const savePrompts = () => {
    if ($promptChat) { ui.config.systemPromptChat = $promptChat.value.trim() === DEFAULT_SYSTEM_PROMPT_CHAT.trim() ? '' : $promptChat.value; }
    if ($promptAI) { ui.config.systemPromptAI = $promptAI.value.trim() === DEFAULT_SYSTEM_PROMPT_AI.trim() ? '' : $promptAI.value; }
    ui.saveConfig();
    setSaveState('已保存', 'ok');
  };
  // 编辑即暂存（blur 由通用自动保存覆盖不了 textarea value 判空逻辑，这里显式处理）
  $promptChat?.addEventListener('change', savePrompts);
  $promptAI?.addEventListener('change', savePrompts);
  // 恢复默认 = 直接填入默认值并落盘（空串 → 运行时走内置常量）
  root.querySelector('#ykt-prompt-chat-reset')?.addEventListener('click', () => {
    ui.config.systemPromptChat = '';
    ui.saveConfig();
    if ($promptChat) $promptChat.value = DEFAULT_SYSTEM_PROMPT_CHAT;
    ui.toast('PPT对话提示词已恢复默认', 2000);
  });
  root.querySelector('#ykt-prompt-ai-reset')?.addEventListener('click', () => {
    ui.config.systemPromptAI = '';
    ui.saveConfig();
    if ($promptAI) $promptAI.value = DEFAULT_SYSTEM_PROMPT_AI;
    ui.toast('AI解答提示词已恢复默认', 2000);
  });
  // 初始填充（后续切 tab 由 syncFormFromConfig 统一刷新）
  fillPrompts();

  // === 解锁入口（低调：仅一行，位于设置最底部；支持多解锁码，各自注入独立 profile） ===
  const $devPass = root.querySelector('#ykt-devmode-pass');
  const $devBtn = root.querySelector('#ykt-devmode-btn');
  const $devHint = root.querySelector('#ykt-devmode-hint');

  function refreshDevHint() {
    const cfgs = getDevConfigs();
    if (cfgs.length) {
      $devPass.placeholder = '已解锁 ' + cfgs.length + ' 个';
      $devHint.textContent = cfgs.map(c => c.name || '内置配置').join('、');
      $devBtn.textContent = '再解锁';
      $devBtn.disabled = false;
    } else {
      $devPass.placeholder = '解锁码';
      $devHint.textContent = '';
      $devBtn.textContent = '解锁';
      $devBtn.disabled = false;
    }
  }

  function applyDevProfile(devCfg, blobIndex) {
    const ai = ui.config.ai;
    ensureAIProfiles(ai);
    const profileId = `dev_${blobIndex}`;
    let p = ai.profiles.find(x => x.id === profileId);
    if (!p) { p = { id: profileId }; ai.profiles.push(p); }
    Object.assign(p, {
      name: devCfg.name || `内置配置 ${blobIndex}`,
      baseUrl: devCfg.baseUrl,
      apiKey: devCfg.apiKey,
      model: devCfg.model,
      visionModel: devCfg.visionModel || devCfg.model,
      thinking: true,
      reasoningEffort: devCfg.reasoningEffort || 'medium',
    });
    if (devCfg.reasoningEffort) p.reasoningEffort = devCfg.reasoningEffort;
    ai.activeProfileId = profileId;
    ui.saveConfig();
    syncFormFromConfig();   // 解锁后表单立即显示新配置
  }

  // === 匿名统计开关（最底部）与强化遥测（依赖基础遥测） ===
  const $telemetry = root.querySelector('#ykt-telemetry');
  const $telemetryEnhanced = root.querySelector('#ykt-telemetry-enhanced');
  const syncEnhancedTelemetryState = () => {
    if (!$telemetryEnhanced) return;
    const base = telemetry.enabled();
    $telemetryEnhanced.disabled = !base;
    if (!base) $telemetryEnhanced.checked = false;
    else $telemetryEnhanced.checked = telemetry.enhancedEnabled();
  };
  if ($telemetry) {
    $telemetry.checked = telemetry.enabled();
    $telemetry.addEventListener('change', () => {
      telemetry.setEnabled($telemetry.checked);
      if (!$telemetry.checked) telemetry.setEnhanced(false);
      syncEnhancedTelemetryState();
      refreshDevHint();   // 关掉后解锁按钮语义不变，但下次解锁会被拦
    });
  }
  if ($telemetryEnhanced) {
    $telemetryEnhanced.addEventListener('change', () => {
      if ($telemetryEnhanced.checked) {
        const ok = confirm('强化遥测会上传发送给模型的消息、模型回复、解析/提交结果和错误信息（已脱敏、截断，不含 API Key 和图片原始数据）。确定开启吗？');
        if (!ok) { $telemetryEnhanced.checked = false; return; }
      }
      const applied = telemetry.setEnhanced($telemetryEnhanced.checked);
      if (!applied && $telemetryEnhanced.checked) {
        $telemetryEnhanced.checked = false;
        ui.toast?.('请先开启「匿名统计使用情况」');
      }
    });
  }
  syncEnhancedTelemetryState();

  $devBtn?.addEventListener('click', async () => {
    const pass = ($devPass?.value || '').trim();
    if (!pass) { ui.toast?.('请输入解锁码'); return; }
    if (!telemetry.enabled()) { ui.toast?.('请先开启「匿名统计使用情况」'); return; }
    $devBtn.disabled = true;
    const originalText = $devBtn.textContent;
    $devBtn.textContent = '校验中…';
    try {
      const { cfg, blobIndex } = await unlockDevMode(pass);
      applyDevProfile(cfg, blobIndex);
      $devPass.value = '';
      ui.toast?.(`解锁成功：${cfg.name || '内置配置'} 已启用`);
    } catch (e) {
      ui.toast?.('解锁失败：' + (e?.message || e));
    } finally {
      refreshDevHint();
      $devBtn.textContent = originalText === '已解锁' ? '再解锁' : originalText;
    }
  });

  $devPass?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $devBtn?.click();
  });

  // 群号一键复制
  root.querySelector('#ykt-devmode-qq')?.addEventListener('click', async () => {
    const ok = await copyText('901466023');
    ui.toast?.(ok ? '已复制群号 901466023' : '复制失败，请手动输入 901466023', 2200);
  });

  refreshDevHint();

  // 切换 profile
  $profileSelect.addEventListener('change', () => {
    loadProfileToForm($profileSelect.value);
  });

  // API Key 眼睛切换（密码⇄明文）
  $apiEye?.addEventListener('click', () => {
    const isPwd = $api.type === 'password';
    $api.type = isPwd ? 'text' : 'password';
    $apiEye.querySelector('i').className = isPwd ? 'fas fa-eye-slash' : 'fas fa-eye';
  });

  // 测试连接：/models 优先；端点不提供模型列表（404/405）时用真实模型做最小对话验证
  $apiTest?.addEventListener('click', async () => {
    const baseUrl = $baseUrl.value.trim().replace(/\/+$/, '');
    const apiKey = $api.value.trim();
    const modelId = $model.value.trim();
    if (!baseUrl) { $apiTestResult.textContent = '请先填 URL'; $apiTestResult.style.color = '#c0392b'; return; }
    if (!apiKey) { $apiTestResult.textContent = '请先填 API Key'; $apiTestResult.style.color = '#c0392b'; return; }
    $apiTest.disabled = true;
    $apiTestResult.textContent = '测试中…';
    $apiTestResult.style.color = '#607190';
    const show = (msg, color) => { $apiTestResult.textContent = msg; $apiTestResult.style.color = color; };
    const gmReq = (method, url, data) => new Promise((resolve, reject) => {
      try {
        gm.xhr({
          method, url,
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          data: data ? JSON.stringify(data) : undefined,
          onload: (r) => resolve(r),
          onerror: (e) => reject(new Error(e?.error || '网络请求失败')),
          ontimeout: () => reject(new Error('请求超时')),
          timeout: 15000,
        });
      } catch (e) { reject(e); }
    });
    try {
      const modelsUrl = baseUrl.replace(/\/chat\/completions.*$/, '') + '/models';
      const r = await gmReq('GET', modelsUrl);
      if (r.status >= 200 && r.status < 300) { show('✅ 连接成功', '#059669'); return; }
      if (r.status === 401 || r.status === 403) { show(`❌ 认证失败 (HTTP ${r.status})`, '#c0392b'); return; }
      // 404/405：该端点没有 /models（火山方舟等）——没有模型 ID 时只能确认端点可达
      if (!modelId) {
        show('✅ 端点可达（该端点不提供模型列表，请填模型 ID 后点测试）', '#059669');
        return;
      }
      const r2 = await gmReq('POST', makeChatUrl(baseUrl),
        { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
      if (r2.status >= 200 && r2.status < 300) { show('✅ 连接成功', '#059669'); return; }
      if (r2.status === 400) { show('✅ 端点可达（模型参数校验通过）', '#059669'); return; }
      if (r2.status === 401 || r2.status === 403) { show(`❌ 认证失败 (HTTP ${r2.status})`, '#c0392b'); return; }
      if (r2.status === 404) { show('❌ 模型 ID 不存在，或该模型不支持此端点', '#c0392b'); return; }
      show(`❌ HTTP ${r2.status}`, '#c0392b');
    } catch (e) {
      show(`❌ 网络错误：${e?.message || e}`, '#c0392b');
    } finally {
      $apiTest.disabled = false;
    }
  });

  // 获取模型列表：仅自定义渠道；云端由服务端按渠道分配
  $baseUrl?.addEventListener('input', applyCloudModelState);
  $baseUrl?.addEventListener('change', applyCloudModelState);

  $modelFetch?.addEventListener('click', async () => {
    const base = ($baseUrl?.value || '').trim().replace(/\/+$/, '');
    if (!base) { ui.toast?.('先填写 URL'); return; }
    if (/api\.raymor\.top\/yuketangstudio/i.test(base)) {
      ui.toast?.('云端模型由服务端按渠道自动分配');
      return;
    }
    let url;
    if (base.includes('/chat/completions')) url = base.replace(/\/chat\/completions.*$/, '/models');
    else if (/\/v\d+$/.test(base)) url = base + '/models';
    else url = base + '/v1/models';
    const key = ($api?.value || '').trim();
    const headers = key ? { Authorization: 'Bearer ' + key } : {};
    const oldText = $modelFetch.textContent;
    $modelFetch.disabled = true;
    $modelFetch.textContent = '获取中…';
    let data;
    let lastStatus = 0;
    try {
      const r = await fetch(url, { headers });
      lastStatus = r.status;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      try {
        data = await new Promise((resolve, reject) => {
          gm.xhr({
            method: 'GET', url, headers, timeout: 10000,
            onload: (res) => {
              lastStatus = res.status;
              if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
              try { resolve(JSON.parse(res.responseText || '{}')); } catch (err) { reject(err); }
            },
            onerror: reject, ontimeout: reject,
          });
        });
      } catch (e2) {
        $modelFetch.disabled = false;
        $modelFetch.textContent = oldText;
        if (lastStatus === 404 || lastStatus === 405) {
          ui.toast?.('该端点不提供模型列表，请手动填写模型 ID', 3200);
        } else {
          ui.toast?.('获取失败：' + (e2?.message || e2));
        }
        return;
      }
    }
    $modelFetch.disabled = false;
    $modelFetch.textContent = oldText;
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
    const items = list.map(m => ({
      id: String(m?.id || ''),
      label: String(m?.name || m?.owned_by || ''),
    })).filter(x => x.id);
    if (!items.length) { ui.toast?.('没有获取到模型'); return; }
    $modelOptions.innerHTML = items.map(x =>
      `<div class="opt" data-id="${escapeHtml(x.id)}"><span>${escapeHtml(x.id)}</span><span class="provider">${escapeHtml(x.label)}</span></div>`
    ).join('');
    $modelOptions.style.display = 'block';
    $modelOptions.querySelectorAll('.opt').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id') || '';
        $model.value = id;
        $model.dispatchEvent(new Event('change', { bubbles: true }));
        $modelOptions.style.display = 'none';
        ui.toast?.(`已选择模型：${id}`, 1800);
      });
    });
    ui.toast?.(`已获取 ${items.length} 个模型，点列表选择`, 2600);
  });

  // 添加 profile
  $profileAdd.addEventListener('click', () => {
    const id = `p_${Date.now().toString(36)}`;
    const newP = {
      id,
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',   // 默认模板：多数人用 DeepSeek
      apiKey: '',
      model: 'deepseek-flash',
      visionModel: '',
      thinking: true,  // 默认开启思考
      reasoningEffort: 'medium',
    };
    ui.config.ai.profiles.push(newP);
    ui.config.ai.activeProfileId = id;

    refreshProfileSelect();
    loadProfileToForm(id);
  });

  // 删除 profile
  $profileDel.addEventListener('click', () => {
    const ai = ui.config.ai;
    if (ai.profiles.length <= 1) {
      ui.toast('至少保留一个配置', 2500);
      return;
    }
    const id = ai.activeProfileId;
    ai.profiles = ai.profiles.filter(p => p.id !== id);
    ai.activeProfileId = ai.profiles[0].id;

    refreshProfileSelect();
    loadProfileToForm(ai.activeProfileId);
  });

  // 初始化表单（后续所有刷新统一走 syncFormFromConfig）
  syncFormFromConfig();

  // 保存按钮
  root.querySelector('#ykt-btn-settings-save').addEventListener('click', () => commitForm());

  // ===== 表单 → config 的唯一写入路径（保存按钮与自动保存共用，避免两套逻辑漂移） =====
  function commitForm({ silent = false } = {}) {
    const ai = ui.config.ai;
    const pid = ai.activeProfileId;
    const p = ai.profiles.find(x => x.id === pid);
    if (p) {
      p.name = $profileName.value.trim() || p.name;
      p.baseUrl = $baseUrl.value.trim() || p.baseUrl;
      p.apiKey = $api.value.trim();
      p.model = $model.value.trim() || p.model;
      p.visionModel = $visionModel.value.trim() || p.visionModel;
      if ($thinking) p.thinking = !!$thinking.checked;
      if ($effort) p.reasoningEffort = $effort.value || 'medium';
      const curOpt = $profileSelect.querySelector(`option[value="${p.id}"]`);
      if (curOpt) curOpt.textContent = p.name || p.id;
    }

    if (p) {
      ai.kimiApiKey = p.apiKey;      // 兼容旧字段
      storage.set('kimiApiKey', p.apiKey);
    }
    ui.config.autoJoinEnabled = !!$autoJoin.checked;
    ui.config.autoAnswerOnAutoJoin = !!$autoJoinAutoAnswer.checked;
    ui.config.autoAnswer = !!$auto.checked;
    ui.config.autoAnswerFallbackDefault = !!$fallbackAns?.checked;
    ui.config.aiAutoAnalyze = !!$autoAnalyze.checked;
    ui.config.autoAnswerDelay = Math.max(1000, (+$delay.value || 0) * 1000);
    ui.config.autoAnswerRandomDelay = Math.max(0, (+$rand.value || 0) * 1000);
    ui.config.iftex = !!$iftex.checked;
    ui.config.regexToolCall = !!$regex?.checked;
    ui.config.notifyPopupDuration = Math.max(2000, (+$notifyDur.value || 0) * 1000);
    const volumePercent = Number($notifyVol?.value);
    ui.config.notifyVolume = Number.isFinite(volumePercent)
      ? Math.max(0, Math.min(1, volumePercent / 100))
      : 0.6;

    ui.saveConfig();
    ui.updateAutoAnswerBtn();
    setSaveState(silent ? '已自动保存' : '已保存', 'ok');
    if (!silent) ui.toast('设置已保存');
    return p;
  }

  // 自动保存：失焦/变更即落盘（此前必须先点"保存设置"，关掉面板改动就丢）
  // 用 blur（捕获阶段）而非每次 input，避免边打字边写存储
  let autoSaveTimer = 0;
  const scheduleAutoSave = () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      try { commitForm({ silent: true }); } catch (e) { log.warn('[Settings] 自动保存失败', e); }
    }, 300);
  };
  const AUTO_SAVE_SELECTOR = 'input[type="text"], input[type="password"], input[type="number"], input[type="range"], textarea, select, input[type="checkbox"]';
  root.addEventListener('change', (e) => {
    if (e.target?.matches?.(AUTO_SAVE_SELECTOR) && e.target.closest('.settings-content')) scheduleAutoSave();
  });
  root.addEventListener('focusout', (e) => {
    if (e.target?.matches?.('input[type="text"], input[type="password"], input[type="number"], textarea')
      && e.target.closest('.settings-content')) scheduleAutoSave();
  });

  /** 从 config 反向刷新所有表单（解锁开发者模式、切 tab、重置后调用） */
  function syncFormFromConfig() {
    ensureAIProfiles(ui.config.ai);
    refreshProfileSelect();
    loadProfileToForm(ui.config.ai.activeProfileId);
    $autoJoin.checked = !!ui.config.autoJoinEnabled;
    $autoJoinAutoAnswer.checked = !!ui.config.autoAnswerOnAutoJoin;
    $auto.checked = !!ui.config.autoAnswer;
    if ($fallbackAns) $fallbackAns.checked = !!ui.config.autoAnswerFallbackDefault;
    $autoAnalyze.checked = !!ui.config.aiAutoAnalyze;
    $iftex.checked = !!ui.config.iftex;
    const delayMs = Number.isFinite(Number(ui.config.autoAnswerDelay)) && Number(ui.config.autoAnswerDelay) > 0
      ? Number(ui.config.autoAnswerDelay) : 3000;
    const randMs = Number.isFinite(Number(ui.config.autoAnswerRandomDelay))
      ? Number(ui.config.autoAnswerRandomDelay) : 2000;
    $delay.value = Math.floor(delayMs / 1000);
    $rand.value = Math.floor(randMs / 1000);
    if ($regex) $regex.checked = !!ui.config.regexToolCall;
    $notifyDur.value = Math.floor((ui.config.notifyPopupDuration || 5000) / 1000);
    $notifyVol.value = Math.round(100 * (ui.config.notifyVolume ?? 0.6));
    syncVolumeOut();
    $audioName.textContent = ui.config.customNotifyAudioName
      ? `当前：${ui.config.customNotifyAudioName}`
      : '当前：使用内置“叮-咚”提示音';
    if ($telemetry) $telemetry.checked = telemetry.enabled();
    syncEnhancedTelemetryState();
    fillPrompts();
  }
  // 暴露给面板外部（shell 切换 tab 时重新同步，避免显示陈旧值）
  root.__yksOnShow = syncFormFromConfig;   // shell 切 tab 时刷新表单

  //--------------------------------------
  //            重置为默认
  //--------------------------------------

  root.querySelector('#ykt-btn-settings-reset').addEventListener('click', () => {
    if (!confirm('确定要重置为默认设置吗？')) return;

    // 彻底重置：先删掉 DEFAULT_CONFIG 里没有的残留键（旧版本遗留/实验字段/
    // 解锁写入的 profiles），再整体覆盖——只 Object.assign 会漏项，用户会看到
    // 「重置后某些开关还是原来的值」
    const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    for (const k of Object.keys(ui.config)) {
      if (!(k in fresh)) delete ui.config[k];
    }
    Object.assign(ui.config, fresh);
    ensureAIProfiles(ui.config.ai);

    syncFormFromConfig();
    storage.set('kimiApiKey', '');

    // 遥测开关不在 config 里（独立 storage key），一并复位（默认开）
    telemetry.setEnabled(true);
    telemetry.setEnhanced(false);
    if ($telemetry) $telemetry.checked = true;
    syncEnhancedTelemetryState();

    ui.saveConfig();
    ui.updateAutoAnswerBtn();
    setSaveState('已重置', 'ok');
    ui.toast('设置已重置');
  });

  // 音频设置
  const MAX_SIZE = 2 * 1024 * 1024;

  if ($audioFile) {
    $audioFile.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > MAX_SIZE) {
        ui.toast('音频文件过大（>2MB）', 3000);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result;
        ui.setCustomNotifyAudio({ src, name: f.name });
        $audioName.textContent = `当前：${f.name}`;
        setSaveState('已保存', 'ok');
        ui._playNotifySound(ui.config.notifyVolume);
        ui.toast('已应用自定义提示音');
      };
      reader.readAsDataURL(f);
    });
  }

  if ($applyUrl) {
    $applyUrl.addEventListener('click', () => {
      const url = ($audioUrl.value || '').trim();
      if (!url) return ui.toast('请输入音频URL');

      if (!/^https?:\/\/|^data:audio\//i.test(url)) {
        ui.toast('URL 必须以 http/https 或 data:audio/ 开头');
        return;
      }

      ui.setCustomNotifyAudio({ src: url, name: '' });
      $audioName.textContent = '当前：（自定义URL）';
      setSaveState('已保存', 'ok');
      ui._playNotifySound(ui.config.notifyVolume);
      ui.toast('已应用自定义音频URL');
    });
  }

  if ($preview) {
    $preview.addEventListener('click', () => {
      ui._playNotifySound(ui.config.notifyVolume);
    });
  }

  if ($clear) {
    $clear.addEventListener('click', () => {
      ui.setCustomNotifyAudio({ src: '', name: '' });
      $audioName.textContent = '当前：使用内置“叮-咚”提示音';
      setSaveState('已保存', 'ok');
      ui.toast('已清除自定义音频');
    });
  }

  // 测试提醒
  const $btnTest = root.querySelector('#ykt-btn-test-notify');
  if ($btnTest) {
    $btnTest.addEventListener('click', () => {
      const mockProblem = {
        problemId: 'TEST-001',
        body: '【测试题】这是一个测试提醒',
        options: [],
      };
      ui.notifyProblem(mockProblem, { thumbnail: null });
    });
  }

  // 关闭统一走 shell 右上角 ✕（面板自带 X 已删，见 html）

  mounted = true;
  return root;
}

export function showSettingsPanel(visible = true) {
  mountSettingsPanel();
  const panel = document.getElementById('ykt-settings-panel');
  if (!panel) return;
  panel.classList.toggle('visible', !!visible);
  // 每次打开时从 config 重新拉取（解锁开发者模式、其他面板改配置后保持一致）
  if (visible) panel.__yksOnShow?.();
}

export function toggleSettingsPanel() {
  mountSettingsPanel();
  const panel = document.getElementById('ykt-settings-panel');
  showSettingsPanel(!panel.classList.contains('visible'));
}
