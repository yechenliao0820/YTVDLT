/**
 * playlist-import.js — live playlist probe → default-select-all → one confirm.
 *
 * Zero dependencies, no `electron`, no `node:*`: it talks to the main process
 * only through the queue page's `call()` (preload whitelist). Like the TXT and
 * subtitle components it is loaded at runtime ONLY in live mode, so the frozen
 * M3 playlist dialog / M4-4 batch page and all 31 screenshot baselines are
 * untouched.
 *
 * The M3 fixture selector (dialogs/playlist-selector.js) is deliberately NOT
 * modified: D-38 pins it to "confirm writes only selectedIds, never enqueue".
 * This component is the PRODUCTION path: it sends (previewId, url, ids) to a
 * main-process ticket, which owns the full PlaylistInfo.
 *
 * A URL that looks like a playlist is auto-detected by `isPlaylistLike()`;
 * the queue page calls `open()` instead of starting a single download. If the
 * probe fails, the user can fall back to a normal single download.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});

  /** Same structural rules as `core::looksLikePlaylistUrl` (no site registry). */
  function isPlaylistLike(raw) {
    var lower = String(raw || '').toLowerCase();
    var at = lower.indexOf('?');
    var path = at === -1 ? lower : lower.slice(0, at);
    var query = at === -1 ? '' : lower.slice(at + 1);
    if (/(?:^|&)list=[^&]+/.test(query)) return true;
    if (/(?:^|&)playlist=[^&]+/.test(query)) return true;
    if (/\/playlists?(?:\/|$)/.test(path)) return true;
    if (/\/sets(?:\/|$)/.test(path)) return true;
    if (/\/(?:channel|user|c)\/[^/]+\/videos(?:\/|$)/.test(path)) return true;
    if (/\/[^/]*videos(?:\/|$)/.test(path) && /\/@/.test(path)) return true;
    return false;
  }

  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (v) { return v < 10 ? '0' + v : String(v); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function create(options) {
    var doc = options.doc;
    var t = options.t;
    var call = options.call;
    var notify = options.notify;
    var getChoice = options.getChoice;
    var refresh = options.refresh;
    var startSingleDownload = options.startSingleDownload;
    var readUrl = options.readUrl;

    var entry = null;
    var overlay = null;
    var preview = null;
    var selected = {};
    var query = '';
    var busy = false;
    var currentUrl = '';
    var currentPreviewId = '';
    var generation = 0;

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

    function mount(anchor, cssHref) {
      if (entry !== null || !anchor || anchor.parentNode === null) return;
      var style = doc.createElement('link');
      style.setAttribute('rel', 'stylesheet');
      style.setAttribute('href', cssHref);
      doc.head.appendChild(style);

      entry = el('button', '', t('queue.playlist.button'));
      entry.setAttribute('type', 'button');
      entry.setAttribute('id', 'queue-import-playlist');
      entry.setAttribute('data-i18n', 'queue.playlist.button');
      entry.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        var url = typeof readUrl === 'function' ? String(readUrl() || '').trim() : '';
        if (url === '') { notify(t('queue.playlist.needUrl')); return; }
        open(url);
      });
      anchor.parentNode.insertBefore(entry, anchor.nextSibling);
    }

    function close() {
      if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.removeChild(overlay);
      overlay = null;
      busy = false;
    }

    /** Cancel must NOT create tasks; it releases the main-process ticket. */
    function cancel() {
      if (currentPreviewId !== '') {
        var id = currentPreviewId;
        currentPreviewId = '';
        call('PLAYLIST_PREVIEW_CANCEL', { previewId: id });
      }
      preview = null;
      selected = {};
      close();
    }

    function shell() {
      if (overlay !== null) return overlay;
      overlay = el('div', 'pl-overlay');
      overlay.setAttribute('id', 'pl-dialog');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var box = el('div', 'pl-dialog');
      var head = el('div', 'pl-head');
      head.appendChild(label('queue.playlist.title', null, 'pl-title'));
      var x = el('button', 'pl-icon', '×');
      x.setAttribute('type', 'button');
      x.setAttribute('id', 'pl-close');
      x.addEventListener('click', function () { cancel(); });
      head.appendChild(x);
      box.appendChild(head);
      var body = el('div', 'pl-body');
      body.setAttribute('id', 'pl-body');
      box.appendChild(body);
      var foot = el('div', 'pl-foot');
      foot.setAttribute('id', 'pl-foot');
      box.appendChild(foot);
      overlay.appendChild(box);
      doc.body.appendChild(overlay);
      return overlay;
    }

    function bodyNode() { return doc.getElementById('pl-body'); }
    function footNode() { return doc.getElementById('pl-foot'); }

    function message(text, kind) {
      return el('p', 'pl-message' + (kind ? ' ' + kind : ''), text);
    }

    function errorText(result) {
      if (!result) return t('queue.notify.ipc');
      if (result.message) return String(result.message);
      var code = result.code || 'UNKNOWN';
      var key = 'queue.playlist.error.' + code;
      var translated = t(key, { code: code });
      return translated === key ? t('queue.playlist.error.generic', { code: code }) : translated;
    }

    function stat(key, value, extra) {
      var cell = el('div', 'pl-stat' + (extra ? ' ' + extra : ''));
      cell.appendChild(el('span', 'pl-stat-value', value === null ? '—' : String(value)));
      cell.appendChild(label(key, null, 'pl-stat-label'));
      return cell;
    }

    function selectedIds() {
      if (preview === null) return [];
      return preview.entries.filter(function (item) {
        return item.available && selected[item.id] === true;
      }).map(function (item) { return item.id; });
    }

    function selectedDuration() {
      if (preview === null) return null;
      var total = 0;
      var known = 0;
      preview.entries.forEach(function (item) {
        if (!item.available || selected[item.id] !== true) return;
        if (typeof item.durationSec !== 'number' || !isFinite(item.durationSec)) return;
        total += item.durationSec;
        known += 1;
      });
      return known === 0 ? null : total;
    }

    function visibleEntries() {
      if (preview === null) return [];
      var needle = query.trim().toLowerCase();
      if (needle === '') return preview.entries;
      return preview.entries.filter(function (item) {
        return String(item.title).toLowerCase().indexOf(needle) !== -1
          || String(item.id).toLowerCase().indexOf(needle) !== -1
          || String(item.position).indexOf(needle) !== -1;
      });
    }

    /** Search only changes which rows are visible; `selected` is untouched. */
    function renderList() {
      var list = doc.getElementById('pl-list');
      if (list === null) return;
      list.textContent = '';
      var rows = visibleEntries();
      rows.forEach(function (item) {
        var row = el('label', 'pl-row');
        row.setAttribute('data-entry-id', item.id);
        row.setAttribute('data-available', item.available ? 'true' : 'false');
        row.setAttribute('data-selected', selected[item.id] === true ? 'true' : 'false');
        var box = doc.createElement('input');
        box.setAttribute('type', 'checkbox');
        box.checked = item.available && selected[item.id] === true;
        box.disabled = !item.available;
        if (item.available) {
          box.addEventListener('change', function () {
            if (box.checked) selected[item.id] = true;
            else delete selected[item.id];
            row.setAttribute('data-selected', box.checked ? 'true' : 'false');
            renderCounts();
          });
        }
        var no = el('span', 'pl-no', t('queue.playlist.episode', { n: item.position }));
        var title = el('span', 'pl-name', item.title);
        title.setAttribute('title', item.title);
        var meta = el('span', 'pl-meta', item.available
          ? formatDuration(item.durationSec)
          : t('queue.playlist.unavailable'));
        row.appendChild(box);
        row.appendChild(no);
        row.appendChild(title);
        row.appendChild(meta);
        list.appendChild(row);
      });
      if (rows.length === 0) list.appendChild(message(t('queue.playlist.noMatch')));
    }

    function renderCounts() {
      var count = selectedIds().length;
      var node = doc.getElementById('pl-selected');
      if (node !== null) node.textContent = t('queue.playlist.selected', { n: count });
      var duration = doc.getElementById('pl-duration');
      if (duration !== null) {
        duration.textContent = t('queue.playlist.duration', { duration: formatDuration(selectedDuration()) });
      }
      var confirm = doc.getElementById('pl-confirm');
      if (confirm !== null) {
        confirm.textContent = t('queue.playlist.confirm', { n: count });
        if (count === 0 || busy) confirm.setAttribute('disabled', 'disabled');
        else confirm.removeAttribute('disabled');
      }
    }

    function render() {
      var body = bodyNode();
      var foot = footNode();
      if (body === null || foot === null || preview === null) return;
      body.textContent = '';
      foot.textContent = '';

      body.appendChild(el('div', 'pl-name-big', preview.title));
      var grid = el('div', 'pl-stats');
      grid.appendChild(stat('queue.playlist.stats.declared', preview.declaredCount));
      grid.appendChild(stat('queue.playlist.stats.fetched', preview.fetchedCount));
      grid.appendChild(stat('queue.playlist.stats.available', preview.availableCount, 'ok'));
      grid.appendChild(stat('queue.playlist.stats.unavailable', preview.unavailableCount,
        preview.unavailableCount > 0 ? 'warn' : ''));
      body.appendChild(grid);

      // Never claim a complete collection when the probe returned fewer rows.
      if (preview.declaredCount !== null && preview.declaredCount > preview.fetchedCount) {
        body.appendChild(message(t('queue.playlist.partial', {
          fetched: preview.fetchedCount, declared: preview.declaredCount
        }), 'warn'));
      }
      if (preview.truncated) {
        body.appendChild(message(t('queue.playlist.truncated', { max: preview.entries.length }), 'warn'));
      }

      var summary = el('div', 'pl-summary');
      var selectedText = el('span', '', t('queue.playlist.selected', { n: selectedIds().length }));
      selectedText.setAttribute('id', 'pl-selected');
      var durationText = el('span', '', t('queue.playlist.duration', {
        duration: formatDuration(selectedDuration())
      }));
      durationText.setAttribute('id', 'pl-duration');
      summary.appendChild(selectedText);
      summary.appendChild(durationText);
      body.appendChild(summary);

      var controls = el('div', 'pl-controls');
      var all = el('button', 'pl-btn', t('queue.playlist.selectAll'));
      all.setAttribute('type', 'button');
      all.setAttribute('id', 'pl-all');
      all.addEventListener('click', function () { bulk('all'); });
      var none = el('button', 'pl-btn', t('queue.playlist.selectNone'));
      none.setAttribute('type', 'button');
      none.setAttribute('id', 'pl-none');
      none.addEventListener('click', function () { bulk('none'); });
      var invert = el('button', 'pl-btn', t('queue.playlist.invert'));
      invert.setAttribute('type', 'button');
      invert.setAttribute('id', 'pl-invert');
      invert.addEventListener('click', function () { bulk('invert'); });
      var search = doc.createElement('input');
      search.setAttribute('type', 'search');
      search.setAttribute('id', 'pl-search');
      search.setAttribute('data-i18n-placeholder', 'queue.playlist.search');
      search.setAttribute('placeholder', t('queue.playlist.search'));
      search.value = query;
      search.addEventListener('input', function () {
        query = String(search.value || '');
        renderList();
      });
      controls.appendChild(all);
      controls.appendChild(none);
      controls.appendChild(invert);
      controls.appendChild(search);
      body.appendChild(controls);

      var list = el('div', 'pl-list');
      list.setAttribute('id', 'pl-list');
      body.appendChild(list);

      var cancelBtn = el('button', 'pl-btn', t('common.cancel'));
      cancelBtn.setAttribute('type', 'button');
      cancelBtn.setAttribute('id', 'pl-cancel');
      cancelBtn.addEventListener('click', function () { cancel(); });
      var confirmBtn = el('button', 'pl-btn primary', t('queue.playlist.confirm', { n: selectedIds().length }));
      confirmBtn.setAttribute('type', 'button');
      confirmBtn.setAttribute('id', 'pl-confirm');
      confirmBtn.addEventListener('click', function () {
        if (busy || preview === null || currentPreviewId === '') return;
        enqueue();
      });
      foot.appendChild(cancelBtn);
      foot.appendChild(confirmBtn);
      renderList();
      renderCounts();
    }

    /** Bulk actions cover ALL downloadable entries, not just the search hits. */
    function bulk(mode) {
      if (preview === null) return;
      preview.entries.forEach(function (item) {
        if (!item.available) return;
        if (mode === 'all') selected[item.id] = true;
        else if (mode === 'none') delete selected[item.id];
        else if (selected[item.id] === true) delete selected[item.id];
        else selected[item.id] = true;
      });
      renderList();
      renderCounts();
    }

    function enqueue() {
      var ids = selectedIds();
      if (ids.length === 0) { notify(t('queue.playlist.error.EMPTY_SELECTION')); return; }
      busy = true;
      var choice = typeof getChoice === 'function' ? getChoice() : { kind: 'video' };
      var payload = {
        previewId: currentPreviewId,
        url: currentUrl,
        selectedIds: ids,
        kind: choice.kind === 'audio' ? 'audio' : 'video'
      };
      if (payload.kind === 'audio') {
        if (choice.audioQuality) payload.audioQuality = choice.audioQuality;
        if (choice.audioFormat) payload.audioFormat = choice.audioFormat;
      } else if (choice.videoQuality) {
        payload.quality = choice.videoQuality;
      }
      var button = doc.getElementById('pl-confirm');
      if (button !== null) button.setAttribute('disabled', 'disabled');
      var spentId = currentPreviewId;
      call('PLAYLIST_BATCH_ENQUEUE', payload).then(function (result) {
        busy = false;
        currentPreviewId = '';
        preview = null;
        selected = {};
        renderResult(result, spentId);
      });
    }

    function renderResult(result, spentId) {
      var body = bodyNode();
      var foot = footNode();
      if (body === null || foot === null) return;
      body.textContent = '';
      foot.textContent = '';
      var requested = result && typeof result.requested === 'number' ? result.requested : 0;
      var enqueued = result && typeof result.enqueued === 'number' ? result.enqueued : 0;
      var failed = result && typeof result.failed === 'number' ? result.failed : 0;
      var text = t('queue.playlist.result', { requested: requested, enqueued: enqueued, failed: failed });
      body.appendChild(message(text, result && result.ok === true ? 'ok' : 'warn'));
      if (!result || result.ok !== true) body.appendChild(message(errorText(result), 'warn'));
      var failures = result && Array.isArray(result.failures) ? result.failures : [];
      failures.forEach(function (item) {
        body.appendChild(message(String(item.id) + ' — ' + String(item.reason), 'warn'));
      });
      notify(text);
      var done = el('button', 'pl-btn primary', t('common.close'));
      done.setAttribute('type', 'button');
      done.setAttribute('id', 'pl-done');
      done.addEventListener('click', function () { close(); });
      foot.appendChild(done);
      if (spentId) { /* ticket was consumed by main; nothing else to release */ }
      if (typeof refresh === 'function') refresh();
    }

    function renderFailure(result) {
      var body = bodyNode();
      var foot = footNode();
      if (body === null || foot === null) return;
      body.textContent = '';
      foot.textContent = '';
      body.appendChild(message(errorText(result), 'warn'));
      var cancelBtn = el('button', 'pl-btn', t('common.cancel'));
      cancelBtn.setAttribute('type', 'button');
      cancelBtn.addEventListener('click', function () { cancel(); });
      foot.appendChild(cancelBtn);
      // A single video / unsupported site must still be downloadable: fall back
      // to the untouched normal single-download path.
      if (typeof startSingleDownload === 'function') {
        var fallback = el('button', 'pl-btn primary', t('queue.playlist.fallbackSingle'));
        fallback.setAttribute('type', 'button');
        fallback.setAttribute('id', 'pl-fallback');
        fallback.addEventListener('click', function () {
          var url = currentUrl;
          cancel();
          startSingleDownload(url);
        });
        foot.appendChild(fallback);
      }
    }

    function open(rawUrl) {
      if (busy) return;
      var target = String(rawUrl || '').trim();
      if (target === '') { notify(t('queue.playlist.needUrl')); return; }
      busy = true;
      generation += 1;
      var mine = generation;
      currentUrl = target;
      preview = null;
      selected = {};
      query = '';
      var root = shell();
      var body = bodyNode();
      var foot = footNode();
      if (body === null || foot === null) { busy = false; return; }
      body.textContent = '';
      foot.textContent = '';
      body.appendChild(message(t('queue.playlist.picking')));
      var previous = currentPreviewId;
      currentPreviewId = '';
      call('PLAYLIST_PREVIEW', { url: target, previousPreviewId: previous }).then(function (result) {
        // A newer URL replaced this one while the probe was in flight.
        if (mine !== generation) return;
        busy = false;
        if (!result || result.ok !== true) { renderFailure(result); return; }
        currentPreviewId = result.previewId;
        preview = result;
        // DEFAULT: every downloadable entry is selected.
        selected = {};
        result.entries.forEach(function (item) {
          if (item.available) selected[item.id] = true;
        });
        render();
      });
      return root;
    }

    return {
      mount: mount,
      open: open,
      close: close,
      cancel: cancel,
      isPlaylistLike: isPlaylistLike,
      isOpen: function () { return overlay !== null; },
      state: function () {
        return {
          url: currentUrl,
          busy: busy,
          previewId: currentPreviewId,
          selected: selectedIds(),
          query: query,
          declared: preview === null ? null : preview.declaredCount,
          fetched: preview === null ? null : preview.fetchedCount
        };
      }
    };
  }

  YTVDLT.playlists = { create: create, isPlaylistLike: isPlaylistLike, formatDuration: formatDuration };
})(typeof window === 'undefined' ? this : window);
