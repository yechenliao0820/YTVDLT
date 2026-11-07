/**
 * task-log.js — M4-5 任务日志页（零依赖静态页）。
 *
 * 渲染 `window.__YTVDLT_TASK__` = {id, state, percent, lines[]}；每行一个
 * `<span class="ln" data-line="n">`，便于虚拟滚动与「复制日志」逐行取用。
 * 按钮只产出动作 JSON（copy / cancel / retry），不直接操作进程：
 * 真正的取消/重试由主进程经 IPC 执行。
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
        var text = lines.join('\n');
        if (global.navigator && global.navigator.clipboard) global.navigator.clipboard.writeText(text);
        emit('copy', model);
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
