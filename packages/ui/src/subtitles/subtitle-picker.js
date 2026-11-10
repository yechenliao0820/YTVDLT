/**
 * subtitle-picker.js — stage 5: the on-demand subtitle option for the queue page.
 *
 * ZERO imports, zero node/electron access: this is a plain browser script that
 * talks to the main process only through the injected `call(channel, payload)`.
 * It is intentionally NOT referenced by any static `<script>` tag:
 *
 *   - The queue page loads it ONLY in live mode (a preload bridge is present),
 *     or when `?subtitle=1` is given for layout verification. That is the same
 *     trick D-120 uses for the "open file" button: static file:// preview and
 *     the frozen screenshot baselines stay byte-identical, while the packaged
 *     Electron app gets the real control.
 *   - No probe happens on page load, on URL typing, or on tab switches. The one
 *     and only `ytvdlt:subtitle:preview` call is made from `open()`, which the
 *     user triggers by clicking the "Subtitles" button.
 *
 * SECURITY (stage 1 R8 / stage 2): the only media data this file ever sees is
 * the whitelisted `SubtitlePreviewDto`. It NEVER renders the video URL, never
 * writes it into an attribute, the status line, localStorage or any debug
 * surface, and every site-supplied string (title / language name) is painted
 * with `textContent`, never `innerHTML`.
 *
 * The selection produced here is a plain set of the SIX flat DOWNLOAD_START
 * keys stage 3 defined, plus the opaque one-shot `previewId`. No new request,
 * plan, cache or artifact model is introduced.
 */
(function (global) {
  'use strict';

  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});
  var MAX_LANGUAGES = 12;                 // core/subtitle-planner::MAX_SUBTITLE_LANGUAGES
  var CONVERT_VALUES = ['none', 'srt', 'vtt', 'ass', 'lrc'];
  var CONVERTIBLE_SOURCES = ['srt', 'vtt', 'ass', 'ssa', 'lrc', 'json3', 'srv1', 'srv2', 'srv3', 'ttml', 'dfxp', 'sbv'];

  /** Stable failure bucket -> i18n key. The renderer owns the sentence. */
  var ERROR_KEYS = {
    PREVIEW_UNAVAILABLE: 'subtitle.error.unavailable',
    PREVIEW_INVALID_URL: 'subtitle.error.invalidUrl',
    PREVIEW_FAILED: 'subtitle.error.failed',
    PREVIEW_EXPIRED: 'subtitle.error.expired',
    PREVIEW_CONSUMED: 'subtitle.error.consumed',
    PREVIEW_URL_MISMATCH: 'subtitle.error.mismatch',
    PREVIEW_UNKNOWN: 'subtitle.error.unknown',
    PREVIEW_REQUIRED: 'subtitle.error.expired',
    SUBTITLE_LANGUAGE_UNKNOWN: 'subtitle.error.languageUnknown',
    SUBTITLE_NO_MANUAL_TRACK: 'subtitle.warn.automaticRequired',
    SUBTITLE_EMBED_UNSUPPORTED: 'subtitle.error.embedAudio',
    BRIDGE_UNAVAILABLE: 'subtitle.error.unavailable',
    IPC_ERROR: 'subtitle.error.failed'
  };

  /** Codes that mean "the ticket is gone, ask for a new preview". */
  var TICKET_DEAD = {
    PREVIEW_EXPIRED: true, PREVIEW_CONSUMED: true, PREVIEW_UNKNOWN: true,
    PREVIEW_URL_MISMATCH: true, PREVIEW_REQUIRED: true,
    SUBTITLE_LANGUAGE_UNKNOWN: true
  };

  function isHttpUrl(value) { return /^https?:\/\//i.test(String(value || '').trim()); }
  function isExpired(expiresAt, now) {
    var ms = Date.parse(expiresAt);
    return !isFinite(ms) || ms <= now;
  }
  function unique(list) {
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (out.indexOf(list[i]) === -1) out.push(list[i]);
    }
    return out;
  }
  /** Track formats that `--convert-subs` can realistically consume. */
  function usableFormats(track) {
    return unique((track.manualFormats || []).concat(track.automaticFormats || []))
      .filter(function (ext) { return CONVERTIBLE_SOURCES.indexOf(String(ext).toLowerCase()) !== -1; });
  }
  function trackLabel(track) {
    return track.languageName ? String(track.languageName) : String(track.languageCode);
  }

  function create(options) {
    var doc = options.doc;
    var t = options.t;
    var call = options.call;
    var notify = options.notify || function () {};
    var getUrl = options.getUrl;
    var getKind = options.getKind || function () { return 'video'; };
    var now = options.now || function () { return Date.now(); };
    var onSelectionChange = options.onSelectionChange || function () {};

    var state = {
      phase: 'idle',          // idle | loading | ready | empty | error | expired | stale
      errorKey: null,
      preview: null,          // SubtitlePreviewDto
      url: '',                // the URL this preview belongs to; NEVER rendered
      selected: {},           // languageCode -> true
      includeAutomatic: false,
      convertTo: 'none',
      embed: false,
      keepFile: false,
      query: '',
      confirmed: null,        // frozen selection handed to DOWNLOAD_START
      seq: 0,                 // out-of-order response guard
      loading: false,
      limitHit: false         // show the "too many languages" hint INSIDE the modal
    };

    var refs = {};
    var mounted = false;
    var controller = {};

    // ---- DOM helpers -----------------------------------------------------
    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }
    function show(node, visible) { if (node) node.setAttribute('hidden', visible ? 'false' : 'true'); }
    function setText(node, value) { if (node) node.textContent = String(value); }

    function buildButton() {
      var button = el('button', 'subtitle-entry');
      button.setAttribute('type', 'button');
      // NOT `queue-subtitle`: pages/queue/index.html already uses that id for the
      // header subtitle line (`<p class="queue-sub" id="queue-subtitle">`).
      // Reusing it produced a duplicate id, made `getElementById` return the
      // paragraph, and let a real-input smoke click the paragraph instead of
      // this button (stage-6 finding). Keep every id here unique against the
      // page — asserted by `subtitle-picker.test.ts`.
      button.setAttribute('id', 'queue-subtitle-open');
      button.setAttribute('data-i18n', 'subtitle.entry');
      button.setAttribute('aria-pressed', 'false');
      button.textContent = t('subtitle.entry');
      button.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        controller.open();
      });
      return button;
    }

    function buildChip() {
      var chip = el('span', 'subtitle-chip');
      chip.setAttribute('id', 'queue-subtitle-chip');
      chip.setAttribute('data-state', 'none');
      chip.setAttribute('hidden', 'true');
      var label = el('span', 'subtitle-chip-label');
      var clear = el('button', 'subtitle-chip-clear', '×');
      clear.setAttribute('type', 'button');
      clear.setAttribute('data-i18n-aria-label', 'subtitle.clear.aria');
      clear.setAttribute('aria-label', t('subtitle.clear.aria'));
      clear.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        controller.clearSelection();
      });
      chip.appendChild(label);
      chip.appendChild(clear);
      refs.chipLabel = label;
      return chip;
    }

    function buildModal() {
      var backdrop = el('div', 'modal-backdrop');
      backdrop.setAttribute('id', 'subtitle-modal');
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.setAttribute('aria-labelledby', 'subtitle-modal-title');
      backdrop.setAttribute('hidden', 'true');

      var modal = el('div', 'modal subtitle-modal');
      modal.setAttribute('data-phase', 'idle');

      var head = el('header', 'subtitle-head');
      var title = el('h2', '', t('subtitle.title'));
      title.setAttribute('id', 'subtitle-modal-title');
      title.setAttribute('data-i18n', 'subtitle.title');
      var close = el('button', 'subtitle-icon-btn', '×');
      close.setAttribute('type', 'button');
      close.setAttribute('id', 'subtitle-close');
      close.setAttribute('aria-label', t('subtitle.close.aria'));
      close.addEventListener('click', function () { controller.cancel(); });
      head.appendChild(title);
      head.appendChild(close);

      var media = el('p', 'subtitle-media');
      media.setAttribute('id', 'subtitle-media');
      media.setAttribute('hidden', 'true');

      var alertBox = el('div', 'subtitle-alert');
      alertBox.setAttribute('id', 'subtitle-alert');
      alertBox.setAttribute('role', 'status');
      alertBox.setAttribute('aria-live', 'polite');
      alertBox.setAttribute('data-tone', 'info');
      alertBox.setAttribute('hidden', 'true');

      var body = el('div', 'subtitle-body');
      var stateBox = el('div', 'subtitle-state');
      stateBox.setAttribute('id', 'subtitle-state');
      stateBox.setAttribute('data-state', 'idle');
      var stateText = el('span', 'subtitle-state-text', t('subtitle.state.idle'));
      stateText.setAttribute('id', 'subtitle-state-text');
      var retry = el('button', '', t('subtitle.retry'));
      retry.setAttribute('type', 'button');
      retry.setAttribute('id', 'subtitle-retry');
      retry.setAttribute('data-i18n', 'subtitle.retry');
      retry.setAttribute('hidden', 'true');
      retry.addEventListener('click', function () { controller.retry(); });
      stateBox.appendChild(stateText);
      stateBox.appendChild(retry);

      var toolbar = el('div', 'subtitle-toolbar');
      toolbar.setAttribute('id', 'subtitle-toolbar');
      toolbar.setAttribute('hidden', 'true');
      var search = doc.createElement('input');
      search.setAttribute('type', 'search');
      search.setAttribute('class', 'subtitle-search');
      search.setAttribute('id', 'subtitle-search');
      search.setAttribute('data-i18n-placeholder', 'subtitle.search.placeholder');
      search.setAttribute('placeholder', t('subtitle.search.placeholder'));
      search.setAttribute('aria-label', t('subtitle.search.placeholder'));
      search.addEventListener('input', function () {
        state.query = String(search.value || '').toLowerCase();
        renderRows();
      });
      var count = el('span', 'subtitle-count', '');
      count.setAttribute('id', 'subtitle-count');
      toolbar.appendChild(search);
      toolbar.appendChild(count);

      var rows = el('div', 'subtitle-rows');
      rows.setAttribute('id', 'subtitle-rows');

      var selectedBox = el('div', 'subtitle-selected');
      selectedBox.setAttribute('id', 'subtitle-selected');
      selectedBox.setAttribute('hidden', 'true');
      var selectedLabel = el('span', 'subtitle-selected-label', t('subtitle.selected.label'));
      selectedLabel.setAttribute('data-i18n', 'subtitle.selected.label');
      var chips = el('div', 'subtitle-chips');
      chips.setAttribute('id', 'subtitle-chips');
      selectedBox.appendChild(selectedLabel);
      selectedBox.appendChild(chips);

      var optionsBox = el('div', 'subtitle-options');
      optionsBox.setAttribute('id', 'subtitle-options');
      optionsBox.setAttribute('hidden', 'true');

      // Mode: external file vs embedded soft subtitle.
      var modeSet = el('fieldset', 'subtitle-mode');
      var legend = el('legend', '', t('subtitle.mode.legend'));
      legend.setAttribute('data-i18n', 'subtitle.mode.legend');
      modeSet.appendChild(legend);
      function radio(id, value, labelKey, checked) {
        var label = doc.createElement('label');
        var input = doc.createElement('input');
        input.setAttribute('type', 'radio');
        input.setAttribute('name', 'subtitle-mode');
        input.setAttribute('id', id);
        input.setAttribute('value', value);
        if (checked) input.setAttribute('checked', 'checked');
        input.checked = !!checked;
        input.addEventListener('change', function () {
          if (!input.checked) return;
          state.embed = value === 'embed';
          renderOptions();
        });
        var span = el('span', '', t(labelKey));
        span.setAttribute('data-i18n', labelKey);
        label.appendChild(input);
        label.appendChild(span);
        modeSet.appendChild(label);
        return input;
      }
      refs.external = radio('subtitle-mode-external', 'external', 'subtitle.mode.external', true);
      refs.embed = radio('subtitle-mode-embed', 'embed', 'subtitle.mode.embed', false);
      optionsBox.appendChild(modeSet);

      // Output format (post-download conversion target, NOT a source track pick).
      var convertLabel = doc.createElement('label');
      var convertSpan = el('span', '', t('subtitle.convert.label'));
      convertSpan.setAttribute('data-i18n', 'subtitle.convert.label');
      var convert = doc.createElement('select');
      convert.setAttribute('id', 'subtitle-convert');
      convert.setAttribute('aria-label', t('subtitle.convert.label'));
      CONVERT_VALUES.forEach(function (value) {
        var opt = doc.createElement('option');
        opt.setAttribute('value', value);
        opt.textContent = t(value === 'none' ? 'subtitle.convert.none' : 'subtitle.convert.' + value);
        opt.setAttribute('data-i18n', value === 'none' ? 'subtitle.convert.none' : 'subtitle.convert.' + value);
        convert.appendChild(opt);
      });
      convert.value = 'none';
      convert.addEventListener('change', function () {
        state.convertTo = CONVERT_VALUES.indexOf(convert.value) === -1 ? 'none' : convert.value;
        renderWarnings();
      });
      convertLabel.appendChild(convertSpan);
      convertLabel.appendChild(convert);
      optionsBox.appendChild(convertLabel);
      refs.convert = convert;

      function check(id, labelKey, onChange) {
        var label = doc.createElement('label');
        var input = doc.createElement('input');
        input.setAttribute('type', 'checkbox');
        input.setAttribute('id', id);
        input.checked = false;
        input.addEventListener('change', function () { onChange(input.checked); });
        var span = el('span', '', t(labelKey));
        span.setAttribute('data-i18n', labelKey);
        label.appendChild(input);
        label.appendChild(span);
        optionsBox.appendChild(label);
        return input;
      }
      refs.automatic = check('subtitle-automatic', 'subtitle.automatic', function (on) {
        state.includeAutomatic = on;
        renderWarnings();
        syncConfirm();
      });
      refs.keep = check('subtitle-keep', 'subtitle.keep', function (on) { state.keepFile = on; });

      var warning = el('div', 'subtitle-warning');
      warning.setAttribute('id', 'subtitle-warning');
      warning.setAttribute('role', 'note');
      warning.setAttribute('hidden', 'true');

      var note = el('p', 'subtitle-note', t('subtitle.note'));
      note.setAttribute('data-i18n', 'subtitle.note');

      body.appendChild(stateBox);
      body.appendChild(toolbar);
      body.appendChild(rows);
      body.appendChild(selectedBox);
      body.appendChild(optionsBox);
      body.appendChild(warning);
      body.appendChild(note);

      var actions = el('div', 'modal-actions subtitle-actions');
      var clearBtn = el('button', '', t('subtitle.clear'));
      clearBtn.setAttribute('type', 'button');
      clearBtn.setAttribute('id', 'subtitle-clear');
      clearBtn.setAttribute('data-i18n', 'subtitle.clear');
      clearBtn.addEventListener('click', function () { controller.clearSelection(); });
      var cancelBtn = el('button', '', t('subtitle.cancel'));
      cancelBtn.setAttribute('type', 'button');
      cancelBtn.setAttribute('id', 'subtitle-cancel');
      cancelBtn.setAttribute('data-i18n', 'subtitle.cancel');
      // Cancel ONLY releases the ticket. It must never create a download task.
      cancelBtn.addEventListener('click', function () { controller.cancel(); });
      var confirmBtn = el('button', 'primary', t('subtitle.confirm'));
      confirmBtn.setAttribute('type', 'button');
      confirmBtn.setAttribute('id', 'subtitle-confirm');
      confirmBtn.setAttribute('data-i18n', 'subtitle.confirm');
      confirmBtn.disabled = true;
      confirmBtn.addEventListener('click', function () { controller.confirm(); });
      actions.appendChild(clearBtn);
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);

      modal.appendChild(head);
      modal.appendChild(media);
      modal.appendChild(alertBox);
      modal.appendChild(body);
      modal.appendChild(actions);
      backdrop.appendChild(modal);

      backdrop.addEventListener('click', function (event) {
        if (event && event.target === backdrop) controller.cancel();
      });
      // Esc / close button must use the SAME cancel path: release the ticket,
      // never enqueue. A bare `hide()` here would leak the preview ticket.
      if (doc.addEventListener) {
        doc.addEventListener('keydown', function (event) {
          if (!event || event.key !== 'Escape' || backdrop.getAttribute('hidden') === 'true') return;
          controller.cancel();
        });
      }

      refs.backdrop = backdrop;
      refs.modal = modal;
      refs.media = media;
      refs.alert = alertBox;
      refs.stateBox = stateBox;
      refs.stateText = stateText;
      refs.retry = retry;
      refs.toolbar = toolbar;
      refs.rows = rows;
      refs.count = count;
      refs.selectedBox = selectedBox;
      refs.chips = chips;
      refs.options = optionsBox;
      refs.warning = warning;
      refs.confirm = confirmBtn;
      return backdrop;
    }

    // ---- rendering -------------------------------------------------------
    function selectedCodes() {
      var out = [];
      (state.preview ? state.preview.tracks : []).forEach(function (track) {
        if (state.selected[track.languageCode]) out.push(track.languageCode);
      });
      return out.slice(0, MAX_LANGUAGES);
    }

    function renderRows() {
      var rows = refs.rows;
      if (!rows) return;
      rows.textContent = '';
      if (state.phase !== 'ready' || !state.preview) return;
      var needle = state.query;
      var shown = 0;
      state.preview.tracks.forEach(function (track) {
        var code = track.languageCode;
        var label = trackLabel(track);
        if (needle && (code + ' ' + label).toLowerCase().indexOf(needle) === -1) return;
        shown += 1;
        var formats = usableFormats(track);
        var noFormat = formats.length === 0;

        var row = el('label', 'subtitle-row');
        row.setAttribute('data-language', code);
        row.setAttribute('data-selected', state.selected[code] ? 'true' : 'false');
        row.setAttribute('data-disabled', noFormat ? 'true' : 'false');

        var box = doc.createElement('input');
        box.setAttribute('type', 'checkbox');
        box.setAttribute('value', code);
        box.checked = !!state.selected[code];
        if (noFormat) box.setAttribute('disabled', 'disabled');
        box.disabled = noFormat;
        box.addEventListener('change', function () {
          if (noFormat) return;
          var picked = selectedCodes();
          if (box.checked && picked.length >= MAX_LANGUAGES && !state.selected[code]) {
            box.checked = false;
            // The status line sits behind the modal, so the reason must ALSO
            // be visible inside it; otherwise the checkbox looks broken.
            state.limitHit = true;
            setAlert(null);
            refs.alert.textContent = t('subtitle.limit', { n: MAX_LANGUAGES });
            refs.alert.setAttribute('data-tone', 'info');
            show(refs.alert, true);
            notify(t('subtitle.limit', { n: MAX_LANGUAGES }));
            return;
          }
          clearLimitHint();
          if (box.checked) state.selected[code] = true;
          else delete state.selected[code];
          renderRows();
          renderChips();
          renderWarnings();
          syncConfirm();
        });

        var main = el('div', 'subtitle-row-main');
        main.appendChild(el('span', 'subtitle-row-code', code));
        if (track.languageName) main.appendChild(el('span', 'subtitle-row-name', label));
        var sources = el('div', 'subtitle-sources');
        if (track.manualAvailable) {
          var manual = el('span', 'subtitle-source', t('subtitle.source.manual') +
            (track.manualFormats.length ? ' · ' + track.manualFormats.join(', ') : ''));
          manual.setAttribute('data-source', 'manual');
          sources.appendChild(manual);
        }
        if (track.automaticAvailable) {
          var automatic = el('span', 'subtitle-source', t('subtitle.source.automatic') +
            (track.automaticFormats.length ? ' · ' + track.automaticFormats.join(', ') : ''));
          automatic.setAttribute('data-source', 'automatic');
          sources.appendChild(automatic);
        }
        if (noFormat) {
          var none = el('span', 'subtitle-source', t('subtitle.format.unavailable'));
          none.setAttribute('data-source', 'none');
          sources.appendChild(none);
        }
        main.appendChild(sources);
        row.appendChild(box);
        row.appendChild(main);
        rows.appendChild(row);
      });
      if (shown === 0) {
        var emptyRow = el('p', 'subtitle-note', t('subtitle.search.empty'));
        rows.appendChild(emptyRow);
      }
    }

    function renderChips() {
      var codes = selectedCodes();
      refs.chips.textContent = '';
      show(refs.selectedBox, codes.length > 0);
      codes.forEach(function (code) {
        var chip = el('span', 'subtitle-chip-item', code);
        var remove = el('button', '', '×');
        remove.setAttribute('type', 'button');
        remove.setAttribute('aria-label', t('subtitle.remove.aria', { code: code }));
        remove.addEventListener('click', function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          delete state.selected[code];
          clearLimitHint();
          renderRows();
          renderChips();
          renderWarnings();
          syncConfirm();
        });
        chip.appendChild(remove);
        refs.chips.appendChild(chip);
      });
      setText(refs.count, t('subtitle.count', { n: codes.length }));
    }

    function renderOptions() {
      if (!refs.embed) return;
      var audio = getKind() === 'audio';
      refs.embed.disabled = audio;
      if (audio && state.embed) {
        state.embed = false;
        refs.embed.checked = false;
        refs.external.checked = true;
      }
      if (refs.keep) {
        refs.keep.disabled = !state.embed;
        if (!state.embed) { refs.keep.checked = false; state.keepFile = false; }
      }
      refs.automatic.checked = state.includeAutomatic;
      refs.embed.checked = state.embed;
      refs.external.checked = !state.embed;
      refs.keep.checked = state.keepFile;
      renderWarnings();
    }

    function renderWarnings() {
      if (!refs.warning) return;
      var messages = [];
      if (requiresAutomatic()) messages.push(t('subtitle.warn.automaticRequired'));
      var audio = getKind() === 'audio';
      if (state.embed) {
        messages.push(t('subtitle.warn.container'));
        var codes = selectedCodes();
        var manualOnly = state.preview && codes.every(function (code) {
          var track = findTrack(code);
          return track ? !track.manualAvailable : true;
        });
        if (codes.length > 0 && manualOnly) messages.push(t('subtitle.warn.embedAuto'));
        messages.push(t('subtitle.warn.embedKeep'));
      }
      if (audio) messages.push(t('subtitle.warn.audio'));
      if (state.convertTo !== 'none') {
        var picked = selectedCodes();
        var convertible = picked.length > 0 && picked.every(function (code) {
          var track = findTrack(code);
          return track ? usableFormats(track).length > 0 : false;
        });
        if (!convertible) messages.push(t('subtitle.warn.format', { format: state.convertTo.toUpperCase() }));
      }
      if (messages.length === 0) {
        show(refs.warning, false);
        refs.warning.textContent = '';
        return;
      }
      refs.warning.textContent = messages.join(' ');
      show(refs.warning, true);
    }

    function findTrack(code) {
      var found = null;
      (state.preview ? state.preview.tracks : []).forEach(function (track) {
        if (track.languageCode === code) found = track;
      });
      return found;
    }

    function requiresAutomatic() {
      return !state.includeAutomatic && selectedCodes().some(function (code) {
        var track = findTrack(code);
        return track && !track.manualAvailable;
      });
    }

    function syncConfirm() {
      if (refs.confirm) refs.confirm.disabled = !(state.phase === 'ready' && selectedCodes().length > 0 && !state.loading && !requiresAutomatic());
    }

    function renderChip() {
      if (!refs.chip) return;
      var sel = state.confirmed;
      if (!sel) {
        show(refs.chip, false);
        refs.chip.setAttribute('data-state', 'none');
        if (refs.button) refs.button.setAttribute('aria-pressed', 'false');
        return;
      }
      refs.chip.setAttribute('data-state', 'active');
      setText(refs.chipLabel, t('subtitle.chip', { n: sel.subtitleLanguages.length, mode: sel.subtitleEmbed ? t('subtitle.mode.embed') : t('subtitle.mode.external') }));
      show(refs.chip, true);
      if (refs.button) refs.button.setAttribute('aria-pressed', 'true');
    }

    function setAlert(key, tone) {
      if (!refs.alert) return;
      if (!key) { show(refs.alert, false); refs.alert.textContent = ''; return; }
      refs.alert.textContent = t(key);
      refs.alert.setAttribute('data-tone', tone || 'info');
      show(refs.alert, true);
    }

    /** The max-languages hint is transient; any successful edit clears it. */
    function clearLimitHint() {
      if (!state.limitHit) return;
      state.limitHit = false;
      setAlert(state.errorKey, state.phase === 'error' ? 'error' : 'info');
    }

    function render() {
      var phase = state.phase;
      refs.modal.setAttribute('data-phase', phase);
      refs.stateBox.setAttribute('data-state', phase);
      var keys = {
        idle: 'subtitle.state.idle',
        loading: 'subtitle.state.loading',
        ready: 'subtitle.state.ready',
        empty: 'subtitle.state.empty',
        error: 'subtitle.state.error',
        expired: 'subtitle.state.expired',
        stale: 'subtitle.state.stale'
      };
      setText(refs.stateText, t(keys[phase] || 'subtitle.state.idle'));
      show(refs.retry, phase === 'error' || phase === 'expired' || phase === 'stale');
      var ready = phase === 'ready';
      show(refs.toolbar, ready);
      show(refs.selectedBox, ready && selectedCodes().length > 0);
      show(refs.options, ready);
      if (state.errorKey) setAlert(state.errorKey, phase === 'error' ? 'error' : 'info');
      else if (state.limitHit && ready) {
        refs.alert.textContent = t('subtitle.limit', { n: MAX_LANGUAGES });
        refs.alert.setAttribute('data-tone', 'info');
        show(refs.alert, true);
      } else setAlert(null);

      if (state.preview && state.preview.media) {
        var media = state.preview.media;
        var bits = [];
        if (media.title) bits.push(String(media.title));           // textContent: site text is not markup
        if (media.uploader) bits.push(String(media.uploader));
        if (typeof media.durationSec === 'number' && isFinite(media.durationSec)) {
          var total = Math.round(media.durationSec);
          bits.push(Math.floor(total / 60) + ':' + ('0' + (total % 60)).slice(-2));
        }
        setText(refs.media, bits.join(' · '));
        show(refs.media, bits.length > 0);
      } else {
        show(refs.media, false);
      }

      renderRows();
      renderChips();
      renderOptions();
      renderWarnings();
      syncConfirm();
      renderChip();
    }

    // ---- ticket + selection lifecycle ------------------------------------
    function releaseTicket(id) {
      if (!id) return;
      try {
        Promise.resolve(call('SUBTITLE_PREVIEW_CANCEL', { previewId: id })).catch(function () {});
      } catch (error) { /* best-effort cleanup; the 5 min TTL is the backstop */ }
    }

    function fail(code) {
      state.loading = false;
      state.limitHit = false;
      var dead = !!TICKET_DEAD[code];
      state.phase = dead ? (code === 'PREVIEW_EXPIRED' || code === 'PREVIEW_CONSUMED' || code === 'PREVIEW_REQUIRED' ? 'expired' : 'error') : 'error';
      state.errorKey = ERROR_KEYS[code] || 'subtitle.error.failed';
      // A dead ticket can never back a download: drop any confirmed selection too.
      if (dead) { state.confirmed = null; onSelectionChange(null); }
      render();
    }

    function applyPreview(dto) {
      state.preview = dto;
      state.selected = {};
      state.loading = false;
      state.errorKey = null;
      state.phase = dto.empty || !dto.tracks || dto.tracks.length === 0 ? 'empty' : 'ready';
      render();
    }

    function preview(url) {
      var seq = ++state.seq;
      state.loading = true;
      state.limitHit = false;
      state.phase = 'loading';
      state.errorKey = null;
      state.url = url;
      render();
      var previous = state.preview && state.preview.previewId ? state.preview.previewId : '';
      var payload = { url: url };
      if (previous) payload.previousPreviewId = previous;
      Promise.resolve(call('SUBTITLE_PREVIEW', payload)).then(function (result) {
        if (seq !== state.seq) {                       // stale / out-of-order response
          if (result && result.ok && result.preview) releaseTicket(result.preview.previewId);
          return;
        }
        if (getUrl() !== url) {                       // URL changed mid-flight
          state.phase = 'stale';
          state.loading = false;
          state.errorKey = 'subtitle.error.stale';
          if (result && result.ok && result.preview) releaseTicket(result.preview.previewId);
          render();
          return;
        }
        if (!result || result.ok !== true) {
          fail(result && result.code ? result.code : 'PREVIEW_FAILED');
          return;
        }
        applyPreview(result.preview);
      }).catch(function () {
        if (seq !== state.seq) return;
        fail('PREVIEW_FAILED');
      });
    }

    // ---- public controller ----------------------------------------------
    controller.mount = function (anchor, cssHref, before) {
      if (mounted) return;
      mounted = true;
      if (cssHref && doc.createElement) {
        var link = doc.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', cssHref);
        if (doc.head && doc.head.appendChild) doc.head.appendChild(link);
      }
      refs.button = buildButton();
      refs.chip = buildChip();
      var modal = buildModal();
      if (anchor && anchor.appendChild) {
        // Real page: put the entry immediately before "Start download", i.e. in
        // the URL input row. The fake DOM used by unit tests has no
        // insertBefore, so appendChild is the deterministic fallback there.
        if (before && typeof anchor.insertBefore === 'function') {
          anchor.insertBefore(refs.button, before);
          anchor.insertBefore(refs.chip, before);
        } else {
          anchor.appendChild(refs.button);
          anchor.appendChild(refs.chip);
        }
      }
      if (doc.body && doc.body.appendChild) doc.body.appendChild(modal);
      render();
    };

    controller.open = function () {
      var url = String(getUrl() || '').trim();
      show(refs.backdrop, true);
      if (!isHttpUrl(url)) {
        state.phase = 'error';
        state.errorKey = 'subtitle.error.invalidUrl';
        state.preview = null;
        render();
        return;
      }
      // Restore a still-valid confirmed selection into the draft without probing.
      if (state.confirmed && state.confirmed.url === url && !isExpired(state.confirmed.expiresAt, now())) {
        state.phase = 'ready';
        state.selected = {};
        state.confirmed.subtitleLanguages.forEach(function (code) { state.selected[code] = true; });
        state.includeAutomatic = state.confirmed.subtitleAutoCaptions;
        state.convertTo = state.confirmed.subtitleConvertTo;
        state.embed = state.confirmed.subtitleEmbed;
        state.keepFile = state.confirmed.subtitleKeepFile;
        if (refs.convert) refs.convert.value = state.convertTo;
        if (refs.automatic) refs.automatic.checked = state.includeAutomatic;
        if (refs.keep) refs.keep.checked = state.keepFile;
        if (refs.external) refs.external.checked = !state.embed;
        if (refs.embed) refs.embed.checked = state.embed;
        render();
        return;
      }
      preview(url);
    };

    controller.retry = function () { controller.clearSelection(); controller.open(); };

    controller.cancel = function () {
      var ticket = state.preview && state.preview.previewId ? state.preview.previewId : null;
      // A confirmed choice keeps its ticket (the user may still download).
      var keepTicket = state.confirmed && state.confirmed.previewId === ticket;
      state.seq += 1;                 // discard any in-flight response
      state.loading = false;
      if (!keepTicket && ticket) {
        releaseTicket(ticket);
        state.preview = null;
        state.selected = {};
      }
      state.errorKey = null;
      state.phase = state.confirmed ? 'ready' : 'idle';
      show(refs.backdrop, false);
      render();
      if (!state.confirmed) notify(t('subtitle.notify.cancelled'));
    };

    controller.clearSelection = function () {
      state.seq += 1;
      state.loading = false;
      var ticket = state.preview && state.preview.previewId ? state.preview.previewId : null;
      state.confirmed = null;
      state.selected = {};
      state.preview = null;
      state.phase = 'idle';
      state.errorKey = null;
      state.limitHit = false;
      state.embed = false;
      state.includeAutomatic = false;
      state.keepFile = false;
      state.convertTo = 'none';
      state.query = '';
      if (ticket) releaseTicket(ticket);
      onSelectionChange(null);
      if (refs.convert) refs.convert.value = 'none';
      render();
    };

    controller.confirm = function () {
      var codes = selectedCodes();
      if (state.phase !== 'ready' || codes.length === 0 || state.loading || requiresAutomatic()) return;
      var url = String(getUrl() || '').trim();
      if (!state.preview || state.url !== url || isExpired(state.preview.expiresAt, now())) {
        state.phase = 'expired';
        state.errorKey = 'subtitle.error.expired';
        state.confirmed = null;
        onSelectionChange(null);
        render();
        notify(t('subtitle.notify.expired'));
        return;
      }
      state.confirmed = {
        url: url,                                  // main-memory only, never rendered
        previewId: state.preview.previewId,
        expiresAt: state.preview.expiresAt,
        subtitleLanguages: codes,
        subtitleAutoCaptions: !!state.includeAutomatic,
        subtitleConvertTo: state.convertTo,
        subtitleEmbed: !!state.embed,
        subtitleKeepFile: !!state.embed && !!state.keepFile
      };
      show(refs.backdrop, false);
      render();
      onSelectionChange(state.confirmed);
      notify(t('subtitle.notify.confirmed', { n: codes.length }));
    };

    /** Selection keys, null if unselected, or false if submission must stop. */
    controller.getSelection = function () {
      var sel = state.confirmed;
      if (!sel) return null;
      var url = String(getUrl() || '').trim();
      // Enqueue-time mismatch: never send a ticket that belongs to another URL.
      if (sel.url !== url || isExpired(sel.expiresAt, now())) {
        state.phase = sel.url !== url ? 'stale' : 'expired';
        state.errorKey = sel.url !== url ? 'subtitle.error.stale' : 'subtitle.error.expired';
        render();
        show(refs.backdrop, true);
        notify(t(state.errorKey));
        return false;
      }
      return {
        previewId: sel.previewId,
        subtitleLanguages: sel.subtitleLanguages.slice(),
        subtitleAutoCaptions: sel.subtitleAutoCaptions,
        subtitleConvertTo: sel.subtitleConvertTo,
        subtitleEmbed: sel.subtitleEmbed,
        subtitleKeepFile: sel.subtitleKeepFile
      };
    };

    /** Called after DOWNLOAD_START. A consumed/dead ticket must be forgotten. */
    controller.onEnqueueResult = function (result) {
      if (result && result.accepted === true && result.enqueued === true) {
        // The main process consumed the one-shot ticket; nothing to cancel.
        state.preview = null;
        controller.clearSelection();
        return null;
      }
      var code = result && result.code;
      if (state.confirmed && (code === 'SUBTITLE_NO_MANUAL_TRACK' || (code && TICKET_DEAD[code]) || !result || result.enqueued !== true)) {
        state.confirmed.expiresAt = '1970-01-01T00:00:00.000Z';
        state.preview = null;
        state.phase = 'expired';
        state.errorKey = ERROR_KEYS[code] || 'subtitle.error.expired';
        onSelectionChange(state.confirmed);
        render();
        return t(state.errorKey);
      }
      return null;
    };

    /** URL edit invalidates every old preview and selection. */
    controller.onUrlChanged = function (url) {
      var next = String(url || '').trim();
      // Nothing to invalidate after a completed download / explicit clear: just
      // track the new URL, do not paint a bogus "stale" state on the next run.
      if (!state.preview && !state.confirmed && !state.loading) {
        state.url = next;
        return false;
      }
      if (state.url && next !== state.url) {
        state.seq += 1;
        state.loading = false;
        state.confirmed = null;
        state.selected = {};
        if (state.preview && state.preview.previewId) releaseTicket(state.preview.previewId);
        state.preview = null;
        state.phase = 'stale';
        state.errorKey = 'subtitle.error.stale';
        state.url = next;
        onSelectionChange(null);
        render();
        return true;
      }
      state.url = next;
      return false;
    };

    controller.setKind = function () {
      renderOptions();
      if (getKind() === 'audio' && state.confirmed && state.confirmed.subtitleEmbed) {
        state.confirmed.subtitleEmbed = false;
        state.confirmed.subtitleKeepFile = false;
        renderChip();
        onSelectionChange(state.confirmed);
        notify(t('subtitle.notify.audioExternal'));
      }
    };

    /** Test/layout hook: render a whitelisted DTO without any IPC. */
    controller.renderPreview = function (dto) {
      state.url = String(getUrl() || '').trim();
      applyPreview(dto);
      show(refs.backdrop, true);
    };
    controller.state = state;
    controller.refs = refs;
    controller.close = function () { show(refs.backdrop, false); };
    return controller;
  }

  YTVDLT.subtitles = {
    create: create,
    isHttpUrl: isHttpUrl,
    isExpired: isExpired,
    usableFormats: usableFormats,
    MAX_LANGUAGES: MAX_LANGUAGES,
    CONVERT_VALUES: CONVERT_VALUES,
    ERROR_KEYS: ERROR_KEYS
  };
})(typeof window === 'undefined' ? this : window);
