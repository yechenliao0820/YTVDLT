/**
 * app-nav.js — one navigation / fullscreen authority for every main-window page
 * (D-106). Zero imports: static `file://` pages have no bundler and no node:*.
 *
 * Why this file exists:
 *   1. navigation used to live ONLY in the native menu (`loadURL`), so the
 *      settings page had no visible way back and a page reload wiped the queue
 *      tab / search / sort / selection;
 *   2. fullscreen had TWO independent states — the queue button used the HTML
 *      Fullscreen API while 视图/全屏 used Electron's `setFullScreen()`. The
 *      button could therefore never exit a fullscreen entered from the menu.
 *
 * Contract:
 *   - the main process owns the window-level fullscreen state through the
 *     append-only channel `ytvdlt:window:fullscreen`; the renderer only asks.
 *     Without a preload bridge (static preview / e2e) we degrade to the HTML
 *     Fullscreen API so the button is still testable;
 *   - `window.YTVDLTShell.setFullscreenState(bool)` is the push endpoint the
 *     bootstrap calls on `enter-full-screen` / `leave-full-screen`;
 *   - view state lives in sessionStorage: same window, cleared on quit, and
 *     never shared between the independent e2e browser processes.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var FS_CHANNEL = 'ytvdlt:window:fullscreen';
  var VIEW_KEY = 'ytvdlt.queue.view';
  var HOST_IDS = ['queue-root', 'settings-root', 'ytvdlt-task-detail', 'ytvdlt-task-log', 'ytvdlt-batch'];

  var state = { fullscreen: false, buttons: [], leave: [], installed: false };

  function t(key, zh, en) {
    var i18n = global.YTVDLT && global.YTVDLT.i18n;
    var value = i18n && typeof i18n.t === 'function' ? i18n.t(key) : key;
    if (value === key || value === undefined || value === null) {
      var lang = doc && doc.documentElement ? String(doc.documentElement.getAttribute('lang') || '') : '';
      return lang.toLowerCase().indexOf('en') === 0 ? (en || key) : (zh || key);
    }
    return value;
  }

  function bridge() {
    var candidate = global.ytvdltBridge;
    return candidate && typeof candidate.invoke === 'function' ? candidate : null;
  }

  function viewStore() {
    try { if (global.sessionStorage) return global.sessionStorage; } catch (error) { /* unavailable */ }
    try { if (global.localStorage) return global.localStorage; } catch (error) { /* unavailable */ }
    return null;
  }

  function saveView(snapshot) {
    var store = viewStore();
    if (store === null || !snapshot || typeof snapshot !== 'object') return false;
    try { store.setItem(VIEW_KEY, JSON.stringify(snapshot)); return true; }
    catch (error) { return false; }
  }

  function restoreView() {
    var store = viewStore();
    if (store === null) return null;
    try {
      var raw = store.getItem(VIEW_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) { return null; }
  }

  function onLeave(fn) { if (typeof fn === 'function') state.leave.push(fn); }

  /** `.../pages/<name>/<file>.html` -> `.../pages/<target>/index.html`. */
  function pageUrl(target) {
    var href = String(global.location ? global.location.href : '');
    var base = href.split('#')[0].split('?')[0];
    var marker = base.lastIndexOf('/pages/');
    var file = marker === -1 ? base : base.slice(0, marker) + '/pages/' + target + '/index.html';
    var keep = [];
    try {
      var params = new global.URLSearchParams(String(global.location ? global.location.search : ''));
      ['lang', 'v'].forEach(function (key) {
        var value = params.get(key);
        if (value !== null && value !== '') keep.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      });
    } catch (error) { /* no URLSearchParams: navigate without query */ }
    return keep.length > 0 ? file + '?' + keep.join('&') : file;
  }

  function go(target) {
    state.leave.forEach(function (fn) { try { fn(); } catch (error) { /* best effort */ } });
    var url = pageUrl(target);
    if (global.location && typeof global.location.assign === 'function') global.location.assign(url);
    else if (global.location) global.location.href = url;
  }

  // ---------------------------------------------------------------- fullscreen

  function paintFullscreen(active) {
    state.fullscreen = active === true;
    state.buttons.forEach(function (button) {
      if (button === null) return;
      var label = state.fullscreen ? 'queue.fullscreen.exit' : 'queue.fullscreen.enter';
      button.textContent = '⛶ ' + t(label, state.fullscreen ? '退出全屏' : '全屏',
        state.fullscreen ? 'Exit full screen' : 'Full screen');
      button.setAttribute('aria-pressed', state.fullscreen ? 'true' : 'false');
      button.setAttribute('data-fullscreen', state.fullscreen ? 'true' : 'false');
    });
  }

  /** Main-process push endpoint (and the only source of truth while packaged). */
  function setFullscreenState(active) { paintFullscreen(active === true); }

  function requestFullscreen(flag) {
    var target = flag === true;
    var b = bridge();
    if (b !== null) {
      return Promise.resolve(b.invoke(FS_CHANNEL, { action: 'set', value: target }))
        .then(function (reply) {
          var value = reply && typeof reply === 'object' && typeof reply.fullscreen === 'boolean'
            ? reply.fullscreen : target;
          paintFullscreen(value);
        })
        .catch(function () { /* leave the last known state; the menu still works */ });
    }
    // Static preview: no main process, so use the browser API. Kept only for
    // headless / file:// — the packaged app never takes this branch.
    try {
      var active = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
      if (target && !active) {
        var root = doc.documentElement;
        if (root.requestFullscreen) root.requestFullscreen();
        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      } else if (!target && active) {
        if (doc.exitFullscreen) doc.exitFullscreen();
        else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      }
      paintFullscreen(target);
    } catch (error) { /* browser refused */ }
    return Promise.resolve();
  }

  function toggleFullscreen() { return requestFullscreen(!state.fullscreen); }

  function bindFullscreenButton(id) {
    var button = doc.getElementById(id);
    if (button === null || state.buttons.indexOf(button) !== -1) return button;
    state.buttons.push(button);
    button.addEventListener('click', function () { toggleFullscreen(); });
    paintFullscreen(state.fullscreen);
    return button;
  }

  // ------------------------------------------------------------------- install

  function currentPage() {
    var path = String(global.location ? global.location.pathname : '');
    if (path.indexOf('/settings/') !== -1) return 'settings';
    if (/\/queue\/index\.html$/i.test(path)) return 'queue';
    return 'other';
  }

  function makeButton(kind, key, zh, en) {
    var button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ytv-nav-btn';
    button.setAttribute('data-nav', kind);
    button.setAttribute('data-i18n', key);
    button.textContent = t(key, zh, en);
    button.addEventListener('click', function () { go(kind); });
    return button;
  }

  function install() {
    if (state.installed || doc === null || doc === undefined) return false;
    var host = null;
    for (var i = 0; i < HOST_IDS.length; i += 1) {
      host = doc.getElementById(HOST_IDS[i]);
      if (host !== null) break;
    }
    if (host === null) return false; // M3 dialogs are separate windows.
    state.installed = true;

    var page = currentPage();
    var nav = doc.createElement('nav');
    nav.className = 'ytv-nav';
    nav.id = 'ytvdlt-app-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', t('nav.label', '页面导航', 'Page navigation'));

    var back = makeButton('queue', 'nav.backToQueue', '← 返回下载队列', '← Back to queue');
    var settings = makeButton('settings', 'nav.settings', '设置', 'Settings');
    if (page === 'queue') back.setAttribute('hidden', 'true');
    if (page === 'settings') settings.setAttribute('hidden', 'true');
    nav.appendChild(back);
    nav.appendChild(settings);

    var current = doc.createElement('span');
    current.className = 'ytv-nav-current';
    var currentKey = page === 'settings' ? 'nav.settings' : (page === 'queue' ? 'nav.queue' : 'nav.other');
    current.textContent = t(currentKey, page === 'settings' ? '设置' : (page === 'queue' ? '下载队列' : '任务页面'),
      page === 'settings' ? 'Settings' : (page === 'queue' ? 'Download queue' : 'Task view'));
    var spacer = doc.createElement('span');
    spacer.className = 'ytv-nav-spacer';
    nav.appendChild(spacer);
    nav.appendChild(current);

    var fs = doc.createElement('button');
    fs.type = 'button';
    fs.className = 'ytv-nav-btn';
    fs.id = 'ytvdlt-nav-fullscreen';
    fs.setAttribute('data-fullscreen-action', 'toggle');
    nav.appendChild(fs);

    host.insertBefore(nav, host.firstChild);
    bindFullscreenButton('ytvdlt-nav-fullscreen');
    // A page that still ships the legacy header button is kept in sync too.
    bindFullscreenButton('queue-fullscreen');

    doc.addEventListener('keydown', function (event) {
      if (event && event.key === 'Escape' && state.fullscreen) {
        event.preventDefault();
        toggleFullscreen();
      }
    });
    doc.addEventListener('fullscreenchange', function () {
      if (bridge() === null) paintFullscreen(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    });
    doc.addEventListener('webkitfullscreenchange', function () {
      if (bridge() === null) paintFullscreen(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    });
    return true;
  }

  global.YTVDLT = global.YTVDLT || {};
  global.YTVDLTNav = {
    install: install,
    go: go,
    pageUrl: pageUrl,
    saveView: saveView,
    restoreView: restoreView,
    onLeave: onLeave,
    bindFullscreenButton: bindFullscreenButton,
    toggleFullscreen: toggleFullscreen,
    setFullscreenState: setFullscreenState,
    state: state
  };
  // Short alias used by the main process's executeJavaScript push.
  global.YTVDLTShell = global.YTVDLTShell || {};
  global.YTVDLTShell.toggleFullscreen = toggleFullscreen;
  global.YTVDLTShell.setFullscreenState = setFullscreenState;

  if (doc && doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install);
  else install();
})(typeof window === 'undefined' ? this : window);
