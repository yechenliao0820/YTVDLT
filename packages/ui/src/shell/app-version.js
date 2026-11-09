/**
 * app-version.js — the ONE place the renderer learns which build is running
 * (D-114). Zero imports, no bundler, runs from `file://`.
 *
 * Why this file exists:
 *   The version used to travel only as `?v=` on the page URL. Every navigation
 *   that rebuilt a URL by hand (queue -> task detail -> queue) silently dropped
 *   it, and `about.js` then fell back to a hard-coded `0.2.2` — a number that
 *   was true four releases ago. The footer, Settings and the About box therefore
 *   told the user they were on 0.2.2 while 0.2.5 was running.
 *
 * Contract:
 *   - `?v=` is a first-paint hint ONLY: it avoids a visible "—" flash on the
 *     very first frame. It is never treated as proof.
 *   - `APP_INFO` (main process `app.getVersion()`) is the authoritative value.
 *     When it answers, it overwrites the hint — including when the two disagree.
 *   - When neither is available the label is `v—`, never a plausible old number.
 *   - `onChange()` lets an already-built dialog (the About box) repaint itself
 *     without a page reload.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var UNKNOWN = '—';
  var CHANNEL = 'ytvdlt:app:info';

  var state = { version: '', source: 'none', settled: false };
  var listeners = [];
  var asked = false;

  function param(name) {
    var search = global.location && typeof global.location.search === 'string'
      ? global.location.search : '';
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(search);
    return match === null ? '' : decodeURIComponent(match[1]);
  }

  function bridge() {
    var candidate = global.ytvdltBridge;
    return candidate && typeof candidate.invoke === 'function' ? candidate : null;
  }

  /** A version is usable when it is a non-empty, printable, short string. */
  function usable(value) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= 40
      && !/[\u0000-\u001f]/.test(value);
  }

  function version() {
    return state.version;
  }

  /** `v0.2.5`, or `v—` when nothing reliable is known. */
  function label() {
    return 'v' + (state.version === '' ? UNKNOWN : state.version);
  }

  function setText(id, text) {
    var node = doc === null || doc === undefined ? null : doc.getElementById(id);
    if (node !== null) node.textContent = text;
  }

  function paint() {
    var text = label();
    setText('queue-version', text);
    setText('settings-meta', text);
    setText('about-version', state.version === '' ? UNKNOWN : text);
    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('data-app-version', state.version);
    }
  }

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(state.version, label()); } catch (error) { /* a listener must not break the page */ }
    });
  }

  function apply(value, source) {
    if (!usable(value) || value === state.version) return false;
    state.version = value;
    state.source = source;
    paint();
    notify();
    return true;
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  /**
   * Ask the main process once. A missing bridge (static preview / screenshots)
   * or a failed call leaves the hint in place; it never invents a value.
   */
  function refresh() {
    if (asked) return Promise.resolve(state.version);
    var b = bridge();
    if (b === null) return Promise.resolve(state.version);
    asked = true;
    return Promise.resolve(b.invoke(CHANNEL, {}))
      .then(function (reply) {
        var value = reply && typeof reply === 'object' ? reply.version : '';
        state.settled = true;
        if (usable(value)) { apply(value, 'ipc'); return state.version; }
        // The host answered but could not state a version: drop the hint too,
        // otherwise the page would keep showing a value nobody vouched for.
        state.version = '';
        state.source = 'none';
        paint();
        notify();
        return '';
      })
      .catch(function () {
        // Bridge refused / channel unavailable: keep whatever the URL said.
        asked = false;
        return state.version;
      });
  }

  // First paint from the URL hint (may be empty).
  var hint = param('v');
  if (usable(hint)) state.version = hint;
  paint();

  global.YTVDLT = global.YTVDLT || {};
  global.YTVDLTAppVersion = {
    version: version,
    label: label,
    source: function () { return state.source; },
    settled: function () { return state.settled; },
    refresh: refresh,
    onChange: onChange,
    /** Used by navigation helpers: `?v=` copied onto every rebuilt URL. */
    query: function () { return state.version === '' ? '' : encodeURIComponent(state.version); },
  };

  // Ask immediately: the About dialog can be opened before the first poll.
  void refresh();
})(typeof window === 'undefined' ? this : window);
