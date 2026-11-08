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
  const registeredChannels: string[] = [];
  host.gateway.registerAll({
    register(channel, handler) {
      ipcMain.handle(channel, (_event, payload) => handler(payload));
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1720' : '#eef2f6',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

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
