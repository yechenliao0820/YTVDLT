/**
 * Preload contextBridge whitelist (M3-B4 / F058).
 *
 * No static `electron` import: `contextBridge` / `ipcRenderer` are injected so
 * this module stays unit-testable without an Electron binary (D-39). The UI may
 * only call `window.ytvdltBridge.invoke(channel, payload)` with a channel from
 * the frozen `IPC_CHANNELS` list (packages/shared/src/ipc.ts).
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';

export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}
export interface IpcRendererLike {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

export const BRIDGE_API_KEY = 'ytvdltBridge';
export const BRIDGE_CHANNELS: readonly string[] = Object.freeze(Object.values(IPC_CHANNELS));

export interface BridgeApi {
  readonly channels: readonly string[];
  invoke(channel: string, payload?: Record<string, unknown>): Promise<unknown>;
}

export function createBridgeApi(ipcRenderer: IpcRendererLike): BridgeApi {
  return {
    channels: BRIDGE_CHANNELS,
    invoke(channel: string, payload: Record<string, unknown> = {}): Promise<unknown> {
      if (!BRIDGE_CHANNELS.includes(channel)) {
        return Promise.reject(new Error(`[preload] channel not whitelisted: ${channel}`));
      }
      return ipcRenderer.invoke(channel, payload);
    },
  };
}

export function installBridge(contextBridge: ContextBridgeLike, ipcRenderer: IpcRendererLike): BridgeApi {
  const api = createBridgeApi(ipcRenderer);
  contextBridge.exposeInMainWorld(BRIDGE_API_KEY, api);
  return api;
}

