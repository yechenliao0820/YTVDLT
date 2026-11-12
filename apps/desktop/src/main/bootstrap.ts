/**
 * Bootstrap — window / tray / IPC registration (M5-0).
 *
 * `electron` is INJECTED (`ElectronLike`) rather than imported, for the same
 * reason `tray.ts` and `preload/bridge.ts` are: this environment has no Electron
 * binary (D-39), and a module that cannot even be imported cannot be tested.
 * `electron-entry.ts` is the only file that touches the real `electron` module.
 *
 * What is real here (and tested with fakes):
 *   - single-instance lock + second-instance focus/prefill (A-4.1-02);
 *   - registering EVERY gateway channel on `ipcMain.handle`;
 *   - a hardened BrowserWindow (contextIsolation, no nodeIntegration, sandbox);
 *   - tray icon + menu rebuilt from the M4 `buildTrayMenu()` model;
 *   - close-to-tray policy and the "quit only when idle" rule.
 *
 * What is NOT here: engine / verifier construction. That needs the packaged
 * runtime layout and electron-builder output (N1), so `createHost` is injected
 * and the real wiring lands with the packaging block (M5-4).
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { M5Host } from './m5-host.js';
import { buildTrayMenu, trayTooltip, shouldHideToTray, canQuit, type TrayStats } from './tray.js';
import { buildAppMenu } from './app-menu.js';

export interface BrowserWindowOptionsLike {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly show: boolean;
  readonly backgroundColor: string;
  /** 0.2.1 (D-97): optional window/taskbar icon (`.ico` path). */
  readonly icon?: string;
  readonly webPreferences: {
    readonly preload: string;
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly sandbox: true;
    readonly webSecurity: true;
  };
}

export interface WebContentsLike {
  loadURL(url: string): Promise<void>;
  on(event: string, listener: () => void): void;
  /** D-91: optional so the unit-test fake needs no change; real Electron has it. */
  executeJavaScript?(code: string): Promise<unknown>;
  /** D-137 (F-04): optional for the same reason; absent = no new-window policy. */
  setWindowOpenHandler?(
    handler: (details: { readonly url: string }) => { readonly action: 'deny' },
  ): void;
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  on(event: string, listener: () => void): void;
  show(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  hide(): void;
  destroy(): void;
  /** D-106: optional so the unit-test fake stays valid without an Electron binary. */
  isFullScreen?(): boolean;
  setFullScreen?(flag: boolean): void;
}

export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: string, listener: () => void): void;
  destroy(): void;
}

export interface MenuItemLike {
  readonly id?: string;
  readonly label?: string;
  readonly role?: string;
  readonly accelerator?: string;
  readonly type?: 'normal' | 'separator' | 'submenu';
  readonly enabled?: boolean;
  readonly submenu?: readonly MenuItemLike[];
  readonly click?: () => void;
}

export interface ElectronLike {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: never[]) => void): void;
    quit(): void;
    requestSingleInstanceLock(): boolean;
    getVersion(): string;
    getPath(name: string): string;
    readonly isPackaged: boolean;
  };
  readonly ipcMain: {
    handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
  };
  readonly BrowserWindow: new (options: BrowserWindowOptionsLike) => BrowserWindowLike;
  readonly nativeTheme: {
    readonly shouldUseDarkColors: boolean;
    on(event: string, listener: () => void): void;
  };
  readonly Tray: new (iconPath: string) => TrayLike;
  readonly Menu: {
    buildFromTemplate(template: readonly MenuItemLike[]): unknown;
    /** Optional so the unit-test fake (buildFromTemplate only) stays valid. */
    setApplicationMenu?(menu: unknown): void;
  };
  readonly clipboard: {
    readText(): string;
  };
}

export interface BootstrapOptions {
  /** `file://.../pages/queue/index.html` (dev) or `app://…` (packaged). */
  readonly pageUrl: string;
  readonly preloadPath: string;
  readonly trayIconPath: string;
  /** `process.argv` at launch; only `--url=` matters here. */
  readonly argv: readonly string[];
  /** Builds the assembled host; injected so the packaging block owns engine wiring. */
  readonly createHost: () => Promise<M5Host>;
  /** Live counters for the tray menu; defaults to zeros. */
  readonly trayStats?: () => TrayStats;
  /** Called when the OS theme / accent changes (A-4.4-20 "跟随系统"). */
  readonly onSystemAppearanceChanged?: () => void;
  /**
   * D-88: private-mode cleanup hook. Fired on window close (which also covers
   * quitting) so the host can drop the task snapshot. Fire-and-forget here; the
   * desktop entry additionally guards `before-quit` to let it finish.
   */
  readonly onWindowClose?: () => Promise<void> | void;
  readonly platform?: string;
}

export interface BootstrapHandle {
  readonly host: M5Host;
  readonly window: BrowserWindowLike;
  readonly tray: TrayLike | null;
  readonly registeredChannels: readonly string[];
  showWindow(): void;
  dispose(): void;
}

const EMPTY_STATS: TrayStats = { active: 0, pending: 0, completed: 0, failed: 0 };

/**
 * D-137 (F-04) — the ONLY definition of "a page we trust with the bridge".
 *
 * D-138 fixes the first version: it compared `origin` to separate local pages
 * from remote ones, but EVERY `file:` URL has the literal origin `null`. So
 * `file:///C:/Users/Public/evil.html` — and even `file:///app/pages/%2e%2e/
 * %2e%2e/evil.html` — looked exactly like the packaged page. The rule is now a
 * normalised PATH allowlist under the application root:
 *
 *   - same scheme and host;
 *   - the candidate path is decoded, `.`/`..` are resolved, and the result must
 *     stay INSIDE the root derived from `pageUrl` (`<dist>/pages/queue/
 *     index.html` -> `<dist>/pages/`), compared case-insensitively because
 *     Windows is;
 *   - `file:` and the packaged app scheme both work; http(s) never does.
 *
 * `webContents.loadURL()` does not emit `will-navigate`, so this check cannot
 * interfere with the menu's own page switches.
 *
 * NOT covered: symlinks and NTFS 8.3 short names cannot be resolved without
 * touching the filesystem, which this module deliberately does not do. The
 * install directory is not user-writable, so an untrusted page cannot create
 * such an alias inside the trusted root.
 */
export function isTrustedLocalPage(candidate: string, pageUrl: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(pageUrl);
    if (actual.protocol !== expected.protocol) return false;
    if (/^https?:$/.test(actual.protocol)) return false;
    if (actual.host !== expected.host) return false;

    const actualSegments = normalizedPathSegments(actual.pathname);
    if (actualSegments === null) return false;

    if (actual.protocol === 'file:') {
      // The page lives at <root>/pages/<page>/index.html; trust the `pages`
      // directory, so every shipped page passes and nothing else does.
      const rootSegments = normalizedPathSegments(new URL('../', expected).pathname);
      if (rootSegments === null || rootSegments.length === 0) return false;
      if (actualSegments.length <= rootSegments.length) return false;
      if (!rootSegments.every((segment, index) => actualSegments[index] === segment)) return false;
      // A page, not an arbitrary asset: `index.html.bak` and `evil.js` inside
      // the root are not navigable application pages.
      return /\.html?$/.test(actualSegments[actualSegments.length - 1] as string);
    }

    // Packaged custom scheme (`app://queue`): same host is the same app.
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode and normalise a URL path into lowercase segments. `..` is resolved
 * HERE, not left to the URL parser — `new URL('file:///a/%2e%2e/b')` keeps the
 * encoded dots in `pathname`, so a parser-only check misses that traversal.
 * Returns null when the path escapes above its own root or decodes to garbage.
 */
function normalizedPathSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\u0000')) return null;
  const segments: string[] = [];
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part.toLowerCase());
  }
  return segments;
}

/** The slice of Electron's `IpcMainInvokeEvent` this boundary needs. */
export interface IpcInvokeEventLike {
  readonly sender?: unknown;
  readonly senderFrame?: {
    readonly url?: string;
    /** `null` on the main frame; a non-null parent means a subframe. */
    readonly parent?: unknown;
  } | null;
}

/**
 * Reject an invocation that did not come from the application window's MAIN
 * frame on a trusted local page. Throwing is deliberate: every renderer call
 * already treats a rejected promise as a failure, and there is no channel whose
 * "denied" reply shape could be invented here without lying about its type.
 *
 * Pure apart from the injected window reference, so both the allowed and the
 * refused paths are unit-testable without an Electron binary (D-39).
 */
export function assertTrustedIpcSender(
  event: unknown,
  window: BrowserWindowLike | null,
  pageUrl: string,
): void {
  const invocation = (event === null || typeof event !== 'object')
    ? null : event as IpcInvokeEventLike;
  if (invocation === null) throw new Error('[ipc] rejected: no invocation context');
  if (window !== null) {
    if (invocation.sender === undefined || invocation.sender !== window.webContents) {
      throw new Error('[ipc] rejected: sender is not the application window');
    }
  }
  const frame = invocation.senderFrame;
  if (frame === undefined || frame === null) {
    throw new Error('[ipc] rejected: no sender frame');
  }
  if (frame.parent !== null && frame.parent !== undefined) {
    throw new Error('[ipc] rejected: subframe invocation');
  }
  if (!isTrustedLocalPage(frame.url ?? '', pageUrl)) {
    throw new Error('[ipc] rejected: untrusted page');
  }
}

/** `?prefill=` is how the renderer learns about `--url` before its JS runs. */
export function pageUrlWithPrefill(pageUrl: string, url: string | null): string {
  if (url === null) return pageUrl;
  const separator = pageUrl.includes('?') ? '&' : '?';
  return `${pageUrl}${separator}prefill=${encodeURIComponent(url)}`;
}

/**
 * D-85: the persisted language must survive a restart. The renderer reads
 * `?lang=en` (i18n.js), so the main process pins it onto the page URL at load
 * time. Chinese is the shipped default and needs no query parameter — this also
 * keeps every existing URL assertion byte-identical.
 */
export function withLocale(pageUrl: string, locale: 'zh-CN' | 'en'): string {
  if (locale !== 'en' || /[?&]lang=/.test(pageUrl)) return pageUrl;
  const separator = pageUrl.includes('?') ? '&' : '?';
  return `${pageUrl}${separator}lang=en`;
}

export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg.startsWith('--url=')) {
      const value = arg.slice('--url='.length);
      return /^https?:\/\//i.test(value) ? value : null;
    }
    if (arg === '--url') {
      const next = argv[index + 1];
      if (next === undefined) return null;
      const value = String(next);
      return /^https?:\/\//i.test(value) ? value : null;
    }
  }
  return null;
}

export async function bootstrap(electron: ElectronLike, options: BootstrapOptions): Promise<BootstrapHandle | null> {
  const { app, ipcMain, BrowserWindow, nativeTheme, Tray, Menu } = electron;
  const platform = options.platform ?? 'win32';

  // 1. Single instance: a second launch focuses the window and prefills the URL.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  await app.whenReady();

  const host = await options.createHost();

  // D-85: read the persisted language before the first page load. The unit-test
  // fake returns `{}`, which deliberately falls back to Chinese.
  const appearance = typeof host.appearance === 'function' ? await host.appearance() : null;
  let menuLocale: 'zh-CN' | 'en' = appearance?.language === 'en' ? 'en' : 'zh-CN';
  const launchUrl = withLocale(options.pageUrl, menuLocale);

  // 2. Register every channel of the merged gateway (M3 + M5).
  // D-137 (F-04): `_event` used to be discarded, so ANY webContents/frame that
  // somehow obtained the bridge could invoke a sensitive channel. The window is
  // created in step 3, so the guard reads it through a reference that is set
  // before the first page load; registration ORDER and channel SET stay intact.
  const registeredChannels: string[] = [];
  let windowRef: BrowserWindowLike | null = null;
  const guarded = (event: unknown): void => {
    assertTrustedIpcSender(event, windowRef, options.pageUrl);
  };
  host.gateway.registerAll({
    register(channel, handler) {
      ipcMain.handle(channel, (event, payload) => {
        guarded(event);
        return handler(payload);
      });
      registeredChannels.push(channel);
    },
  });

  // 3. Hardened window: no node integration, isolated context, sandboxed.
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    // 0.2.1 (D-97): pin the window/taskbar icon as well. A packaged build inherits
    // the exe icon, but a dev run (`electron .`) would otherwise show the stock
    // Electron atom — the same visual bug as a stale desktop shortcut.
    icon: options.trayIconPath,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1720' : '#eef2f6',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  windowRef = window;

  // D-137 (F-04): keep the renderer on a trusted LOCAL page. A compromised
  // page must not be able to navigate this window (which still holds the
  // preload bridge) to a remote origin, and must not open new windows with it.
  // `webContents.loadURL()` (menu navigation, `--url` prefill) does NOT emit
  // `will-navigate`, so those paths are unaffected. External links are opened
  // by the main process through `shell.openExternal`, never by the renderer.
  window.webContents.on('will-navigate', ((event: { preventDefault(): void }, url: string) => {
    if (!isTrustedLocalPage(url, options.pageUrl)) event.preventDefault();
  }) as () => void);
  window.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));

  window.webContents.on('context-menu', ((_event: unknown, params: {
    isEditable: boolean;
    editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
  }) => {
    if (!params.isEditable) return;
    const labels: readonly [string, string, string, string] = menuLocale === 'en'
      ? ['Cut', 'Copy', 'Paste', 'Select all']
      : ['剪切', '复制', '粘贴', '全选'];
    const menu = Menu.buildFromTemplate([
      { label: labels[0], role: 'cut', enabled: params.editFlags.canCut },
      { label: labels[1], role: 'copy', enabled: params.editFlags.canCopy },
      { label: labels[2], role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: labels[3], role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]) as { popup(options: { window: BrowserWindowLike }): void };
    menu.popup({ window });
  }) as () => void);

  // D-106: ONE fullscreen authority. Every renderer page and the 视图 menu
  // ask this handler; enter/leave events push the resulting state back so the
  // visible button always says the truth (and can always exit).
  const currentFullscreen = (): boolean =>
    typeof window.isFullScreen === 'function' ? window.isFullScreen() : false;
  function pushFullscreenState(flag: boolean): void {
    void Promise.resolve(window.webContents.executeJavaScript?.(
      `window.YTVDLTShell && window.YTVDLTShell.setFullscreenState(${flag === true})`,
    )).catch(() => { /* renderer not ready yet */ });
  }
  function applyFullscreen(flag: boolean): boolean {
    if (typeof window.setFullScreen === 'function') window.setFullScreen(flag);
    const actual = currentFullscreen();
    pushFullscreenState(actual);
    return actual;
  }
  ipcMain.handle(IPC_CHANNELS.WINDOW_FULLSCREEN, (event, payload) => {
    guarded(event);
    const record = payload !== null && typeof payload === 'object'
      ? payload as Record<string, unknown> : {};
    const action = record['action'] === 'get' || record['action'] === 'set'
      ? record['action'] : 'toggle';
    const current = currentFullscreen();
    if (action === 'get') return { ok: true, fullscreen: current };
    const target = action === 'set' ? record['value'] === true : !current;
    return { ok: true, fullscreen: target === current ? current : applyFullscreen(target) };
  });
  window.on('enter-full-screen', () => { pushFullscreenState(true); });
  window.on('leave-full-screen', () => { pushFullscreenState(false); });
  registeredChannels.push(IPC_CHANNELS.WINDOW_FULLSCREEN);

  const stats = options.trayStats ?? (() => EMPTY_STATS);
  let quitting = false;

  // 4. Close-to-tray: only when a tray really exists. Without this guard a
  //    failed tray creation would hide the window with no way to bring it back.
  let trayReady = false;
  window.on('close', () => {
    const intent = { action: 'close' as const, minimizeToTray: trayReady, active: stats().active };
    if (shouldHideToTray(intent) && !quitting) window.hide();
    // D-88: private mode clears the history on every window close (hiding to
    // the tray included). The desktop entry also guards before-quit for the
    // case where the process really exits.
    void Promise.resolve(options.onWindowClose?.()).catch(() => { /* best effort */ });
  });

  // 4.5 应用菜单（D-82 中文化 / D-85 跟随语言）。没有这一步 Electron 会自带
  //     英文默认菜单（File / Edit / View / Window）。语言切换会让渲染层重载
  //     页面，`did-finish-load` 时再刷一次菜单即可，无需新增 IPC 通道。
  // D-91: the Settings menu owns navigation to the settings page and the About
  // dialog. No new IPC channel — navigation uses loadURL, and About is opened
  // by calling a renderer-side function through executeJavaScript.
  const settingsPageUrl = options.pageUrl.replace(/pages[\\/]queue[\\/]index\.html/, 'pages/settings/index.html');
  function refreshAppMenu(locale: 'zh-CN' | 'en'): void {
    const appMenu: readonly MenuItemLike[] = buildAppMenu({
      showWindow: () => { showWindow(); },
      quit: () => {
        void Promise.resolve(options.onWindowClose?.()).catch(() => { /* best effort */ });
        quitting = true;
        app.quit();
      },
      platform,
      locale,
      openSettings: () => {
        void window.webContents.loadURL(withLocale(settingsPageUrl, menuLocale));
      },
      openQueue: () => {
        void window.webContents.loadURL(withLocale(options.pageUrl, menuLocale));
      },
      openAbout: () => {
        void window.webContents.executeJavaScript?.('window.YTVDLTAbout && window.YTVDLTAbout.open()');
      },
      toggleFullscreen: () => { applyFullscreen(!currentFullscreen()); },
    });
    Menu.setApplicationMenu?.(Menu.buildFromTemplate(appMenu));
  }
  refreshAppMenu(menuLocale);

  // 5. Tray: same menu model as M4, rebuilt from live counters.
  let tray: TrayLike | null = null;
  try {
    tray = new Tray(options.trayIconPath);
    const template: MenuItemLike[] = buildTrayMenu(stats()).map((item) => ({
      ...(item.type === 'separator' ? {} : { id: item.id }),
      label: item.label,
      type: item.type,
      enabled: item.enabled,
      ...(item.id === 'show' ? { click: () => { window.show(); window.focus(); } } : {}),
      ...(item.id === 'quit' ? {
        click: () => {
          if (!canQuit(stats())) return;
          quitting = true;
          app.quit();
        },
      } : {}),
    }));
    tray.setToolTip(trayTooltip(stats()));
    tray.setContextMenu(Menu.buildFromTemplate(template));
    trayReady = true;
  } catch {
    // A missing tray icon must not abort start-up (headless CI / first run).
    tray = null;
  }

  // 6. OS theme / accent changes repaint the renderer without a reload.
  nativeTheme.on('updated', () => { options.onSystemAppearanceChanged?.(); });

  // 7. Launch the queue page; `--url` arrives as a query parameter.
  const deepLink = deepLinkFromArgv(options.argv);
  await window.webContents.loadURL(pageUrlWithPrefill(launchUrl, deepLink));
  window.webContents.on('did-finish-load', () => {
    window.show();
    // D-106: a page jump (menu / nav bar) rebuilds the renderer, so re-push
    // the current window state instead of leaving the fresh button stale.
    pushFullscreenState(currentFullscreen());
    // D-85: switching the language reloads the renderer. Re-read the setting
    // and repaint the native menu so File/Edit/View/Window follow the page.
    void (async () => {
      const next = typeof host.appearance === 'function' ? await host.appearance() : null;
      menuLocale = next?.language === 'en' ? 'en' : 'zh-CN';
      refreshAppMenu(menuLocale);
    })();
  });

  app.on('second-instance', ((...args: never[]) => {
    const argv = Array.isArray(args[2]) ? (args[2] as unknown as readonly string[]) : [];
    showWindow();
    const url = deepLinkFromArgv(argv);
    if (url !== null) void window.webContents.loadURL(pageUrlWithPrefill(withLocale(options.pageUrl, menuLocale), url));
  }) as (...args: never[]) => void);

  app.on('window-all-closed', (() => {
    if (platform !== 'darwin') app.quit();
  }) as (...args: never[]) => void);

  function showWindow(): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  return {
    host,
    window,
    tray,
    registeredChannels,
    showWindow,
    dispose(): void {
      quitting = true;
      host.dispose();
      tray?.destroy();
      window.destroy();
    },
  };
}
