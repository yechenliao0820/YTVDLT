/**
 * settings.js — appearance / language / update settings page (M5-1, M5-2).
 *
 * Live behaviour required by the acceptance:
 *   - theme switch repaints the whole page instantly (attributes on <html>, no reload);
 *   - accent follows the OS by default, a preset overrides it;
 *   - language switch reloads with `?lang=` because the M3 dialogs are frozen
 *     phrase-table pages (a reload is the only way back to Chinese without
 *     keeping the whole original DOM in memory — documented in M5-2-REPORT);
 *   - every change is also emitted as `{action, value}` so the main process can
 *     persist it through `CONFIG_SET` (A-4.4-20 / A-4.4-21 persistence).
 *
 * The page never writes config itself: `node:fs` is forbidden here.
 */
(function (global) {
  'use strict';
  var doc = global.document;
  var THEME_STATE = { theme: 'system', accent: 'system', motion: 'system', locale: 'zh-CN' };

  function param(name, fallback) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? fallback : decodeURIComponent(match[1]);
  }

  function settingsInjected() {
    var injected = global.__YTVDLT_SETTINGS__;
    return injected !== null && typeof injected === 'object' ? injected : {};
  }

  function initial() {
    var base = settingsInjected();
    var theme = param('theme', base.theme || 'system');
    var accent = param('accent', base.accent || 'system');
    var motion = param('motion', base.motion || 'system');
    var locale = param('lang', base.locale || 'zh-CN');
    return {
      theme: theme === 'light' || theme === 'dark' ? theme : 'system',
      accent: /^#?[0-9a-f]{6}$/i.test(accent) ? accent : (
        ['system', 'blue', 'teal', 'violet', 'amber', 'rose'].indexOf(accent) === -1 ? 'system' : accent
      ),
      motion: motion === 'reduced' || motion === 'full' ? motion : 'system',
      locale: String(locale).toLowerCase().indexOf('en') === 0 ? 'en' : 'zh-CN'
    };
  }

  function emit(action, value) {
    var output = doc.getElementById('ytvdlt-output');
    var payload = { action: action, value: value };
    if (output !== null) {
      output.setAttribute('hidden', 'false');
      output.textContent = JSON.stringify(payload, null, 2);
      output.setAttribute('data-last-action', action);
    }
    var bridge = global.ytvdltBridge;
    if (bridge && typeof bridge.invoke === 'function') {
      try { bridge.invoke('CONFIG_SET', { domain: 'general', key: action, value: value }); } catch (error) { /* offline */ }
    }
    return payload;
  }

  function paintTheme() {
    if (global.YTVDLTTheme) {
      global.YTVDLTTheme.apply({
        theme: THEME_STATE.theme,
        accent: THEME_STATE.accent,
        motion: THEME_STATE.motion,
        systemAccent: settingsInjected().systemAccent || null
      });
    }
    var root = doc.getElementById('settings-root');
    if (root !== null) {
      root.setAttribute('data-theme-value', THEME_STATE.theme);
      root.setAttribute('data-accent-value', THEME_STATE.accent);
      root.setAttribute('data-motion-value', THEME_STATE.motion);
      root.setAttribute('data-locale-value', THEME_STATE.locale);
    }
    ['light', 'dark', 'system'].forEach(function (value) {
      var button = doc.querySelector('#settings-theme [data-theme="' + value + '"]');
      if (button !== null) button.setAttribute('aria-pressed', value === THEME_STATE.theme ? 'true' : 'false');
    });
    ['system', 'blue', 'teal', 'violet', 'amber', 'rose'].forEach(function (value) {
      var button = doc.querySelector('#settings-accent [data-accent="' + value + '"]');
      if (button !== null) button.setAttribute('aria-pressed', value === THEME_STATE.accent ? 'true' : 'false');
    });
    ['zh-CN', 'en'].forEach(function (value) {
      var button = doc.querySelector('#settings-language [data-locale="' + value + '"]');
      if (button !== null) button.setAttribute('aria-pressed', value === THEME_STATE.locale ? 'true' : 'false');
    });
  }

  function persistTheme(theme) {
    THEME_STATE.theme = theme;
    paintTheme();
    emit('theme', theme);
  }

  function persistAccent(accent) {
    THEME_STATE.accent = accent;
    paintTheme();
    emit('accent', accent);
  }

  function persistMotion(motion) {
    THEME_STATE.motion = motion;
    paintTheme();
    emit('motion', motion);
  }

  /** Language needs a reload: `i18n.js` only translates forward (zh -> en). */
  function switchLocale(locale) {
    THEME_STATE.locale = locale;
    var url = String(global.location.href).replace(/[?&]lang=[^&]*/g, '');
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    var next = locale === 'zh-CN' ? url : url + separator + 'lang=' + encodeURIComponent(locale);
    emit('language', locale);
    // D-85: `CONFIG_SET` is the M3 fixture channel and does not persist the
    // locale. Write the real setting as well, so a restart keeps the language
    // (bootstrap.ts reads it back through SETTINGS_GET).
    var bridge = global.ytvdltBridge;
    if (bridge && typeof bridge.invoke === 'function') {
      try { bridge.invoke('ytvdlt:settings:set', { language: locale }); } catch (error) { /* offline */ }
    }
    try { if (global.localStorage) global.localStorage.setItem('ytvdlt.locale', locale); } catch (error) { /* offline */ }
    if (global.location && typeof global.location.replace === 'function') global.location.replace(next);
  }


  /* --- D-67: bundled component (yt-dlp / aria2c) updates ------------------ */

  var COMPONENT_CHANNELS = {
    status: 'ytvdlt:component:status',
    update: 'ytvdlt:component:update'
  };

  /** Catalogue lookup with `{name}` substitution; empty string when missing. */
  function t(key, params) {
    var i18n = global.YTVDLT_I18N;
    var table = i18n && i18n.MESSAGES
      ? (i18n.MESSAGES[THEME_STATE.locale] || i18n.MESSAGES[i18n.DEFAULT_LOCALE] || {})
      : {};
    var text = table[key] || '';
    var values = params || {};
    Object.keys(values).forEach(function (name) {
      text = text.split('{' + name + '}').join(String(values[name]));
    });
    return text;
  }

  /** No bridge = plain file:// preview (e2e) or a broken preload. Be explicit. */
  function offlineText() {
    return THEME_STATE.locale === 'en'
      ? 'Offline: main process not connected'
      : '离线：未连接主进程，无法检查更新';
  }

  function setComponentState(state, text) {
    var element = doc.getElementById('settings-components');
    if (element === null) return;
    element.setAttribute('data-component-state', state);
    element.textContent = text;
  }

  function versionList(components) {
    return (components || []).map(function (component) {
      return component.label + ' ' + (component.installed ? (component.version || '?') : '×');
    }).join(' / ');
  }

  /** Returns null when the preload bridge is absent (e2e, offline). */
  function invokeBridge(channel, payload) {
    var bridge = global.ytvdltBridge;
    if (!bridge || typeof bridge.invoke !== 'function') return null;
    try { return bridge.invoke(channel, payload || {}); } catch (error) { return null; }
  }

  function refreshComponents() {
    var button = doc.getElementById('settings-engine-update');
    var pending = invokeBridge(COMPONENT_CHANNELS.status, {});
    if (pending === null) {
      setComponentState('offline', offlineText());
      if (button !== null) button.disabled = true;
      return;
    }
    Promise.resolve(pending).then(function (status) {
      var hasSource = Boolean(status && status.source);
      setComponentState(hasSource ? 'idle' : 'no-source',
        hasSource
          ? t('settings.component.idle', { list: versionList(status.components) })
          : t('settings.component.nosource'));
      if (button !== null) button.disabled = !hasSource;
    }).catch(function () {
      setComponentState('offline', offlineText());
    });
  }

  function runComponentUpdate() {
    var button = doc.getElementById('settings-engine-update');
    if (button !== null) button.disabled = true;
    setComponentState('running', t('settings.component.running'));
    var pending = invokeBridge(COMPONENT_CHANNELS.update, {});
    if (pending === null) {
      setComponentState('offline', offlineText());
      return;
    }
    Promise.resolve(pending).then(function (result) {
      if (result && result.ok) {
        var changed = (result.results || []).filter(function (item) { return item.changed; })
          .map(function (item) { return item.label + ' ' + (item.toVersion || ''); })
          .join(', ');
        setComponentState('done',
          changed ? t('settings.component.done', { list: changed }) : t('settings.component.idle', { list: '' }));
      } else {
        setComponentState('failed',
          t('settings.component.failed', { reason: (result && result.reason) || 'unknown' }));
      }
    }).catch(function (error) {
      setComponentState('failed', t('settings.component.failed', { reason: String(error) }));
    }).then(function () {
      if (button !== null) button.disabled = false;
      refreshComponents();
    });
  }

  function wire() {
    doc.querySelectorAll('#settings-theme [data-theme]').forEach(function (button) {
      button.addEventListener('click', function () { persistTheme(button.getAttribute('data-theme')); });
    });
    doc.querySelectorAll('#settings-accent [data-accent]').forEach(function (button) {
      button.addEventListener('click', function () { persistAccent(button.getAttribute('data-accent')); });
    });
    doc.querySelectorAll('#settings-language [data-locale]').forEach(function (button) {
      button.addEventListener('click', function () { switchLocale(button.getAttribute('data-locale')); });
    });
    var motion = doc.getElementById('settings-motion');
    if (motion !== null) {
      motion.value = THEME_STATE.motion;
      motion.addEventListener('change', function () { persistMotion(motion.value); });
    }
    var autostart = doc.getElementById('settings-autostart');
    if (autostart !== null) {
      autostart.checked = settingsInjected().autostart === true;
      autostart.addEventListener('change', function () { emit('autostart', autostart.checked); });
    }
    var channel = doc.getElementById('settings-channel');
    if (channel !== null) {
      channel.value = settingsInjected().updateChannel === 'nightly' ? 'nightly' : 'stable';
      channel.addEventListener('change', function () { emit('update-channel', channel.value); });
    }
    var interval = doc.getElementById('settings-interval');
    if (interval !== null) {
      var value = settingsInjected().updateInterval;
      interval.value = value === 'daily' || value === 'never' ? value : 'weekly';
      interval.addEventListener('change', function () { emit('update-interval', interval.value); });
    }
    var engineUpdate = doc.getElementById('settings-engine-update');
    if (engineUpdate !== null) engineUpdate.addEventListener('click', runComponentUpdate);
    // App updates stay disabled until the GitHub repo + feed exist (D-67).
    var appUpdate = doc.getElementById('settings-app-update');
    if (appUpdate !== null) appUpdate.disabled = true;
    refreshComponents();
  }

  THEME_STATE = initial();
  paintTheme();
  wire();
  if (global.YTVDLT && global.YTVDLT.shell) {
    global.YTVDLT.shell.boot({ 'settings': function () { /* already here */ } });
  }
  global.YTVDLTSettings = { state: THEME_STATE, paintTheme: paintTheme, switchLocale: switchLocale };
})(typeof window === 'undefined' ? this : window);
