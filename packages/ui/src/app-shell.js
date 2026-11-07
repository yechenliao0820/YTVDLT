/**
 * app-shell.js — shared page shell for the M5 surfaces (M5-1 / M5-2 / M5-3).
 *
 * Responsibilities (and nothing else):
 *   1. apply the theme (delegates to `theme/theme.js`);
 *   2. install the shortcut dispatcher (delegates to `shortcuts/shortcuts.js`)
 *      and route ids to page handlers;
 *   3. expose locale-aware label/format helpers so pages never hard-code a
 *      language ("task.state.*" comes from core's `stateLabelKey()`);
 *   4. `--url` / `Ctrl+Shift+V` prefill plumbing: the page hands over a URL and
 *      the shell focuses the paste box + emits `prefill` (no clipboard access:
 *      the preload/main process owns the real clipboard, A-4.1-02).
 *
 * Zero imports, no bundler, no `node:*` / `electron` — see check-layering.
 */
(function (global) {
  'use strict';

  var doc = global.document;

  function t(key, params) {
    var i18n = global.YTVDLT && global.YTVDLT.i18n;
    return i18n ? i18n.t(key, params) : key;
  }

  function stateLabel(state) {
    return t('task.state.' + String(state));
  }

  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    var total = Math.round(seconds);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var rest = total % 60;
    var pad = function (value) { return value < 10 ? '0' + value : String(value); };
    if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(rest);
    return minutes + ':' + pad(rest);
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

  function formatSpeed(bytesPerSecond) {
    if (typeof bytesPerSecond !== 'number' || !isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
    return formatBytes(bytesPerSecond) + '/s';
  }

  function formatEta(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    return formatDuration(seconds);
  }

  /**
   * Boot the shell: theme first (avoid a light flash), then shortcuts.
   * `handlers` maps a shortcut id to a function; unknown ids are ignored.
   */
  function boot(handlers) {
    var themeResult = null;
    if (global.YTVDLTTheme) themeResult = global.YTVDLTTheme.apply();
    var dispose = function noop() {};
    if (global.YTVDLT && global.YTVDLT.shortcuts) {
      var map = handlers !== null && typeof handlers === 'object' ? handlers : {};
      Object.keys(map).forEach(function (id) {
        global.YTVDLT.shortcuts.on(id, map[id]);
      });
      dispose = global.YTVDLT.shortcuts.install(doc);
    }
    return { theme: themeResult, dispose: dispose };
  }

  /** Fill the paste box with a deep-link / global-hotkey URL and fire `onSubmit`. */
  function prefill(url, options) {
    var input = doc ? doc.getElementById('queue-url') : null;
    if (input === null) return false;
    input.value = url;
    if (doc) {
      input.setAttribute('data-prefilled', 'true');
      if (typeof options === 'object' && options !== null && options.submit === true) {
        var form = doc.getElementById('queue-paste-form');
        if (form !== null && typeof form.dispatchEvent === 'function') {
          form.dispatchEvent(new global.Event('submit', { bubbles: true, cancelable: true }));
        }
      }
      // Screenshot suite passes `focus:false`: a blinking caret is not
      // deterministic in a headless capture.
      if (options !== null && typeof options === 'object' && options.focus !== false
        && typeof input.focus === 'function') input.focus();
    }
    return true;
  }

  /** URL arriving via `--url=` (cold start) or the global hotkey (A-4.1-02). */
  function prefillFromArgv(argv) {
    if (!global.YTVDLT || !global.YTVDLT.shortcuts) return null;
    var url = global.YTVDLT.shortcuts.extractDeepLink(argv);
    if (url === null) return null;
    prefill(url, { submit: true });
    return url;
  }

  global.YTVDLT = global.YTVDLT || {};
  global.YTVDLT.shell = {
    t: t,
    stateLabel: stateLabel,
    formatDuration: formatDuration,
    formatBytes: formatBytes,
    formatSpeed: formatSpeed,
    formatEta: formatEta,
    boot: boot,
    prefill: prefill,
    prefillFromArgv: prefillFromArgv
  };
})(typeof window === 'undefined' ? this : window);
