// src/quiz/exam-fill.js
// 进行中考试页的“通用 DOM 适配器”：
// - 只读收集题目文本和答题控件；
// - 只写入答案，不点击提交按钮、不触发交卷；
// - 页面结构未知时宁可返回 0，不猜字段。
//
// 说明：考试页是官方前端，不同学校/新旧版 DOM 差异很大；这里用保守选择器 +
// 最小侵入的 native setter，失败时由调用方展示答案让用户手动复制。

const QUESTION_SELECTOR = [
  '[data-question-id]',
  '[data-problem-id]',
  '[data-questionid]',
  '.question-item',
  '.problem-item',
  '.subject-item',
  '.exam-question',
  '.question-card',
  '.question_block',
].join(',');

function visible(el) {
  try {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch { return true; }
}

function textOf(el) {
  return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function idOf(el, i) {
  return String(
    el?.getAttribute?.('data-question-id')
    || el?.getAttribute?.('data-problem-id')
    || el?.getAttribute?.('data-questionid')
    || el?.id
    || `q${i + 1}`,
  );
}

function optionLabel(input) {
  const label = input.closest?.('label');
  if (label) return textOf(label);
  const parent = input.parentElement;
  const text = textOf(parent);
  return text || String(input.value || '');
}

function controlsOf(root) {
  return [...root.querySelectorAll('input, textarea')].filter((el) => {
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'INPUT' && ['hidden', 'button', 'submit', 'file'].includes(String(el.type).toLowerCase())) return false;
    return true;
  });
}

/**
 * 收集当前页面的题目根节点。嵌套候选只保留最内层，避免一道题被填两次。
 */
export function collectExamQuestions(doc = document) {
  if (!doc) return [];
  const docs = [doc];
  // 考试页可能嵌在同源 iframe 里；递归一层，跨域 iframe 会抛错并跳过。
  for (const f of (doc.querySelectorAll?.('iframe') || [])) {
    try {
      if (f.contentDocument) docs.push(f.contentDocument);
    } catch { /* cross-origin */ }
  }
  const allNodes = [];
  for (const d of docs) {
    let nodes = [...(d.querySelectorAll?.(QUESTION_SELECTOR) || [])].filter(visible);
    nodes = nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
    allNodes.push(...nodes);
  }
  let nodes = allNodes;
  nodes = nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
  return nodes.map((el, i) => {
    const controls = controlsOf(el);
    const choices = controls.filter((c) => c.tagName === 'INPUT' && ['radio', 'checkbox'].includes(String(c.type).toLowerCase()));
    const texts = controls.filter((c) => c.tagName === 'TEXTAREA' || (c.tagName === 'INPUT' && ['text', 'number', 'search'].includes(String(c.type).toLowerCase())));
    return {
      index: i,
      id: idOf(el, i),
      text: textOf(el),
      element: el,
      choices,
      texts,
      kind: choices.length ? 'choice' : (texts.length ? 'text' : 'unknown'),
      options: choices.map((c) => ({ input: c, label: optionLabel(c), value: String(c.value || '') })),
    };
  }).filter((q) => q.text);
}

/** 从 AI 文本里提取选项字母（A/B/C/D，支持多选）。 */
export function parseChoiceLetters(text) {
  const s = String(text || '');
  const explicit = s.match(/(?:答案|选项|正确选项)\s*[:：]?\s*([A-H](?:\s*[,，、/]\s*[A-H])*)/i);
  const raw = explicit ? explicit[1] : s;
  const letters = [...raw.toUpperCase().matchAll(/\b([A-H])\b/g)].map((m) => m[1]);
  return [...new Set(letters)];
}

function setChecked(input, checked) {
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(input, !!checked);
    else input.checked = !!checked;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /* ignore */ }
}

function setValue(el, value) {
  try {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, String(value ?? ''));
    else el.value = String(value ?? '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /* ignore */ }
}

/**
 * 将答案写入当前考试页面。answers 顺序与 collectExamQuestions 一致。
 * @param {Array<string|string[]>} answers
 * @param {{questions?:Array}} [opts]
 * @returns {{filled:number, skipped:number, details:Array}}
 */
export function fillExamAnswers(answers, { questions = null } = {}) {
  const list = Array.isArray(questions) ? questions : collectExamQuestions(document);
  const details = [];
  let filled = 0;
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const answer = answers?.[i];
    if (answer == null || String(answer).trim() === '') {
      skipped++;
      details.push({ id: q.id, status: 'empty' });
      continue;
    }
    try {
      if (q.kind === 'choice' && q.choices.length) {
        const letters = parseChoiceLetters(answer);
        if (!letters.length) {
          skipped++;
          details.push({ id: q.id, status: 'no-choice-letter' });
          continue;
        }
        const matched = q.options.filter((o) => {
          const label = String(o.label || '').trim().toUpperCase();
          return letters.some((l) => label.startsWith(l) || label.startsWith(`${l}.`) || label.startsWith(`${l}、`) || label.startsWith(`${l} `));
        });
        if (!matched.length) {
          skipped++;
          details.push({ id: q.id, status: 'no-matched-option', letters });
          continue;
        }
        const multi = q.choices.some((c) => String(c.type).toLowerCase() === 'checkbox');
        if (!multi) matched.slice(0, 1).forEach((o) => setChecked(o.input, true));
        else for (const o of q.options) setChecked(o.input, matched.includes(o));
        filled++;
        details.push({ id: q.id, status: 'filled', letters });
      } else if (q.kind === 'text' && q.texts.length) {
        const parts = Array.isArray(answer) ? answer : String(answer).split(/\n+/);
        q.texts.forEach((el, idx) => setValue(el, parts[idx] ?? (idx === 0 ? answer : '')));
        filled++;
        details.push({ id: q.id, status: 'filled-text' });
      } else {
        skipped++;
        details.push({ id: q.id, status: 'unknown-control' });
      }
    } catch (e) {
      skipped++;
      details.push({ id: q.id, status: 'error', error: String(e?.message || e) });
    }
  }
  return { filled, skipped, details };
}
