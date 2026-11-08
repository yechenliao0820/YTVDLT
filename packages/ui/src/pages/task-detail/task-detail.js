/**
 * task-detail.js — M4-6 任务详情页（零依赖静态页）。
 *
 * 七个操作按钮与 `TaskDetailAction` 一一对应：
 *   open-file / open-folder / copy-url / copy-error-report / cancel / remove / retry
 *
 * 页面只产出动作 JSON，真正的执行在主进程（`TaskDetailService`）——这样
 * UI 永远不直接碰 `node:fs` / `child_process` / `electron`。
 */
(function (global) {
  'use strict';
  var doc = global.document;

  var SAMPLE = {
    id: 't1',
    state: 'Error',
    percent: 42,
    errorCode: 'HTTP_403',
    artifacts: ['C:/V/fixture.mp4'],
    url: 'https://example.org/v?token=***'
  };

  var ACTIONS = ['open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry'];

  function param(name, fallback) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? fallback : decodeURIComponent(match[1]);
  }

  function task() {
    var injected = global.__YTVDLT_TASK__;
    if (injected && typeof injected.id === 'string') return injected;
    return SAMPLE;
  }

  /** Which buttons are usable for a given task (mirrors the service rules). */
  function availability(model) {
    var running = model.state === 'Running' || model.state === 'FetchingInfo';
    var retryable = model.state === 'Error' || model.state === 'Canceled';
    return {
      'open-file': Array.isArray(model.artifacts) && model.artifacts.length > 0,
      'open-folder': Array.isArray(model.artifacts) && model.artifacts.length > 0,
      'copy-url': true,
      'copy-error-report': typeof model.errorCode === 'string' && model.errorCode.length > 0,
      cancel: model.state === 'Running' || model.state === 'ReadyWithInfo' || model.state === 'FetchingInfo',
      remove: !running,
      retry: retryable
    };
  }

  function emit(action, model) {
    doc.getElementById('ytvdlt-output').textContent = JSON.stringify({
      action: action,
      taskId: model.id,
      accepted: availability(model)[action] === true
    }, null, 2);
  }

  // D-76: real mode. The page used to render a fixture record and only write
  // `{action, taskId}` into a <pre>; with the preload bridge present it now
  // loads `TASK_DETAIL` for ?taskId= and executes the seven actions through
  // `TASK_ACTION`. The file:// screenshot path keeps the fixture rendering.
  var bridge = global.ytvdltBridge && typeof global.ytvdltBridge.invoke === 'function'
    ? global.ytvdltBridge : null;
  var wanted = param('taskId', '');
  var live = bridge !== null && wanted !== '';
  // D-77: the preload whitelists wire strings, not the symbolic names.
  var CABLE = { TASK_DETAIL: 'ytvdlt:task:detail', TASK_ACTION: 'ytvdlt:task:action' };

  function invoke(channel, payload) {
    if (bridge === null) return Promise.resolve({ ok: false, message: '桥接不可用' });
    try {
      return Promise.resolve(bridge.invoke(CABLE[channel] || channel, payload || {})).catch(function (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) };
      });
    } catch (error) {
      return Promise.resolve({ ok: false, message: String(error) });
    }
  }

  var current = { model: task(), enabled: {} };

  function paint(model) {
    current.model = model;
    current.enabled = availability(model);
    doc.getElementById('detail-id').textContent = model.id;
    doc.getElementById('detail-state').textContent = model.state;
    doc.getElementById('detail-progress').textContent = typeof model.percent === 'number' ? model.percent + '%' : '—';
    doc.getElementById('detail-code').textContent = model.errorCode || '—';
    doc.getElementById('detail-artifacts').textContent = (model.artifacts || []).join('\n') || '—';
    doc.getElementById('detail-url').textContent = model.url;
    doc.getElementById('ytvdlt-task-detail').setAttribute('data-state', String(model.state).toLowerCase());
    ACTIONS.forEach(function (action) {
      var node = doc.querySelector('[data-action="' + action + '"]');
      if (node === null) return;
      node.setAttribute('aria-disabled', availability(model)[action] ? 'false' : 'true');
    });
  }

  function showMissing(show) {
    var rootNode = doc.getElementById('ytvdlt-task-detail');
    var body = doc.getElementById('detail-body');
    var actionsBox = doc.getElementById('detail-actions');
    var emptyBox = doc.getElementById('detail-empty');
    if (show) {
      if (rootNode) rootNode.setAttribute('data-state', 'empty');
      if (body) body.setAttribute('hidden', 'true');
      if (actionsBox) actionsBox.setAttribute('hidden', 'true');
      if (emptyBox) emptyBox.setAttribute('hidden', 'false');
      return;
    }
    if (body) body.setAttribute('hidden', 'false');
    if (actionsBox) actionsBox.setAttribute('hidden', 'false');
    if (emptyBox) emptyBox.setAttribute('hidden', 'true');
    if (rootNode) rootNode.setAttribute('data-state', String(current.model.state).toLowerCase());
  }

  function load(taskId) {
    invoke('TASK_DETAIL', { taskId: taskId }).then(function (result) {
      if (!result || result.found !== true || !result.task) { showMissing(true); return; }
      showMissing(false);
      paint(result.task);
    });
  }

  function runAction(action, withFiles) {
    var output = doc.getElementById('ytvdlt-output');
    var payload = { taskId: current.model.id, action: action };
    // D-87: `withFiles` is interpreted by the main process, which moves the
    // task's artifacts to the OS Recycle Bin before dropping the record.
    if (withFiles === true) payload.withFiles = true;
    invoke('TASK_ACTION', payload).then(function (result) {
      var ok = result && result.ok === true;
      output.textContent = ok
        ? '已执行：' + action + (result && result.clipboardText ? '（已复制到剪贴板）' : '')
        : '「' + action + '」未执行：' + ((result && (result.message || result.code)) || '未知原因');
      if (!ok) return;
      if (action === 'remove') { global.location.href = '../queue/index.html'; return; }
      load(current.model.id);
    });
  }

  /**
   * D-80: the detail page had no way back — opening it from the queue made the
   * window un-navigable (no menu, no history control). The link is injected in
   * live mode only, so the file:// screenshot baselines keep their exact DOM.
   */
  function installBackLink() {
    var host = doc.getElementById('ytvdlt-task-detail');
    if (host === null || doc.getElementById('detail-back') !== null) return;
    var back = doc.createElement('button');
    back.id = 'detail-back';
    back.type = 'button';
    back.setAttribute('data-action', 'back');
    back.textContent = '← 返回队列';
    back.style.cssText = [
      'margin:0 0 12px', 'padding:6px 12px', 'font-size:13px', 'cursor:pointer',
      'border:1px solid #d1d5db', 'border-radius:6px', 'background:#ffffff', 'color:#111827',
    ].join(';');
    back.addEventListener('click', function () {
      if (global.history && global.history.length > 1) { global.history.back(); return; }
      global.location.href = '../queue/index.html';
    });
    host.insertBefore(back, host.firstChild);
  }

  /**
   * D-87: the old "删除" button removed the record without saying whether the
   * downloaded file stays. The confirmation is injected in live mode ONLY, so
   * the file:// screenshot baselines keep their exact DOM (same technique as
   * installBackLink, D-80).
   */
  function tt(key) {
    return global.YTVDLT && global.YTVDLT.i18n ? global.YTVDLT.i18n.t(key) : key;
  }

  function setModalHidden(node, hidden) {
    if (node !== null) node.setAttribute('hidden', hidden ? 'true' : 'false');
  }

  function buildRemoveDialog() {
    var wrap = doc.createElement('div');
    wrap.id = 'detail-remove-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:80', 'display:flex',
      'align-items:center', 'justify-content:center',
      'background:rgba(12,22,34,.48)', 'padding:20px'
    ].join(';');
    var box = doc.createElement('div');
    box.style.cssText = [
      'width:min(440px,100%)', 'padding:20px 22px', 'border-radius:12px',
      'background:var(--panel,#fff)', 'color:var(--ink,#111827)',
      'border:1px solid var(--line,#d5dde5)', 'box-shadow:0 20px 60px rgba(10,20,32,.32)'
    ].join(';');
    var heading = doc.createElement('h2');
    heading.style.cssText = 'margin:0 0 8px;font-size:17px;';
    heading.textContent = tt('queue.delete.title');
    var message = doc.createElement('p');
    message.style.cssText = 'margin:0 0 10px;font-size:13px;line-height:1.6;color:var(--muted,#5c6b7a);';
    message.textContent = tt('queue.delete.message');
    var note = doc.createElement('p');
    note.style.cssText = 'margin:0 0 16px;padding:8px 10px;font-size:11px;border-radius:6px;background:var(--accent-soft,#e5f0ff);';
    note.textContent = tt('queue.delete.filesHint');
    var actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    var make = function (label, style, handler) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'height:32px;padding:0 14px;font-size:12px;border-radius:6px;cursor:pointer;' + style;
      button.addEventListener('click', handler);
      actions.appendChild(button);
      return button;
    };
    var base = 'border:1px solid var(--line,#d5dde5);background:var(--panel,#fff);color:var(--ink,#111827);';
    make(tt('queue.delete.cancel'), base, function () { setModalHidden(wrap, true); });
    make(tt('queue.delete.onlyHistory'),
      'border:1px solid var(--accent,#1d63b8);background:var(--accent,#1d63b8);color:#ffffff;font-weight:700;',
      function () { setModalHidden(wrap, true); runAction('remove'); });
    make(tt('queue.delete.withFiles'),
      'border:1px solid var(--danger,#b1283a);background:var(--danger,#b1283a);color:#ffffff;font-weight:700;',
      function () { setModalHidden(wrap, true); runAction('remove', true); });
    box.appendChild(heading);
    box.appendChild(message);
    box.appendChild(note);
    box.appendChild(actions);
    wrap.appendChild(box);
    setModalHidden(wrap, true);
    wrap.addEventListener('click', function (event) {
      if (event && event.target === wrap) setModalHidden(wrap, true);
    });
    doc.body.appendChild(wrap);
    return wrap;
  }

  function openRemoveDialog() {
    var modal = doc.getElementById('detail-remove-modal');
    if (modal === null) modal = buildRemoveDialog();
    setModalHidden(modal, false);
  }

  paint(current.model);

  ACTIONS.forEach(function (action) {
    var button = doc.querySelector('[data-action="' + action + '"]');
    if (button === null) return;
    button.addEventListener('click', function () {
      if (!current.enabled[action]) return;
      if (live) {
        if (action === 'remove') { openRemoveDialog(); return; }
        runAction(action);
        return;
      }
      emit(action, current.model);
    });
  });

  // Applied last: the missing-task state must win over the record's own state.
  var missing = param('empty', '0') === '1';
  if (missing) showMissing(true);
  else if (live) load(wanted);
  if (live) installBackLink();

  global.YTVDLTDetail = { availability: availability, actions: ACTIONS, live: live, current: current };
})(typeof window === 'undefined' ? this : window);
