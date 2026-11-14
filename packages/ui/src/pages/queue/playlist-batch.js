/**
 * playlist-batch.js — M4-4 batch preview page (zero dependency, no bundler).
 *
 * Reads the SAME L1 fixture the dialog uses (`?fixture=dialog-playlist.json`
 * relative to tests/e2e/fixtures, injected as `window.__YTVDLT_FIXTURE__` by the
 * page loader; a built-in sample keeps the page usable when opened directly).
 *
 * Contract:
 *  - one row per selected entry, `data-task-id` + `data-playlist-items` set from
 *    the ORIGINAL playlist position (never the click order);
 *  - the page never starts a download: it only emits the task list the main
 *    process should create (`{accepted, enqueued, taskIds}`);
 *  - concurrency is display-only here; the queue owns the real limit.
 */
(function (global) {
  'use strict';
  var doc = global.document;

  var SAMPLE = {
    id: 'PL_fixture_01',
    title: 'Recorded Flat Playlist',
    webpage_url: 'https://example.org/playlist?list=PL_fixture_01',
    entries: [
      { id: 'a1', title: 'Episode 1', duration: 100 },
      { id: 'a2', title: 'Episode 2', duration: 200 },
      { id: 'a3', title: 'Episode 3', duration: 300 },
      { id: 'a4', title: 'Episode 4', duration: 400 },
      { id: 'a5', title: 'Episode 5', duration: 500 },
      { id: 'a6', title: 'Episode 6', duration: 600 }
    ]
  };

  function param(name, fallback) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? fallback : decodeURIComponent(match[1]);
  }

  function fixture() {
    var injected = global.__YTVDLT_FIXTURE__;
    var playlist = injected && injected.playlist ? injected.playlist : injected;
    if (playlist && Array.isArray(playlist.entries) && playlist.entries.length > 0) return playlist;
    return SAMPLE;
  }

  function selectedIds(playlist) {
    var raw = param('selected', '');
    if (raw.length > 0) {
      return raw.split(',').map(function (id) { return id.trim(); }).filter(function (id) { return id.length > 0; });
    }
    // Default: the whole playlist (the dialog's own default is "select all").
    return playlist.entries.map(function (entry) { return entry.id; });
  }

  function limit() {
    var value = parseInt(param('concurrency', '3'), 10);
    if (!isFinite(value) || value < 1) return 3;
    return Math.min(8, value);
  }

  function durationLabel(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    var minutes = Math.floor(seconds / 60);
    var rest = Math.floor(seconds % 60);
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function render() {
    var playlist = fixture();
    var ids = selectedIds(playlist);
    var positions = {};
    playlist.entries.forEach(function (entry, index) { positions[entry.id] = index + 1; });
    var concurrency = limit();

    var rows = [];
    var seen = {};
    ids.forEach(function (id) {
      if (seen[id] === true) return;
      seen[id] = true;
      var position = positions[id];
      if (position === undefined) return;
      var entry = playlist.entries[position - 1];
      rows.push({
        id: playlist.id + '-' + id,
        position: position,
        title: entry.title,
        duration: entry.duration
      });
    });

    var host = doc.getElementById('batch-rows');
    host.textContent = '';
    rows.forEach(function (row) {
      var line = doc.createElement('div');
      line.className = 'task-row';
      line.setAttribute('data-state', 'queued');
      line.setAttribute('data-task-id', row.id);
      line.setAttribute('data-playlist-items', String(row.position));

      var dot = doc.createElement('span');
      dot.className = 'dot';
      var title = doc.createElement('span');
      title.textContent = row.title;
      var meta = doc.createElement('span');
      meta.className = 'task-meta';
      meta.textContent = '条目 #' + row.position + ' · ' + durationLabel(row.duration);
      var id = doc.createElement('span');
      id.className = 'task-id';
      id.textContent = row.id;

      line.appendChild(dot);
      line.appendChild(title);
      line.appendChild(meta);
      line.appendChild(id);
      host.appendChild(line);
    });

    doc.getElementById('batch-title').textContent = playlist.title || '播放列表';
    doc.getElementById('batch-selected').textContent = String(ids.length);
    doc.getElementById('batch-tasks').textContent = String(rows.length);
    doc.getElementById('batch-limit').textContent = String(concurrency);
    doc.getElementById('batch-concurrency').textContent = String(Math.min(concurrency, rows.length));

    var page = doc.getElementById('ytvdlt-batch');
    var errorMode = param('error', '0') === '1';
    page.setAttribute('data-state', errorMode ? 'error' : rows.length === 0 ? 'empty' : 'ready');
    var emptyBox = doc.getElementById('batch-empty');
    var errorBox = doc.getElementById('batch-error');
    if (emptyBox !== null) emptyBox.setAttribute('hidden', !errorMode && rows.length === 0 ? 'false' : 'true');
    if (errorBox !== null) errorBox.setAttribute('hidden', errorMode ? 'false' : 'true');
    if (host !== null) host.setAttribute('hidden', rows.length === 0 || errorMode ? 'true' : 'false');
    page.setAttribute('data-task-count', String(rows.length));

    var button = doc.getElementById('batch-enqueue');
    button.setAttribute('aria-disabled', rows.length === 0 || errorMode ? 'true' : 'false');
    button.setAttribute('data-confirm', rows.length === 0 || errorMode ? 'disabled' : 'enabled');

    var next = { playlist: playlist, rows: rows, concurrency: concurrency, ids: ids };
    // D-190: `YTVDLTBatch.render()` is a public re-render surface. The click
    // listener closes over the module-level `model` variable (a binding, not a
    // snapshot), so every render must refresh it; otherwise a programmatic
    // re-render followed by a click emits the selection from first import.
    model = next;
    return next;
  }

  function emit(model) {
    var output = doc.getElementById('ytvdlt-output');
    if (model.rows.length === 0) {
      output.textContent = JSON.stringify({ accepted: false, enqueued: false, reason: 'EMPTY_SELECTION', taskIds: [] }, null, 2);
      return;
    }
    output.textContent = JSON.stringify({
      accepted: true,
      enqueued: true,
      kind: 'playlist',
      playlistUrl: model.playlist.webpage_url,
      taskIds: model.rows.map(function (row) { return row.id; })
    }, null, 2);
  }

  var model = null;
  render(); // populates `model` (see the assignment at the end of render()).
  var button = doc.getElementById('batch-enqueue');
  if (button !== null) {
    button.addEventListener('click', function () { emit(model); });
  }
  if (param('autoconfirm', '0') === '1') emit(model);

  global.YTVDLTBatch = { render: render, selectedIds: selectedIds };
})(typeof window === 'undefined' ? this : window);
