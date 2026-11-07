/**
 * subtitle-selector.js — PRD §5.2 三组 / 按语言多选 / 搜索 / 已选计数 /
 * 五选一格式转换 / 语言表达式校验 / 实验性提示 / 音频与 split 门禁 /
 * enabled=false 全禁用 / 五域同构回写（不含 mergeToMkv）。
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT;
  var doc = global.document;
  var dom = YTVDLT.dom;
  var dialog = YTVDLT.createDialog({ kind: 'subtitle', fixture: 'dialog-media.json' });
  var SUGGESTED = ['en.*', '.*-orig'];

  /** Same grammar as core SubtitlePlanner.validateLanguageExpression (pure JS). */
  function validateExpression(expression) {
    if (typeof expression !== 'string' || expression.trim() === '') {
      return { valid: false, reason: '语言表达式不能为空' };
    }
    if (/[\s\u0000-\u001f\u007f]/.test(expression)) {
      return { valid: false, reason: '语言表达式不能包含空白或控制字符' };
    }
    if (!/^[A-Za-z0-9_.,*\-:]+$/.test(expression)) {
      return { valid: false, reason: '语言表达式包含非法字符' };
    }
    if (expression.split(',').some(function (token) { return token === ''; })) {
      return { valid: false, reason: '存在空的语言项' };
    }
    return { valid: true, reason: null };
  }

  function matchesPattern(lang, pattern) {
    var normalized = pattern.replace(/\.\*/g, '*');
    var source = '^';
    for (var i = 0; i < normalized.length; i += 1) {
      var ch = normalized.charAt(i);
      if (ch === '*') source += '.*';
      else if (ch === '?') source += '.';
      else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    source += '$';
    try { return new RegExp(source, 'i').test(lang); } catch (e) { return false; }
  }

  function groupLanguages(media) {
    var subs = Object.keys(media.subtitles || {});
    var autos = Object.keys(media.automatic_captions || {});
    return {
      suggested: subs.filter(function (lang) {
        return SUGGESTED.some(function (p) { return matchesPattern(lang, p); });
      }),
      other: subs.filter(function (lang) {
        return !SUGGESTED.some(function (p) { return matchesPattern(lang, p); });
      }),
      automatic: autos
    };
  }

  function descriptor(lang) {
    var tracks = [];
    var media = dialog.payload && dialog.payload.media ? dialog.payload.media : {};
    if ((media.subtitles || {})[lang]) tracks = tracks.concat((media.subtitles || {})[lang]);
    if ((media.automatic_captions || {})[lang]) tracks = tracks.concat((media.automatic_captions || {})[lang]);
    var exts = tracks.map(function (t) { return t.ext; }).join('/');
    var names = tracks.map(function (t) { return t.name || '—'; }).join('/');
    return {
      id: lang,
      row1: lang + ' · ' + (exts || '—'),
      row2: 'name:' + (names || '—') + ' tracks:' + tracks.length,
      searchText: lang + ' ' + exts + ' ' + names
    };
  }

  function makeItem(desc, state) {
    var label = doc.createElement('label');
    label.className = 'item';
    label.setAttribute('data-language', desc.id);
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

  function setDisabledLabel(id, disabled, note) {
    dom.dataAttr(id, 'disabled', disabled ? 'true' : 'false');
    var input = dom.byId(id.replace('label-', 'ctl-'));
    if (input !== null && input.type === 'checkbox') input.disabled = disabled;
    if (note) dom.dataAttr(id, 'reason', note);
  }

  function render(self, searchTerm) {
    var media = self.payload.media || {};
    var groups = groupLanguages(media);
    var mode = self.option('mode', 'video');
    var split = self.option('split', '0') === '1';
    var forceError = self.option('error', '0') === '1';
    var forceEmpty = self.option('empty', '0') === '1';
    var disabledAll = self.option('enabled', '1') === '0';
    var expression = self.option('expr', 'en.*,.*-orig');
    var expressionInput = dom.byId('ctl-expression');
    if (expressionInput !== null && expressionInput.value !== expression && !expressionInput.dataset.touched) {
      expressionInput.value = expression;
    }
    if (forceEmpty) groups = { suggested: [], other: [], automatic: [] };

    var allLanguages = groups.suggested.length + groups.other.length + groups.automatic.length;
    if (self.selected.length === 0 && !forceError && !forceEmpty && !disabledAll) {
      self.setSelected(groups.suggested.slice(0, 2));
    }

    var map = { suggested: 'suggested', other: 'other', automatic: 'automatic' };
    Object.keys(map).forEach(function (group) {
      var items = groups[group].map(descriptor);
      dom.text('count-' + group, items.length);
      self.renderItems('items-' + group, items, searchTerm, function (desc) {
        return makeItem(desc, {
          selected: self.selected.indexOf(desc.id) !== -1,
          disabled: disabledAll || mode === 'command'
        });
      });
    });

    var enabledBox = dom.byId('ctl-enabled');
    if (enabledBox !== null) enabledBox.checked = !disabledAll;
    var audioMode = mode === 'audio';
    dom.dataAttr('ytvdlt-dialog', 'mode', mode);
    dom.dataAttr('ytvdlt-dialog', 'split', split ? 'true' : 'false');
    dom.dataAttr('ytvdlt-dialog', 'enabled', disabledAll ? 'false' : 'true');

    ['label-auto', 'label-skip', 'label-convert'].forEach(function (id) {
      dom.dataAttr(id, 'disabled', disabledAll ? 'true' : 'false');
    });
    var convert = dom.byId('ctl-convert');
    if (convert !== null) convert.disabled = disabledAll;
    setDisabledLabel('label-embed', disabledAll || audioMode || split,
      audioMode ? '仅音频模式不可嵌入' : (split ? '章节拆分时不可嵌入' : ''));
    setDisabledLabel('label-keep', disabledAll || audioMode, '仅音频模式不可保留独立字幕');

    var embedBox = dom.byId('ctl-embed');
    var showMkv = embedBox !== null && embedBox.checked && !audioMode && !split && !disabledAll;
    dom.dataAttr('ctl-mkv-hint', 'visible', showMkv ? 'true' : 'false');
    var skipBox = dom.byId('ctl-skip');
    var translatedOn = skipBox !== null && !skipBox.checked;
    dom.dataAttr('ctl-experimental', 'visible', translatedOn ? 'true' : 'false');

    var validation = validateExpression(expression);
    dom.dataAttr('ytvdlt-dialog', 'expression-valid', validation.valid ? 'true' : 'false');

    if (forceError) {
      self.setState('error', '解析失败（UNSUPPORTED_SITE）；可点击「重试解析」');
      self.setSelected([]);
    } else if (allLanguages === 0) {
      self.setState('empty', '没有字幕语言；可手动输入语言表达式后确认');
    } else if (disabledAll) {
      self.setState('disabled', '字幕总开关已关闭，其余控件全部禁用');
      self.setSelected([]);
    } else if (audioMode) {
      self.setState('ready', '仅音频模式：嵌入与保留独立字幕已置灰');
    } else {
      self.setState('ready');
    }

    // In an empty dialog a valid manual expression is the ONLY valid selection;
    // the EMPTY banner stays visible (PRD §5.2) while the confirm gate opens.
    if (allLanguages === 0 && validation.valid && !forceError && !disabledAll) {
      self.setSelected([expression]);
    }

    self.setInlineError(validation.valid ? '' : validation.reason);
    self.setWarnings(translatedOn ? ['自动翻译字幕为实验性功能，请确认'] : []);
    self.refreshGate();
  }

  function patch(self) {
    var byId = dom.byId;
    var checked = function (id) { var n = byId(id); return n !== null && n.checked; };
    var expressionNode = byId('ctl-expression');
    var expression = expressionNode !== null ? expressionNode.value : 'en.*,.*-orig';
    var languages = self.selected.filter(function (s) { return s !== expression; });
    return {
      subtitle: {
        enabled: checked('ctl-enabled'),
        languages: languages.join(','),
        autoCaptions: checked('ctl-auto'),
        skipTranslated: checked('ctl-skip'),
        convertTo: byId('ctl-convert') !== null ? byId('ctl-convert').value : 'none',
        embed: checked('ctl-embed'),
        keepSubtitleFile: checked('ctl-keep')
      }
    };
  }

  dialog.start(render, patch);
  global.YTVDLT_SUBTITLE_DIALOG = dialog;
})(window);
