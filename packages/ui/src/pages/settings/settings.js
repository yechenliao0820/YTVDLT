/**
 * settings.js — appearance / language / update settings page (M5-1, M5-2).
 *
 * Live behaviour required by the acceptance:
 *   - theme switch repaints the whole page instantly (attributes on <html>, no reload);
 *   - accent follows the OS by default, a preset overrides it;
 *   - language switch reloads with `?lang=` because the M3 dialogs are frozen
 *     phrase-table pages (a reload is the only way back to Chinese without
 *     keeping the whole original DOM in memory — documented in M5-2-REPORT);
 *   - D-106: theme / accent / motion are written by `theme.js` into the real
 *     `SETTINGS_SET` channel (config.json) plus a synchronous local cache, so
 *     they survive page jumps and restarts. The old `CONFIG_SET` emission was
 *     an M3 fixture that never persisted anything — it no longer pretends to.
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
    var injected = settingsInjected();
    // D-106: the shared appearance state (config.json + local cache) is the
    // single source of truth; `?theme=` still wins for deterministic renders.
    var appearance = global.YTVDLTTheme && typeof global.YTVDLTTheme.state === 'function'
      ? global.YTVDLTTheme.state() : {};
    var theme = param('theme', appearance.theme || injected.theme || 'system');
    var accent = param('accent', appearance.accent || injected.accent || 'system');
    var motion = param('motion', appearance.motion || injected.motion || 'system');
    var locale = param('lang', injected.locale || injected.language || 'zh-CN');
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
    // D-106: `CONFIG_SET` is an M3 fixture channel and NEVER wrote config.json.
    // Appearance persistence is owned by theme.js -> SETTINGS_SET; the `<pre>`
    // above stays a debug surface for the screenshot suite only.
    return payload;
  }

  function paintTheme() {
    var appearance = global.YTVDLTTheme && typeof global.YTVDLTTheme.state === 'function'
      ? global.YTVDLTTheme.state() : null;
    if (appearance !== null) {
      THEME_STATE.theme = appearance.theme;
      THEME_STATE.accent = appearance.accent;
      THEME_STATE.motion = appearance.motion;
    }
    if (global.YTVDLTTheme) {
      global.YTVDLTTheme.apply({
        theme: THEME_STATE.theme,
        accent: THEME_STATE.accent,
        motion: THEME_STATE.motion,
        systemAccent: appearance === null
          ? (settingsInjected().systemAccent || null) : appearance.systemAccent
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

  /** D-106: one write fans out to the local cache, this DOM and config.json. */
  function persistAppearance(patch, action, value) {
    if (global.YTVDLTTheme && typeof global.YTVDLTTheme.set === 'function') {
      global.YTVDLTTheme.set(patch);
    } else if (patch.theme !== undefined) THEME_STATE.theme = patch.theme;
    else if (patch.accent !== undefined) THEME_STATE.accent = patch.accent;
    else if (patch.motion !== undefined) THEME_STATE.motion = patch.motion;
    emit(action, value);
    paintTheme();
  }

  function persistTheme(theme) { persistAppearance({ theme: theme }, 'theme', theme); }
  function persistAccent(accent) { persistAppearance({ accent: accent }, 'accent', accent); }
  function persistMotion(motion) { persistAppearance({ motion: motion }, 'motion', motion); }

  /** Language needs a reload: `i18n.js` only translates forward (zh -> en). */
  function switchLocale(locale) {
    THEME_STATE.locale = locale;
    var url = String(global.location.href).replace(/[?&]lang=[^&]*/g, '');
    // D-114: keep the version hint across the reload. A reload does not lose
    // the query by itself, but a page that arrived without `?v=` would stay
    // without it — and then only the async APP_INFO call keeps the footer right.
    if (!/[?&]v=/.test(url)) {
      var registry = global.YTVDLTAppVersion;
      var known = registry && typeof registry.query === 'function' ? registry.query() : '';
      if (known !== '') url += (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + known;
    }
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

  var appBusy = false;
  var appFeedback = '';

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
      stateNode.textContent = appFeedback || text;
      stateNode.setAttribute('data-update-state', phase);
    }
    if (block !== null) block.setAttribute('data-update-state', phase);
    if (checkButton !== null) {
      checkButton.disabled = appBusy || phase === 'checking' || phase === 'downloading';
      checkButton.removeAttribute('data-i18n');
      checkButton.textContent = phase === 'ready' ? t('update.install')
        : phase === 'available' ? t('update.download') : t('settings.app.check');
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
    if (appBusy) return;
    appBusy = true;
    appFeedback = '';
    var button = doc.getElementById('settings-app-update');
    if (button !== null) button.disabled = true;
    var pending = invokeBridge(APP_CHANNELS.action, { action: action });
    if (pending === null) { appBusy = false; paintApp(null); return; }
    Promise.resolve(pending).then(function (result) {
      appBusy = action === 'install' && result && result.ok === true;
      if (result && result.message && (result.ok === false || action === 'install')) {
        appFeedback = result.message;
      }
      if (result && result.state) paintApp(result.state);
      else readAppState();
    }).catch(function (error) {
      appBusy = false;
      appFeedback = t('settings.app.error', { reason: String(error) });
      readAppState();
    });
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

  /* --- D-103: 封面缓存管理 ------------------------------------------------ */
  /**
   * All four actions go through ONE channel. The renderer never sends a path:
   * `status` / `prune` / `set-auto` / `set-max-bytes` are main-process owned,
   * and the delete primitive there is `shell.trashItem` (never a hard unlink).
   */
  var CACHE_CHANNEL = 'ytvdlt:thumbnail:cache';

  function cacheNode(id) { return doc.getElementById(id); }

  function cacheNote(text, state) {
    var note = cacheNode('settings-cache-note');
    if (note === null) return;
    note.removeAttribute('data-i18n');
    note.textContent = text;
    note.setAttribute('data-cache-state', state);
  }

  function cacheControlsEnabled(enabled) {
    ['settings-cache-auto', 'settings-cache-limit', 'settings-cache-prune'].forEach(function (id) {
      var node = cacheNode(id);
      if (node !== null) node.disabled = !enabled;
    });
  }

  function paintCache(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') return;
    var bytes = cacheNode('settings-cache-bytes');
    var files = cacheNode('settings-cache-files');
    var reclaim = cacheNode('settings-cache-reclaim');
    // A policy-only update carries no occupancy numbers — leave those alone.
    if (bytes !== null && typeof snapshot.bytes === 'number') bytes.textContent = formatBytes(snapshot.bytes);
    if (files !== null && typeof snapshot.files === 'number') {
      files.textContent = t('settings.cache.filesUnit', { n: snapshot.files });
    }
    if (reclaim !== null && typeof snapshot.reclaimableBytes === 'number') {
      reclaim.textContent = formatBytes(snapshot.reclaimableBytes);
    }

    var auto = cacheNode('settings-cache-auto');
    if (auto !== null && typeof snapshot.enabled === 'boolean') auto.checked = snapshot.enabled;
    var limit = cacheNode('settings-cache-limit');
    if (limit !== null && typeof snapshot.maxBytes === 'number') {
      var wanted = String(Number(snapshot.maxBytes) || 0);
      var match = null;
      for (var i = 0; i < limit.options.length; i += 1) {
        if (limit.options[i].value === wanted) { match = limit.options[i]; break; }
      }
      if (match === null && wanted !== '0') {
        // A config.json value outside the four presets must still be shown,
        // otherwise the dropdown would silently disagree with the stored value.
        var option = doc.createElement('option');
        option.value = wanted;
        option.textContent = formatBytes(Number(wanted));
        limit.appendChild(option);
      }
      limit.value = wanted;
    }
  }

  function refreshCache(keepNote) {
    var pending = invokeBridge(CACHE_CHANNEL, { action: 'status' });
    if (pending === null) {
      cacheControlsEnabled(false);
      cacheNote(t('settings.cache.offline'), 'error');
      return;
    }
    Promise.resolve(pending).then(function (result) {
      if (result === null || typeof result !== 'object' || result.ok !== true || result.status === undefined) {
        cacheControlsEnabled(false);
        cacheNote(t('settings.cache.unavailable'), 'error');
        return;
      }
      cacheControlsEnabled(true);
      paintCache(result.status);
      if (keepNote !== true) cacheNote(t('settings.cache.hint'), 'idle');
    }).catch(function (error) {
      cacheControlsEnabled(false);
      cacheNote(t('settings.cache.failed', { reason: String(error) }), 'error');
    });
  }

  function updateCachePolicy(payload) {
    var pending = invokeBridge(CACHE_CHANNEL, payload);
    if (pending === null) { cacheNote(t('settings.cache.offline'), 'error'); return; }
    Promise.resolve(pending).then(function (result) {
      if (result !== null && typeof result === 'object' && result.policy !== undefined) {
        paintCache({ maxBytes: result.policy.maxBytes });
        var auto = cacheNode('settings-cache-auto');
        if (auto !== null && typeof result.policy.enabled === 'boolean') auto.checked = result.policy.enabled;
      }
      refreshCache(false);
    }).catch(function (error) {
      cacheNote(t('settings.cache.failed', { reason: String(error) }), 'error');
    });
  }

  function cleanCacheNow() {
    var button = cacheNode('settings-cache-prune');
    if (button !== null) {
      button.disabled = true;
      button.removeAttribute('data-i18n');
      button.textContent = t('settings.cache.pruning');
    }
    cacheNote(t('settings.cache.pruning'), 'idle');
    var pending = invokeBridge(CACHE_CHANNEL, { action: 'prune' });
    if (pending === null) {
      cacheNote(t('settings.cache.offline'), 'error');
      if (button !== null) button.disabled = false;
      return;
    }
    Promise.resolve(pending).then(function (result) {
      var report = result && result.report ? result.report : null;
      if (report === null || report.ok !== true) {
        cacheNote(t('settings.cache.failed', { reason: (result && result.message) || 'unknown' }), 'error');
        return;
      }
      // Explicit before -> after, so the reclaimed space is visible even when
      // the numbers above already refreshed.
      cacheNote(t('settings.cache.result', {
        before: formatBytes(Number(report.bytesBefore) || 0),
        after: formatBytes(Number(report.bytesAfter) || 0),
        freed: formatBytes(Number(report.freedBytes) || 0),
      }), 'ok');
    }).catch(function (error) {
      cacheNote(t('settings.cache.failed', { reason: String(error) }), 'error');
    }).then(function () {
      if (button !== null) {
        button.removeAttribute('data-i18n');
        button.textContent = t('settings.cache.prune');
        button.disabled = false;
      }
      refreshCache(true);
    });
  }

  function installCacheControls() {
    var auto = cacheNode('settings-cache-auto');
    if (auto !== null) {
      auto.addEventListener('change', function () {
        updateCachePolicy({ action: 'set-auto', enabled: auto.checked === true });
      });
    }
    var limit = cacheNode('settings-cache-limit');
    if (limit !== null) {
      limit.addEventListener('change', function () {
        var bytes = Number(limit.value);
        if (isFinite(bytes) && bytes > 0) updateCachePolicy({ action: 'set-max-bytes', maxBytes: bytes });
      });
    }
    var prune = cacheNode('settings-cache-prune');
    if (prune !== null) prune.addEventListener('click', cleanCacheNow);
    refreshCache(false);
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

  // ---- D-139: command templates (待改清单 #3) -----------------------------
  // The store, validation, IPC handlers and tests all existed; only a renderer
  // entry point was missing. This is the minimal closed loop: list, create,
  // delete — no in-place edit yet (the backend already supports it via `id`).
  // Static previews have no bridge, so the list stays empty and the note says
  // the feature is unavailable; the frozen screenshot baselines are rebuilt
  // only for the two settings cases (see D-139).
  var TEMPLATE_CHANNELS = {
    list: 'ytvdlt:template:list',
    save: 'ytvdlt:template:save',
    remove: 'ytvdlt:template:delete'
  };

  function templateNote(text) {
    var node = doc.getElementById('settings-template-note');
    if (node !== null) node.textContent = text;
  }

  /** One argument per line: no shell parsing, no quoting rules to get wrong. */
  function parseArgsText(text) {
    return String(text || '').split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line !== ''; });
  }

  function renderTemplates(templates) {
    var list = doc.getElementById('settings-template-list');
    var empty = doc.getElementById('settings-template-empty');
    if (list === null) return;
    list.textContent = '';
    var items = Array.isArray(templates) ? templates : [];
    if (empty !== null) empty.hidden = items.length > 0;
    items.forEach(function (template) {
      var row = doc.createElement('div');
      row.className = 'template-item';
      var name = doc.createElement('b');
      name.textContent = String(template.name || '');
      var args = doc.createElement('code');
      args.textContent = Array.isArray(template.args) ? template.args.join(' ') : '';
      var remove = doc.createElement('button');
      remove.type = 'button';
      remove.textContent = t('settings.templates.delete');
      remove.addEventListener('click', function () { removeTemplate(String(template.id || '')); });
      row.appendChild(name);
      row.appendChild(args);
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  function loadTemplates() {
    var pending = invokeBridge(TEMPLATE_CHANNELS.list, {});
    if (pending === null) {
      templateNote(t('settings.templates.unavailable'));
      return;
    }
    Promise.resolve(pending).then(function (result) {
      if (!result || !Array.isArray(result.templates)) {
        templateNote(t('settings.templates.unavailable'));
        return;
      }
      renderTemplates(result.templates);
      var rejected = Array.isArray(result.rejectedAtLoad) ? result.rejectedAtLoad.length : 0;
      if (rejected > 0) templateNote(t('settings.templates.rejected', { n: rejected }));
    }).catch(function () { templateNote(t('settings.templates.unavailable')); });
  }

  function saveTemplate() {
    var nameField = doc.getElementById('settings-template-name');
    var argsField = doc.getElementById('settings-template-args');
    if (nameField === null || argsField === null) return;
    var name = String(nameField.value || '').trim();
    var args = parseArgsText(argsField.value);
    if (name === '' || args.length === 0) {
      templateNote(t('settings.templates.missing'));
      return;
    }
    var pending = invokeBridge(TEMPLATE_CHANNELS.save, { name: name, args: args });
    if (pending === null) { templateNote(t('settings.templates.unavailable')); return; }
    Promise.resolve(pending).then(function (result) {
      if (!result || result.created === undefined) {
        var reason = result && (result.message || result.reason) ? String(result.message || result.reason) : '';
        templateNote(t('settings.templates.invalid', { reason: reason }));
        return;
      }
      nameField.value = '';
      argsField.value = '';
      templateNote(t('settings.templates.saved'));
      loadTemplates();
    }).catch(function (error) {
      templateNote(t('settings.templates.invalid', { reason: String(error).slice(0, 120) }));
    });
  }

  function removeTemplate(id) {
    if (id === '') return;
    var pending = invokeBridge(TEMPLATE_CHANNELS.remove, { id: id });
    if (pending === null) { templateNote(t('settings.templates.unavailable')); return; }
    Promise.resolve(pending).then(function (result) {
      if (!result || result.removed !== true) {
        templateNote(t('settings.templates.invalid', { reason: '' }));
        return;
      }
      templateNote(t('settings.templates.deleted'));
      loadTemplates();
    }).catch(function () { templateNote(t('settings.templates.unavailable')); });
  }

  function installTemplatePanel() {
    var save = doc.getElementById('settings-template-save');
    if (save === null) return;
    save.addEventListener('click', saveTemplate);
    loadTemplates();
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
      // D-166: this used to call `emit()`, which only wrote a debug <pre> — the
      // switch was decoration. Persist through the same channel the other
      // switches use; the main process writes the HKCU Run entry first and only
      // then the config, so a failure leaves the toggle telling the truth.
      autostart.addEventListener('change', function () {
        var bridge = global.ytvdltBridge;
        if (bridge && typeof bridge.invoke === 'function') {
          try {
            var pending = bridge.invoke('ytvdlt:settings:set', { autostart: autostart.checked });
            if (pending && typeof pending.catch === 'function') {
              pending.catch(function () { autostart.checked = !autostart.checked; });
            }
          } catch (error) {
            autostart.checked = !autostart.checked;
          }
        }
      });
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
        // D-106: config.json is authoritative; repaint once it has landed so
        // the three segmented controls never show a stale local value.
        paintTheme();
        paintPaths(snapshot);
        if (appAuto !== null && typeof snapshot.autoCheckAppUpdate === 'boolean') {
          appAuto.checked = snapshot.autoCheckAppUpdate;
        }
        if (engineAuto !== null && typeof snapshot.autoCheckEngineUpdate === 'boolean') {
          engineAuto.checked = snapshot.autoCheckEngineUpdate;
        }
        // D-166 follow-up: `autostart` on the snapshot is the HKCU Run truth
        // (m5-channels reads the registry). The initial paint above falls back
        // to `__YTVDLT_SETTINGS__`, which the packaged app never injects —
        // without this repaint the checkbox showed a stale `false`.
        if (autostart !== null && typeof snapshot.autostart === 'boolean') {
          autostart.checked = snapshot.autostart;
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
        appAction(phase === 'ready' ? 'install' : phase === 'available' ? 'download' : 'check');
      });
    }
    var appPage = doc.getElementById('settings-app-page');
    if (appPage !== null) appPage.addEventListener('click', function () { appAction('open-page'); });

    refreshComponents();
    readAppState();
    installCacheControls();
    installSectionNav();
    installTemplatePanel();
    // The queue dialog polls the same state; here it only has to keep the card
    // honest while a download is in flight.
    setInterval(function () {
      if (doc.visibilityState === 'hidden') return;
      var block = doc.getElementById('settings-app-block');
      var phase = block === null ? 'idle' : block.getAttribute('data-update-state');
      // D-141: `appBusy` is the ONLY signal that exists while `download` is
      // still pending — the main process answers that action when the transfer
      // finishes, so `data-update-state` stays `available` for the whole
      // download. Gating on the phase alone froze the card: no text updates and
      // no progress for minutes, then a jump straight to "install now".
      if (appBusy || phase === 'downloading' || phase === 'checking') readAppState();
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
