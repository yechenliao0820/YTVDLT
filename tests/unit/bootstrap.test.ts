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
  bootstrap, deepLinkFromArgv, pageUrlWithPrefill,
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
    destroyed: number;
    trayDestroyed: number;
    appMenu: unknown;
  };
}

function fakeElectron(options: { lock?: boolean; theme?: 'dark' | 'light' } = {}): Harness {
  const log: Harness['log'] = {
    quit: 0, handlers: [], windows: [], urls: [], trayToolTip: [], trayMenus: [],
    appEvents: new Map(), windowEvents: new Map(), shown: 0, focused: 0, destroyed: 0, trayDestroyed: 0,
    appMenu: null,
  };

  class FakeWindow implements BrowserWindowLike {
    readonly webContents;
    constructor(opts: BrowserWindowOptionsLike) {
      log.windows.push(opts);
      const events = new Map<string, () => void>();
      log.windowEvents = events;
      this.webContents = {
        loadURL: async (url: string) => { log.urls.push(url); },
        on: (event: string, listener: () => void) => { events.set(`wc:${event}`, listener); },
      };
    }
    on(event: string, listener: () => void): void { log.windowEvents.set(event, listener); }
    show(): void { log.shown += 1; }
    focus(): void { log.focused += 1; }
    isMinimized(): boolean { return false; }
    restore(): void { /* no-op */ }
    hide(): void { /* no-op */ }
    destroy(): void { log.destroyed += 1; }
  }

  class FakeTray implements TrayLike {
    setToolTip(text: string): void { log.trayToolTip.push(text); }
    setContextMenu(menu: unknown): void { log.trayMenus.push(menu); }
    on(): void { /* no-op */ }
    destroy(): void { log.trayDestroyed += 1; }
  }

  const electron: ElectronLike = {
    app: {
      whenReady: async () => {},
      on: (event: string, listener: (...args: never[]) => void) => { log.appEvents.set(event, listener); },
      quit: () => { log.quit += 1; },
      requestSingleInstanceLock: () => options.lock !== false,
      getVersion: () => '0.1.0',
      getPath: () => 'C:/Users/test/AppData/Roaming',
      isPackaged: false,
    },
    ipcMain: {
      handle: (channel: string) => { log.handlers.push(channel); },
    },
    BrowserWindow: FakeWindow as unknown as ElectronLike['BrowserWindow'],
    nativeTheme: {
      shouldUseDarkColors: options.theme === 'dark',
      on: () => { /* no-op */ },
    },
    Tray: FakeTray as unknown as ElectronLike['Tray'],
    Menu: {
      buildFromTemplate: (template: readonly MenuItemLike[]) => template,
      setApplicationMenu: (menu: unknown) => { log.appMenu = menu; },
    },
    clipboard: { readText: () => '' },
  };
  return { electron, log };
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
    expect(log.handlers.slice().sort()).toEqual([IPC_CHANNELS.PROBE, IPC_CHANNELS.TASK_LIST, IPC_CHANNELS.SETTINGS_GET].sort());

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
    expect(handle?.registeredChannels).toHaveLength(3);
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
    // did-finish-load shows the window (no flash of an empty frame).
    log.windowEvents.get('wc:did-finish-load')?.();
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
    // close -> hide (close-to-tray), not destroy
    log.windowEvents.get('close')?.();
    expect(log.destroyed).toBe(0);

    const secondInstance = log.appEvents.get('second-instance');
    expect(secondInstance).toBeDefined();
    secondInstance?.(undefined as never, undefined as never, ['--url', 'https://example.org/second'] as never);
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
});
