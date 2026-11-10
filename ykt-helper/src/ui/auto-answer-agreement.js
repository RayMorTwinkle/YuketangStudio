// src/ui/auto-answer-agreement.js
// 自动作答首次使用前的「君子协定」。
// 只约束自动作答；AI 手动答题/工具调用不触发本协议。
import { storage } from '../core/storage.js';

const STORAGE_KEY = 'autoAnswerAgreementAccepted';
let pending = null;

function accepted(ui) {
  try {
    return !!(ui?.config?.autoAnswerAgreementAccepted || storage.get(STORAGE_KEY, false));
  } catch { return false; }
}

function persistAccepted(ui) {
  try {
    if (ui?.config) ui.config.autoAnswerAgreementAccepted = true;
    storage.set(STORAGE_KEY, true);
    ui?.saveConfig?.();
  } catch {}
}

function deferAndDisable(ui) {
  try {
    if (ui?.config) {
      ui.config.autoAnswer = false;
      ui.config.autoAnswerOnAutoJoin = false;
    }
    ui?.saveConfig?.();
    ui?.updateAutoAnswerBtn?.();
  } catch {}
}

export function showAutoAnswerAgreementAtStartup(ui) {
  if (accepted(ui)) return;
  try {
    if (sessionStorage.getItem('ykt-auto-agreement-shown') === '1') return;
    sessionStorage.setItem('ykt-auto-agreement-shown', '1');
  } catch {}
  void ensureAutoAnswerAgreement(ui);
}

export function ensureAutoAnswerAgreement(ui) {
  if (accepted(ui)) return Promise.resolve(true);
  if (pending) return pending;

  pending = new Promise((resolve) => {
    if (!document?.body) { pending = null; resolve(false); return; }

    const mask = document.createElement('div');
    mask.id = 'ykt-auto-agreement';
    mask.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483001',
      'background:rgba(15,23,42,.55)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:20px',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#fff', 'color:#1f2937', 'border-radius:14px',
      'max-width:390px', 'width:100%', 'padding:18px 18px 14px',
      'box-shadow:0 20px 55px rgba(0,0,0,.3)', 'font-size:13px', 'line-height:1.65',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '君子协定 · 使用自动作答前';
    title.style.cssText = 'font-weight:700;font-size:16px;color:#111827;margin-bottom:9px;';

    const body = document.createElement('div');
    body.textContent = [
      '自动作答是辅助功能，答案不保证正确，可能造成误提交，风险由使用者自行承担。',
      '',
      '我承诺：',
      '1. 不向任何人透露此功能的存在、名称、截图、使用方法或效果；',
      '2. 不把自动作答用于违反学校、课程或平台规定的场景；',
      '3. 使用前自行核对题目与答案，不把自动结果当作唯一依据。',
      '',
      '如果暂不同意，将暂时关闭自动作答；之后仍可在设置中重新开启并再次同意。',
    ].join('\n');
    body.style.cssText = 'white-space:pre-wrap;color:#334155;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:9px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px;';

    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = '暂不同意并暂时关闭自动开关';
    no.style.cssText = 'padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;font-size:12px;';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '同意';
    ok.style.cssText = 'padding:8px 18px;border:none;border-radius:8px;color:#fff;cursor:pointer;background:#1d63df;font-size:12px;';

    const close = (isAccepted) => {
      mask.remove();
      pending = null;
      resolve(!!isAccepted);
    };
    no.addEventListener('click', () => {
      deferAndDisable(ui);
      close(false);
    });
    ok.addEventListener('click', () => {
      persistAccepted(ui);
      close(true);
    });

    bar.appendChild(no);
    bar.appendChild(ok);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(bar);
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
  return pending;
}
