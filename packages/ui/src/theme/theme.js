/**
 * theme.js — ONE global appearance state for every page (D-106).
 *
 * Zero imports on purpose (static pages, no bundler, no `node:*`):
 *   - the palette lives in `styles/theme.css`; this file only sets attributes
 *     on `<html>`, so CSS stays the single source of colour truth;
 *   - in the default state (no explicit setting, system = light) NOTHING is
 *     written to the DOM — that is what keeps the M3 screenshot baselines
 *     pixel-identical;
 *   - "dynamic colour" is "follow the OS accent": the injected `systemAccent`
 *     wins over the built-in preset; a user hex always wins over both.
 *
 * Resolution order: URL query (`?theme=dark&accent=teal&motion=reduced`)
 * > local cache (`ytvdlt.appearance`) > injected `window.__YTVDLT_SETTINGS__`
 * > defaults. The query form exists so the headless screenshot suite can render
 * every combination deterministically; it must stay first.
 *
 * D-106: the settings page used to emit `CONFIG_SET` (an M3 fixture channel
 * that never writes config.json) and repaint only its own DOM. The real
 * `SETTINGS_GET` / `SETTINGS_SET` channels already persist theme/accent/motion
 * into `general.*`, so this module now owns a single state: local cache for the
 * first frame (no light flash on navigation), config.json for restarts, and a
 * `storage` listener for other windows of the same origin.
 */
(function (global) {
  'use strict';

  var PRESETS = ['blue', 'teal', 'violet', 'amber', 'rose'];
  var DEFAULT_ACCENT = 'blue';
  var HEX_RE = /^#?([0-9a-f]{6})$/i;
  var STORAGE_KEY = 'ytvdlt.appearance';
  var GET_WIRE = 'ytvdlt:settings:get';
  var SET_WIRE = 'ytvdlt:settings:set';
  /** An in-flight `sync()` must never overwrite a newer user choice. */
  var dirty = false;

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

  /** Synchronous, cross-page cache. Never throws (file:// / privacy modes). */
  function readLocal() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch (error) { return {}; }
  }

  function writeLocal(state) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) { /* storage unavailable: config.json still persists */ }
  }

  function bridge() {
    var candidate = global.ytvdltBridge;
    return candidate && typeof candidate.invoke === 'function' ? candidate : null;
  }

  function settings() {
    var base = injected();
    var local = readLocal();
    return {
      // D-106: 'system' is the shipped default for ALL three, so the settings
      // page and every other page agree on the same value.
      theme: normalizeTheme(query('theme') || local.theme || base.theme || 'system'),
      accent: normalizeAccent(query('accent') || local.accent || base.accent || 'system'),
      motion: normalizeMotion(query('motion') || local.motion || base.motion || 'system'),
      /** OS accent read by the main process (A-4.6-06 "主色跟随系统"). */
      systemAccent: normalizeHex(local.systemAccent) || normalizeHex(base.systemAccent) || null
    };
  }

  /** String-shaped snapshot for the settings page (accent is not an object). */
  function state() {
    var config = settings();
    return {
      theme: config.theme,
      accent: config.accent.value,
      accentKind: config.accent.kind,
      motion: config.motion,
      systemAccent: config.systemAccent
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
    var accentSetting = config.accent && typeof config.accent === 'object'
      ? config.accent : normalizeAccent(config.accent || 'system');
    var accent = effectiveAccent(accentSetting, config.systemAccent === undefined ? null : config.systemAccent);

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

  function emitChange(snapshot) {
    try {
      if (typeof global.CustomEvent === 'function' && global.document) {
        global.document.dispatchEvent(new global.CustomEvent('ytvdlt:appearance', { detail: snapshot }));
      }
    } catch (error) { /* older webview */ }
  }

  /**
   * Write-once, read-everywhere. Persists to config.json when the packaged
   * bridge is present; the local cache always updates so a reload is instant.
   */
  function set(patch) {
    var input = patch && typeof patch === 'object' ? patch : {};
    dirty = true;
    var current = state();
    var next = {
      theme: input.theme === undefined ? current.theme : normalizeTheme(input.theme),
      accent: input.accent === undefined ? current.accent : normalizeAccent(input.accent).value,
      motion: input.motion === undefined ? current.motion : normalizeMotion(input.motion)
    };
    writeLocal(next);
    var result = apply({
      theme: next.theme,
      accent: normalizeAccent(next.accent),
      motion: next.motion,
      systemAccent: current.systemAccent
    });
    var b = bridge();
    if (b !== null && Object.keys(input).length > 0) {
      var wire = {};
      ['theme', 'accent', 'motion'].forEach(function (key) {
        if (input[key] !== undefined) wire[key] = next[key];
      });
      try { Promise.resolve(b.invoke(SET_WIRE, wire)).catch(function () { /* offline */ }); }
      catch (error) { /* offline */ }
    }
    emitChange(next);
    return result;
  }

  /** Re-read the authoritative config.json (survives restarts and page jumps). */
  function sync() {
    var b = bridge();
    // A query override is a deterministic test render: never let config win.
    if (b === null || query('theme') || query('accent') || query('motion')) {
      return Promise.resolve(null);
    }
    return Promise.resolve(b.invoke(GET_WIRE, {})).then(function (snapshot) {
      // The user changed the theme while this read was in flight: their choice
      // (and the SETTINGS_SET write behind it) is newer than the snapshot.
      if (dirty) return null;
      if (snapshot === null || typeof snapshot !== 'object') return null;
      var next = {
        theme: normalizeTheme(snapshot.theme),
        accent: normalizeAccent(snapshot.accent || 'system').value,
        motion: normalizeMotion(snapshot.motion),
        systemAccent: normalizeHex(snapshot.systemAccent)
      };
      writeLocal(next);
      apply({
        theme: next.theme,
        accent: normalizeAccent(next.accent),
        motion: next.motion,
        systemAccent: next.systemAccent
      });
      emitChange(next);
      return next;
    }).catch(function () { return null; });
  }

  /** Re-apply when the OS theme / reduced-motion / accent changes at runtime. */
  function watch(onChange) {
    if (typeof global.matchMedia !== 'function') return function noop() {};
    var list = [];
    var attach = function (queryString) {
      var mql = global.matchMedia(queryString);
      var handler = function () { var result = apply(); if (typeof onChange === 'function') onChange(result); };
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

  /** Other windows of the same origin changed the setting: follow them. */
  function listen() {
    if (typeof global.addEventListener !== 'function') return function noop() {};
    var handler = function (event) {
      if (event && event.key !== null && event.key !== undefined && event.key !== STORAGE_KEY) return;
      var result = apply();
      if (result !== null) emitChange(state());
    };
    global.addEventListener('storage', handler);
    return function dispose() { global.removeEventListener('storage', handler); };
  }

  global.YTVDLTTheme = {
    STORAGE_KEY: STORAGE_KEY,
    PRESETS: PRESETS,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    normalizeTheme: normalizeTheme,
    normalizeAccent: normalizeAccent,
    normalizeHex: normalizeHex,
    resolveTheme: resolveTheme,
    resolveMotion: resolveMotion,
    settings: settings,
    state: state,
    effectiveAccent: effectiveAccent,
    readLocal: readLocal,
    apply: apply,
    set: set,
    sync: sync,
    watch: watch,
    listen: listen
  };

  // Apply immediately (the <script> sits in <head> right after the CSS on main
  // window pages, or at the end of <body> on the frozen M3 dialogs).
  apply();
})(typeof window === 'undefined' ? this : window);
