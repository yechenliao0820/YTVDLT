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


  /* --- 0.2.1 (D-93): 应用本体更新 --------------------------------------- */

  var APP_CHANNELS = {
    status: 'ytvdlt:appUpdate:status',
    action: 'ytvdlt:appUpdate:action'
  };

  function formatBytes(value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var size = value;
    var index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    var digits = size >= 100 || index === 0 ? 0 : 1;
    return size.toFixed(digits) + ' ' + units[index];
  }

  function paintApp(update) {
    var block = doc.getElementById('settings-app-block');
    var current = doc.getElementById('settings-app-current');
    var stateNode = doc.getElementById('settings-app-state');
    var checkButton = doc.getElementById('settings-app-update');
    var pageButton = doc.getElementById('settings-app-page');
    if (update === null || typeof update !== 'object') {
      if (stateNode !== null) stateNode.textContent = offlineText();
      if (checkButton !== null) checkButton.disabled = true;
      return;
    }

    var version = update.currentVersion || '';
    if (current !== null && version !== '') current.textContent = t('settings.app.current', { version: version });

    var phase = String(update.phase || 'idle');
    var text = '';
    if (phase === 'checking') text = t('settings.app.checking');
    else if (phase === 'available') text = t('settings.app.available', { version: (update.latest && update.latest.version) || '' });
    else if (phase === 'downloading') {
      var total = typeof update.totalBytes === 'number' ? update.totalBytes : null;
      text = t('update.downloading', {
        done: formatBytes(update.downloadedBytes || 0),
        total: total === null ? '—' : formatBytes(total)
      });
    } else if (phase === 'ready') text = t('update.ready');
    else if (phase === 'error') text = t('settings.app.error', { reason: update.message || '—' });
    else if (update.message) text = update.message;
    else text = t('settings.app.uptodate');

    if (stateNode !== null) {
      stateNode.textContent = text;
      stateNode.setAttribute('data-update-state', phase);
    }
    if (block !== null) block.setAttribute('data-update-state', phase);
    if (checkButton !== null) {
      checkButton.disabled = phase === 'checking' || phase === 'downloading';
      checkButton.removeAttribute('data-i18n');
      checkButton.textContent = phase === 'available' || phase === 'ready'
        ? t('update.download')
        : t('settings.app.check');
    }
    if (pageButton !== null) {
      var hasPage = Boolean(update.latest && update.latest.pageUrl);
      setHidden(pageButton, !hasPage);
      pageButton.removeAttribute('data-i18n');
      pageButton.textContent = t('settings.app.page');
    }
  }

  function readAppState() {
    var pending = invokeBridge(APP_CHANNELS.status, {});
    if (pending === null) { paintApp(null); return; }
    Promise.resolve(pending).then(paintApp).catch(function () { paintApp(null); });
  }

  function appAction(action) {
    var pending = invokeBridge(APP_CHANNELS.action, { action: action });
    if (pending === null) { paintApp(null); return; }
    Promise.resolve(pending).then(function (result) {
      if (result && result.state) paintApp(result.state);
      else readAppState();
    }).catch(function () { readAppState(); });
  }

  /* --- 0.2.1 (D-98): 下载位置 ------------------------------------------- */

  var PATH_CHANNEL = 'ytvdlt:path:action';

  function paintPaths(snapshot) {
    ['video', 'audio'].forEach(function (kind) {
      var node = doc.getElementById('settings-path-' + kind);
      if (node === null) return;
      var value = snapshot && typeof snapshot[kind + 'Dir'] === 'string' ? snapshot[kind + 'Dir'] : '';
      node.textContent = value === '' ? '—' : value;
      // The row is elided; `title` is the only way to read the whole path.
      node.setAttribute('title', value);
    });
  }

  function pathNote(text, state) {
    var note = doc.getElementById('settings-path-note');
    if (note === null) return;
    note.removeAttribute('data-i18n');
    note.textContent = text;
    note.setAttribute('data-path-state', state);
  }

  /** pick / reset / open — the main process owns the dialog and the write. */
  function pathAction(action, kind) {
    var pending = invokeBridge(PATH_CHANNEL, { action: action, kind: kind });
    if (pending === null) { pathNote(offlineText(), 'error'); return; }
    Promise.resolve(pending).then(function (result) {
      if (result && result.paths) paintPaths(result.paths);
      if (result === null || result === undefined) return;
      if (result.canceled === true) return;
      if (result.ok === true) {
        if (action === 'open') { pathNote(t('settings.paths.hint'), 'idle'); return; }
        pathNote(t('settings.paths.saved', { path: result.path || '' }), 'ok');
        return;
      }
      pathNote(t('settings.paths.failed', { reason: result.error || '' }), 'error');
    }).catch(function (error) {
      pathNote(t('settings.paths.failed', { reason: String(error) }), 'error');
    });
  }

  /* --- D-67 / 0.2.1 (D-94): yt-dlp 引擎更新 ----------------------------- */

  var COMPONENT_CHANNELS = {
    status: 'ytvdlt:component:status',
    update: 'ytvdlt:component:update',
    check: 'ytvdlt:component:check'
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

  function setHidden(node, hidden) {
    if (node !== null && node !== undefined) node.setAttribute('hidden', hidden ? 'true' : 'false');
  }

  /** yt-dlp is the only component that matters for "downloads stop working". */
  function ytdlpOf(components) {
    var list = components || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === 'yt-dlp') return list[i];
    }
    return list.length > 0 ? list[0] : null;
  }

  function paintEngine(status) {
    var component = ytdlpOf(status && status.components);
    var current = doc.getElementById('settings-engine-current');
    var latest = doc.getElementById('settings-engine-latest');
    var button = doc.getElementById('settings-engine-update');
    var check = doc.getElementById('settings-engine-check');
    if (component === null) {
      setComponentState('no-source', t('settings.engine.nofeed'));
      if (button !== null) button.disabled = true;
      if (check !== null) check.disabled = true;
      return;
    }
    if (current !== null) {
      current.textContent = component.installed
        ? t('settings.engine.installed', { version: component.version || '?' })
        : t('settings.engine.missing');
    }
    if (latest !== null) {
      latest.textContent = component.latestVersion
        ? t('settings.engine.latest', { version: component.latestVersion })
        : t('settings.engine.unknown');
    }
    var updatable = Boolean(component.feedUrl);
    if (button !== null) button.disabled = !updatable;
    if (check !== null) check.disabled = !component.versionApiUrl && !updatable;

    if (!updatable) {
      setComponentState('no-source', t('settings.engine.nofeed'));
      return;
    }
    if (component.updateAvailable && component.latestVersion) {
      setComponentState('available', t('settings.engine.available', {
        from: component.version || '?',
        to: component.latestVersion
      }));
      return;
    }
    if (component.latestVersion) {
      setComponentState('idle', t('settings.engine.uptodate') + ' · ' + versionList(status.components));
      return;
    }
    setComponentState('idle', t('settings.component.idle', { list: versionList(status.components) }));
  }

  function refreshComponents() {
    var pending = invokeBridge(COMPONENT_CHANNELS.status, {});
    if (pending === null) {
      setComponentState('offline', offlineText());
      var button = doc.getElementById('settings-engine-update');
      if (button !== null) button.disabled = true;
      return;
    }
    Promise.resolve(pending).then(paintEngine).catch(function () {
      setComponentState('offline', offlineText());
    });
  }

  function checkEngine() {
    var button = doc.getElementById('settings-engine-check');
    if (button !== null) button.disabled = true;
    setComponentState('checking', t('settings.app.checking'));
    var pending = invokeBridge(COMPONENT_CHANNELS.check, {});
    if (pending === null) {
      setComponentState('offline', offlineText());
      return;
    }
    Promise.resolve(pending).then(function (report) {
      var result = report && Array.isArray(report.results) ? report.results[0] : null;
      if (result === null) {
        setComponentState('failed', t('settings.engine.unknown'));
        return;
      }
      if (result.error) {
        setComponentState('failed', t('settings.engine.checkFailed', { reason: result.error }));
        return;
      }
      // A fresh check must land in the same shape `paintEngine` expects.
      refreshComponents();
      if (result.updateAvailable) {
        setComponentState('available', t('settings.engine.available', {
          from: result.installedVersion || '?',
          to: result.latestVersion || '?'
        }));
      }
    }).catch(function (error) {
      setComponentState('failed', t('settings.engine.checkFailed', { reason: String(error) }));
    }).then(function () {
      if (button !== null) button.disabled = false;
    });
  }

  function runComponentUpdate() {
    var button = doc.getElementById('settings-engine-update');
    if (button !== null) button.disabled = true;
    setComponentState('running', t('settings.engine.updating'));
    var pending = invokeBridge(COMPONENT_CHANNELS.update, {});
    if (pending === null) {
      setComponentState('offline', offlineText());
      return;
    }
    Promise.resolve(pending).then(function (result) {
      if (result && result.ok) {
        var changed = (result.results || []).filter(function (item) { return item.changed; });
        setComponentState('done', changed.length > 0
          ? t('settings.engine.done', { version: changed[0].toVersion || '?' })
          : t('settings.engine.uptodate'));
      } else if (result && result.reason === 'up-to-date') {
        setComponentState('done', t('settings.engine.uptodate'));
      } else if (result && result.ok === false && (result.reason === 'up-to-date')) {
        setComponentState('done', t('settings.engine.uptodate'));
      } else {
        var failed = result && result.results
          ? result.results.filter(function (item) { return item.error || (item.reason && item.reason !== 'up-to-date'); })
          : [];
        var reason = failed.length > 0
          ? (failed[0].error || failed[0].reason || '')
          : ((result && result.reason) || 'unknown');
        setComponentState('failed', t('settings.engine.failed', { reason: reason }));
      }
    }).catch(function (error) {
      setComponentState('failed', t('settings.engine.failed', { reason: String(error) }));
    }).then(function () {
      refreshComponents();
    });
  }

  /* --- 0.2.2 (D-99): 目录侧边栏 + 滚动联动 ------------------------------ */
  /**
   * Two behaviours, no dependencies:
   *   - clicking an entry scrolls the inner column (smooth unless the user asked
   *     for reduced motion);
   *   - scrolling moves the highlight (scrollspy), so the sidebar always says
   *     which pane you are looking at.
   *
   * Measured with `getBoundingClientRect()` instead of `offsetTop`: the sections
   * sit in different offsetParents (the two-column grid vs the scroll column),
   * and `offsetTop` would be relative to whichever one happens to be positioned.
   */
  function installSectionNav() {
    var host = doc.getElementById('settings-scroll');
    var nav = doc.getElementById('settings-nav');
    if (host === null || nav === null) return;
    var links = Array.prototype.slice.call(nav.querySelectorAll('[data-nav-target]'));
    if (links.length === 0) return;
    var sections = links.map(function (link) { return doc.getElementById(link.getAttribute('data-nav-target')); });

    function offsetInHost(node) {
      return node.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
    }

    function paint() {
      var probe = host.scrollTop + 28;
      var active = 0;
      for (var i = 0; i < sections.length; i += 1) {
        var node = sections[i];
        if (node !== null && offsetInHost(node) <= probe) active = i;
      }
      // At the very bottom the last section is the honest answer even when its
      // heading never crosses the probe line (a short tail section). Only when
      // the column actually overflows — otherwise the page is "all visible" and
      // the first entry is the right one.
      if (host.scrollHeight > host.clientHeight + 2
        && host.scrollTop + host.clientHeight >= host.scrollHeight - 4) {
        active = sections.length - 1;
      }

      links.forEach(function (link, index) {
        link.setAttribute('aria-current', index === active ? 'true' : 'false');
      });

      nav.setAttribute('data-active', links[active] === undefined ? '' : links[active].getAttribute('data-nav-target'));
      nav.setAttribute('data-scrollable', host.scrollHeight > host.clientHeight + 2 ? '1' : '0');
    }

    // No requestAnimationFrame gate: four rect reads per scroll event is cheaper
    // than a frame of lag, and scroll events are already frame-aligned.
    host.addEventListener('scroll', paint, { passive: true });

    links.forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        var target = doc.getElementById(link.getAttribute('data-nav-target'));
        if (target === null) return;
        var reduced = doc.documentElement.getAttribute('data-motion') === 'reduced';
        var top = Math.max(0, offsetInHost(target) - 4);
        if (typeof host.scrollTo === 'function') host.scrollTo({ top: top, behavior: reduced ? 'auto' : 'smooth' });
        else host.scrollTop = top;
        // Optimistic highlight: the click should feel instant, even though the
        // smooth scroll then emits a burst of scroll events.
        links.forEach(function (other) {
          other.setAttribute('aria-current', other === link ? 'true' : 'false');
        });
      });
    });

    global.addEventListener('resize', paint);
    // `wire()` runs before layout settles (and before the settings promise fills
    // the path rows), so the first measurement can be wrong. Re-measure when the
    // document is ready and whenever a pane changes height.
    global.addEventListener('load', paint);
    if (typeof global.ResizeObserver === 'function') {
      var observer = new global.ResizeObserver(function () { paint(); });
      observer.observe(host);
      sections.forEach(function (node) { if (node !== null) observer.observe(node); });
    }
    paint();
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
    // 0.2.1 (D-93 / D-94): the two update switches persist through SETTINGS_SET,
    // which is the only channel that actually writes config.json.
    var appAuto = doc.getElementById('settings-app-auto');
    if (appAuto !== null) {
      appAuto.checked = settingsInjected().autoCheckAppUpdate !== false;
      appAuto.addEventListener('change', function () {
        var bridge = global.ytvdltBridge;
        if (bridge && typeof bridge.invoke === 'function') {
          try { bridge.invoke('ytvdlt:settings:set', { autoCheckAppUpdate: appAuto.checked }); } catch (error) { /* offline */ }
        }
      });
    }
    var engineAuto = doc.getElementById('settings-engine-auto');
    if (engineAuto !== null) {
      engineAuto.checked = settingsInjected().autoCheckEngineUpdate !== false;
      engineAuto.addEventListener('change', function () {
        var bridge = global.ytvdltBridge;
        if (bridge && typeof bridge.invoke === 'function') {
          try { bridge.invoke('ytvdlt:settings:set', { autoCheckEngineUpdate: engineAuto.checked }); } catch (error) { /* offline */ }
        }
      });
    }

    // The persisted values are the truth, not `__YTVDLT_SETTINGS__` (which the
    // packaged app never injects — the settings page is a static file:// page).
    var pendingSettings = invokeBridge('ytvdlt:settings:get', {});
    if (pendingSettings !== null) {
      Promise.resolve(pendingSettings).then(function (snapshot) {
        if (snapshot === null || typeof snapshot !== 'object') return;
        paintPaths(snapshot);
        if (appAuto !== null && typeof snapshot.autoCheckAppUpdate === 'boolean') {
          appAuto.checked = snapshot.autoCheckAppUpdate;
        }
        if (engineAuto !== null && typeof snapshot.autoCheckEngineUpdate === 'boolean') {
          engineAuto.checked = snapshot.autoCheckEngineUpdate;
        }
      }).catch(function () { /* keep the defaults */ });
    }

    doc.querySelectorAll('[data-path-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        pathAction(
          button.getAttribute('data-path-action'),
          button.getAttribute('data-path-kind') === 'audio' ? 'audio' : 'video'
        );
      });
    });

    var engineCheck = doc.getElementById('settings-engine-check');
    if (engineCheck !== null) engineCheck.addEventListener('click', checkEngine);
    var engineUpdate = doc.getElementById('settings-engine-update');
    if (engineUpdate !== null) engineUpdate.addEventListener('click', runComponentUpdate);

    var appCheck = doc.getElementById('settings-app-update');
    if (appCheck !== null) {
      appCheck.addEventListener('click', function () {
        var current = doc.getElementById('settings-app-block');
        var phase = current === null ? 'idle' : current.getAttribute('data-update-state');
        appAction(phase === 'available' || phase === 'ready' ? 'download' : 'check');
      });
    }
    var appPage = doc.getElementById('settings-app-page');
    if (appPage !== null) appPage.addEventListener('click', function () { appAction('open-page'); });

    refreshComponents();
    readAppState();
    installSectionNav();
    // The queue dialog polls the same state; here it only has to keep the card
    // honest while a download is in flight.
    setInterval(function () {
      if (doc.visibilityState === 'hidden') return;
      var block = doc.getElementById('settings-app-block');
      var phase = block === null ? 'idle' : block.getAttribute('data-update-state');
      if (phase === 'downloading' || phase === 'checking') readAppState();
    }, 1500);
  }

  THEME_STATE = initial();
  paintTheme();
  wire();
  if (global.YTVDLT && global.YTVDLT.shell) {
    global.YTVDLT.shell.boot({ 'settings': function () { /* already here */ } });
  }
  global.YTVDLTSettings = { state: THEME_STATE, paintTheme: paintTheme, switchLocale: switchLocale };
})(typeof window === 'undefined' ? this : window);
