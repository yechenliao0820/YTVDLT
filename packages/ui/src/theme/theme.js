/**
 * theme.js — Light / Dark / System + accent application (M5-1, A-4.4-20 / A-4.6-06).
 *
 * Zero imports on purpose (static pages, no bundler, no `node:*`):
 *   - the palette lives in `styles/theme.css`; this file only sets attributes
 *     on `<html>`, so CSS stays the single source of colour truth;
 *   - in the default state (no explicit setting, system = light) NOTHING is
 *     written to the DOM — that is what keeps the M3 screenshot baselines
 *     pixel-identical (see docs/M5-1-REPORT.md);
 *   - "dynamic colour" is implemented as "follow the OS accent": the injected
 *     `systemAccent` (read from the registry by the Electron bootstrap) wins
 *     over the built-in preset; a user hex always wins over both.
 *
 * Settings resolution order: URL query (`?theme=dark&accent=teal&motion=reduced`)
 * > injected `window.__YTVDLT_SETTINGS__` > defaults. The query form exists so
 * the headless screenshot suite can render every combination deterministically.
 */
(function (global) {
  'use strict';

  var PRESETS = ['blue', 'teal', 'violet', 'amber', 'rose'];
  var DEFAULT_ACCENT = 'blue';
  var HEX_RE = /^#?([0-9a-f]{6})$/i;

  function query(name) {
    if (!global.location || typeof global.location.search !== 'string') return '';
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search);
    return match === null ? '' : decodeURIComponent(match[1]);
  }

  function injected() {
    var value = global.__YTVDLT_SETTINGS__;
    return value !== null && typeof value === 'object' ? value : {};
  }

  function normalizeTheme(raw) {
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  }

  function normalizeMotion(raw) {
    return raw === 'reduced' || raw === 'full' ? raw : 'system';
  }

  /** `#RRGGBB` / `RRGGBB` -> `#rrggbb`; anything else -> null. */
  function normalizeHex(raw) {
    var match = HEX_RE.exec(String(raw === undefined || raw === null ? '' : raw).trim());
    return match === null ? null : '#' + match[1].toLowerCase();
  }

  function normalizeAccent(raw) {
    var value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (value.length === 0) return { kind: 'preset', value: DEFAULT_ACCENT };
    var hex = normalizeHex(value);
    if (hex !== null) return { kind: 'hex', value: hex };
    if (value === 'system') return { kind: 'system', value: 'system' };
    if (PRESETS.indexOf(value) !== -1) return { kind: 'preset', value: value };
    return { kind: 'preset', value: DEFAULT_ACCENT };
  }

  function media(queryString, fallback) {
    if (typeof global.matchMedia !== 'function') return fallback;
    try { return global.matchMedia(queryString).matches === true; } catch (error) { return fallback; }
  }

  function systemPrefersDark() { return media('(prefers-color-scheme: dark)', false); }
  function systemPrefersReduced() { return media('(prefers-reduced-motion: reduce)', false); }

  function resolveTheme(mode, prefersDark) {
    var normalized = normalizeTheme(mode);
    if (normalized === 'system') return prefersDark ? 'dark' : 'light';
    return normalized;
  }

  function resolveMotion(mode, prefersReduced) {
    var normalized = normalizeMotion(mode);
    if (normalized === 'system') return prefersReduced ? 'reduced' : 'full';
    return normalized;
  }

  function settings() {
    var base = injected();
    return {
      theme: normalizeTheme(query('theme') || base.theme || 'system'),
      accent: normalizeAccent(query('accent') || base.accent || ''),
      motion: normalizeMotion(query('motion') || base.motion || 'system'),
      /** OS accent read by the main process (A-4.6-06 "主色跟随系统"). */
      systemAccent: normalizeHex(base.systemAccent) || null
    };
  }

  /** Effective accent colour after user > system > preset precedence. */
  function effectiveAccent(setting, systemAccent) {
    if (setting.kind === 'hex') return { kind: 'hex', value: setting.value };
    if (setting.kind === 'system') {
      return systemAccent === null
        ? { kind: 'preset', value: DEFAULT_ACCENT }
        : { kind: 'hex', value: systemAccent };
    }
    return { kind: 'preset', value: setting.value };
  }

  function root() { return global.document ? global.document.documentElement : null; }

  /** Write (or clear) one attribute; clearing keeps the default DOM untouched. */
  function setAttr(element, name, value) {
    if (value === null || value === undefined || value === '') element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  function apply(custom) {
    var element = root();
    if (element === null) return null;
    var config = custom || settings();
    var theme = resolveTheme(config.theme, systemPrefersDark());
    var motion = resolveMotion(config.motion, systemPrefersReduced());
    var accent = effectiveAccent(config.accent, config.systemAccent === undefined ? null : config.systemAccent);

    // Light + default accent + full motion == M3 default: no attributes at all.
    setAttr(element, 'data-theme', theme === 'dark' ? 'dark' : null);
    setAttr(element, 'data-motion', motion === 'reduced' ? 'reduced' : null);

    if (accent.kind === 'hex') {
      element.setAttribute('data-accent', 'custom');
      element.style.setProperty('--accent', accent.value);
      element.style.setProperty('--accent-soft', 'color-mix(in srgb, ' + accent.value + ' 16%, transparent)');
    } else if (accent.value === DEFAULT_ACCENT) {
      setAttr(element, 'data-accent', null);
      element.style.removeProperty('--accent');
      element.style.removeProperty('--accent-soft');
    } else {
      setAttr(element, 'data-accent', accent.value);
      element.style.removeProperty('--accent');
      element.style.removeProperty('--accent-soft');
    }

    return { theme: theme, accent: accent.value, accentKind: accent.kind, motion: motion };
  }

  /** Re-apply when the OS theme / reduced-motion / accent changes at runtime. */
  function watch(onChange) {
    if (typeof global.matchMedia !== 'function') return function noop() {};
    var list = [];
    var attach = function (queryString) {
      var mql = global.matchMedia(queryString);
      var handler = function () { onChange(apply()); };
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', handler);
        list.push(function () { mql.removeEventListener('change', handler); });
      }
      return mql;
    };
    attach('(prefers-color-scheme: dark)');
    attach('(prefers-reduced-motion: reduce)');
    return function dispose() { list.forEach(function (off) { off(); }); };
  }

  global.YTVDLTTheme = {
    PRESETS: PRESETS,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    normalizeTheme: normalizeTheme,
    normalizeAccent: normalizeAccent,
    normalizeHex: normalizeHex,
    resolveTheme: resolveTheme,
    resolveMotion: resolveMotion,
    settings: settings,
    effectiveAccent: effectiveAccent,
    apply: apply,
    watch: watch
  };

  // Apply immediately (the <script> is at the end of <body>, CSS is loaded).
  apply();
})(typeof window === 'undefined' ? this : window);
