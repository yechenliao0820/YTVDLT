/**
 * txt-import.js — "导入 TXT / Import TXT" entry + confirmation dialog.
 *
 * Zero dependencies, no `electron`, no `node:*`: it talks to the main process
 * only through the queue page's `call()` (preload whitelist). Like the
 * subtitle picker, this component is loaded at runtime ONLY in live mode (a
 * preload bridge exists), so the frozen static screenshot baselines see zero
 * extra DOM nodes.
 *
 * Flow: pick (main process opens the native .txt dialog, reads and parses) →
 * PREVIEW with real counts → user confirms → enqueue by opaque importId.
 * Nothing is downloaded until the confirm button is pressed.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});

  function create(options) {
    var doc = options.doc;
    var t = options.t;
    var call = options.call;
    var notify = options.notify;
    var getChoice = options.getChoice;
    var refresh = options.refresh;

    var entry = null;
    var overlay = null;
    var preview = null;
    var busy = false;
    // T5: true while the enqueue round-trip (and its in-flight pre-check) runs.
    var enqueueInFlight = false;
    /**
     * D-160: this submission's opaque cancellation scope. Cancel, progress and
     * the enqueue payload all carry the SAME id, so another live dialog's stop
     * button cannot abort this batch (or vice versa).
     */
    var activeOperationId = '';
    function newOperationId() {
      return 'txt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    // T5: the in-precheck wait row + its STATUS poll. `pollMs` is injectable so
    // tests do not need real 500 ms waits.
    var pollMs = typeof options.pollMs === 'number' && options.pollMs > 0 ? options.pollMs : 500;
    var wait = null;

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function label(key, params, className) {
      var node = el('span', className || '', t(key, params));
      node.setAttribute('data-i18n', key);
      return node;
    }

    /** T5: tear down the wait row and its poll timer. Idempotent. */
    function removeWait() {
      if (wait === null) return;
      if (wait.timer !== null) clearInterval(wait.timer);
      if (wait.row.parentNode !== null) wait.row.parentNode.removeChild(wait.row);
      wait = null;
    }

    /**
     * T5: the "pre-check in progress" row with a cancel button and a
     * checked/total readout. The readout POLLS `URL_SUPPORT_CHECK_STATUS`
     * instead of listening to a push channel on purpose: this IPC surface is
     * invoke/response and the project's progress pattern is polled reads
     * (APP_UPDATE_STATUS, §5 rule 6). Termination is explicit on every path —
     * `active !== true` stops the interval, and the enqueue reply (which always
     * resolves) calls `removeWait()`.
     */
    function showWait() {
      removeWait();
      if (overlay === null) return;
      var foot = overlay.querySelector('#txt-import-foot');
      if (foot === null) return;
      var row = el('div', 'txt-import-wait');
      row.setAttribute('id', 'txt-import-wait');
      var progress = el('span', 'txt-import-wait-progress', t('queue.precheck.checking'));
      progress.setAttribute('id', 'txt-import-wait-progress');
      var stop = el('button', 'txt-import-btn', t('queue.precheck.cancel'));
      stop.setAttribute('type', 'button');
      stop.setAttribute('id', 'txt-import-cancel-precheck');
      stop.addEventListener('click', function () {
        stop.setAttribute('disabled', 'disabled');
        progress.textContent = t('queue.precheck.cancelling');
        call('URL_SUPPORT_CHECK_CANCEL', { operationId: activeOperationId });
      });
      row.appendChild(progress);
      row.appendChild(stop);
      foot.appendChild(row);
      var timer = setInterval(function () {
        call('URL_SUPPORT_CHECK_STATUS', { operationId: activeOperationId }).then(function (status) {
          if (wait === null) return;
          if (!status || status.active !== true) {
            // Batch finished (or the probe is unavailable): stop polling; the
            // enqueue reply will replace this row with the real result.
            clearInterval(timer);
            wait.timer = null;
            return;
          }
          var checked = typeof status.checked === 'number' ? status.checked : 0;
          var total = typeof status.total === 'number' ? status.total : 0;
          if (total > 0) {
            progress.textContent = t('queue.precheck.progress', { checked: checked, total: total });
          }
        });
      }, pollMs);
      wait = { row: row, progress: progress, timer: timer };
    }

    function mount(anchor, cssHref) {
      if (entry !== null || !anchor) return;
      if (anchor.parentNode === null) return;
      var style = doc.createElement('link');
      style.setAttribute('rel', 'stylesheet');
      style.setAttribute('href', cssHref);
      doc.head.appendChild(style);

      entry = doc.createElement('button');
      entry.setAttribute('type', 'button');
      entry.setAttribute('id', 'queue-import-txt');
      entry.setAttribute('data-i18n', 'queue.import.button');
      entry.textContent = t('queue.import.button');
      entry.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        open();
      });
      anchor.parentNode.insertBefore(entry, anchor.nextSibling);
    }

    function close() {
      // T5: closing while the batch pre-check is in flight means "stop" — ask
      // the main process to cancel it (a no-op when nothing is running). The
      // enqueue reply then arrives as the `cancelled` result.
      if (enqueueInFlight) call('URL_SUPPORT_CHECK_CANCEL', { operationId: activeOperationId });
      if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.removeChild(overlay);
      overlay = null;
      preview = null;
      busy = false;
      removeWait();
    }

    function shell() {
      if (overlay !== null) return overlay;
      overlay = el('div', 'txt-import-overlay');
      overlay.setAttribute('id', 'txt-import-dialog');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var box = el('div', 'txt-import-dialog');
      var head = el('div', 'txt-import-head');
      head.appendChild(label('queue.import.title', null, 'txt-import-title'));
      var closeBtn = el('button', 'txt-import-icon', '×');
      closeBtn.setAttribute('type', 'button');
      closeBtn.setAttribute('aria-label', t('common.close'));
      closeBtn.addEventListener('click', function () { close(); });
      head.appendChild(closeBtn);
      box.appendChild(head);
      var body = el('div', 'txt-import-body');
      body.setAttribute('id', 'txt-import-body');
      box.appendChild(body);
      var foot = el('div', 'txt-import-foot');
      foot.setAttribute('id', 'txt-import-foot');
      box.appendChild(foot);
      overlay.appendChild(box);
      doc.body.appendChild(overlay);
      return overlay;
    }

    function message(text, kind) {
      var node = el('p', 'txt-import-message' + (kind ? ' ' + kind : ''), text);
      node.setAttribute('role', 'status');
      return node;
    }

    function errorText(result) {
      if (!result) return t('queue.notify.ipc');
      if (result.message) return String(result.message);
      var code = result.code || 'UNKNOWN';
      var key = 'queue.import.error.' + code;
      var translated = t(key, { code: code });
      return translated === key ? t('queue.import.error.generic', { code: code }) : translated;
    }

    function statRow(name, value, extra) {
      var cell = el('div', 'txt-import-stat' + (extra ? ' ' + extra : ''));
      cell.appendChild(el('span', 'txt-import-stat-value', String(value)));
      cell.appendChild(label(name, null, 'txt-import-stat-label'));
      return cell;
    }

    function renderPreview(result) {
      var root = shell();
      var body = root.querySelector('#txt-import-body');
      var foot = root.querySelector('#txt-import-foot');
      if (body === null || foot === null) return;
      body.textContent = '';
      foot.textContent = '';

      var file = el('div', 'txt-import-file');
      file.appendChild(label('queue.import.fileName', null, 'txt-import-file-label'));
      file.appendChild(el('span', 'txt-import-file-name', result.fileName || '—'));
      body.appendChild(file);

      var grid = el('div', 'txt-import-stats');
      grid.appendChild(statRow('queue.import.totalLines', result.totalLines));
      grid.appendChild(statRow('queue.import.valid', result.validCount, 'ok'));
      grid.appendChild(statRow('queue.import.invalid', result.invalidCount, result.invalidCount > 0 ? 'warn' : ''));
      grid.appendChild(statRow('queue.import.duplicate', result.duplicateCount));
      grid.appendChild(statRow('queue.import.playlist', result.playlistCount, result.playlistCount > 0 ? 'warn' : ''));
      grid.appendChild(statRow('queue.import.blank', result.blankCount));
      body.appendChild(grid);

      if (result.code) {
        body.appendChild(message(errorText({ code: result.code }), 'warn'));
      }
      if (result.playlistCount > 0) {
        body.appendChild(message(t('queue.import.playlistHint'), 'warn'));
      }
      if (result.code === 'TOO_MANY_URLS') {
        body.appendChild(message(t('queue.import.limit', { max: result.maxUrls }), 'warn'));
      }

      var listTitle = label('queue.import.urls', null, 'txt-import-list-title');
      body.appendChild(listTitle);
      var list = el('div', 'txt-import-list');
      list.setAttribute('id', 'txt-import-list');
      var items = Array.isArray(result.items) ? result.items : [];
      if (items.length === 0) {
        list.appendChild(message(t('queue.import.emptyList')));
      }
      items.forEach(function (item) {
        var row = el('div', 'txt-import-row');
        row.setAttribute('data-status', item.status);
        row.appendChild(el('span', 'txt-import-line', String(item.line)));
        var statusKey = {
          valid: 'queue.import.status.valid',
          duplicate: 'queue.import.status.duplicate',
          invalid: 'queue.import.status.invalid',
          playlist: 'queue.import.status.playlist',
          'too-long': 'queue.import.status.tooLong',
          blank: 'queue.import.status.blank'
        }[item.status] || 'queue.import.status.invalid';
        row.appendChild(label(statusKey, null, 'txt-import-badge'));
        var text = el('span', 'txt-import-url', item.text);
        text.setAttribute('title', item.text);
        row.appendChild(text);
        list.appendChild(row);
      });
      body.appendChild(list);

      var cancel = el('button', 'txt-import-btn', t('common.cancel'));
      cancel.setAttribute('type', 'button');
      cancel.setAttribute('id', 'txt-import-cancel');
      cancel.addEventListener('click', function () { close(); });
      foot.appendChild(cancel);

      var confirm = el('button', 'txt-import-btn primary', t('queue.import.confirm'));
      confirm.setAttribute('type', 'button');
      confirm.setAttribute('id', 'txt-import-confirm');
      var canConfirm = result.ok === true && !result.canceled && !!result.importId && !result.code;
      if (!canConfirm) confirm.setAttribute('disabled', 'disabled');
      confirm.addEventListener('click', function () {
        if (busy || !preview || !preview.importId) return;
        enqueue(preview);
      });
      foot.appendChild(confirm);
    }

    /**
     * R1-03: one line per unconfirmed/no-media url, headed by its bucket name.
     * `textContent` only (never innerHTML) — these are user-supplied urls.
     */
    function appendBucket(body, bucketKey, urls) {
      var list = Array.isArray(urls) ? urls : [];
      for (var i = 0; i < list.length; i += 1) {
        body.appendChild(message(t(bucketKey) + ' — ' + String(list[i]), 'warn'));
      }
    }

    function renderResult(result) {
      var root = shell();
      var body = root.querySelector('#txt-import-body');
      var foot = root.querySelector('#txt-import-foot');
      if (body === null || foot === null) return;
      body.textContent = '';
      foot.textContent = '';
      var ok = result && result.ok === true;
      // T5: a cancelled batch is not a failure row — the user said stop and
      // nothing was queued. The tally and any real refusals stay below.
      var cancelled = result !== null && result !== undefined && result.cancelled === true;
      if (cancelled) {
        body.appendChild(message(t('queue.precheck.cancelledBatch'), 'warn'));
      } else {
        body.appendChild(message(t('queue.import.result', {
          requested: result && typeof result.requested === 'number' ? result.requested : 0,
          enqueued: result && typeof result.enqueued === 'number' ? result.enqueued : 0,
          failed: result && typeof result.failed === 'number' ? result.failed : 0
        }), ok ? 'ok' : 'warn'));
      }
      if (!ok && !cancelled) body.appendChild(message(errorText(result), 'warn'));
      // R1-03: the three-way tally FIRST, so the numbers the user is
      // reconciling ("I imported 40") arrive before the per-URL detail. Only the
      // buckets that are NOT already listed as failures appear below: an
      // UNSUPPORTED url is a failure row, a no-media or unconfirmed one is not.
      var precheck = result && result.precheck;
      if (precheck) {
        body.appendChild(message(t('queue.precheck.summary', {
          supported: Number(precheck.supported) || 0,
          unsupported: Number(precheck.unsupported) || 0,
          noMedia: Number(precheck.noMedia) || 0,
          indeterminate: Number(precheck.indeterminate) || 0,
          skipped: Number(precheck.skipped) || 0
        }), 'ok'));
        if ((Number(precheck.skipped) || 0) > 0) {
          body.appendChild(message(t('queue.precheck.skippedNote', {
            skipped: Number(precheck.skipped) || 0
          }), 'warn'));
        }
        appendBucket(body, 'queue.precheck.noMedia', precheck.noMediaUrls);
        appendBucket(body, 'queue.precheck.indeterminate', precheck.indeterminateUrls);
      }
      var failures = result && Array.isArray(result.failures) ? result.failures : [];
      failures.forEach(function (item) {
        body.appendChild(message(String(item.url) + ' — ' + String(item.reason), 'warn'));
      });
      notify(cancelled
        ? t('queue.precheck.cancelledBatch')
        : t('queue.import.result', {
          requested: result && typeof result.requested === 'number' ? result.requested : 0,
          enqueued: result && typeof result.enqueued === 'number' ? result.enqueued : 0,
          failed: result && typeof result.failed === 'number' ? result.failed : 0
        }));
      var done = el('button', 'txt-import-btn primary', t('common.close'));
      done.setAttribute('type', 'button');
      done.addEventListener('click', function () { close(); });
      foot.appendChild(done);
      if (typeof refresh === 'function') refresh();
    }

    function enqueue(current) {
      busy = true;
      var choice = typeof getChoice === 'function' ? getChoice() : { kind: 'video' };
      var payload = { importId: current.importId, kind: choice.kind === 'audio' ? 'audio' : 'video' };
      // D-160: bind this round-trip's pre-check to its own cancellation scope.
      activeOperationId = newOperationId();
      payload.operationId = activeOperationId;
      if (payload.kind === 'audio') {
        if (choice.audioQuality) payload.audioQuality = choice.audioQuality;
        if (choice.audioFormat) payload.audioFormat = choice.audioFormat;
      } else if (choice.videoQuality) {
        payload.quality = choice.videoQuality;
      }
      var button = overlay === null ? null : overlay.querySelector('#txt-import-confirm');
      if (button !== null) button.setAttribute('disabled', 'disabled');
      // T5: the pre-check inside this round-trip is cancellable — show the
      // wait row (progress + cancel) until the reply arrives.
      enqueueInFlight = true;
      showWait();
      call('TXT_IMPORT_ENQUEUE', payload).then(function (result) {
        busy = false;
        enqueueInFlight = false;
        removeWait();
        preview = null;
        renderResult(result);
      });
    }

    function open() {
      if (busy) return;
      busy = true;
      preview = null;
      var root = shell();
      var body = root.querySelector('#txt-import-body');
      var foot = root.querySelector('#txt-import-foot');
      if (body === null || foot === null) { busy = false; return; }
      body.textContent = '';
      foot.textContent = '';
      body.appendChild(message(t('queue.import.picking')));
      call('TXT_IMPORT_PICK', {}).then(function (result) {
        busy = false;
        if (!result || result.ok !== true) {
          body.textContent = '';
          body.appendChild(message(errorText(result), 'warn'));
          var retry = el('button', 'txt-import-btn', t('common.close'));
          retry.setAttribute('type', 'button');
          retry.addEventListener('click', function () { close(); });
          foot.appendChild(retry);
          return;
        }
        if (result.canceled) { close(); return; }
        preview = result;
        renderPreview(result);
      });
    }

    return {
      mount: mount,
      open: open,
      close: close,
      isOpen: function () { return overlay !== null; },
      currentPreview: function () { return preview; }
    };
  }

  YTVDLT.txtImport = { create: create };
})(typeof window === 'undefined' ? this : window);
