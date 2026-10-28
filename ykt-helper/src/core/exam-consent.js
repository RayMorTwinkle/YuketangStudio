// src/core/exam-consent.js
// 进行中考试 AI 自动填充的免责确认。
// 用户选择“永久记住”：同意一次后本机不再弹窗；每次同意状态上传到服务端（只传匿名元数据）。
import { storage } from './storage.js';
import { gm } from './env.js';
import { getInstallId, getVersion } from './telemetry.js';
import { log } from './log.js';

const KEY = 'examAiConsent';
const QUEUE_KEY = 'examAiConsentQueue';
const CONSENT_VERSION = 1;
const ENDPOINT = 'https://api.raymor.top/yuketangstudio/exam-ai-consent';

function readRecord() {
  const v = storage.get(KEY);
  if (!v || typeof v !== 'object' || v.accepted !== true) return null;
  if (Number(v.version) !== CONSENT_VERSION) return null;
  return v;
}

function saveRecord(record) {
  storage.set(KEY, record);
}

export function hasExamConsent() {
  return !!readRecord();
}

export function getExamConsentRecord() {
  return readRecord();
}

function hash32(s) {
  const str = String(s || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function queueUpload(payload) {
  const q = storage.get(QUEUE_KEY);
  const arr = Array.isArray(q) ? q : [];
  arr.push(payload);
  storage.set(QUEUE_KEY, arr.slice(-20));
}

/** 上传“同意”元数据；失败进队列，不阻塞用户。 */
export async function uploadExamConsent({ mode = 'single', examId = '', courseId = '', source = 'exam-fill' } = {}) {
  const payload = {
    installId: getInstallId(),
    platform: typeof window !== 'undefined' && window.YktBridge ? 'android' : 'pc',
    version: getVersion(),
    mode: String(mode || 'single'),
    source: String(source || ''),
    examIdHash: hash32(examId),
    courseIdHash: hash32(courseId),
    accepted: true,
    ts: Date.now(),
  };
  try {
    await new Promise((resolve, reject) => {
      gm.xhr({
        method: 'POST',
        url: ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: 10000,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error('HTTP ' + r.status))),
        onerror: reject,
        ontimeout: () => reject(new Error('上传超时')),
      });
    });
    return { ok: true, payload };
  } catch (e) {
    log.warn('[exam-consent] upload failed, queued', e?.message || e);
    queueUpload(payload);
    return { ok: false, error: String(e?.message || e), payload };
  }
}

/** 重试队列（不阻塞）。 */
export function flushExamConsentQueue() {
  const q = storage.get(QUEUE_KEY);
  const arr = Array.isArray(q) ? q : [];
  if (!arr.length) return;
  storage.set(QUEUE_KEY, []);
  for (const payload of arr) {
    try {
      gm.xhr({
        method: 'POST',
        url: ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: 10000,
        onload: (r) => {
          if (!(r.status >= 200 && r.status < 300)) queueUpload(payload);
        },
        onerror: () => queueUpload(payload),
        ontimeout: () => queueUpload(payload),
      });
    } catch {
      queueUpload(payload);
    }
  }
}

function makeDialog() {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.52);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;';
    const box = document.createElement('div');
    box.style.cssText = 'width:520px;max-width:100%;background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.3);font:13px/1.65 system-ui,sans-serif;color:#111827;';
    box.innerHTML = `
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">⚠️ 进行中考试 AI 自动填充</div>
      <div style="color:#374151;margin-bottom:10px;">
        AI 只会把参考答案写入当前考试页面的答题控件，<b>不会点击提交按钮，也不会自动交卷</b>。
        考试规则风险由你自行承担；请确认你有权这样做，并在提交前逐题核对。
      </div>
      <div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:9px 11px;margin-bottom:12px;">
        首次同意后会永久记住，并上传“同意状态”到服务器（仅匿名安装 ID、版本、模式、时间、考试/课程 ID 哈希；不上传题目、答案、成绩）。
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0 14px;cursor:pointer;">
        <input id="ykt-exam-consent-check" type="checkbox" style="margin-top:3px;width:16px;height:16px;flex:0 0 auto;">
        <span>我已知晓风险并自行承担后果，同意 AI 自动填入考试答案。</span>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="ykt-exam-consent-no" style="padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;">仅展示答案</button>
        <button id="ykt-exam-consent-yes" disabled style="padding:8px 14px;border:0;border-radius:8px;background:#1d63df;color:#fff;cursor:not-allowed;opacity:.5;">同意并继续</button>
      </div>`;
    mask.appendChild(box);
    document.body.appendChild(mask);
    const check = box.querySelector('#ykt-exam-consent-check');
    const yes = box.querySelector('#ykt-exam-consent-yes');
    const no = box.querySelector('#ykt-exam-consent-no');
    const done = (v) => { try { mask.remove(); } catch {} resolve(v); };
    check.addEventListener('change', () => {
      yes.disabled = !check.checked;
      yes.style.cursor = check.checked ? 'pointer' : 'not-allowed';
      yes.style.opacity = check.checked ? '1' : '.5';
    });
    yes.addEventListener('click', () => { if (!check.checked) return; done(true); });
    no.addEventListener('click', () => done(false));
    mask.addEventListener('click', (e) => { if (e.target === mask) done(false); });
  });
}

/**
 * 确保已获得考试自动填充同意。
 * 首次同意后永久记住；上传失败只进队列，不阻塞填充。
 */
export async function ensureExamConsent({ mode = 'single', examId = '', courseId = '', source = 'exam-fill' } = {}) {
  if (hasExamConsent()) {
    flushExamConsentQueue();
    return true;
  }
  const ok = await makeDialog();
  if (!ok) return false;
  const record = { accepted: true, at: Date.now(), version: CONSENT_VERSION };
  saveRecord(record);
  void uploadExamConsent({ mode, examId, courseId, source });
  return true;
}
