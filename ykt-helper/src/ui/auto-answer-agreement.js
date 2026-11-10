// src/ui/auto-answer-agreement.js
// 自动作答首次使用前的「君子协定」。
// 只约束自动作答；AI 手动答题/工具调用不触发本协议。
let pending = null;

export function ensureAutoAnswerAgreement(ui) {
  try {
    if (ui?.config?.autoAnswerAgreementAccepted) return Promise.resolve(true);
  } catch { return Promise.resolve(false); }
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
    ].join('\n');
    body.style.cssText = 'white-space:pre-wrap;color:#334155;';

    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin-top:14px;cursor:pointer;color:#111827;';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = 'ykt-auto-agreement-check';
    check.style.cssText = 'margin-top:3px;flex:0 0 auto;';
    const checkText = document.createElement('span');
    checkText.textContent = '我已阅读并同意以上约定';
    label.appendChild(check);
    label.appendChild(checkText);

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px;';

    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = '取消';
    no.style.cssText = 'padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '同意并开启';
    ok.disabled = true;
    ok.style.cssText = 'padding:8px 14px;border:none;border-radius:8px;color:#fff;cursor:pointer;background:#9ca3af;';

    const close = (accepted) => {
      mask.remove();
      pending = null;
      resolve(!!accepted);
    };
    check.addEventListener('change', () => {
      ok.disabled = !check.checked;
      ok.style.background = check.checked ? '#1d63df' : '#9ca3af';
      ok.style.cursor = check.checked ? 'pointer' : 'not-allowed';
    });
    no.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => {
      if (!check.checked) return;
      try {
        ui.config.autoAnswerAgreementAccepted = true;
        ui.saveConfig?.();
      } catch {}
      close(true);
    });
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });

    bar.appendChild(no);
    bar.appendChild(ok);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(label);
    box.appendChild(bar);
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
  return pending;
}
