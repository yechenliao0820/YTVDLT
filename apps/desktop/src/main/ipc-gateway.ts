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

/**
 * D-167: the two `PROBE*` channels are L1 *development* fixtures (D-31). They
 * used to be registered in every build — packaged included — and only failed
 * later, when the (deliberately unshipped) JSON could not be read. A channel
 * that cannot work must not exist: the paths are now optional and the handlers
 * are only registered when a fixture directory was actually provided.
 */
export interface IpcGatewayOptions {
  /** Injected text reader (production: fs.readText; tests: in-memory fixture). */
  readText: (path: string) => Promise<string>;
  /** Absolute paths of the two L1 recorded fixtures. Absent = dev-only channels. */
  videoFixturePath?: string;
  playlistFixturePath?: string;
  /**
   * D-168: real config writer for `CONFIG_SET`. Before this, the channel
   * answered `{ok:true}` without writing anything — a silent lie. Absent means
   * the channel reports `read-only` instead of pretending.
   */
  config?: IpcConfigPort;
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

/** The narrow slice of `ConfigStore` the gateway is allowed to touch. */
export interface IpcConfigPort {
  getDomain(name: 'general' | 'format' | 'subtitle' | 'paths' | 'network' | 'advanced' | 'saved_links'): unknown;
  setDomain(
    name: 'general' | 'format' | 'subtitle' | 'paths' | 'network' | 'advanced' | 'saved_links',
    patch: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * D-168: the ONLY keys `CONFIG_SET` may write, with their type check.
 *
 * An open `domain/key/value` channel would be a remote-configuration primitive
 * (paths, cookies, proxy) reachable from the renderer. The renderer's real
 * appearance writes go through `SETTINGS_SET`, which has its own whitelist; this
 * table exists so a legacy caller cannot use `CONFIG_SET` as a back door.
 */
const WRITABLE_CONFIG: Readonly<Record<string, (value: unknown) => unknown>> = {
  'network.maxRate': (value) => assertRange(value, 0, 1_000_000),
  'network.concurrentFragments': (value) => assertRange(value, 1, 8),
  'network.ipv4Only': (value) => assertBoolean(value),
  'general.concurrency': (value) => assertRange(value, 1, 8),
  'general.privateMode': (value) => assertBoolean(value),
  'general.disablePreview': (value) => assertBoolean(value),
};

/**
 * D-168 follow-up: the ONLY domains `CONFIG_GET` may read, checked as an
 * exact, case-sensitive match. One check therefore also refuses empty names,
 * `__proto__` / `constructor` / `prototype` and case variants — a malformed
 * `domain` can never reach `getDomain`.
 *
 * Allowed: the three pure-preference domains. Every key in them is a display
 * value with no path, no URL and no credential (`general` theme / language /
 * concurrency, `format` quality prefs, `subtitle` language prefs).
 *
 * Refused on purpose (fail-closed; revisit only for a concrete renderer need):
 *  - `paths`       real user directories. D-98 already stops the renderer from
 *                  *naming* a path; reading them back is the same leak mirrored.
 *  - `network`     at runtime this domain holds `proxy` (credential-shaped —
 *                  `logger/redactor.ts` redacts it as a secret) and
 *                  `cookiesFile` (session-cookie path); `download-plan.ts`
 *                  reads both from here.
 *  - `saved_links` stored links are URLs, and stored URLs never cross to the
 *                  renderer (same redaction rule as `TASK_LIST`).
 *  - `advanced`    main-process bookkeeping (update checks, star-prompt
 *                  counters); the renderer has no need for it today.
 *
 * To open a domain up: add it here only after proving every key (present AND
 * plausible) is non-sensitive, add a unit test, and record the decision in
 * `docs/DECISIONS.md`.
 */
const READABLE_CONFIG_DOMAINS: ReadonlySet<string> = new Set(['general', 'format', 'subtitle']);

function assertRange(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('[ipc] config value must be a finite number');
  }
  if (value < min || value > max) throw new Error(`[ipc] config value out of range ${min}..${max}`);
  return Math.trunc(value);
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('[ipc] config value must be a boolean');
  return value;
}

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

  // D-167: registered ONLY when a fixture directory was provided (dev / tests).
  // A packaged build ships no fixtures, so the channel must not exist at all —
  // it used to exist and fail on read, which is a surface without a purpose.
  const videoFixturePath = options.videoFixturePath;
  if (videoFixturePath !== undefined) {
    register(IPC_CHANNELS.PROBE, async (payload) => {
      validatePayload(IPC_CHANNELS.PROBE, payload);
      const raw: unknown = JSON.parse(await options.readText(videoFixturePath));
      return omitUrl(toMediaInfo(raw)) as Omit<MediaInfo, 'formats'>;
    });
  }

  const playlistFixturePath = options.playlistFixturePath;
  if (playlistFixturePath !== undefined) {
    register(IPC_CHANNELS.PROBE_PLAYLIST, async (payload) => {
      validatePayload(IPC_CHANNELS.PROBE_PLAYLIST, payload);
      const raw: unknown = JSON.parse(await options.readText(playlistFixturePath));
      // `mapProbeResult` dispatches on `_type === 'playlist'`; L1 only, no spawn.
      return omitUrl(mapProbeResult(raw)) as PlaylistInfo;
    });
  }

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
    const record = validatePayload(IPC_CHANNELS.CONFIG_GET, payload);
    const domain = record['domain'];
    if (typeof domain !== 'string' || domain.length === 0) {
      throw new Error('[ipc] config domain must be a non-empty string');
    }
    // D-168 follow-up: exact, case-sensitive whitelist match. Unknown domains
    // are refused with an error, never answered with a silent empty bucket.
    if (!READABLE_CONFIG_DOMAINS.has(domain)) {
      throw new Error(`[ipc] config domain is not readable: ${domain}`);
    }
    // Same read-only contract as CONFIG_SET (D-168): no port injected means a
    // structured refusal, not a `{value:null}` that pretends the domain is empty.
    if (options.config === undefined) return { value: null, reason: 'read-only' };
    const bucket = options.config.getDomain(domain as Parameters<IpcConfigPort['getDomain']>[0]);
    return { value: bucket ?? null };
  });

  register(IPC_CHANNELS.CONFIG_SET, async (payload) => {
    const record = validatePayload(IPC_CHANNELS.CONFIG_SET, payload);
    const domain = record['domain'];
    const key = record['key'];
    if (typeof domain !== 'string' || typeof key !== 'string') {
      throw new Error('[ipc] config domain/key must be strings');
    }
    // D-168: unknown keys are refused, not silently "accepted".
    const check = WRITABLE_CONFIG[`${domain}.${key}`];
    if (check === undefined) {
      throw new Error(`[ipc] config key is not writable: ${domain}.${key}`);
    }
    if (options.config === undefined) return { ok: false, reason: 'read-only' };
    const value = check(record['value']);
    await options.config.setDomain(
      domain as Parameters<IpcConfigPort['setDomain']>[0],
      { [key]: value },
    );
    return { ok: true, domain, key, value };
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
