/**
 * AppHost — assembles the production `CorePorts` (M3-F055).
 *
 * B3 scope: inject the Electron `shell` implementation of `IShellPort` into
 * `createNodePorts()`, so `A-4.6-02` / `A-M3-12` are wired to the real shell
 * contract. The IpcGateway / BrowserWindow / single-instance lock / tray /
 * auto-update remain M4/M5 stubs; no window is created (no electron binary in
 * this offline environment, D-39).
 */
import { shell } from 'electron';
import type { CorePorts } from '@ytvdlt/shared';
import { createNodePorts, type NodePortsOptions } from './adapters/node-ports.js';
import { createElectronShellPort } from './adapters/electron-shell-port.js';
import { createIpcGateway } from './ipc-gateway.js';

export interface AppHostOptions extends NodePortsOptions {}

/** Assemble CorePorts with the Electron shell port (no BrowserWindow). */
export function createAppHost(options: AppHostOptions): CorePorts {
  return createNodePorts({
    ...options,
    shell: createElectronShellPort(shell),
  });
}

export { createElectronShellPort } from './adapters/electron-shell-port.js';

/**
 * B4 (F055): assemble CorePorts (with ElectronShellPort) AND the M3 IpcGateway.
 * The gateway is pure-TS / L1-only: it reads recorded fixture JSON through the
 * injected `readText`, never spawns yt-dlp and never opens a browser window.
 */
export interface M3HostOptions extends AppHostOptions {
  videoFixturePath: string;
  playlistFixturePath: string;
}

export interface M3Host {
  ports: CorePorts;
  gateway: ReturnType<typeof createIpcGateway>;
}

export function createM3Host(options: M3HostOptions): M3Host {
  const ports = createAppHost(options);
  const gateway = createIpcGateway({
    readText: (path: string) => ports.fs.readText(path),
    videoFixturePath: options.videoFixturePath,
    playlistFixturePath: options.playlistFixturePath,
  });
  return { ports, gateway };
}

export { createIpcGateway, omitUrl, validatePayload } from './ipc-gateway.js';
