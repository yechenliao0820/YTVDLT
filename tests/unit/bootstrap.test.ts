/**
 * M5-0 · window / tray / IPC bootstrap (A-M5-00, §12.5 前置).
 *
 * `electron` is injected, so the real orchestration is testable without a binary
 * (B1/D-39): channel registration, the hardened window, the tray menu, the
 * close-to-tray policy, second-instance focus and `--url` prefill.
 */
import { describe, it, expect, vi } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { M5Host } from '../../apps/desktop/src/main/m5-host.js';
import type { IpcGateway } from '../../apps/desktop/src/main/ipc-gateway.js';
import {
  bootstrap, deepLinkFromArgv, pageUrlWithPrefill, resolveStartupLanguage,
  type BrowserWindowLike, type BrowserWindowOptionsLike, type ElectronLike,
  type MenuItemLike, type TrayLike,
} from '../../apps/desktop/src/main/bootstrap.js';

interface Harness {
  electron: ElectronLike;
  log: {
    quit: number;
    handlers: string[];
    windows: BrowserWindowOptionsLike[];
    urls: string[];
    trayToolTip: string[];
    trayMenus: unknown[];
    appEvents: Map<string, (...args: never[]) => void>;
    windowEvents: Map<string, () => void>;
    shown: number;
    focused: number;
    /** D-197: close-to-tray hides the window instead of destroying it. */
    hidden: number;
    destroyed: number;
    trayDestroyed: number;
    appMenu: unknown;
    contextMenus: MenuItemLike[][];
    /** D-137: captured so the sender guard can be exercised without Electron. */
    ipcListeners: Map<string, (event: unknown, payload: unknown) => unknown>;
    windowOpenHandler: ((details: { readonly url: string }) => { readonly action: 'deny' }) | null;
  };
}

function fakeElectron(options: {
  lock?: boolean;
  theme?: 'dark' | 'light';
  /** D-147: `app.getLocale()`; absent = the fake has no locale (old shape). */
  locale?: string;
  /** D-147: shared timeline so tests can prove write-back happens before loadURL. */
  trace?: string[];
  /** D-197: make `new Tray(...)` throw so `trayReady` stays false (D-60 fallback). */
  trayFails?: boolean;
  /**
   * Delivery report 五-1: the CONFIGURED icon path throws but
   * `process.execPath` succeeds — the "first attempt fails, exe retry wins"
   * scenario. Only a path ending in `.ico` fails, so the test passes such a
   * path as `trayIconPath`.
   */
  trayIconFails?: boolean;
  /**
   * Post-D-220 review audit: the icon-path Tray constructor SUCCEEDS but a
   * later buildTray step (`setContextMenu`) throws — the "half-built tray"
   * scenario. Non-icon paths behave like FakeTray, so the exe retry wins.
   */
  trayIconBreaksLater?: boolean;
  /**
   * With `trayIconBreaksLater`: the half-built tray's destroy() ALSO throws —
   * the triple-guard scenario (attempt fails -> cleanup fails -> the retry
   * must still go on, with no unhandled rejection).
   */
  laterBreakDestroyThrows?: boolean;
} = {}): Harness {
  const log: Harness['log'] = {
    quit: 0, handlers: [], windows: [], urls: [], trayToolTip: [], trayMenus: [],
    appEvents: new Map(), windowEvents: new Map(), shown: 0, focused: 0, hidden: 0, destroyed: 0, trayDestroyed: 0,
    appMenu: null, contextMenus: [], ipcListeners: new Map(), windowOpenHandler: null,
  };

  class FakeWindow implements BrowserWindowLike {
    readonly webContents;
    constructor(opts: BrowserWindowOptionsLike) {
      log.windows.push(opts);
      const events = new Map<string, () => void>();
      log.windowEvents = events;
      this.webContents = {
        loadURL: async (url: string) => {
          log.urls.push(url);
          options.trace?.push('loadURL');
          // Real Electron (D-215): `did-finish-load` fires while `loadURL()` is
          // still running — the promise resolves inside the SAME event
          // emission, so the `await` continuation only runs after the emission
          // has finished. A listener registered after the `await` therefore
          // never sees the first load (the launch-hidden regression). Firing
          // here keeps that ordering contract honest in the fake.
          events.get('wc:did-finish-load')?.();
        },
        on: (event: string, listener: () => void) => { events.set(`wc:${event}`, listener); },
        setWindowOpenHandler: (
          handler: (details: { readonly url: string }) => { readonly action: 'deny' },
        ) => { log.windowOpenHandler = handler; },
      };
    }
    on(event: string, listener: () => void): void { log.windowEvents.set(event, listener); }
    show(): void { log.shown += 1; }
    focus(): void { log.focused += 1; }
    isMinimized(): boolean { return false; }
    restore(): void { /* no-op */ }
    hide(): void { log.hidden += 1; }
    destroy(): void { log.destroyed += 1; }
  }

  class FakeTray implements TrayLike {
    setToolTip(text: string): void { log.trayToolTip.push(text); }
    setContextMenu(menu: unknown): void { log.trayMenus.push(menu); }
    on(): void { /* no-op */ }
    destroy(): void { log.trayDestroyed += 1; }
  }

  /**
   * Post-D-220 review audit: constructed fine, dies halfway through the
   * buildTray follow-ups. `setToolTip` works (the attempt really got halfway,
   * like a real native Tray would), `setContextMenu` throws, and — when
   * `laterBreakDestroyThrows` is set — even `destroy()` throws, exercising the
   * guarded-destroy path in `buildTray`.
   */
  class HalfBrokenTray implements TrayLike {
    setToolTip(text: string): void { log.trayToolTip.push(text); }
    setContextMenu(_menu: unknown): void { throw new Error('tray context menu exploded'); }
    on(): void { /* no-op */ }
    destroy(): void {
      if (options.laterBreakDestroyThrows === true) throw new Error('tray destroy exploded');
      log.trayDestroyed += 1;
    }
  }

  const electron: ElectronLike = {
    app: {
      whenReady: async () => {},
      on: (event: string, listener: (...args: never[]) => void) => { log.appEvents.set(event, listener); },
      quit: () => { log.quit += 1; },
      requestSingleInstanceLock: () => options.lock !== false,
      getVersion: () => '0.1.0',
      getPath: () => 'C:/Users/test/AppData/Roaming',
      ...(options.locale === undefined ? {} : { getLocale: () => options.locale ?? '' }),
      isPackaged: false,
    },
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
        log.handlers.push(channel);
        log.ipcListeners.set(channel, listener);
      },
    },
    BrowserWindow: FakeWindow as unknown as ElectronLike['BrowserWindow'],
    nativeTheme: {
      shouldUseDarkColors: options.theme === 'dark',
      on: () => { /* no-op */ },
    },
    Tray: (options.trayFails === true
      ? function FailingTray(): never { throw new Error('tray unavailable'); }
      : options.trayIconFails === true
        ? function FlakyTray(iconPath: string): TrayLike {
            if (/\.ico$/i.test(iconPath)) throw new Error('packaged icon path rejected');
            return new FakeTray();
          }
        : options.trayIconBreaksLater === true
          ? function HalfBrokenTrayFactory(iconPath: string): TrayLike {
              return /\.ico$/i.test(iconPath) ? new HalfBrokenTray() : new FakeTray();
            }
          : FakeTray) as unknown as ElectronLike['Tray'],
    Menu: {
      buildFromTemplate: (template: readonly MenuItemLike[]) => Object.assign([...template], {
        popup: () => { log.contextMenus.push([...template]); },
      }),
      setApplicationMenu: (menu: unknown) => { log.appMenu = menu; },
    },
    clipboard: { readText: () => '' },
  };
  return { electron, log };
}

/**
 * D-197: real-Electron close semantics the fake window must mirror. A `close`
 * event that is NOT prevented DESTROYS the window once the listener returns,
 * which fires `window-all-closed` -> `app.quit()` (win32). Returns whether the
 * close was prevented. With the pre-D-197 listener (which ignored the event)
 * every close took the destroy path and quit the app — the assertions below
 * would catch that regression.
 */
function emitClose(log: Harness['log']): boolean {
  const listener = log.windowEvents.get('close') as unknown as
    | ((event: { preventDefault(): void }) => void)
    | undefined;
  if (listener === undefined) throw new Error('no close listener registered');
  let prevented = false;
  listener({ preventDefault: () => { prevented = true; } });
  if (!prevented) {
    // Real Electron: an unprevented close destroys the window, which fires
    // `window-all-closed` and (on the default win32 platform) `app.quit()`.
    log.destroyed += 1;
    log.appEvents.get('window-all-closed')?.();
  }
  return prevented;
}

function fakeHost(): { host: M5Host; dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn();
  const gateway: IpcGateway = {
    handlers: new Map([
      [IPC_CHANNELS.PROBE, async () => ({ ok: true })],
      [IPC_CHANNELS.TASK_LIST, async () => ({ items: [] })],
      [IPC_CHANNELS.SETTINGS_GET, async () => ({ theme: 'system' })],
    ]),
    async dispatch() { return null; },
    registerAll(registrar) {
      for (const [channel, handler] of this.handlers) registrar.register(channel, handler);
    },
  };
  return {
    host: { gateway, dispose, channels: [], appearance: async () => ({}) } as unknown as M5Host,
    dispose,
  };
}

/**
 * D-147: a host whose config port carries a real, mutable `general.language`
 * and whose gateway MIRRORS the real SETTINGS_SET handler (validate + persist).
 * Every `gateway.dispatch` is recorded — both for the write assertions and for
 * the shared `trace`, which proves the write-back lands BEFORE the first
 * loadURL. `appearance()` mirrors `readAppearance`'s normalization
 * (anything not starting with "en" reads back as zh-CN).
 */
function fakeHostWithConfig(
  initialLanguage: string,
  trace: string[] = [],
): {
  host: M5Host;
  dispatches: { channel: string; payload: unknown }[];
  state: { language: string };
} {
  const state = { language: initialLanguage };
  const dispatches: { channel: string; payload: unknown }[] = [];
  const gateway: IpcGateway = {
    handlers: new Map([
      [IPC_CHANNELS.PROBE, async () => ({ ok: true })],
      [IPC_CHANNELS.TASK_LIST, async () => ({ items: [] })],
      [IPC_CHANNELS.SETTINGS_GET, async () => ({ language: state.language === 'en' ? 'en' : 'zh-CN' })],
    ]),
    async dispatch(channel: string, payload: unknown) {
      dispatches.push({ channel, payload });
      trace.push(channel);
      if (channel === IPC_CHANNELS.SETTINGS_SET) {
        const record = (payload ?? {}) as Record<string, unknown>;
        if (record['language'] !== undefined) {
          if (record['language'] !== 'zh-CN' && record['language'] !== 'en') {
            throw new Error('[m5-ipc] invalid language');
          }
          state.language = record['language'];
        }
        return { language: state.language };
      }
      return null;
    },
    registerAll(registrar) {
      for (const [channel, handler] of this.handlers) registrar.register(channel, handler);
    },
  };
  const config = {
    get: (_domain: string, key: string): unknown => (key === 'language' ? state.language : undefined),
  };
  return {
    host: {
      gateway,
      dispose: vi.fn(),
      channels: [],
      appearance: async () => ({ language: state.language === 'en' ? 'en' : 'zh-CN' }),
      m4: { task: { config } },
    } as unknown as M5Host,
    dispatches,
    state,
  };
}

const baseOptions = {
  pageUrl: 'file:///app/pages/queue/index.html',
  preloadPath: 'C:/app/preload.js',
  trayIconPath: 'C:/app/tray.png',
  argv: [] as readonly string[],
};

describe('bootstrap · launch guards', () => {
  it('quits instead of starting a second instance', async () => {
    const { electron, log } = fakeElectron({ lock: false });
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(handle).toBeNull();
    expect(log.quit).toBe(1);
    expect(log.handlers).toEqual([]);
  });

  it('builds a hardened window and registers every channel', async () => {
    const { electron, log } = fakeElectron({ theme: 'dark' });
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(handle).not.toBeNull();
    expect(log.handlers.slice().sort()).toEqual([
      IPC_CHANNELS.PROBE, IPC_CHANNELS.TASK_LIST, IPC_CHANNELS.SETTINGS_GET,
      IPC_CHANNELS.WINDOW_FULLSCREEN,
    ].sort());

    const windowOptions = log.windows[0] as BrowserWindowOptionsLike;
    expect(windowOptions.width).toBe(1280);
    expect(windowOptions.backgroundColor).toBe('#0e1720');
    expect(windowOptions.webPreferences).toMatchObject({
      preload: 'C:/app/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(handle?.registeredChannels).toHaveLength(4);
    handle?.dispose();
  });
});

describe('bootstrap · editable context menu', () => {
  it.each(['zh-CN', 'en'] as const)('shows localized edit actions only for editable fields (%s)', async (language) => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const localizedHost = { ...host, appearance: async () => ({ language }) } as unknown as M5Host;
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => localizedHost });
    const contextMenu = log.windowEvents.get('wc:context-menu') as unknown as (
      event: unknown, params: { isEditable: boolean; editFlags: Record<string, boolean> },
    ) => void;
    const editFlags = { canCut: false, canCopy: false, canPaste: true, canSelectAll: false };
    contextMenu({}, { isEditable: false, editFlags });
    expect(log.contextMenus).toHaveLength(0);
    contextMenu({}, { isEditable: true, editFlags });
    expect(log.contextMenus[0]).toEqual([
      { label: language === 'en' ? 'Cut' : '剪切', role: 'cut', enabled: false },
      { label: language === 'en' ? 'Copy' : '复制', role: 'copy', enabled: false },
      { label: language === 'en' ? 'Paste' : '粘贴', role: 'paste', enabled: true },
      { type: 'separator' },
      { label: language === 'en' ? 'Select all' : '全选', role: 'selectAll', enabled: false },
    ]);
    handle?.dispose();
  });
});

describe('bootstrap · deep link + tray + lifecycle', () => {
  it('passes --url to the page as ?prefill=', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, {
      ...baseOptions,
      argv: ['electron.exe', '--url=https://example.org/watch?v=1'],
      createHost: async () => host,
    });
    expect(log.urls[0]).toBe('file:///app/pages/queue/index.html?prefill=https%3A%2F%2Fexample.org%2Fwatch%3Fv%3D1');
    // D-215: the FIRST load's did-finish-load must already have shown the
    // window (no flash of an empty frame, no launch-into-tray). The fake fires
    // the event inside loadURL with real-Electron ordering, so a listener
    // registered after the `await` leaves `shown` at 0 here.
    expect(log.shown).toBe(1);
    handle?.dispose();
  });

  it('builds the M4 tray menu and tooltip', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, {
      ...baseOptions,
      trayStats: () => ({ active: 2, pending: 1, completed: 3, failed: 0 }),
      createHost: async () => host,
    });
    expect(log.trayToolTip[0]).toBe('YTVDLT · 运行 2 · 排队 1');
    const menu = log.trayMenus[0] as MenuItemLike[];
    const ids = menu.map((item) => item.id);
    expect(ids).toContain('show');
    expect(ids).toContain('quit');
    expect(menu.find((item) => item.id === 'cancel-all')?.label).toBe('取消全部（3）');
    handle?.dispose();
  });

  it('hides on close, focuses on second-instance, quits when idle', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    // close -> preventDefault + hide (close-to-tray, D-197), not destroy. The
    // listener now receives the close event; emitClose mirrors real Electron.
    expect(emitClose(log)).toBe(true);
    expect(log.hidden).toBe(1);
    expect(log.destroyed).toBe(0);

    const secondInstance = log.appEvents.get('second-instance');
    expect(secondInstance).toBeDefined();
    // Real Electron 45 contract: (event, argv, workingDirectory, additionalData).
    secondInstance?.(undefined as never, ['--url', 'https://example.org/second'] as never, 'C:/second' as never, undefined as never);
    expect(log.focused).toBeGreaterThanOrEqual(1);
    expect(log.urls.at(-1)).toContain('prefill=https%3A%2F%2Fexample.org%2Fsecond');

    const closeAll = log.appEvents.get('window-all-closed');
    closeAll?.();
    expect(log.quit).toBe(1);

    handle?.dispose();
    expect(log.destroyed).toBe(1);
    expect(log.trayDestroyed).toBe(1);
  });
});

describe('bootstrap · close-to-tray real semantics (D-197)', () => {
  it('with a tray: close is prevented and hidden, the app keeps running', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const onWindowClose = vi.fn();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host, onWindowClose });
    // Tray creation succeeded -> trayReady. The close MUST be prevented: with
    // the fake's real semantics an unprevented close destroys the window and
    // quits the app (the pre-D-197 behaviour), so these assertions pin the fix.
    expect(emitClose(log)).toBe(true);
    expect(log.hidden).toBe(1);
    expect(log.destroyed).toBe(0);
    expect(log.quit).toBe(0);
    // D-88: the private cleanup still fires on every close attempt.
    expect(onWindowClose).toHaveBeenCalledTimes(1);
    handle?.dispose();
    expect(log.destroyed).toBe(1);
  });

  it('without a tray (D-60 fallback): close is NOT prevented, the real close quits', async () => {
    // Delivery 五-1: the tray is now attempted TWICE (configured icon, then
    // process.execPath) and every failure is logged. This test injects NO
    // logger on purpose, so the console.error fallback runs — the bootstrap
    // must stay crash-free and the D-60 semantics must not change: tray null
    // -> close passes through -> real quit.
    const { electron, log } = fakeElectron({ trayFails: true });
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(handle?.tray).toBeNull();
    // Hiding would orphan the window, so the close stays unprevented: real
    // Electron destroys the window and the normal quit path completes.
    expect(emitClose(log)).toBe(false);
    expect(log.hidden).toBe(0);
    expect(log.destroyed).toBe(1);
    expect(log.quit).toBe(1); // window-all-closed -> app.quit()
    handle?.dispose();
  });

  it('while quitting: close is NOT prevented, quit still completes', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    // Tray quit (idle) sets `quitting = true` and starts the quit; the closing
    // window must not be prevented from dying.
    const menu = log.trayMenus[0] as MenuItemLike[];
    (menu.find((item) => item.id === 'quit')?.click as () => void)();
    expect(log.quit).toBe(1);
    expect(emitClose(log)).toBe(false);
    expect(log.hidden).toBe(0);
    expect(log.destroyed).toBe(1);
    expect(log.quit).toBe(2); // the close finishes -> window-all-closed -> quit
    handle?.dispose();
  });
});

describe('bootstrap · tray fallback + failure logging (delivery report 五-1)', () => {
  it('retries with process.execPath when the configured icon path fails, and logs the first attempt', async () => {
    const { electron, log } = fakeElectron({ trayIconFails: true });
    const { host } = fakeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const handle = await bootstrap(electron, {
      ...baseOptions,
      // `.ico` on purpose: the fake rejects exactly that shape (packaged
      // icon.ico present on disk but rejected by the Tray constructor).
      trayIconPath: 'C:/app/tray.ico',
      createHost: async () => host,
      logger,
    });
    // The exe retry built the tray: menu + tooltip installed, handle exposes it.
    expect(log.trayMenus).toHaveLength(1);
    expect(log.trayToolTip).toHaveLength(1);
    expect(handle?.tray).not.toBeNull();
    // trayReady semantics hold: close is prevented and hidden, not destroyed.
    expect(emitClose(log)).toBe(true);
    expect(log.hidden).toBe(1);
    expect(log.destroyed).toBe(0);
    // The FIRST attempt's failure was logged exactly once, marked as 'icon'.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('tray', 'tray creation failed', {
      attempt: 'icon',
      detail: expect.stringContaining('packaged icon path rejected'),
    });
    handle?.dispose();
    expect(log.trayDestroyed).toBe(1);
  });

  it('logs both attempts when every tray creation fails, then keeps the D-60 quit fallback', async () => {
    const { electron, log } = fakeElectron({ trayFails: true });
    const { host } = fakeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const handle = await bootstrap(electron, {
      ...baseOptions,
      createHost: async () => host,
      logger,
    });
    expect(handle?.tray).toBeNull();
    // D-60 fallback unchanged: no tray -> close NOT prevented -> real quit.
    expect(emitClose(log)).toBe(false);
    expect(log.hidden).toBe(0);
    expect(log.destroyed).toBe(1);
    expect(log.quit).toBe(1); // window-all-closed -> app.quit()
    // Two independent attempts, two separate log records: icon first, exe second.
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenNthCalledWith(1, 'tray', 'tray creation failed', {
      attempt: 'icon',
      detail: expect.stringContaining('tray unavailable'),
    });
    expect(logger.error).toHaveBeenNthCalledWith(2, 'tray', 'tray creation failed', {
      attempt: 'exe',
      detail: expect.stringContaining('tray unavailable'),
    });
    handle?.dispose();
  });

  // Post-D-220 review audit — 用例 2: the tray constructor succeeds but a
  // LATER buildTray step throws. The half-built instance must be destroyed
  // before the error reaches `createTrayWithFallback`, so the exe retry runs
  // against a clean slate instead of leaving a second tray icon behind.
  it('destroys the half-built tray when a post-construction step throws, and the exe retry still succeeds', async () => {
    const { electron, log } = fakeElectron({ trayIconBreaksLater: true });
    const { host } = fakeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const handle = await bootstrap(electron, {
      ...baseOptions,
      // `.ico` again: the fake makes exactly that shape reach the constructor
      // and THEN fail inside `setContextMenu` — after `new Tray()` succeeded.
      trayIconPath: 'C:/app/tray.ico',
      createHost: async () => host,
      logger,
    });
    // The icon attempt got halfway (tooltip installed), then died on the menu;
    // the exe retry delivered a complete tray.
    expect(log.trayToolTip).toHaveLength(2);
    expect(log.trayMenus).toHaveLength(1);
    expect(handle?.tray).not.toBeNull();
    // The half-built instance was destroyed EXACTLY once (no leaked icon, no
    // double icon); dispose() then destroys the live (exe) tray on top of it.
    expect(log.trayDestroyed).toBe(1);
    handle?.dispose();
    expect(log.trayDestroyed).toBe(2);
    // The ORIGINAL post-construction error reached the logger as the 'icon'
    // attempt — the fallback flow and its per-attempt logging are unchanged.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('tray', 'tray creation failed', {
      attempt: 'icon',
      detail: expect.stringContaining('tray context menu exploded'),
    });
  });

  // Post-D-220 review audit — 用例 3: even the cleanup itself fails. The
  // destroy() guard must swallow the secondary throw and re-raise the ORIGINAL
  // error, so the retry/fallback flow continues and nothing becomes an
  // unhandled rejection (vitest fails the run when one escapes).
  it('a half-built tray whose destroy() also throws still flows into the exe retry without an unhandled rejection', async () => {
    const { electron, log } = fakeElectron({ trayIconBreaksLater: true, laterBreakDestroyThrows: true });
    const { host } = fakeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const handle = await bootstrap(electron, {
      ...baseOptions,
      trayIconPath: 'C:/app/tray.ico',
      createHost: async () => host,
      logger,
    });
    // The guarded destroy swallowed the secondary throw; the retry ran and
    // bootstrap completed with a working (exe-built) tray.
    expect(handle).not.toBeNull();
    expect(log.trayMenus).toHaveLength(1);
    // The ORIGINAL error — not the destroy failure — is what got logged.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('tray', 'tray creation failed', {
      attempt: 'icon',
      detail: expect.stringContaining('tray context menu exploded'),
    });
    // The doomed half-built tray could not be destroyed (its destroy throws
    // before counting), so only the live exe tray is destroyed on dispose.
    handle?.dispose();
    expect(log.trayDestroyed).toBe(1);
  });
});

// Post-D-220 review audit — 用例 1: the injected logger is the seam the audit
// named ("日志异步失败"). electron-entry's `forwardLog` is module-internal and
// its file imports the real `electron` binary, so it is not unit-testable here
// (D-39); the SAME never-throw contract is enforced bootstrap-side in
// `logTrayFailure` and pinned by these two tests — a rejected promise (the
// real Logger -> JSONL sink failure mode) and a synchronous throw (a broken
// fake). Vitest fails the whole run on any unhandled rejection, so these
// tests staying green IS the no-unhandled-rejection assertion.
describe('bootstrap · logger sink failure never breaks start-up (post-D-220 review)', () => {
  it('a logger whose error() returns a rejected promise: bootstrap completes and console gets a minimal hint', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { electron, log } = fakeElectron({ trayFails: true });
      const { host } = fakeHost();
      // The JSONL-sink failure mode: the call itself "succeeds" but returns a
      // promise that rejects (Logger.error -> logSink.appendJsonl rejected).
      const logger = {
        error: vi.fn(() => Promise.reject(new Error('jsonl sink rejected'))),
        warn: vi.fn(),
        info: vi.fn(),
      };
      const handle = await bootstrap(electron, {
        ...baseOptions,
        createHost: async () => host,
        logger,
      });
      expect(handle).not.toBeNull();
      // Both failed tray attempts were reported through the broken sink...
      expect(logger.error).toHaveBeenCalledTimes(2);
      // ...and each degraded to the console fallback: minimal summary only.
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith('[log] sink failure:', expect.objectContaining({
        scope: 'tray',
        message: 'tray creation failed',
        reason: 'jsonl sink rejected',
      }));
      // The fields object (attempt + the tray error detail with its stack) is
      // NOT re-printed: console only ever sees the minimal summary.
      const printed = JSON.stringify(consoleError.mock.calls);
      expect(printed).not.toContain('"attempt"');
      expect(printed).not.toContain('tray unavailable');
      // The D-60 fallback semantics are untouched by the broken logger:
      // no tray -> close NOT prevented -> the real close quits.
      expect(emitClose(log)).toBe(false);
      expect(log.hidden).toBe(0);
      expect(log.quit).toBe(1);
      handle?.dispose();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a logger whose error() throws synchronously: bootstrap still completes and degrades to console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { electron, log } = fakeElectron({ trayFails: true });
      const { host } = fakeHost();
      const logger = {
        error: vi.fn(() => { throw new Error('logger exploded synchronously'); }),
        warn: vi.fn(),
        info: vi.fn(),
      };
      const handle = await bootstrap(electron, {
        ...baseOptions,
        createHost: async () => host,
        logger,
      });
      expect(handle).not.toBeNull();
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith('[log] sink failure:', expect.objectContaining({
        scope: 'tray',
        message: 'tray creation failed',
        reason: 'logger exploded synchronously',
      }));
      handle?.dispose();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('bootstrap · helpers', () => {
  it('only accepts http(s) deep links', () => {
    expect(deepLinkFromArgv(['--url=https://a.test/v'])).toBe('https://a.test/v');
    expect(deepLinkFromArgv(['--url', 'file:///c:/secret'])).toBeNull();
    expect(deepLinkFromArgv(['--other'])).toBeNull();
  });

  it('appends the prefill parameter without breaking an existing query', () => {
    expect(pageUrlWithPrefill('app://queue', null)).toBe('app://queue');
    expect(pageUrlWithPrefill('app://queue', 'https://a.test/v')).toBe('app://queue?prefill=https%3A%2F%2Fa.test%2Fv');
    expect(pageUrlWithPrefill('app://queue?x=1', 'https://a.test/v')).toBe('app://queue?x=1&prefill=https%3A%2F%2Fa.test%2Fv');
  });
});

describe('bootstrap · 中文应用菜单（D-82）', () => {
  it('installs a Chinese menu instead of Electron\'s English default', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    const template = log.appMenu as readonly { label?: string }[];
    expect(template.map((item) => item.label))
      .toEqual(['文件(&F)', '编辑(&E)', '视图(&V)', '窗口(&W)', '设置(&S)']);
    handle?.dispose();
  });

  // D-247 integration pin: whatever app-menu.ts builds, the INSTALLED menu
  // (built here through the real bootstrap wiring, both locales, including the
  // did-finish-load rebuild) must not carry Alt+F4 on 「退出」/ Quit — the
  // accelerator used to hijack the OS chord away from the D-60 close-to-tray
  // semantics. app-menu.test.ts pins the pure model; this pins the wiring.
  it('installed app menu carries no Alt+F4 accelerator on the quit item (D-247)', async () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const { electron, log } = fakeElectron();
      const { host } = fakeHost();
      const localizedHost = { ...host, appearance: async () => ({ language: locale }) } as unknown as M5Host;
      const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => localizedHost });
      const template = log.appMenu as readonly MenuItemLike[];
      const file = template.find((item) => String(item.label).startsWith(locale === 'en' ? 'File' : '文件'));
      const quit = (file?.submenu ?? []).find((item) => item.label === (locale === 'en' ? 'Quit' : '退出'));
      expect(quit?.accelerator).toBeUndefined();
      expect(typeof quit?.click).toBe('function');
      expect(JSON.stringify(template)).not.toContain('Alt+F4');
      handle?.dispose();
    }
  });
});

describe('bootstrap · IPC trust boundary (D-137)', () => {
  it('refuses another webContents, a subframe and an untrusted page', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    const wc = handle?.window.webContents;
    const invoke = log.ipcListeners.get(IPC_CHANNELS.PROBE);
    expect(invoke).toBeDefined();
    const frame = (url: string, parent: unknown = null) => ({
      sender: wc, senderFrame: { url, parent },
    });

    // The legitimate main-frame call still reaches the real handler.
    await expect(Promise.resolve(invoke!(frame(baseOptions.pageUrl), null)))
      .resolves.toMatchObject({ ok: true });
    expect(() => invoke!({
      sender: { other: true }, senderFrame: { url: baseOptions.pageUrl, parent: null },
    }, null)).toThrow(/sender is not the application window/);
    expect(() => invoke!(frame(baseOptions.pageUrl, {}), null)).toThrow(/subframe/);
    expect(() => invoke!(frame('https://evil.test/'), null)).toThrow(/untrusted page/);
    expect(() => invoke!({ sender: wc }, null)).toThrow(/no sender frame/);
    handle?.dispose();
  });

  it('blocks remote navigation while keeping local page switches working', async () => {
    const { electron, log } = fakeElectron();
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    const navigate = log.windowEvents.get('wc:will-navigate') as unknown as (
      event: { preventDefault(): void }, url: string,
    ) => void;
    expect(navigate).toBeDefined();
    const event = { preventDefault: vi.fn() };
    navigate(event, 'file:///app/pages/settings/index.html');
    navigate(event, `${baseOptions.pageUrl}?lang=en`);
    expect(event.preventDefault).not.toHaveBeenCalled();
    navigate(event, 'https://evil.test/');
    expect(event.preventDefault).toHaveBeenCalledOnce();

    // The renderer may not open a window that inherits the preload bridge.
    expect(log.windowOpenHandler).not.toBeNull();
    expect(log.windowOpenHandler?.({ url: 'https://evil.test/' })).toEqual({ action: 'deny' });
    handle?.dispose();
  });
});

describe('bootstrap · 首次启动语言检测（D-147）', () => {
  it('resolveStartupLanguage: the "" sentinel follows the OS locale', () => {
    expect(resolveStartupLanguage('', 'zh-CN')).toBe('zh-CN');
    expect(resolveStartupLanguage('', 'zh-TW')).toBe('zh-CN');
    expect(resolveStartupLanguage('', 'zh')).toBe('zh-CN');
    expect(resolveStartupLanguage('', 'en-US')).toBe('en');
    expect(resolveStartupLanguage('', 'fr-FR')).toBe('en');
  });

  it('resolveStartupLanguage: a concrete configured value wins over the OS locale', () => {
    expect(resolveStartupLanguage('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveStartupLanguage('zh-CN', 'zh-HK')).toBe('zh-CN');
    expect(resolveStartupLanguage('en', 'zh-CN')).toBe('en');
    expect(resolveStartupLanguage('en', 'fr-FR')).toBe('en');
  });

  it('resolveStartupLanguage: unrecognized values, zh script/underscore forms, empty OS locale', () => {
    // An unrecognized stored value is probed like the '' sentinel, so a
    // hand-edited config cannot brick the choice.
    expect(resolveStartupLanguage('fr', 'zh-Hans')).toBe('zh-CN');
    expect(resolveStartupLanguage('fr', 'zh_Hant')).toBe('zh-CN');
    expect(resolveStartupLanguage('fr', 'en-US')).toBe('en');
    // Script / underscore variants all count as Chinese.
    expect(resolveStartupLanguage('', 'zh-Hans')).toBe('zh-CN');
    expect(resolveStartupLanguage('', 'zh_Hant')).toBe('zh-CN');
    // No OS locale at all resolves to the non-Chinese default (English).
    expect(resolveStartupLanguage('', '')).toBe('en');
  });

  it('first launch on a Chinese system: detect -> persist -> load with the detected language', async () => {
    const trace: string[] = [];
    const { electron, log } = fakeElectron({ locale: 'zh-CN', trace });
    const { host, dispatches, state } = fakeHostWithConfig('', trace);
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    // Exactly one write, through the SAME SETTINGS_SET channel the settings
    // page uses, carrying the detected value.
    expect(dispatches).toEqual([
      { channel: IPC_CHANNELS.SETTINGS_SET, payload: { language: 'zh-CN' } },
    ]);
    expect(state.language).toBe('zh-CN');
    // The write-back is awaited BEFORE the first loadURL.
    expect(trace).toEqual([IPC_CHANNELS.SETTINGS_SET, 'loadURL']);
    // zh-CN pins no ?lang= (D-85 URL assertions stay byte-identical).
    expect(log.urls[0]).toBe('file:///app/pages/queue/index.html');
    // The native menu follows the detected language immediately.
    expect((log.appMenu as readonly { label?: string }[]).map((item) => item.label))
      .toEqual(['文件(&F)', '编辑(&E)', '视图(&V)', '窗口(&W)', '设置(&S)']);
    handle?.dispose();
  });

  it('first launch on a non-Chinese system: English, persisted and pinned via ?lang=', async () => {
    const trace: string[] = [];
    const { electron, log } = fakeElectron({ locale: 'en-US', trace });
    const { host, dispatches, state } = fakeHostWithConfig('', trace);
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(dispatches).toEqual([
      { channel: IPC_CHANNELS.SETTINGS_SET, payload: { language: 'en' } },
    ]);
    expect(state.language).toBe('en');
    expect(trace).toEqual([IPC_CHANNELS.SETTINGS_SET, 'loadURL']);
    expect(log.urls[0]).toBe('file:///app/pages/queue/index.html?lang=en');
    expect((log.appMenu as readonly { label?: string }[]).map((item) => item.label))
      .toEqual(['File(&F)', 'Edit(&E)', 'View(&V)', 'Window(&W)', 'Settings(&S)']);
    handle?.dispose();
  });

  it('second launch: the persisted language is never re-detected nor rewritten', async () => {
    // OS locale is English on purpose — the stored zh-CN must survive untouched.
    const trace: string[] = [];
    const { electron, log } = fakeElectron({ locale: 'en-US', trace });
    const { host, dispatches, state } = fakeHostWithConfig('zh-CN', trace);
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(dispatches).toEqual([]);
    expect(state.language).toBe('zh-CN');
    expect(log.urls[0]).toBe('file:///app/pages/queue/index.html');
    handle?.dispose();
  });

  it('second launch: a persisted English choice keeps ?lang= without a write', async () => {
    const { electron, log } = fakeElectron({ locale: 'zh-CN' });
    const { host, dispatches, state } = fakeHostWithConfig('en');
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(dispatches).toEqual([]);
    expect(state.language).toBe('en');
    expect(log.urls[0]).toBe('file:///app/pages/queue/index.html?lang=en');
    handle?.dispose();
  });

  it('a non-empty unrecognized stored value is left alone (no detection write)', async () => {
    const { electron, log } = fakeElectron({ locale: 'zh-CN' });
    const { host, dispatches, state } = fakeHostWithConfig('fr');
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(dispatches).toEqual([]);
    expect(state.language).toBe('fr');
    // The D-85 appearance fallback still governs such hosts: zh-CN pins no ?lang=.
    expect(log.urls[0]).toBe('file:///app/pages/queue/index.html');
    handle?.dispose();
  });
});
