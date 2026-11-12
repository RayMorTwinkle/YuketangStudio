// src/ui/panels/answer-card.js
// 答题卡片：只负责展示 + 调用唯一提交入口，不再判断 __submitTarget。
import { ui } from '../ui-api.js';
import { confirmDialog } from '../confirm.js';
import { repo } from '../../state/repo.js';
import { submitAnswerTask } from '../../answer/submit.js';
import { toDisplayAnswer } from '../../answer/serialize.js';

/**
 * @param {HTMLElement} parent
 * @param {object} args
 * @param {object} args.task
 * @param {object} args.answer
 * @param {boolean} [args.autoSubmit]
 * @param {Function} [args.onSubmitted] (result) => void
 * @returns {HTMLElement}
 */
export function renderAnswerCard(parent, { task, answer, autoSubmit = false, runId = '', onSubmitted } = {}) {
  const card = document.createElement('div');
  card.className = 'ykt-tool-card';
  const isQuiz = task?.target?.kind === 'quiz';
  const displayOnly = !task?.target?.allowSubmit || task?.target?.kind === 'display';
  // 补交只对课堂实时题开放；作业/考试回顾没有课堂补交接口。
  const canRetry = !autoSubmit && task?.target?.kind === 'classroom' && !!task?.target?.allowSubmit;

  const title = document.createElement('div');
  title.className = 'ykt-tool-title';
  title.textContent = displayOnly
    ? '💡 参考答案（不提交）'
    : (isQuiz ? '📥 暂存答案（作业）' : '📤 提交答案');
  card.appendChild(title);

  if (typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence)) {
    const conf = document.createElement('div');
    conf.className = 'ykt-tool-confidence';
    const pct = Math.round(answer.confidence * 100);
    conf.textContent = `置信度 ${pct}%`;
    if (pct < 50) conf.classList.add('ykt-conf-low');
    card.appendChild(conf);
  }

  const ans = document.createElement('div');
  ans.className = 'ykt-tool-answer';
  ans.textContent = toDisplayAnswer(answer);
  card.appendChild(ans);

  if (answer?.reason) {
    const reason = document.createElement('div');
    reason.className = 'ykt-tool-reason';
    reason.textContent = answer.reason;
    card.appendChild(reason);
  }

  const bar = document.createElement('div');
  bar.className = 'ykt-tool-actions';
  card.appendChild(bar);

  const stEl = document.createElement('div');
  stEl.className = 'ykt-tool-status';
  card.appendChild(stEl);

  const copy = async () => {
    const text = toDisplayAnswer(answer);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      stEl.textContent = '✅ 已复制';
    } catch {
      stEl.textContent = '复制失败，请手动选择答案文本';
    }
  };

  if (displayOnly) {
    const btn = document.createElement('button');
    btn.className = 'ykt-tool-submit';
    btn.textContent = '复制答案';
    btn.addEventListener('click', copy);
    bar.appendChild(btn);
    stEl.textContent = task?.target?.answered ? '本题已作答' : '本题仅展示，不会提交';
    parent.appendChild(card);
    return card;
  }

  const submitLabel = task.target.submitLabel || (isQuiz ? '暂存' : '提交');
  const btn = document.createElement('button');
  btn.className = 'ykt-tool-submit';
  btn.textContent = autoSubmit ? '自动提交中…' : submitLabel;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'ykt-tool-secondary';
  copyBtn.textContent = '复制答案';
  copyBtn.addEventListener('click', copy);
  if (!autoSubmit) bar.appendChild(copyBtn);
  bar.appendChild(btn);

  const retryBtn = canRetry ? document.createElement('button') : null;
  if (retryBtn) {
    retryBtn.className = 'ykt-tool-retry';
    retryBtn.textContent = '补交';
    bar.appendChild(retryBtn);
  }

  parent.appendChild(card);

  let busy = false;

  const setBusy = (on, mode = 'submit') => {
    copyBtn.disabled = on;
    btn.disabled = on;
    if (retryBtn) retryBtn.disabled = on;
    if (on) {
      if (mode === 'retry') retryBtn.textContent = '补交中…';
      else btn.textContent = autoSubmit ? '自动提交中…' : (isQuiz ? '暂存中…' : '提交中…');
    } else {
      btn.textContent = submitLabel;
      if (retryBtn) retryBtn.textContent = '补交';
    }
  };

  const doSubmit = async ({ forceRetry = false, viaRetry = false } = {}) => {
    if (busy) return null;
    let finalForceRetry = !!forceRetry;

    if (!autoSubmit && !isQuiz && !viaRetry) {
      const ok = await confirmDialog(`确认提交答案：${toDisplayAnswer(answer)}？`, { okText: '提交' });
      if (!ok) return null;
      const st = repo.problemStatus.get(String(task.target.problemId));
      const offset = Number.isFinite(st?.clockOffset) ? st.clockOffset : 0;
      const endTime = Number.isFinite(st?.endTime) ? st.endTime : task.target.endTime;
      if (Number.isFinite(endTime) && (Date.now() + offset) >= endTime) {
        const ok2 = await confirmDialog('这道题已超过截止时间，将以补交方式提交。确定继续吗？', { okText: '补交', danger: true });
        if (!ok2) return null;
        finalForceRetry = true;
      }
    }

    busy = true;
    setBusy(true, viaRetry ? 'retry' : 'submit');
    stEl.textContent = '';
    try {
      const r = await submitAnswerTask(task, answer, { forceRetry: finalForceRetry, runId });
      card.classList.add('done');
      if (r.route === 'cache') {
        stEl.textContent = '✅ 已暂存（未交卷）';
        ui.toast?.('✅ 已暂存，未交卷', 2500);
      } else if (r.route === 'display') {
        stEl.textContent = '本题仅展示，不会提交';
      } else if (r.route === 'retry') {
        stEl.textContent = '✅ 补交成功（可再次补交，后一次覆盖前一次）';
        ui.toast?.('✅ 补交成功', 2500);
      } else {
        stEl.textContent = '✅ 提交成功';
        ui.toast?.('✅ 提交成功', 2500);
      }
      onSubmitted?.(r);
      return r;
    } catch (e) {
      stEl.textContent = `❌ ${viaRetry ? '补交' : (isQuiz ? '暂存' : '提交')}失败：${e?.message || e}`;
      return null;
    } finally {
      busy = false;
      setBusy(false);
    }
  };

  btn.addEventListener('click', () => doSubmit());
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(
        '将以补交方式提交（服务端会记录补交标记）。确定继续吗？',
        { okText: '确认补交', danger: true },
      );
      if (!ok) return;
      await doSubmit({ forceRetry: true, viaRetry: true });
    });
  }
  if (autoSubmit) card.__submitPromise = doSubmit();
  return card;
}
