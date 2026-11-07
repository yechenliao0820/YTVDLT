/**
 * playlist-selector.js — PRD §5.3 全选 / 反选 / 搜索 / 已选计数 /
 * 合计时长 / 路径预览 / 「保存选择」/ 空态 / 错误态。
 *
 * HARD RULE (A-M3-04 / D-38): confirmation writes back ONLY `selectedIds`.
 * This module never calls enqueueBatch(), never creates a TaskRecord, and the
 * writeback JSON contains no requestPatch at all.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT;
  var doc = global.document;
  var dom = YTVDLT.dom;
  var dialog = YTVDLT.createDialog({ kind: 'playlist', fixture: 'dialog-playlist.json' });

  function durationLabel(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function descriptor(entry, index) {
    return {
      id: entry.id,
      row1: (index + 1) + '. ' + entry.title,
      row2: 'id:' + entry.id + ' duration:' + durationLabel(entry.duration),
      duration: entry.duration,
      searchText: entry.id + ' ' + entry.title,
      entry: entry
    };
  }

  function makeItem(desc, state) {
    var label = doc.createElement('label');
    label.className = 'item';
    label.setAttribute('data-entry-id', desc.id);
    label.setAttribute('data-selected', state.selected ? 'true' : 'false');
    label.setAttribute('data-disabled', state.disabled ? 'true' : 'false');
    var input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = state.selected;
    input.disabled = state.disabled;
    if (!state.disabled) {
      input.addEventListener('change', function () {
        dialog.toggleSelected(desc.id, false);
        render(dialog, (dom.byId('ytvdlt-search') || {}).value || '');
      });
    }
    var line1 = doc.createElement('div'); line1.className = 'row1'; line1.textContent = desc.row1;
    var line2 = doc.createElement('div'); line2.className = 'row2'; line2.textContent = desc.row2;
    label.appendChild(input); label.appendChild(line1); label.appendChild(line2);
    return label;
  }

  function render(self, searchTerm) {
    var playlist = self.payload.playlist || {};
    var entries = playlist.entries || [];
    var forceError = self.option('error', '0') === '1';
    var forceEmpty = self.option('empty', '0') === '1';
    var notPlaylist = self.option('single', '0') === '1';
    if (forceEmpty || notPlaylist) entries = [];

    if (self.selected.length === 0 && !forceError && entries.length > 0) {
      self.setSelected(entries.map(function (e) { return e.id; }));
    }

    var descriptors = entries.map(descriptor);
    dom.text('count-entries', descriptors.length);
    dom.text('ytvdlt-entry-count', descriptors.length);
    self.renderItems('items-entries', descriptors, searchTerm, function (desc) {
      return makeItem(desc, {
        selected: self.selected.indexOf(desc.id) !== -1,
        disabled: forceError
      });
    });

    var selectedSet = self.selected;
    var total = 0;
    descriptors.forEach(function (desc) {
      if (selectedSet.indexOf(desc.id) === -1) return;
      if (typeof desc.duration === 'number') total += desc.duration;
    });
    dom.text('ytvdlt-total-duration', durationLabel(total));
    dom.dataAttr('ytvdlt-dialog', 'total-duration', durationLabel(total));

    var subdir = self.option('subdir', '1') === '1';
    var base = 'C:/Videos';
    var preview = subdir ? base + '/' + (playlist.title || '') + '/' : base + '/';
    dom.text('ytvdlt-path-preview', preview);
    dom.dataAttr('ytvdlt-dialog', 'path-preview', preview);

    dom.dataAttr('ytvdlt-dialog', 'kind-of-source', notPlaylist ? 'video' : 'playlist');
    dom.dataAttr('ytvdlt-dialog', 'enqueue-batch', 'never');

    if (forceError) {
      self.setState('error', '解析失败（UNSUPPORTED_SITE）；可点击「重试解析」');
      self.setSelected([]);
    } else if (notPlaylist) {
      self.setState('empty', '不是播放列表（单视频），无需选择条目');
      self.setSelected([]);
    } else if (entries.length === 0) {
      self.setState('empty', '没有可选择的条目（entries=[]）');
      self.setSelected([]);
    } else {
      self.setState('ready');
    }
    dom.text('ctl-notice', 'M3 确认仅保存选择，不创建任务 / 不入队');
    self.setWarnings([]);
    self.clearInlineError();
    self.refreshGate();
  }

  /** Playlist confirmation carries NO patch: only selected ids are persisted. */
  function patch() { return null; }

  dialog.start(render, patch);

  var selectAll = dom.byId('ctl-select-all');
  if (selectAll !== null) {
    selectAll.addEventListener('click', function () {
      var entries = (dialog.payload.playlist || {}).entries || [];
      dialog.setSelected(entries.map(function (e) { return e.id; }));
      render(dialog, (dom.byId('ytvdlt-search') || {}).value || '');
    });
  }
  var selectNone = dom.byId('ctl-select-none');
  if (selectNone !== null) {
    selectNone.addEventListener('click', function () {
      var entries = (dialog.payload.playlist || {}).entries || [];
      var all = entries.map(function (e) { return e.id; });
      var inverted = all.filter(function (id) { return dialog.selected.indexOf(id) === -1; });
      dialog.setSelected(inverted);
      render(dialog, (dom.byId('ytvdlt-search') || {}).value || '');
    });
  }

  global.YTVDLT_PLAYLIST_DIALOG = dialog;
})(window);
