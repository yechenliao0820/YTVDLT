/**
 * dialog-state.js — native DOM state machine shared by all three dialogs.
 *
 * Four states: ready / empty / error / disabled (covers PRD §5.0 三态门禁).
 * Owns: confirm gating, search filtering, multi-select counting, data-*
 * rendering, inline errors, and the five-domain-isomorphic JSON writeback that
 * is serialized into `<pre id="ytvdlt-output">` for pure-TS contract tests.
 *
 * Classic script on purpose: `file://` pages cannot load ES modules under
 * Chrome's CORS rules. No imports, no node built-ins, no electron.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});
  var doc = global.document;

  var STATES = ['ready', 'empty', 'error', 'disabled'];
  var STATE_LABEL = {
    ready: '已就绪',
    empty: '没有可用数据',
    error: '解析失败，请重试',
    disabled: '当前模式不可选择'
  };

  /** Frozen five-domain defaults, isomorphic with packages/shared/src/request.ts. */
  var DEFAULT_DOMAINS = {
    format: {
      quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false
    },
    subtitle: {
      enabled: false, languages: 'en.*,.*-orig', autoCaptions: false,
      skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false
    },
    paths: {
      videoDir: 'C:/Videos', audioDir: 'C:/Music', commandDir: 'C:/Commands',
      privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
      outputTemplate: '%(title)s.%(ext)s', tempDir: ''
    },
    network: {
      rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
      ipv4Only: false, concurrentFragments: null, aria2cPath: null
    },
    advanced: {
      sponsorblockRemove: null, downloadSections: null, splitChapters: false,
      customTitle: null, debug: false, downloadArchive: null, customCommand: null
    }
  };

  function byId(id) { return doc.getElementById(id); }
  function text(id, value) {
    var node = byId(id);
    if (node !== null) node.textContent = String(value);
  }
  function attr(id, name, value) {
    var node = byId(id);
    if (node !== null) node.setAttribute(name, String(value));
  }
  function dataAttr(id, key, value) { attr(id, 'data-' + key, value); }
  function setBodyState(state) {
    if (doc.body !== null) doc.body.setAttribute('data-state', state);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  /** Merge a partial five-domain patch over the frozen defaults (never mutate). */
  function fiveDomainPatch(patch) {
    var out = clone(DEFAULT_DOMAINS);
    if (patch === null || typeof patch !== 'object') return out;
    Object.keys(out).forEach(function (domain) {
      var incoming = patch[domain];
      if (incoming !== null && typeof incoming === 'object') {
        Object.keys(incoming).forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(out[domain], key)) {
            out[domain][key] = incoming[key];
          }
        });
      }
    });
    return out;
  }

  function DialogState(config) {
    this.config = config || {};
    this.kind = this.config.kind || 'format';
    this.state = 'ready';
    this.reason = '';
    this.confirmed = false;
    this.selected = [];
    this.inlineError = '';
    this.warnings = [];
    this.payload = null;
    this.writeback = null;
    this.query = new URLSearchParams(global.location.search);
    this.onConfirm = null;
    this.onRender = null;
  }

  /** Load the L1 recorded fixture (URL keys already stripped). */
  DialogState.prototype.load = function () {
    this.payload = YTVDLT.loadProbeFixture(this.config.fixture);
    return this.payload;
  };

  DialogState.prototype.option = function (name, fallback) {
    return this.query.has(name) ? this.query.get(name) : fallback;
  };

  DialogState.prototype.setState = function (state, reason) {
    if (STATES.indexOf(state) === -1) throw new Error('unknown dialog state: ' + state);
    this.state = state;
    this.reason = reason || '';
    setBodyState(state);
    dataAttr('ytvdlt-dialog', 'state', state);
    text('ytvdlt-state-label', STATE_LABEL[state]);
    var banner = byId('ytvdlt-banner');
    if (banner !== null) {
      banner.setAttribute('data-visible', state === 'ready' ? 'false' : 'true');
      banner.textContent = state === 'ready' ? '' : (this.reason || STATE_LABEL[state]);
    }
    attr('ytvdlt-retry', 'hidden', state === 'error' ? 'false' : 'true');
    this.refreshGate();
    return this;
  };

  DialogState.prototype.setInlineError = function (message) {
    this.inlineError = message || '';
    var node = byId('ytvdlt-inline-error');
    if (node !== null) {
      node.textContent = this.inlineError;
      node.setAttribute('data-visible', this.inlineError === '' ? 'false' : 'true');
    }
    this.refreshGate();
    return this;
  };

  DialogState.prototype.clearInlineError = function () { return this.setInlineError(''); };

  DialogState.prototype.setWarnings = function (list) {
    this.warnings = list || [];
    text('ytvdlt-warnings', this.warnings.join(' / '));
    dataAttr('ytvdlt-dialog', 'warning-count', this.warnings.length);
    return this;
  };

  /**
   * Confirm gate: error / disabled / inline error / no selection => disabled.
   * An `empty` state may still confirm when the user supplied a valid manual
   * language expression (PRD §5.2「空态 + 允许手动输入表达式，表达式非空方可确认」).
   */
  DialogState.prototype.isConfirmAllowed = function () {
    return this.state !== 'error'
      && this.state !== 'disabled'
      && this.inlineError === ''
      && this.selected.length > 0;
  };

  DialogState.prototype.refreshGate = function () {
    var allowed = this.isConfirmAllowed();
    var button = byId('ytvdlt-confirm');
    if (button !== null) {
      button.setAttribute('aria-disabled', allowed ? 'false' : 'true');
      button.disabled = !allowed;
      button.setAttribute('data-confirm-state', allowed ? 'enabled' : 'disabled');
    }
    dataAttr('ytvdlt-dialog', 'confirm', allowed ? 'enabled' : 'disabled');
    return allowed;
  };

  DialogState.prototype.setSelected = function (ids) {
    this.selected = (ids || []).slice();
    text('ytvdlt-selected-count', this.selected.length);
    dataAttr('ytvdlt-dialog', 'selected-count', this.selected.length);
    this.refreshGate();
    return this;
  };

  DialogState.prototype.toggleSelected = function (id, single) {
    var index = this.selected.indexOf(id);
    if (single === true) {
      this.selected = index === -1 ? [id] : [];
    } else if (index === -1) {
      this.selected.push(id);
    } else {
      this.selected.splice(index, 1);
    }
    return this.setSelected(this.selected);
  };

  /** Render a filtered item list from a descriptor array. */
  DialogState.prototype.renderItems = function (containerId, items, searchTerm, renderOne) {
    var container = byId(containerId);
    if (container === null) return 0;
    var needle = (searchTerm || '').toLowerCase();
    var shown = 0;
    container.textContent = '';
    items.forEach(function (item) {
      var haystack = (item.searchText || '').toLowerCase();
      if (needle !== '' && haystack.indexOf(needle) === -1) return;
      container.appendChild(renderOne(item));
      shown += 1;
    });
    container.setAttribute('data-visible-count', shown);
    container.setAttribute('data-total-count', items.length);
    return shown;
  };

  /** Five-domain-isomorphic writeback; playlist writes ONLY selectedIds. */
  DialogState.prototype.buildWriteback = function (patch) {
    if (this.kind === 'playlist') {
      return {
        kind: 'playlist',
        confirmed: this.confirmed,
        state: this.state,
        selectedPlaylistIds: this.selected.slice()
      };
    }
    return {
      kind: this.kind,
      confirmed: this.confirmed,
      state: this.state,
      requestPatch: fiveDomainPatch(patch)
    };
  };

  DialogState.prototype.renderOutput = function (value) {
    var pre = byId('ytvdlt-output');
    if (pre !== null) pre.textContent = JSON.stringify(value, null, 2);
  };

  /** The ONLY confirm path (also used by the `autoconfirm=1` e2e hook). */
  DialogState.prototype.confirm = function (patch) {
    if (!this.isConfirmAllowed()) {
      this.renderOutput({ kind: this.kind, confirmed: false, state: this.state, reason: 'confirm-gate-closed' });
      return null;
    }
    this.confirmed = true;
    this.writeback = this.buildWriteback(patch);
    this.renderOutput(this.writeback);
    dataAttr('ytvdlt-dialog', 'confirmed', 'true');
    if (typeof this.onConfirm === 'function') this.onConfirm(this.writeback);
    // Playlist confirmation NEVER enqueues: A-M3-04 / D-38.
    if (YTVDLT.bridge && typeof YTVDLT.bridge.confirmDialog === 'function') {
      YTVDLT.bridge.confirmDialog(this.writeback);
    }
    return this.writeback;
  };

  /** Wire search / confirm / retry; then render once. */
  DialogState.prototype.start = function (renderFn, patchFn) {
    var self = this;
    this.load();
    var search = byId('ytvdlt-search');
    if (search !== null) {
      search.addEventListener('input', function () { renderFn(self, search.value); });
    }
    var confirmButton = byId('ytvdlt-confirm');
    if (confirmButton !== null) {
      confirmButton.addEventListener('click', function () {
        self.confirm(typeof patchFn === 'function' ? patchFn(self) : {});
      });
    }
    var retry = byId('ytvdlt-retry');
    if (retry !== null) {
      retry.addEventListener('click', function () {
        YTVDLT.bridge.invoke('PROBE', { url: '' });
        self.setInlineError('');
        self.setState('ready');
        renderFn(self, '');
      });
    }
    renderFn(this, '');
    if (this.onRender !== null && typeof this.onRender === 'function') this.onRender(this);
    // Deterministic e2e hook: exercises the SAME confirm() path as a click.
    if (this.option('autoconfirm', '0') === '1') {
      this.confirm(typeof patchFn === 'function' ? patchFn(this) : {});
    }
    return this;
  };

  YTVDLT.STATES = STATES;
  YTVDLT.DEFAULT_DOMAINS = DEFAULT_DOMAINS;
  YTVDLT.DialogState = DialogState;
  YTVDLT.createDialog = function (config) { return new DialogState(config); };
  YTVDLT.dom = {
    byId: byId, text: text, attr: attr, dataAttr: dataAttr,
    clone: clone, fiveDomainPatch: fiveDomainPatch
  };
})(window);
