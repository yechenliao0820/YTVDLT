/**
 * shortcuts.js — keyboard bindings for the M5 UI (A-4.1-02, §6.8).
 *
 * The canonical table + policy live in `packages/core/src/shortcuts/shortcuts.ts`
 * (L0-tested). This file is the browser-side mirror used by static pages; a
 * unit test parses `DEFAULT_BINDINGS` below and fails if the two ever diverge
 * (tests/unit/shortcuts.test.ts).
 *
 * Rules enforced here:
 *   - "input focus never hijacks editing keys": Ctrl+V / Ctrl+F / Delete / F5
 *     are NOT dispatched while a text field, textarea, select or
 *     contenteditable element has focus;
 *   - `Ctrl` maps to `Cmd` on macOS (the same table drives both);
 *   - `Ctrl+Shift+V` (global prefill) still fires while editing, because that is
 *     its whole purpose.
 */
(function (global) {
  'use strict';

  var DEFAULT_BINDINGS = [
    { id: 'paste-parse', accelerator: 'Ctrl+V', scope: 'app', editingSafe: false },
    { id: 'new-download', accelerator: 'Ctrl+N', scope: 'app', editingSafe: true },
    { id: 'start', accelerator: 'Ctrl+Enter', scope: 'app', editingSafe: true },
    { id: 'settings', accelerator: 'Ctrl+,', scope: 'app', editingSafe: true },
    { id: 'search', accelerator: 'Ctrl+F', scope: 'app', editingSafe: false },
    { id: 'global-prefill', accelerator: 'Ctrl+Shift+V', scope: 'global', editingSafe: true },
    { id: 'cancel-selected', accelerator: 'Delete', scope: 'app', editingSafe: false },
    { id: 'retry', accelerator: 'Ctrl+R', scope: 'app', editingSafe: true },
    { id: 'close-dialog', accelerator: 'Escape', scope: 'app', editingSafe: true },
    { id: 'refresh', accelerator: 'F5', scope: 'app', editingSafe: false },
    { id: 'nav-1', accelerator: 'Ctrl+1', scope: 'app', editingSafe: true },
    { id: 'nav-2', accelerator: 'Ctrl+2', scope: 'app', editingSafe: true },
    { id: 'nav-3', accelerator: 'Ctrl+3', scope: 'app', editingSafe: true },
    { id: 'nav-4', accelerator: 'Ctrl+4', scope: 'app', editingSafe: true }
  ];

  var EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

  function bindings() {
    var injected = global.__YTVDLT_SHORTCUTS__;
    return Array.isArray(injected) && injected.length > 0 ? injected : DEFAULT_BINDINGS;
  }

  function isMac() {
    if (global.__YTVDLT_PLATFORM__) return String(global.__YTVDLT_PLATFORM__).indexOf('darwin') === 0;
    var nav = global.navigator;
    return nav !== undefined && typeof nav.platform === 'string' && nav.platform.indexOf('Mac') === 0;
  }

  /** `Ctrl+Shift+V` -> `{ctrl:true, shift:true, alt:false, meta:false, key:'v'}`. */
  function parseAccelerator(accelerator) {
    var parts = String(accelerator).split('+');
    var combo = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
    for (var i = 0; i < parts.length; i += 1) {
      var token = parts[i].trim();
      var lower = token.toLowerCase();
      if (lower === 'ctrl' || lower === 'cmdorctrl') combo.ctrl = true;
      else if (lower === 'shift') combo.shift = true;
      else if (lower === 'alt') combo.alt = true;
      else if (lower === 'meta' || lower === 'cmd') combo.meta = true;
      else combo.key = lower;
    }
    return combo;
  }

  function eventKey(event) {
    var key = String(event.key || '').toLowerCase();
    if (key === 'del') return 'delete';
    if (key === 'esc') return 'escape';
    if (key === ' ') return 'space';
    return key;
  }

  function matches(event, accelerator) {
    var combo = parseAccelerator(accelerator);
    var ctrlExpected = combo.ctrl || (combo.meta && isMac());
    var ctrlSeen = isMac() ? event.metaKey === true : event.ctrlKey === true;
    if (ctrlExpected !== ctrlSeen) return false;
    if (combo.shift !== (event.shiftKey === true)) return false;
    if (combo.alt !== (event.altKey === true)) return false;
    return eventKey(event) === combo.key;
  }

  function isEditingTarget(target) {
    if (target === null || target === undefined) return false;
    if (target.isContentEditable === true) return true;
    // D-190: mirror core/src/shortcuts/shortcuts.ts. Real DOM tagNames are
    // uppercase, but XML documents and test doubles may hand us lower case
    // (or a non-string); normalising keeps both mirrors in agreement.
    var tag = target.tagName;
    return typeof tag === 'string' && EDITABLE_TAGS.indexOf(tag.toUpperCase()) !== -1;
  }

  /** Resolve an event to a binding id, honouring the editing guard. */
  function resolve(event, table) {
    var list = Array.isArray(table) ? table : bindings();
    var editing = isEditingTarget(event.target);
    for (var i = 0; i < list.length; i += 1) {
      var binding = list[i];
      if (!matches(event, binding.accelerator)) continue;
      if (editing && binding.editingSafe !== true) continue;
      return binding;
    }
    return null;
  }

  var handlers = {};

  function on(id, fn) {
    handlers[id] = fn;
    return function off() { delete handlers[id]; };
  }

  function install(doc) {
    if (!doc || typeof doc.addEventListener !== 'function') return function noop() {};
    var listener = function (event) {
      var binding = resolve(event);
      if (binding === null) return;
      var handler = handlers[binding.id];
      if (typeof handler !== 'function') return;
      event.preventDefault();
      handler(event);
    };
    doc.addEventListener('keydown', listener);
    return function dispose() { doc.removeEventListener('keydown', listener); };
  }

  /** `--url=<value>` deep link (A-4.1-02); mirrors core `extractDeepLink()`. */
  function extractDeepLink(argv) {
    var list = Array.isArray(argv) ? argv : [];
    for (var i = 0; i < list.length; i += 1) {
      var arg = String(list[i]);
      if (arg.indexOf('--url=') === 0) {
        var value = arg.slice('--url='.length);
        return /^https?:\/\//i.test(value) ? value : null;
      }
      if (arg === '--url' && i + 1 < list.length) {
        var next = String(list[i + 1]);
        return /^https?:\/\//i.test(next) ? next : null;
      }
    }
    return null;
  }

  global.YTVDLT = global.YTVDLT || {};
  global.YTVDLT.shortcuts = {
    DEFAULT_BINDINGS: DEFAULT_BINDINGS,
    bindings: bindings,
    parseAccelerator: parseAccelerator,
    isEditingTarget: isEditingTarget,
    matches: matches,
    resolve: resolve,
    on: on,
    install: install,
    extractDeepLink: extractDeepLink
  };
})(typeof window === 'undefined' ? this : window);
