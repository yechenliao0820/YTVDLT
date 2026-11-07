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
  readonly type?: 'normal' | 'separator';
  readonly enabled?: boolean;
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
  });

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
  await window.webContents.loadURL(pageUrlWithPrefill(options.pageUrl, deepLink));
  window.webContents.on('did-finish-load', () => { window.show(); });

  app.on('second-instance', ((...args: never[]) => {
    const argv = Array.isArray(args[2]) ? (args[2] as unknown as readonly string[]) : [];
    showWindow();
    const url = deepLinkFromArgv(argv);
    if (url !== null) void window.webContents.loadURL(pageUrlWithPrefill(options.pageUrl, url));
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
