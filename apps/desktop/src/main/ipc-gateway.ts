/**
 * IpcGateway — M3 whitelisted IPC handlers (F054).
 *
 * B4 scope is intentionally OFFLINE and L1 only:
 *  - `PROBE` / `PROBE_PLAYLIST` parse the M1 RECORDED fixture JSON through
 *    `JsonMapper.mapProbeResult()`; they NEVER spawn a process or touch the
 *    network (A-4.1-05). `YtDlpEngine.probePlaylist()` stays the M2 `UNKNOWN`
 *    placeholder (D-37).
 *  - Every DTO crossing to the renderer goes through `omitUrl()`, so
 *    `MediaFormat.url` / `SubtitleTrack.url` can never leak (§8.4).
 *  - No `electron` / `node:fs` import here: the filesystem is injected via a
 *    minimal `readText` port, and `ipcMain` is injected by `index.ts`.
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { mapProbeResult, toMediaInfo, toPlaylistInfo, assertHttpUrl } from '@ytvdlt/engine-ytdlp';
import type { MediaInfo, PlaylistInfo } from '@ytvdlt/shared';

export interface IpcGatewayOptions {
  /** Injected text reader (production: fs.readText; tests: in-memory fixture). */
  readText: (path: string) => Promise<string>;
  /** Absolute paths of the two L1 recorded fixtures. */
  videoFixturePath: string;
  playlistFixturePath: string;
  /**
   * M4-4: explicit batch enqueue. Injected by the task host so the gateway
   * stays free of TaskQueue imports; absent = the channel reports `enqueued:false`
   * (L1 fixture tests, no queue).
   */
  enqueuePlaylistBatch?: (input: {
    readonly selectedIds: readonly string[];
    readonly playlistUrl: string;
    readonly kind: 'video' | 'audio';
  }) => Promise<readonly string[]>;
}

export interface IpcRegistrar {
  register(channel: string, handler: (payload: unknown) => unknown | Promise<unknown>): void;
}

export type IpcHandler = (payload: unknown) => Promise<unknown>;

/** Recursively strip every own property named `url` (credential red line). */
export function omitUrl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUrl);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key !== 'url') out[key] = omitUrl(item);
    }
    return out;
  }
  return value;
}

const CHANNEL_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  [IPC_CHANNELS.PROBE]: ['url'],
  [IPC_CHANNELS.PROBE_PLAYLIST]: ['url'],
  [IPC_CHANNELS.DIALOG_OPEN]: ['kind'],
  [IPC_CHANNELS.DIALOG_CONFIRM]: ['kind', 'confirmed', 'state', 'requestPatch', 'selectedPlaylistIds', 'reason'],
  [IPC_CHANNELS.PATH_PREVIEW]: ['paths', 'vars'],
  [IPC_CHANNELS.CONFIG_GET]: ['domain'],
  [IPC_CHANNELS.CONFIG_SET]: ['domain', 'key', 'value'],
  [IPC_CHANNELS.PLAYLIST_ENQUEUE]: ['selectedIds', 'playlistUrl', 'kind'],
};

const MAX_BATCH_ITEMS = 500;
const MAX_ID_LENGTH = 200;

/** Strict input whitelist: unknown keys / non-objects are rejected. */
export function validatePayload(channel: string, payload: unknown): Record<string, unknown> {
  const allowed = CHANNEL_PAYLOAD_KEYS[channel];
  if (allowed === undefined) throw new Error(`[ipc] unregistered channel: ${channel}`);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`[ipc] payload must be an object for ${channel}`);
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`[ipc] payload key not allowed: ${key}`);
  }
  return record;
}

export interface IpcGateway {
  readonly handlers: ReadonlyMap<string, IpcHandler>;
  dispatch(channel: string, payload: unknown): Promise<unknown>;
  registerAll(registrar: IpcRegistrar): void;
}

export function createIpcGateway(options: IpcGatewayOptions): IpcGateway {
  const handlers = new Map<string, IpcHandler>();

  const register = (channel: string, handler: IpcHandler): void => {
    handlers.set(channel, handler);
  };

  register(IPC_CHANNELS.PROBE, async (payload) => {
    validatePayload(IPC_CHANNELS.PROBE, payload);
    const raw: unknown = JSON.parse(await options.readText(options.videoFixturePath));
    return omitUrl(toMediaInfo(raw)) as Omit<MediaInfo, 'formats'>;
  });

  register(IPC_CHANNELS.PROBE_PLAYLIST, async (payload) => {
    validatePayload(IPC_CHANNELS.PROBE_PLAYLIST, payload);
    const raw: unknown = JSON.parse(await options.readText(options.playlistFixturePath));
    // `mapProbeResult` dispatches on `_type === 'playlist'`; L1 only, no spawn.
    return omitUrl(mapProbeResult(raw)) as PlaylistInfo;
  });

  register(IPC_CHANNELS.DIALOG_OPEN, async (payload) => {
    const record = validatePayload(IPC_CHANNELS.DIALOG_OPEN, payload);
    const kind = record['kind'];
    if (kind !== 'format' && kind !== 'subtitle' && kind !== 'playlist') {
      throw new Error('[ipc] invalid dialog kind');
    }
    return { kind, state: 'ready' };
  });

  register(IPC_CHANNELS.DIALOG_CONFIRM, async (payload) => {
    const record = validatePayload(IPC_CHANNELS.DIALOG_CONFIRM, payload);
    if (record['kind'] === 'playlist' && record['requestPatch'] !== undefined) {
      throw new Error('[ipc] playlist confirmation must not carry a requestPatch (A-M3-04)');
    }
    return { accepted: true, persisted: true, enqueued: false };
  });

  register(IPC_CHANNELS.PLAYLIST_ENQUEUE, async (payload) => {
    const record = validatePayload(IPC_CHANNELS.PLAYLIST_ENQUEUE, payload);
    const selectedIds = record['selectedIds'];
    if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
      throw new Error('[ipc] selectedIds must be a non-empty array');
    }
    if (selectedIds.length > MAX_BATCH_ITEMS) {
      throw new Error(`[ipc] selectedIds exceeds ${MAX_BATCH_ITEMS} items`);
    }
    for (const id of selectedIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
        throw new Error('[ipc] selectedIds entries must be non-empty strings');
      }
    }
    const playlistUrl = record['playlistUrl'];
    if (typeof playlistUrl !== 'string') throw new Error('[ipc] playlistUrl must be a string');
    // Reuses the engine's http(s)-only whitelist (no file://, UNC, credentials).
    assertHttpUrl(playlistUrl);
    const kind = record['kind'] ?? 'video';
    if (kind !== 'video' && kind !== 'audio') throw new Error('[ipc] kind must be video|audio');

    const taskIds = options.enqueuePlaylistBatch === undefined
      ? []
      : await options.enqueuePlaylistBatch({
        selectedIds: selectedIds as readonly string[],
        playlistUrl,
        kind,
      });
    return { accepted: true, enqueued: taskIds.length > 0, taskIds };
  });

  register(IPC_CHANNELS.PATH_PREVIEW, async (payload) => {
    validatePayload(IPC_CHANNELS.PATH_PREVIEW, payload);
    return { preview: 'C:/Videos/%(title)s.%(ext)s', warnings: [] as string[] };
  });

  register(IPC_CHANNELS.CONFIG_GET, async (payload) => {
    validatePayload(IPC_CHANNELS.CONFIG_GET, payload);
    return { value: null };
  });

  register(IPC_CHANNELS.CONFIG_SET, async (payload) => {
    validatePayload(IPC_CHANNELS.CONFIG_SET, payload);
    return { ok: true };
  });

  return {
    handlers,
    async dispatch(channel: string, payload: unknown): Promise<unknown> {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`[ipc] unregistered channel: ${channel}`);
      return handler(payload);
    },
    registerAll(registrar: IpcRegistrar): void {
      for (const [channel, handler] of handlers) {
        registrar.register(channel, (payload: unknown) => handler(payload ?? {}));
      }
    },
  };
}

/** Re-export the pure mapper entry points used by the L1 fixture contract. */
export { toMediaInfo, toPlaylistInfo, mapProbeResult };
