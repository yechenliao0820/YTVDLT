/**
 * about.js — shared version badge + About dialog (D-91, 0.1.10).
 *
 * Zero imports, no bundler, runs from `file://`. Loaded by BOTH the queue page
 * and the settings page so the native 「设置 → 关于 YTVDLT」 menu works no
 * matter which page is currently displayed. The main process opens it through
 * `webContents.executeJavaScript('window.YTVDLTAbout.open()')` — no new IPC
 * channel, no page reload.
 *
 * D-114: the version now comes from `YTVDLTAppVersion` (URL hint + authoritative
 * `APP_INFO`), never from a literal in this file. The old `FALLBACK_VERSION`
 * was `0.2.2` and survived four releases: any navigation that dropped `?v=`
 * made the footer, Settings and this dialog confidently display an obsolete
 * build. Unknown now renders as `v—`, which is honest and visibly wrong.
 */
(function (global) {
  'use strict';
  var doc = global.document;

  function param(name) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location ? global.location.search : '');
    return match === null ? '' : decodeURIComponent(match[1]);
  }

  function t(key) {
    return global.YTVDLT && global.YTVDLT.i18n ? global.YTVDLT.i18n.t(key) : key;
  }

  /** Single source of truth (D-114); the URL parameter is only a fallback hint. */
  function versionSource() {
    var registry = global.YTVDLTAppVersion;
    return registry && typeof registry.version === 'function' ? registry : null;
  }

  function version() {
    var registry = versionSource();
    if (registry !== null) return registry.version();
    return param('v');
  }

  function label() {
    var registry = versionSource();
    if (registry !== null) return registry.label();
    var value = param('v');
    return 'v' + (value === '' ? '—' : value);
  }

  var backdrop = null;
  var versionValue = null;

  function setText(id, text) {
    var node = doc.getElementById(id);
    if (node !== null) node.textContent = text;
  }

  /** Publish the version wherever the current page shows it. */
  function paintVersion() {
    setText('queue-version', label());
    setText('settings-meta', label());
    setText('about-version', label());
    if (versionValue !== null) versionValue.textContent = label();
  }

  function el(tag, style, text) {
    var node = doc.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  var LOGO = '<svg viewBox="0 0 40 40" width="44" height="44" aria-hidden="true" focusable="false">'
    + '<defs><linearGradient id="aboutGrad" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#3b8cf0"/><stop offset="1" stop-color="#174ea6"/>'
    + '</linearGradient></defs>'
    + '<rect x="0" y="0" width="40" height="40" rx="11" fill="url(#aboutGrad)"/>'
    + '<path d="M15.5 11.5 L27.5 19 L15.5 26.5 Z" fill="#ffffff"/>'
    + '<path d="M20 28.5 L20 34 M16.5 31.2 L20 34.7 L23.5 31.2" stroke="#ffffff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

  function build() {
    var wrap = el('div', [
      'position:fixed', 'inset:0', 'z-index:90', 'display:flex',
      'align-items:center', 'justify-content:center',
      'background:rgba(12,22,34,.5)', 'padding:20px'
    ].join(';'));
    wrap.id = 'ytvdlt-about';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('hidden', 'true');

    var box = el('div', [
      'width:min(460px,100%)', 'padding:22px 24px', 'border-radius:14px',
      'background:var(--panel,#fff)', 'color:var(--ink,#1b2430)',
      'border:1px solid var(--line,#d5dde5)',
      'box-shadow:0 24px 70px rgba(10,20,32,.34)', 'font-family:inherit'
    ].join(';'));

    var head = el('div', 'display:flex;align-items:center;gap:12px;margin-bottom:14px;');
    var mark = el('span');
    mark.innerHTML = LOGO;
    head.appendChild(mark);
    var names = el('div', 'display:flex;flex-direction:column;line-height:1.25;');
    names.appendChild(el('strong', 'font-size:19px;letter-spacing:.06em;', t('about.appName')));
    names.appendChild(el('span', 'font-size:12px;color:var(--muted,#5c6b7a);', t('about.tagline')));
    head.appendChild(names);
    box.appendChild(head);

    var grid = el('dl', [
      'display:grid', 'grid-template-columns:88px 1fr', 'gap:7px 12px',
      'font-size:13px', 'margin:0 0 14px', 'padding:12px 0',
      'border-top:1px solid var(--line,#d5dde5)',
      'border-bottom:1px solid var(--line,#d5dde5)'
    ].join(';'));
    var row = function (labelText, value) {
      var dt = el('dt', 'color:var(--muted,#5c6b7a);margin:0;', labelText);
      var dd = el('dd', 'margin:0;font-weight:700;', value);
      grid.appendChild(dt);
      grid.appendChild(dd);
      return dd;
    };
    versionValue = row(t('about.version'), label());
    row(t('about.author'), t('about.author.name'));
    box.appendChild(grid);

    box.appendChild(el('p', 'font-size:12px;line-height:1.6;color:var(--muted,#5c6b7a);margin:0 0 14px;', t('about.runtime')));
    box.appendChild(el('h3', 'font-size:13px;margin:0 0 6px;', t('about.license.title')));
    box.appendChild(el('p', 'font-size:12px;line-height:1.7;color:var(--muted,#5c6b7a);margin:0 0 18px;', t('about.license.body')));

    var foot = el('div', 'display:flex;align-items:center;gap:10px;');
    foot.appendChild(el('span', 'font-size:11px;color:var(--muted,#5c6b7a);flex:1 1 auto;', t('about.footer')));
    var close = el('button', [
      'height:32px', 'padding:0 16px', 'font-size:12px', 'font-family:inherit',
      'border-radius:6px', 'cursor:pointer', 'font-weight:700', 'color:#ffffff',
      'background:var(--accent,#1d63b8)', 'border:1px solid var(--accent,#1d63b8)'
    ].join(';'), t('common.close'));
    close.type = 'button';
    close.addEventListener('click', function () { setHidden(true); });
    foot.appendChild(close);
    box.appendChild(foot);

    wrap.appendChild(box);
    wrap.addEventListener('click', function (event) {
      if (event && event.target === wrap) setHidden(true);
    });
    doc.body.appendChild(wrap);
    return wrap;
  }

  function setHidden(hidden) {
    if (backdrop === null) backdrop = build();
    backdrop.setAttribute('hidden', hidden ? 'true' : 'false');
  }

  function open() { setHidden(false); }
  function close() { setHidden(true); }

  global.YTVDLTAbout = {
    open: open,
    close: close,
    // D-114: live getters — a value captured at load time would freeze the
    // pre-`APP_INFO` hint into the About box.
    get version() { return version(); },
    get label() { return label(); },
  };

  // The authoritative answer can arrive after this file ran; repaint both the
  // page badges and an already-built dialog (no reload, no reopen).
  if (global.YTVDLTAppVersion && typeof global.YTVDLTAppVersion.onChange === 'function') {
    global.YTVDLTAppVersion.onChange(paintVersion);
  }

  doc.addEventListener('keydown', function (event) {
    if (event && event.key === 'Escape') close();
  });

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', paintVersion);
  } else {
    paintVersion();
  }
})(typeof window === 'undefined' ? this : window);
