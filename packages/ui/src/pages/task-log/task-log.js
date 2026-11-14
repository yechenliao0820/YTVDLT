/**
 * task-log.js — M4-5 任务日志页（零依赖静态页）。
 *
 * 渲染 `window.__YTVDLT_TASK__` = {id, state, percent, lines[]}；每行一个
 * `<span class="ln" data-line="n">`，便于虚拟滚动与「复制日志」逐行取用。
 * 按钮只产出动作 JSON（copy / cancel / retry），不直接操作进程：
 * 真正的取消/重试由主进程经 IPC 执行。「复制日志」自 D-173 起也走 IPC：
 * 剪贴板由主进程写入（`ytvdlt:clipboard:write`），失败时给出可见反馈。
 */
(function (global) {
  'use strict';
  var doc = global.document;

  var SAMPLE = {
    id: 't1',
    state: 'Running',
    percent: 42,
    lines: [
      '[00:00:01] [info] 开始解析 https://example.org/v',
      '[00:00:02] [download] Destination: C:/V/fixture.mp4',
      '[00:00:03] [download]  42.0% of 10.00MiB at 1.20MiB/s ETA 00:05',
      '[00:00:04] [info] 校验产物 C1–C12'
    ]
  };

  function param(name, fallback) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? fallback : decodeURIComponent(match[1]);
  }

  function task() {
    var injected = global.__YTVDLT_TASK__;
    if (injected && Array.isArray(injected.lines)) return injected;
    return SAMPLE;
  }

  function renderLines(host, lines) {
    host.textContent = '';
    lines.forEach(function (line, index) {
      var span = doc.createElement('span');
      span.className = 'ln';
      span.setAttribute('data-line', String(index + 1));
      span.textContent = line;
      host.appendChild(span);
    });
    host.setAttribute('data-line-count', String(lines.length));
  }

  function emit(action, payload) {
    var output = doc.getElementById('ytvdlt-output');
    output.textContent = JSON.stringify({ action: action, taskId: payload.taskId, accepted: action !== 'copy' }, null, 2);
  }

  function t(key) {
    var i18n = global.YTVDLT && global.YTVDLT.i18n;
    return i18n ? i18n.t(key) : key;
  }

  /** D-173: copy failure feedback — the same output pre `emit()` already uses. */
  function copyFailed() {
    var output = doc.getElementById('ytvdlt-output');
    if (output === null) return;
    output.textContent = t('log.copy.failed');
  }

  /**
   * D-173: the clipboard is written by the MAIN process
   * (`ytvdlt:clipboard:write`). Since D-170 the packaged app denies every
   * renderer permission — including the `clipboard-sanitized-write` check
   * behind `navigator.clipboard` — so the old renderer-side write silently
   * failed. The wire string is called directly (the settings.js pattern: this
   * page does not load ipc-bridge.js, but the channel is registered in all
   * three §5 cable tables).
   */
  function copyLog(text, model) {
    var bridge = global.ytvdltBridge;
    if (bridge && typeof bridge.invoke === 'function') {
      try {
        var pending = bridge.invoke('ytvdlt:clipboard:write', { text: text });
        if (pending && typeof pending.then === 'function') {
          pending.then(function (result) {
            if (result && result.ok === true) emit('copy', model);
            else copyFailed();
          }, function () { copyFailed(); });
        } else {
          copyFailed();
        }
      } catch (error) {
        copyFailed();
      }
      return;
    }
    // Static preview (no preload bridge): a plain browser clipboard still works.
    if (global.navigator && global.navigator.clipboard) {
      try {
        var written = global.navigator.clipboard.writeText(text);
        if (written && typeof written.then === 'function') {
          written.then(function () { emit('copy', model); }, function () { copyFailed(); });
        } else {
          emit('copy', model);
        }
      } catch (error) {
        copyFailed();
      }
      return;
    }
    copyFailed();
  }

  var model = task();
  var lines = model.lines;
  var filter = param('grep', '');
  // M5-3: unified empty / error states (same shape as the queue page).
  var emptyMode = param('empty', '0') === '1';
  var errorMode = param('error', '0') === '1';
  if (filter.length > 0) {
    lines = lines.filter(function (line) { return line.indexOf(filter) !== -1; });
  }

  doc.getElementById('log-title').textContent = '任务日志 · ' + model.id;
  doc.getElementById('log-state').textContent = model.state + (typeof model.percent === 'number' ? ' · ' + model.percent + '%' : '');
  doc.getElementById('ytvdlt-task-log').setAttribute('data-state', model.state.toLowerCase());
  renderLines(doc.getElementById('log-lines'), lines);

  var retry = doc.getElementById('log-retry');
  var retryable = model.state === 'Error' || model.state === 'Canceled';
  retry.setAttribute('aria-disabled', retryable ? 'false' : 'true');

  ['copy', 'cancel', 'retry'].forEach(function (action) {
    var button = doc.getElementById('log-' + action);
    if (button === null) return;
    button.addEventListener('click', function () {
      if (action === 'retry' && !retryable) return;
      if (action === 'copy') {
        copyLog(lines.join('\n'), model);
        return;
      }
      emit(action, model);
    });
  });

  // M5-3: empty / error states win over the task-state label (applied last).
  var root = doc.getElementById('ytvdlt-task-log');
  if (root !== null && (emptyMode || errorMode)) {
    root.setAttribute('data-state', errorMode ? 'error' : 'empty');
    root.setAttribute('data-line-count', '0');
  }
  var emptyBox = doc.getElementById('log-empty');
  var errorBox = doc.getElementById('log-error');
  var linesBox = doc.getElementById('log-lines');
  if (emptyBox !== null) emptyBox.setAttribute('hidden', emptyMode && !errorMode ? 'false' : 'true');
  if (errorBox !== null) errorBox.setAttribute('hidden', errorMode ? 'false' : 'true');
  if (linesBox !== null) linesBox.setAttribute('hidden', emptyMode || errorMode ? 'true' : 'false');

  global.YTVDLTLog = { task: task };
})(typeof window === 'undefined' ? this : window);
