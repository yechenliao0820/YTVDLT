/**
 * format-selector.js — PRD §5.1 三组分栏 / 搜索 / 视频单选 + 音频多选 /
 * 合计体积（缺失显「—」）/ 默认勾选建议格式 / 三态门禁 / 五域同构回写。
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT;
  var doc = global.document;
  var dom = YTVDLT.dom;
  var dialog = YTVDLT.createDialog({ kind: 'format', fixture: 'dialog-media.json' });

  function bytesLabel(value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) return '—';
    if (value >= 1073741824) return (value / 1073741824).toFixed(2) + ' GiB';
    if (value >= 1048576) return (value / 1048576).toFixed(2) + ' MiB';
    if (value >= 1024) return (value / 1024).toFixed(1) + ' KiB';
    return value + ' B';
  }

  function sizeOf(format) {
    if (typeof format.filesize === 'number') return format.filesize;
    if (typeof format.filesize_approx === 'number') return format.filesize_approx;
    return null;
  }

  function classify(formats) {
    var groups = { 'video-only': [], 'audio-only': [], 'merged': [] };
    (formats || []).forEach(function (f) {
      var hasVideo = f.vcodec !== 'none';
      var hasAudio = f.acodec !== 'none';
      if (hasVideo && hasAudio) groups.merged.push(f);
      else if (hasVideo) groups['video-only'].push(f);
      else if (hasAudio) groups['audio-only'].push(f);
    });
    return groups;
  }

  /** yt-dlp 建议格式 = 同组最高 tbr；全缺失时取组内第一项。 */
  function recommended(group) {
    var best = null;
    var bestTbr = -Infinity;
    group.forEach(function (f) {
      if (typeof f.tbr === 'number' && f.tbr > bestTbr) { bestTbr = f.tbr; best = f; }
    });
    return best || group[0] || null;
  }

  function descriptor(f) {
    var resolution = (f.height ? f.height + 'p' : (f.width ? f.width + 'x' : '—'));
    var row1 = f.format_id + ' · ' + f.ext + ' · ' + resolution;
    var row2 = 'v:' + f.vcodec + ' a:' + f.acodec
      + ' tbr:' + (typeof f.tbr === 'number' ? f.tbr : '—')
      + ' size:' + bytesLabel(sizeOf(f))
      + (f.format_note ? ' ' + f.format_note : '');
    return {
      id: f.format_id,
      row1: row1,
      row2: row2,
      size: sizeOf(f),
      searchText: row1 + ' ' + row2,
      format: f
    };
  }

  function makeItem(desc, state) {
    var label = doc.createElement('label');
    label.className = 'item';
    label.setAttribute('data-format-id', desc.id);
    label.setAttribute('data-selected', state.selected ? 'true' : 'false');
    label.setAttribute('data-disabled', state.disabled ? 'true' : 'false');
    var input = doc.createElement('input');
    input.type = state.single ? 'radio' : 'checkbox';
    input.name = 'fmt-' + state.group;
    input.checked = state.selected;
    input.disabled = state.disabled;
    if (!state.disabled) {
      input.addEventListener('change', function () {
        dialog.toggleSelected(desc.id, state.single);
        render(dialog, (dom.byId('ytvdlt-search') || {}).value || '');
      });
    }
    var line1 = doc.createElement('div'); line1.className = 'row1'; line1.textContent = desc.row1;
    var line2 = doc.createElement('div'); line2.className = 'row2'; line2.textContent = desc.row2;
    label.appendChild(input);
    label.appendChild(line1);
    label.appendChild(line2);
    return label;
  }

  function renderColumns(self, groups, mode, searchTerm) {
    ['video-only', 'audio-only', 'merged'].forEach(function (group) {
      var items = groups[group].map(descriptor);
      var containerId = group === 'video-only' ? 'items-video-only'
        : group === 'audio-only' ? 'items-audio-only' : 'items-merged';
      var countId = group === 'video-only' ? 'count-video-only'
        : group === 'audio-only' ? 'count-audio-only' : 'count-merged';
      var groupDisabled = mode === 'command'
        || (mode === 'audio' && group !== 'audio-only');
      dom.text(countId, items.length);
      self.renderItems(containerId, items, searchTerm, function (desc) {
        return makeItem(desc, {
          group: group,
          single: group !== 'audio-only',
          selected: self.selected.indexOf(desc.id) !== -1,
          disabled: groupDisabled
        });
      });
      var col = dom.byId('col-' + group);
      if (col !== null) col.setAttribute('data-disabled', groupDisabled ? 'true' : 'false');
    });
  }

  function totalBytesLabel(groups, selectedIds) {
    var found = false;
    var total = 0;
    Object.keys(groups).forEach(function (group) {
      groups[group].forEach(function (f) {
        if (selectedIds.indexOf(f.format_id) === -1) return;
        var size = sizeOf(f);
        if (size === null) return;
        total += size;
        found = true;
      });
    });
    return found ? bytesLabel(total) : '—';
  }

  function render(self, searchTerm) {
    var media = self.payload.media || {};
    var groups = classify(media.formats || []);
    var mode = self.option('mode', 'video');
    var forceError = self.option('error', '0') === '1';
    var forceEmpty = self.option('empty', '0') === '1';
    var badId = self.option('badid', '0') === '1';
    var mp3 = self.option('mp3', '0') === '1';

    var formats = (media.formats || []);
    if (forceEmpty) { groups = { 'video-only': [], 'audio-only': [], 'merged': [] }; formats = []; }

    // Default recommendation on first render: highest-tbr video + audio.
    if (self.selected.length === 0 && !forceError && !forceEmpty && mode !== 'command') {
      var recVideo = recommended(forceEmpty ? [] : groups['video-only']);
      var recAudio = recommended(forceEmpty ? [] : groups['audio-only']);
      var initial = [];
      if (recVideo !== null) initial.push(recVideo.format_id);
      if (recAudio !== null) initial.push(recAudio.format_id);
      if (initial.length === 0 && formats.length > 0) initial.push(formats[0].format_id);
      self.setSelected(initial);
    }

    renderColumns(self, groups, mode, searchTerm);
    dom.text('ytvdlt-total-bytes', totalBytesLabel(groups, self.selected));

    dom.attr('ctl-mp3', 'checked', mp3 ? 'checked' : 'false');
    var mp3Box = dom.byId('ctl-mp3');
    if (mp3Box !== null) mp3Box.checked = mp3;
    dom.dataAttr('label-audio-quality', 'disabled', mp3 ? 'true' : 'false');
    var aq = dom.byId('ctl-audio-quality');
    if (aq !== null) aq.disabled = mp3;
    dom.dataAttr('ytvdlt-dialog', 'mode', mode);
    dom.dataAttr('ytvdlt-dialog', 'total-bytes', totalBytesLabel(groups, self.selected));

    if (mp3) self.setWarnings(['R1：转码 MP3 时音质档位（abr~N）已被抑制']);
    else self.setWarnings([]);

    if (forceError) {
      self.setState('error', '解析失败（FORMAT_UNAVAILABLE / UNSUPPORTED_SITE）；可点击「重试解析」');
      self.setSelected([]);
    } else if (mode === 'command') {
      self.setState('disabled', 'Command 模式：GUI 格式项全部禁用，请到命令页配置（A-4.1-07）');
      dom.text('ctl-notice', 'Command 模式下格式选择不可用');
    } else if (formats.length === 0) {
      self.setState('empty', '没有可用格式（formats=[]）');
      self.setSelected([]);
    } else {
      self.setState('ready');
    }

    if (badId) {
      self.setInlineError('FORMAT_UNAVAILABLE：手填格式 id 不在解析结果中，请重试或重新解析');
    } else {
      self.clearInlineError();
    }
    self.refreshGate();
  }

  function patch(self) {
    var byId = dom.byId;
    var value = function (id, fallback) { var n = byId(id); return n !== null ? n.value : fallback; };
    var selectedAudio = self.selected.filter(function (id) {
      return ((self.payload.media || {}).formats || []).some(function (f) {
        return f.format_id === id && f.vcodec === 'none' && f.acodec !== 'none';
      });
    });
    return {
      format: {
        quality: value('ctl-quality', 'best'),
        videoCodecPref: value('ctl-vcodec', 'auto'),
        formatId: self.selected.length > 0 ? self.selected.join('+') : null,
        sortingFields: null,
        extractAudio: self.option('mode', 'video') === 'audio',
        audioQuality: value('ctl-audio-quality', 'best'),
        audioCodecPref: value('ctl-acodec', 'auto'),
        audioFormat: self.option('mp3', '0') === '1' ? 'mp3' : null,
        audioMultistreams: selectedAudio.length >= 2
      }
    };
  }

  dialog.start(render, patch);
  global.YTVDLT_FORMAT_DIALOG = dialog;
})(window);
