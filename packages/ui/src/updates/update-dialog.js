/**
 * update-dialog.js — "发现新版本" 弹窗（0.2.1, D-93）。
 *
 * Loaded by BOTH the queue page and the settings page (like `about.js`), because
 * the startup check can finish while either page is on screen. No bundler, no
 * imports, no `innerHTML` for remote text: the release notes come from a JSON
 * document and are therefore rendered with `textContent` only.
 *
 * State comes from the main process (`ytvdlt:appUpdate:status`), which is a
 * pure in-memory read — polling it costs nothing and keeps this file free of
 * any "download progress" bookkeeping of its own.
 */
(function (global) {
  'use strict';
  var doc = global.document;
  var CH_STATUS = 'ytvdlt:appUpdate:status';
  var CH_ACTION = 'ytvdlt:appUpdate:action';
  var DISMISS_KEY = 'ytvdlt.update.dismissed';
  var POLL_MS = 4000;

  var state = null;
  var nodes = null;
  var busy = false;
  var downloadPending = false;
  var cancelling = false;
  var actionVersion = 0;

  function t(key, params) {
    return global.YTVDLT && global.YTVDLT.i18n ? global.YTVDLT.i18n.t(key, params) : key;
  }

  function bridge() {
    var candidate = global.ytvdltBridge;
    return candidate && typeof candidate.invoke === 'function' ? candidate : null;
  }

  function readSession(key) {
    try { return global.sessionStorage ? global.sessionStorage.getItem(key) : null; } catch (error) { return null; }
  }
  function writeSession(key, value) {
    try { if (global.sessionStorage) global.sessionStorage.setItem(key, value); } catch (error) { /* file:// */ }
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var value = bytes;
    var index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    var digits = value >= 100 || index === 0 ? 0 : 1;
    return value.toFixed(digits) + ' ' + units[index];
  }

  function el(tag, style, text) {
    var node = doc.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  var LOGO = '<svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true" focusable="false">'
    + '<defs><linearGradient id="updGrad" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#3b8cf0"/><stop offset="1" stop-color="#174ea6"/>'
    + '</linearGradient></defs>'
    + '<rect x="0" y="0" width="40" height="40" rx="11" fill="url(#updGrad)"/>'
    + '<path d="M15.5 11.5 L27.5 19 L15.5 26.5 Z" fill="#ffffff"/>'
    + '<path d="M20 28.5 L20 34 M16.5 31.2 L20 34.7 L23.5 31.2" stroke="#ffffff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

  function build() {
    var backdrop = el('div', [
      'position:fixed', 'inset:0', 'z-index:95', 'display:flex',
      'align-items:center', 'justify-content:center',
      'background:rgba(12,22,34,.52)', 'padding:20px'
    ].join(';'));
    backdrop.id = 'ytvdlt-update';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('hidden', 'true');

    var box = el('div', [
      'width:min(520px,100%)', 'max-height:min(84vh,680px)', 'display:flex', 'flex-direction:column',
      'padding:18px 20px', 'border-radius:14px',
      'background:var(--panel,#fff)', 'color:var(--ink,#1b2430)',
      'border:1px solid var(--line,#d5dde5)',
      'box-shadow:0 24px 70px rgba(10,20,32,.34)', 'font-family:inherit'
    ].join(';'));

    var head = el('div', 'display:flex;align-items:center;gap:11px;margin-bottom:12px;');
    var mark = el('span', 'display:flex;flex:0 0 auto;');
    mark.innerHTML = LOGO;
    head.appendChild(mark);
    var names = el('div', 'display:flex;flex-direction:column;gap:2px;line-height:1.3;min-width:0;');
    var title = el('strong', 'font-size:16px;letter-spacing:.02em;', t('update.title'));
    title.id = 'ytvdlt-update-title';
    var sub = el('span', 'font-size:12px;color:var(--muted,#5c6b7a);', '');
    sub.id = 'ytvdlt-update-sub';
    names.appendChild(title);
    names.appendChild(sub);
    head.appendChild(names);
    box.appendChild(head);

    var notesTitle = el('div', 'font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted,#5c6b7a);margin:0 0 5px;', t('update.notes'));
    box.appendChild(notesTitle);
    var notes = el('pre', [
      'margin:0 0 12px', 'padding:10px 12px', 'border-radius:8px',
      'background:var(--accent-soft,#eef3fa)', 'color:var(--ink,#1b2430)',
      'font-family:inherit', 'font-size:12.5px', 'line-height:1.7',
      'white-space:pre-wrap', 'word-break:break-word',
      'max-height:240px', 'overflow-y:auto', 'overflow-x:hidden', 'flex:0 1 auto'
    ].join(';'), '');
    notes.id = 'ytvdlt-update-notes';
    box.appendChild(notes);

    var progress = el('div', 'display:flex;flex-direction:column;gap:4px;margin:0 0 10px;');
    progress.id = 'ytvdlt-update-progress';
    progress.setAttribute('hidden', 'true');
    var track = el('div', 'height:6px;border-radius:3px;background:var(--line,#d5dde5);overflow:hidden;');
    var fill = el('i', 'display:block;height:6px;width:0;background:var(--accent,#1d63b8);transition:width .2s;');
    fill.id = 'ytvdlt-update-bar';
    track.appendChild(fill);
    var progressText = el('span', 'font-size:11px;color:var(--muted,#5c6b7a);font-variant-numeric:tabular-nums;', '');
    progressText.id = 'ytvdlt-update-progress-text';
    progress.appendChild(track);
    progress.appendChild(progressText);
    box.appendChild(progress);

    var hint = el('p', 'margin:0 0 12px;font-size:12px;line-height:1.6;color:var(--muted,#5c6b7a);', '');
    hint.id = 'ytvdlt-update-hint';
    box.appendChild(hint);

    var actions = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;');
    var buttonStyle = [
      'height:32px', 'padding:0 13px', 'font-size:12px', 'font-family:inherit',
      'border-radius:6px', 'cursor:pointer', 'white-space:nowrap',
      'border:1px solid var(--line,#d5dde5)', 'background:var(--panel,#fff)', 'color:var(--ink,#1b2430)'
    ].join(';');
    var primaryStyle = buttonStyle
      + ';background:var(--accent,#1d63b8);border-color:var(--accent,#1d63b8);color:#ffffff;font-weight:700';

    // "Don't remind me about this version" is a preference, not an action: a
    // checkbox keeps the button row to three items (English labels otherwise
    // wrap the primary action onto a second line).
    var skipLabel = el('label', [
      'display:inline-flex', 'align-items:center', 'gap:6px', 'flex:0 0 auto',
      'font-size:12px', 'color:var(--muted,#5c6b7a)', 'cursor:pointer', 'margin:0 0 8px'
    ].join(';'));
    var skipBox = doc.createElement('input');
    skipBox.type = 'checkbox';
    skipBox.id = 'ytvdlt-update-skip';
    skipBox.style.cssText = 'accent-color:var(--accent,#1d63b8);margin:0;';
    skipLabel.appendChild(skipBox);
    skipLabel.appendChild(el('span', null, t('update.skip')));
    box.appendChild(skipLabel);

    var spacer = el('span', 'flex:1 1 auto;');

    var page = el('button', buttonStyle, t('update.page'));
    page.type = 'button';
    page.id = 'ytvdlt-update-page';
    page.addEventListener('click', function () { act('open-page', false); });

    var later = el('button', buttonStyle, t('update.later'));
    later.type = 'button';
    later.id = 'ytvdlt-update-later';
    later.addEventListener('click', function () {
      // A checked box means "never again for THIS version"; otherwise the
      // suppression only lasts until the next launch (sessionStorage).
      if (skipBox.checked) { act('skip-version', true); return; }
      rememberSessionDismiss();
      hide();
    });

    var primary = el('button', primaryStyle, t('update.download'));
    primary.type = 'button';
    primary.id = 'ytvdlt-update-primary';
    primary.addEventListener('click', function () {
      if (downloadPending || (state !== null && state.phase === 'downloading')) { act('cancel-download', false); return; }
      if (state !== null && state.phase === 'ready') { act('install', false); return; }
      act('download', false);
    });

    actions.appendChild(spacer);
    actions.appendChild(page);
    actions.appendChild(later);
    actions.appendChild(primary);
    box.appendChild(actions);

    backdrop.appendChild(box);
    backdrop.addEventListener('click', function (event) {
      if (event && event.target === backdrop) {
        if (skipBox.checked) { act('skip-version', true); return; }
        rememberSessionDismiss();
        hide();
      }
    });
    doc.body.appendChild(backdrop);

    return {
      backdrop: backdrop, sub: sub, notes: notes, progress: progress,
      bar: fill, progressText: progressText, hint: hint,
      primary: primary, page: page, skip: skipBox
    };
  }

  function rememberSessionDismiss() {
    if (state !== null && state.latest !== null) {
      writeSession(DISMISS_KEY, String(state.latest.version));
    }
  }

  function hide() {
    if (nodes === null) return;
    // Inline `display` as well as the attribute: the dialog also runs on pages
    // whose stylesheet has no `[hidden="true"]` rule, and an inline
    // `display:flex` would otherwise beat the UA `[hidden]` style.
    nodes.backdrop.style.display = 'none';
    nodes.backdrop.setAttribute('hidden', 'true');
  }

  function show() {
    if (nodes === null) nodes = build();
    nodes.backdrop.style.display = 'flex';
    nodes.backdrop.setAttribute('hidden', 'false');
  }

  function paint() {
    if (nodes === null || state === null) return;
    var latest = state.latest;
    if (latest === null) { hide(); return; }

    nodes.sub.textContent = t('update.subtitle', {
      version: latest.version,
      current: state.currentVersion
    });
    nodes.notes.textContent = latest.notes !== '' ? latest.notes : t('update.notes.empty');

    var downloading = state.phase === 'downloading' || downloadPending;
    var ready = state.phase === 'ready';
    var showProgress = downloading || ready;
    nodes.progress.style.display = showProgress ? 'flex' : 'none';
    nodes.progress.setAttribute('hidden', showProgress ? 'false' : 'true');
    if (showProgress) {
      var totalBytes = state.totalBytes;
      var downloaded = state.downloadedBytes;
      var percent = totalBytes !== null && totalBytes > 0
        ? Math.max(0, Math.min(100, (downloaded / totalBytes) * 100))
        : 0;
      nodes.bar.style.width = percent.toFixed(1) + '%';
      nodes.progressText.textContent = t('update.downloading', {
        done: formatBytes(downloaded),
        total: totalBytes === null ? '—' : formatBytes(totalBytes)
      }) + ' · ' + percent.toFixed(1) + '%';
    }

    if (state.phase === 'error') {
      nodes.hint.textContent = t('update.error', { reason: state.message || '—' });
      nodes.hint.style.color = 'var(--danger,#b4232f)';
    } else if (ready) {
      nodes.hint.textContent = t('update.ready');
      nodes.hint.style.color = 'var(--muted,#5c6b7a)';
    } else if (!state.canAutoInstall) {
      nodes.hint.textContent = t('update.manual');
      nodes.hint.style.color = 'var(--muted,#5c6b7a)';
    } else {
      nodes.hint.textContent = '';
    }

    nodes.primary.textContent = downloading ? t(cancelling ? 'update.cancelling' : 'update.cancelDownload') : (ready ? t('update.install') : t('update.download'));
    nodes.primary.disabled = downloading ? cancelling : (busy || (!state.canAutoInstall && !ready));
    nodes.page.disabled = busy;
    nodes.skip.disabled = busy;
  }

  function apply(next) {
    if (next === null || typeof next !== 'object') return;
    var previous = state;
    state = next;
    var latest = next.latest;
    if (latest === null) { hide(); return; }

    var dismissed = readSession(DISMISS_KEY);
    var skipped = typeof next.skippedVersion === 'string' ? next.skippedVersion : '';
    var suppressed = (dismissed !== null && dismissed === latest.version) || skipped === latest.version;

    // `checking` keeps an open dialog open (e.g. a manual re-check); it must not
    // pop a NEW dialog, and it must not close one the user is reading.
    var visible = nodes !== null && nodes.backdrop.getAttribute('hidden') === 'false';
    if (next.phase === 'available' && !suppressed && !visible) {
      show();
      paint();
      return;
    }
    if (next.phase === 'available' || next.phase === 'downloading' || next.phase === 'ready'
      || next.phase === 'error') {
      if (visible) paint();
      return;
    }
    // idle / checking with no dialog open: nothing to do.
    if (visible && (next.phase === 'idle' || next.phase === 'checking')) {
      if (previous !== null && previous.phase === 'available') hide();
    }
  }

  function act(action, closeAfter) {
    var api = bridge();
    if (api === null) return;
    if (action === 'cancel-download' && cancelling) return;
    var version = ++actionVersion;
    if (action === 'download') downloadPending = true;
    if (action === 'cancel-download') cancelling = true;
    busy = true;
    paint();
    var pending;
    try {
      pending = api.invoke(CH_ACTION, { action: action });
    } catch (error) {
      if (version !== actionVersion) return;
      downloadPending = false;
      cancelling = false;
      busy = false;
      paint();
      return;
    }
    Promise.resolve(pending).then(function (result) {
      if (version !== actionVersion) return;
      if (action === 'cancel-download') actionVersion += 1;
      downloadPending = false;
      cancelling = false;
      busy = false;
      if (result && result.state) apply(result.state);
      else paint();
      if (closeAfter) hide();
    }).catch(function () {
      if (version !== actionVersion) return;
      downloadPending = false;
      cancelling = false;
      busy = false;
      paint();
    });
  }

  function poll() {
    var api = bridge();
    if (api === null) return;
    var pending;
    try { pending = api.invoke(CH_STATUS, {}); } catch (error) { return; }
    var version = actionVersion;
    Promise.resolve(pending).then(function (next) { if (version === actionVersion && !cancelling) apply(next); }).catch(function () { /* offline */ });
  }

  function attach() {
    if (bridge() === null) return;
    // Give the startup check a head start, then poll at a human pace.
    setTimeout(function () {
      poll();
      setInterval(function () {
        if (doc.visibilityState === 'hidden') return;
        poll();
      }, POLL_MS);
    }, 1500);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') poll();
    });
  }

  global.YTVDLTUpdateDialog = {
    attach: attach,
    /** For tests / screenshots: force a state without a main process. */
    __apply: apply
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
})(typeof window === 'undefined' ? this : window);
