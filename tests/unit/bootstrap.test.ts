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
} = {}): Harness {
  const log: Harness['log'] = {
    quit: 0, handlers: [], windows: [], urls: [], trayToolTip: [], trayMenus: [],
    appEvents: new Map(), windowEvents: new Map(), shown: 0, focused: 0, destroyed: 0, trayDestroyed: 0,
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
    Tray: FakeTray as unknown as ElectronLike['Tray'],
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
