/**
 * supported-sites.js — "支持的网站 / Supported sites" panel (D-134 A).
 *
 * WHAT THIS PANEL IS FOR: answering "can this engine parse my site?" from the
 * ENGINE ITSELF, so the answer cannot go stale the way a wiki page or a shipped
 * list does. The numbers on screen are the running engine's own counts.
 *
 * WHY IT IS LOADED AT RUNTIME ONLY IN LIVE MODE: the frozen screenshot
 * baselines are a fixed 1280x800 frame; injecting a new button into the static
 * preview would change every queue baseline. `ensure()` mirrors the txt-import /
 * playlist-import pattern exactly for that reason.
 *
 * WHAT IT MUST NEVER DO: ship a fallback list. If the engine cannot be asked,
 * the panel says so — a plausible-looking stale list is indistinguishable from
 * a correct one, which is precisely the failure this feature exists to remove.
 * There is no literal site name anywhere in this file.
 *
 * The GenericIE row is singled out on purpose: `generic` means "the engine will
 * ATTEMPT any page", which reads like universal support on a naive list. The
 * note says what it actually means.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});

  /** How many rows are painted per page. The engine lists ~1,750 entries. */
  var PAGE_SIZE = 60;

  function create(options) {
    var doc = options.doc;
    var t = options.t;
    var call = options.call;

    var entry = null;
    var overlay = null;
    var listBox = null;
    var statusBox = null;
    var summaryBox = null;
    var noteBox = null;
    var searchBox = null;
    var sortSelect = null;
    var refreshButton = null;

    var rows = [];
    var view = [];
    var shown = 0;
    var sortMode = 'name';
    var loading = false;
    /** The whole panel is unusable until a real answer (or a real failure) lands. */
    var state = 'idle';

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function close() {
      if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.removeChild(overlay);
      overlay = null;
      listBox = null;
      statusBox = null;
      summaryBox = null;
      noteBox = null;
      searchBox = null;
      sortSelect = null;
      refreshButton = null;
    }

    function shell() {
      if (overlay !== null) return overlay;
      overlay = el('div', 'sites-overlay');
      overlay.setAttribute('id', 'supported-sites-dialog');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.addEventListener('click', function (event) {
        if (event && event.target === overlay) close();
      });

      var panel = el('div', 'sites-panel');
      var head = el('div', 'sites-head');
      head.appendChild(el('h2', 'sites-title', t('sites.title')));

      var controls = el('div', 'sites-controls');
      searchBox = doc.createElement('input');
      searchBox.setAttribute('type', 'search');
      searchBox.setAttribute('id', 'sites-search');
      searchBox.setAttribute('placeholder', t('sites.search'));
      searchBox.addEventListener('input', function () { apply(); });

      sortSelect = doc.createElement('select');
      sortSelect.setAttribute('id', 'sites-sort');
      var sorts = [['name', 'sites.sort.name'], ['broken', 'sites.sort.broken']];
      for (var i = 0; i < sorts.length; i += 1) {
        var option = doc.createElement('option');
        option.setAttribute('value', sorts[i][0]);
        option.textContent = t(sorts[i][1]);
        sortSelect.appendChild(option);
      }
      sortSelect.addEventListener('change', function () {
        sortMode = String(sortSelect.value || 'name');
        apply();
      });

      refreshButton = doc.createElement('button');
      refreshButton.setAttribute('type', 'button');
      refreshButton.setAttribute('id', 'sites-refresh');
      refreshButton.className = 'sites-refresh';
      refreshButton.textContent = t('sites.refresh');
      refreshButton.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        load(true);
      });

      controls.appendChild(searchBox);
      controls.appendChild(sortSelect);
      controls.appendChild(refreshButton);
      head.appendChild(controls);

      var closeButton = el('button', 'sites-close', '×');
      closeButton.setAttribute('type', 'button');
      closeButton.setAttribute('aria-label', t('sites.close'));
      closeButton.addEventListener('click', function () { close(); });
      head.appendChild(closeButton);

      summaryBox = el('p', 'sites-summary', '');
      noteBox = el('p', 'sites-note', '');
      noteBox.setAttribute('id', 'sites-generic-note');
      statusBox = el('div', 'sites-status', '');
      statusBox.setAttribute('id', 'sites-status');
      listBox = el('ul', 'sites-list', '');
      listBox.setAttribute('id', 'sites-list');

      panel.appendChild(head);
      panel.appendChild(summaryBox);
      panel.appendChild(noteBox);
      panel.appendChild(statusBox);
      panel.appendChild(listBox);
      overlay.appendChild(panel);
      doc.body.appendChild(overlay);
      return overlay;
    }

    /** Stable failure copy. A failure is never rendered as an empty list. */
    function failureText(code) {
      if (code === 'ENGINE_TIMEOUT') return t('sites.error.timeout');
      if (code === 'ENGINE_UNAVAILABLE') return t('sites.error.unavailable');
      if (code === 'ENGINE_EMPTY') return t('sites.error.empty');
      if (code === 'OUTPUT_LIMIT_EXCEEDED') return t('sites.error.tooLarge');
      return t('sites.error.failed');
    }

    function apply() {
      if (listBox === null) return;
      var needle = searchBox === null ? '' : String(searchBox.value || '').trim().toLowerCase();
      var filtered = needle === ''
        ? rows.slice()
        : rows.filter(function (row) {
          return String(row.name || '').toLowerCase().indexOf(needle) !== -1;
        });
      if (sortMode === 'broken') {
        // Broken first, then engine order. `false < true`, so compare by the
        // negation to put the engine's own broken flag on top.
        filtered.sort(function (a, b) {
          var left = a.broken === true ? 0 : 1;
          var right = b.broken === true ? 0 : 1;
          return left - right;
        });
      } else {
        filtered.sort(function (a, b) {
          return String(a.name).localeCompare(String(b.name));
        });
      }
      view = filtered;
      shown = 0;
      listBox.textContent = '';
      if (filtered.length === 0) {
        statusBox.textContent = t('sites.emptyFilter');
        return;
      }
      statusBox.textContent = '';
      paint(false);
    }

    function paint(append) {
      if (listBox === null) return;
      var end = Math.min(view.length, shown + PAGE_SIZE);
      for (var i = shown; i < end; i += 1) {
        listBox.appendChild(rowNode(view[i]));
      }
      shown = end;
      if (shown < view.length) {
        var more = el('li', 'sites-more', t('sites.more', { count: view.length - shown }));
        more.setAttribute('id', 'sites-more');
        more.addEventListener('click', function () {
          if (more.parentNode !== null) more.parentNode.removeChild(more);
          paint(true);
        });
        listBox.appendChild(more);
      }
      if (!append) {
        // Screen readers and the summary both need to know how much is on screen.
        if (summaryBox !== null) {
          summaryBox.setAttribute('data-shown', String(shown));
        }
      }
    }

    function rowNode(row) {
      var item = el('li', 'sites-row');
      item.setAttribute('data-name', String(row.name));
      if (row.parent) item.setAttribute('data-parent', String(row.parent));
      if (row.broken === true) item.setAttribute('data-broken', '1');
      if (row.isGeneric === true) item.setAttribute('data-generic', '1');
      item.appendChild(el('span', 'sites-name', String(row.name)));
      if (row.parent) item.appendChild(el('span', 'sites-parent', String(row.parent)));
      if (row.broken === true) item.appendChild(el('span', 'sites-broken', t('sites.broken')));
      if (row.isGeneric === true) item.appendChild(el('span', 'sites-generic', t('sites.genericBadge')));
      return item;
    }

    function renderSummary(payload) {
      if (summaryBox === null) return;
      var version = payload.engineVersion === '' ? t('sites.version.unknown') : payload.engineVersion;
      summaryBox.textContent = payload.cached === true
        ? t('sites.summary.cached', {
          version: version,
          sites: payload.siteCount,
          subs: payload.subExtractorCount,
        })
        : t('sites.summary', {
          version: version,
          sites: payload.siteCount,
          subs: payload.subExtractorCount,
        });
      if (noteBox !== null) {
        // The GenericIE note is shown ONLY when the engine actually reports
        // `generic`: a note about a row that is not there would be noise.
        if (payload.hasGeneric === true) {
          noteBox.textContent = t('sites.generic.note');
          noteBox.removeAttribute('hidden');
        } else {
          noteBox.textContent = '';
          noteBox.setAttribute('hidden', 'hidden');
        }
      }
    }

    /** D-190: terminal failure state, shared by an `ok:false` reply and a
     * rejected channel. A rejection used to leave `loading` stuck at true and
     * the refresh button disabled until the page was reloaded. */
    function fail(code) {
      loading = false;
      state = 'failed';
      rows = [];
      if (refreshButton !== null) refreshButton.disabled = false;
      if (statusBox !== null) statusBox.textContent = failureText(String(code || ''));
      // On failure the controls are disabled rather than left looking
      // functional: a search box over an empty list implies "no sites".
      if (searchBox !== null) searchBox.disabled = true;
      if (sortSelect !== null) sortSelect.disabled = true;
    }

    function load(force) {
      if (loading) return;
      loading = true;
      state = 'loading';
      shell();
      if (refreshButton !== null) refreshButton.disabled = true;
      if (statusBox !== null) statusBox.textContent = t('sites.loading');
      if (listBox !== null) listBox.textContent = '';
      if (summaryBox !== null) summaryBox.textContent = '';

      call('SUPPORTED_SITES', force === true ? { refresh: true } : {}).then(function (payload) {
        var data = payload || {};
        if (data.ok !== true) { fail(String(data.code || '')); return; }
        loading = false;
        state = 'ready';
        if (refreshButton !== null) refreshButton.disabled = false;
        if (searchBox !== null) searchBox.disabled = false;
        if (sortSelect !== null) sortSelect.disabled = false;
        rows = Array.isArray(data.rows) ? data.rows : [];
        renderSummary(data);
        apply();
      }).catch(function () { fail(''); });
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
      entry.setAttribute('id', 'queue-sites-entry');
      entry.className = 'sites-entry';
      entry.textContent = t('sites.entry');
      entry.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        shell();
        // The catalog is cached main-side, so re-opening is instant; a stale
        // answer is not served because the main process re-checks the engine
        // identity and the TTL on every call.
        if (state === 'idle' || state === 'failed') load(false);
      });
      anchor.parentNode.insertBefore(entry, anchor.nextSibling);
    }

    return {
      mount: mount,
      close: close,
      /** Test hooks: no production caller uses these. */
      open: function () { shell(); load(false); },
      isOpen: function () { return overlay !== null; },
      stateOf: function () { return state; },
      setSort: function (mode) { sortMode = mode; apply(); },
      setQuery: function (text) { if (searchBox !== null) searchBox.value = String(text); apply(); },
      rowCount: function () { return listBox === null ? 0 : listBox.querySelectorAll('.sites-row').length; },
      resize: function () { return PAGE_SIZE; }
    };
  }

  YTVDLT.supportedSites = { create: create, PAGE_SIZE: PAGE_SIZE };
})(window);
