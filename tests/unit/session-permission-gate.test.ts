/**
 * D-198 · the D-170 session permission gate is actually WIRED in production.
 *
 * D-170 added two deny-all handlers on `electron.session?.defaultSession`, but
 * the production surface (`electron-entry.ts::electronSurface()`) carried no
 * `session` key, so the double optional chain short-circuited and the handlers
 * were never installed in a real Electron run. The surface now provides the
 * real `session.defaultSession`; this file pins the gate itself:
 *
 *   - a surface WITH `session` installs `setPermissionRequestHandler`, and the
 *     installed handler denies EVERY permission (asynchronous callback path);
 *   - `setPermissionCheckHandler` is installed and answers false for every
 *     permission (synchronous path);
 *   - a surface WITHOUT `session` (the shape of the older unit-test fakes)
 *     skips both gates silently and bootstrap still completes.
 *
 * Fake shape mirrors `bootstrap.test.ts` (same harness style, no Electron
 * binary needed — B1/D-39).
 */
import { describe, it, expect, vi } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { M5Host } from '../../apps/desktop/src/main/m5-host.js';
import type { IpcGateway } from '../../apps/desktop/src/main/ipc-gateway.js';
import {
  bootstrap,
  type BrowserWindowLike, type BrowserWindowOptionsLike, type ElectronLike,
  type MenuItemLike, type TrayLike,
} from '../../apps/desktop/src/main/bootstrap.js';

interface SessionLog {
  /** Handler installed by `setPermissionRequestHandler`, or null when absent. */
  permissionRequestHandler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null;
  /** Handler installed by `setPermissionCheckHandler`, or null when absent. */
  permissionCheckHandler: ((contents: unknown, permission: string) => boolean) | null;
}

interface Harness {
  electron: ElectronLike;
  sessionLog: SessionLog;
}

function fakeElectron(options: { withSession?: boolean } = {}): Harness {
  const sessionLog: SessionLog = { permissionRequestHandler: null, permissionCheckHandler: null };

  class FakeWindow implements BrowserWindowLike {
    readonly webContents;
    constructor(_opts: BrowserWindowOptionsLike) {
      this.webContents = {
        loadURL: async (_url: string) => { /* no-op */ },
        on: (_event: string, _listener: () => void) => { /* no-op */ },
        setWindowOpenHandler: (
          _handler: (details: { readonly url: string }) => { readonly action: 'deny' },
        ) => { /* no-op */ },
      };
    }
    on(_event: string, _listener: () => void): void { /* no-op */ }
    show(): void { /* no-op */ }
    focus(): void { /* no-op */ }
    isMinimized(): boolean { return false; }
    restore(): void { /* no-op */ }
    hide(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
  }

  class FakeTray implements TrayLike {
    setToolTip(_text: string): void { /* no-op */ }
    setContextMenu(_menu: unknown): void { /* no-op */ }
    on(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
  }

  const session: NonNullable<ElectronLike['session']> = {
    defaultSession: {
      setPermissionRequestHandler: (handler) => { sessionLog.permissionRequestHandler = handler; },
      setPermissionCheckHandler: (handler) => { sessionLog.permissionCheckHandler = handler; },
    },
  };

  const electron: ElectronLike = {
    app: {
      whenReady: async () => {},
      on: () => { /* no-op */ },
      quit: () => { /* no-op */ },
      requestSingleInstanceLock: () => true,
      getVersion: () => '0.1.0',
      getPath: () => 'C:/Users/test/AppData/Roaming',
      isPackaged: false,
    },
    ipcMain: {
      handle: (_channel: string, _listener: (event: unknown, payload: unknown) => unknown) => { /* no-op */ },
    },
    BrowserWindow: FakeWindow as unknown as ElectronLike['BrowserWindow'],
    nativeTheme: {
      shouldUseDarkColors: false,
      on: () => { /* no-op */ },
    },
    Tray: FakeTray as unknown as ElectronLike['Tray'],
    Menu: {
      buildFromTemplate: (template: readonly MenuItemLike[]) => Object.assign([...template], {
        popup: () => { /* no-op */ },
      }),
      setApplicationMenu: () => { /* no-op */ },
    },
    clipboard: { readText: () => '' },
    // Older fakes (bootstrap.test.ts included) carry NO `session` key; the
    // absent-key shape must keep working without throwing (D-198 assertion 3).
    ...(options.withSession === true ? { session } : {}),
  };
  return { electron, sessionLog };
}

function fakeHost(): { host: M5Host } {
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
    host: { gateway, dispose: vi.fn(), channels: [], appearance: async () => ({}) } as unknown as M5Host,
  };
}

const baseOptions = {
  pageUrl: 'file:///app/pages/queue/index.html',
  preloadPath: 'C:/app/preload.js',
  trayIconPath: 'C:/app/tray.png',
  argv: [] as readonly string[],
};

describe('bootstrap · session permission gate (D-170 / D-198)', () => {
  it('a surface WITH session installs the request handler and it denies every permission', async () => {
    const { electron, sessionLog } = fakeElectron({ withSession: true });
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(handle).not.toBeNull();

    // ① registered, then denies EVERY permission through the async callback.
    expect(sessionLog.permissionRequestHandler).not.toBeNull();
    const requestHandler = sessionLog.permissionRequestHandler as NonNullable<typeof sessionLog.permissionRequestHandler>;
    for (const permission of [
      'media', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write',
      'notifications', 'midi', 'midiSysex', 'idle-detection', 'pointerLock',
      'openExternal', 'unknown-future-permission',
    ]) {
      const seen: boolean[] = [];
      requestHandler({}, permission, (granted: boolean) => { seen.push(granted); });
      expect(seen).toEqual([false]);
    }
    handle?.dispose();
  });

  it('a surface WITH session installs the check handler and it answers false for every permission', async () => {
    const { electron, sessionLog } = fakeElectron({ withSession: true });
    const { host } = fakeHost();
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(handle).not.toBeNull();

    // ② registered, then false for EVERY permission on the sync path.
    expect(sessionLog.permissionCheckHandler).not.toBeNull();
    const checkHandler = sessionLog.permissionCheckHandler as NonNullable<typeof sessionLog.permissionCheckHandler>;
    for (const permission of ['media', 'geolocation', 'clipboard-read', 'notifications', 'unknown-future-permission']) {
      expect(checkHandler({}, permission)).toBe(false);
    }
    handle?.dispose();
  });

  it('a surface WITHOUT session skips both gates silently and bootstrap still completes', async () => {
    const { electron, sessionLog } = fakeElectron(); // no `session` key, like the older fakes
    const { host } = fakeHost();
    // ③ must neither register nor throw.
    const handle = await bootstrap(electron, { ...baseOptions, createHost: async () => host });
    expect(handle).not.toBeNull();
    expect(sessionLog.permissionRequestHandler).toBeNull();
    expect(sessionLog.permissionCheckHandler).toBeNull();
    // Bootstrap ran to the end: the IPC channels were registered and the page
    // URL was loaded, so the skip really is silent, not an early exit.
    expect(handle?.registeredChannels).toEqual([
      IPC_CHANNELS.PROBE, IPC_CHANNELS.TASK_LIST, IPC_CHANNELS.SETTINGS_GET,
      IPC_CHANNELS.WINDOW_FULLSCREEN,
    ]);
    handle?.dispose();
  });
});
