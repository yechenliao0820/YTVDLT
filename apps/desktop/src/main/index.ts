/**
 * Electron main-process entry point (M3-B4 / F056).
 *
 * Registers the whitelisted IpcGateway handlers with an INJECTED registrar.
 * Deliberately does NOT create a BrowserWindow, call `app.whenReady()` or
 * import `electron` at runtime: `node_modules/electron/dist` has no binary in
 * this offline environment (D-39). The real window / renderer wiring is a
 * post-network补做项 (PRD-M3 §5.5 table item 2).
 */
import type { IpcGateway, IpcRegistrar } from './ipc-gateway.js';

/** Register every M3 channel. Returns the number of registered handlers. */
export function registerIpcGateway(gateway: IpcGateway, registrar: IpcRegistrar): number {
  const registered: string[] = [];
  gateway.registerAll({
    register(channel: string, handler: (payload: unknown) => unknown | Promise<unknown>): void {
      registrar.register(channel, handler);
      registered.push(channel);
    },
  });
  return registered.length;
}

export { createIpcGateway } from './ipc-gateway.js';
// M5-0 additions (append-only): window / tray / IPC bootstrap and the M5 host.
export { bootstrap, type ElectronLike, type BootstrapHandle } from './bootstrap.js';
export { createM5Host, type M5Host } from './m5-host.js';
export { createM5Handlers, M5_CHANNELS } from './m5-channels.js';
