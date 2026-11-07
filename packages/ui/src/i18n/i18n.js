/**
 * i18n.js — runtime locale application for the static pages (M5-2, A-4.4-21).
 *
 * Design constraints:
 *   - zero imports, no bundler, must run from `file://` (screenshot suite);
 *   - the M3 dialogs are frozen baselines, so the Chinese rendering may not
 *     change by a single pixel: `apply()` therefore writes NOTHING when the
 *     locale is the default `zh-CN`;
 *   - DOM stays the source of truth: `data-i18n="key"` replaces `textContent`,
 *     `data-i18n-placeholder` / `data-i18n-aria-label` replace attributes;
 *   - text nodes of the M3 dialogs are translated through the zh -> en phrase
 *     table (`messages.js`), because rewriting their markup would invalidate the
 *     M3 DOM baselines (documented deviation in docs/M5-2-REPORT.md);
 *   - after translation the page reports `data-text-overflow` (elements whose
 *     `scrollWidth` exceeds `clientWidth`), which is what the English layout
 *     acceptance actually asserts.
 */
(function (global) {
  'use strict';

  var CATALOGUE = global.YTVDLT_I18N || { MESSAGES: { 'zh-CN': {}, en: {} }, PHRASES: {}, DEFAULT_LOCALE: 'zh-CN' };
  var LOCALES = CATALOGUE.LOCALES || ['zh-CN', 'en'];
  var DEFAULT_LOCALE = CATALOGUE.DEFAULT_LOCALE || 'zh-CN';

  function query(name) {
    if (!global.location || typeof global.location.search !== 'string') return '';
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search);
    return match === null ? '' : decodeURIComponent(match[1]);
  }

  /** `en`, `en-US`, `EN_us` -> `en`; anything Chinese -> `zh-CN`; else default. */
  function normalizeLocale(raw) {
    var value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
    if (value.length === 0) return DEFAULT_LOCALE;
    if (value === 'en' || value.indexOf('en-') === 0 || value.indexOf('en_') === 0) return 'en';
    if (value === 'zh' || value.indexOf('zh-') === 0 || value.indexOf('zh_') === 0) return 'zh-CN';
    return DEFAULT_LOCALE;
  }

  function settings() {
    var injected = global.__YTVDLT_SETTINGS__;
    var base = injected !== null && typeof injected === 'object' ? injected : {};
    return {
      locale: normalizeLocale(query('lang') || base.locale || base.language || DEFAULT_LOCALE)
    };
  }

  function interpolate(template, params) {
    if (params === undefined || params === null) return template;
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, function (whole, name) {
      var value = params[name];
      return value === undefined || value === null ? whole : String(value);
    });
  }

  function translator(locale) {
    var table = CATALOGUE.MESSAGES[locale] || {};
    var fallback = CATALOGUE.MESSAGES[DEFAULT_LOCALE] || {};
    return function t(key, params) {
      var value = table[key];
      if (value === undefined) value = fallback[key];
      if (value === undefined) return key;
      return interpolate(value, params);
    };
  }

  function applyAttributes(element, t) {
    var key = element.getAttribute('data-i18n');
    if (key !== null) {
      var text = t(key);
      if (text !== key) {
        if (/\{[a-zA-Z0-9_]+\}/.test(text)) {
          // Placeholder template: the page owns the values (it already rendered
          // them through t(key, params)); writing the raw template here would
          // print literal "{active}/{limit}" on screen.
        } else if (element.children.length > 0) {
          // Preserve child nodes (e.g. the per-tab counter <span>): replace only
          // the leading text node instead of wiping the whole subtree.
          var first = element.firstChild;
          if (first !== null && first.nodeType === 3) first.nodeValue = text;
          else element.insertBefore((global.document || document).createTextNode(text), first);
        } else {
          element.textContent = text;
        }
      }
    }
    var placeholder = element.getAttribute('data-i18n-placeholder');
    if (placeholder !== null) element.setAttribute('placeholder', t(placeholder));
    var ariaLabel = element.getAttribute('data-i18n-aria-label');
    if (ariaLabel !== null) element.setAttribute('aria-label', t(ariaLabel));
    var title = element.getAttribute('data-i18n-title');
    if (title !== null) element.setAttribute('title', t(title));
  }

  /** Walk text nodes and swap whole-node matches from the legacy phrase table. */
  function translatePhrases(root, table, stats) {
    var visit = function (node) {
      if (node.nodeType === 3) {
        var raw = node.nodeValue || '';
        var trimmed = raw.trim();
        if (trimmed.length === 0) return;
        var hit = table[trimmed];
        if (hit === undefined) return;
        var leading = raw.slice(0, raw.indexOf(trimmed));
        var trailing = raw.slice(raw.indexOf(trimmed) + trimmed.length);
        node.nodeValue = leading + hit + trailing;
        stats.translated += 1;
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'PRE') return;
      for (var i = 0; i < node.childNodes.length; i += 1) visit(node.childNodes[i]);
    };
    visit(root);
  }

  // Elements whose text must never clip after translation. Pages that opt into
  // `data-fit` get measured exactly; older pages fall back to this selector set
  // (truncating titles are intentionally NOT measured — ellipsis is by design).
  var DEFAULT_FIT_SELECTOR = 'h1,h2,button,label,th,dt,.subtitle,.note,.log-meta,.batch-sub';

  function countOverflow(doc) {
    var nodes = doc.querySelectorAll('[data-fit]');
    if (nodes.length === 0) nodes = doc.querySelectorAll(DEFAULT_FIT_SELECTOR);
    var overflow = 0;
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.scrollWidth - node.clientWidth > 1) overflow += 1;
    }
    return overflow;
  }

  function formatDate(value) {
    // Locale-aware but deterministic (no Intl in the screenshot suite).
    if (typeof value !== 'string') return '';
    return value.replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '');
  }

  function apply(custom) {
    var doc = global.document;
    if (!doc || !doc.documentElement) return null;
    var locale = (custom && custom.locale) || settings().locale;
    locale = normalizeLocale(locale);
    var stats = { locale: locale, translated: 0, missing: [], overflow: 0 };

    if (locale === DEFAULT_LOCALE) {
      // Default locale: the shipped markup is already correct AND frozen.
      stats.overflow = countOverflow(doc);
      return stats;
    }

    var t = translator(locale);
    var nodes = doc.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-aria-label],[data-i18n-title]');
    for (var i = 0; i < nodes.length; i += 1) {
      applyAttributes(nodes[i], t);
      stats.translated += 1;
    }
    translatePhrases(doc.body || doc.documentElement, CATALOGUE.PHRASES || {}, stats);

    // Missing keys are a bug, not a silent fallback: expose them for the gate.
    var referenced = doc.querySelectorAll('[data-i18n]');
    for (var k = 0; k < referenced.length; k += 1) {
      var key = referenced[k].getAttribute('data-i18n');
      if (key !== null && (CATALOGUE.MESSAGES[locale] || {})[key] === undefined) stats.missing.push(key);
    }

    doc.documentElement.setAttribute('lang', locale);
    doc.documentElement.setAttribute('data-lang', locale);
    stats.overflow = countOverflow(doc);
    if (doc.body) {
      doc.body.setAttribute('data-text-overflow', String(stats.overflow));
      doc.body.setAttribute('data-i18n-missing', String(stats.missing.length));
    }
    return stats;
  }

  global.YTVDLT = global.YTVDLT || {};
  global.YTVDLT.i18n = {
    LOCALES: LOCALES,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    normalizeLocale: normalizeLocale,
    translator: translator,
    t: function (key, params) { return translator(settings().locale)(key, params); },
    apply: apply,
    formatDate: formatDate,
    countOverflow: countOverflow
  };

  // Apply on load unless the page opts out (pages that render async call it).
  if (!global.__YTVDLT_I18N_MANUAL__) {
    if (global.document && global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', function () { apply(); });
    } else {
      apply();
    }
  }
})(typeof window === 'undefined' ? this : window);
