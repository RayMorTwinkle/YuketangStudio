// src/ui/confirm.js
// 自绘二次确认框（WebView 里 window.confirm 默认返回 false，不能用）。
// 返回 Promise<boolean>。

export function confirmDialog(text, { okText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483000',
      'background:rgba(15,23,42,.45)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:24px',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#fff', 'color:#1f2937', 'border-radius:12px',
      'max-width:340px', 'width:100%', 'padding:18px 18px 12px',
      'box-shadow:0 20px 50px rgba(0,0,0,.25)', 'font-size:14px', 'line-height:1.6',
    ].join(';');

    const msg = document.createElement('div');
    msg.textContent = text;
    msg.style.cssText = 'white-space:pre-wrap;word-break:break-word;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px;';

    const no = document.createElement('button');
    no.textContent = cancelText;
    no.style.cssText = 'padding:7px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;cursor:pointer;';

    const ok = document.createElement('button');
    ok.textContent = okText;
    ok.style.cssText = `padding:7px 14px;border:none;border-radius:8px;color:#fff;cursor:pointer;background:${danger ? '#dc2626' : '#1d63df'};`;

    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    no.onclick = () => done(false);
    ok.onclick = () => done(true);
    mask.addEventListener('click', (e) => { if (e.target === mask) done(false); });

    bar.appendChild(no);
    bar.appendChild(ok);
    box.appendChild(msg);
    box.appendChild(bar);
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
}
