/**
 * M5Host — composes the M4 host with the M5 IPC surface (M5-0).
 *
 * `createM4Host()` already assembles queue/restore/batch/notifications/templates/
 * task-detail; this file adds the channels the renderer needs to actually DRIVE
 * those services (task list, task detail, the seven actions, template CRUD,
 * settings), and exposes one gateway so `registerAll()` registers everything.
 *
 * Still no `electron` import: the window, tray and nativeTheme live in
 * `bootstrap.ts`, which takes them injected. That keeps this composition
 * L0-testable — which is the only honest way to verify it in an environment
 * without an Electron binary (D-39).
 */
import type { TaskDetailAction } from '@ytvdlt/core';
import { createM4Host, type M4Host, type M4HostOptions } from './m4-host.js';
import {
  createM5Handlers, M5_CHANNELS,
  type AppUpdatePortLike, type AppearanceDto, type ComponentUpdatePortLike,
  type PathPickerPort, type SubtitlePreviewPortLike, type SystemAppearancePort,
  type TaskDetailPort, type TaskListPort, type ThumbnailPort, type TrashFilesPort,
} from './m5-channels.js';
import type { IpcGateway, IpcHandler } from './ipc-gateway.js';
import type { LocalFileStatusPort } from './local-file-status.js';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { assertHttpUrl } from '@ytvdlt/engine-ytdlp';
import { createTxtImportService } from './txt-import-service.js';
import type { TxtImportFilePort } from './txt-import-service.js';
import { randomUUID } from 'node:crypto';
import { PlaylistPreviewService } from './playlist-preview-service.js';
import { SiteSupportService } from './site-support-service.js';
import type { SiteSupportPortLike } from './m5-channels.js';
import { createStarPromptService } from './star-prompt-service.js';

export interface M5HostOptions extends M4HostOptions {
  /** OS probe (nativeTheme + registry accent); injected so tests stay offline. */
  readonly systemAppearance: SystemAppearancePort;
  /** Called after SETTINGS_SET so the Electron layer can repaint native chrome. */
  readonly onAppearanceChanged?: (snapshot: AppearanceDto) => void;
  /** Resolved data directory (portable vs %APPDATA%%) — shown in the About box. */
  readonly dataDir?: string;
  /** Why that directory won; surfaced so support can see it without a debugger. */
  readonly dataDirReason?: string;
  /** D-67: component (yt-dlp / aria2c) updater; absent = button disabled. */
  readonly componentUpdate?: ComponentUpdatePortLike;
  /** D-93: app updater (GitHub Releases); absent = "此构建不含更新器". */
  readonly appUpdate?: AppUpdatePortLike;
  /** D-96: cached cover images; absent = letter badges. */
  readonly thumbnails?: ThumbnailPort;
  /** D-98: `%VAR%` expansion for the download roots. */
  readonly expandPath?: (raw: string) => string;
  /** D-98: native folder picker; absent = path rows stay read-only. */
  readonly pathPicker?: PathPickerPort;
  /** D-87: recycle-bin adapter for "also delete local files". */
  readonly trashFiles?: TrashFilesPort;
  /** D-120: local artifact state probe; absent keeps the old (no field) DTO. */
  readonly fileStatus?: LocalFileStatusPort;
  /** Subtitle preview (stage 2): live probe + ticket store; absent = disabled. */
  readonly subtitlePreview?: SubtitlePreviewPortLike;
  /**
   * TXT batch import: the native picker/read adapter. Absent = both channels
   * report TXT_IMPORT_UNAVAILABLE (unit-test builds stay offline).
   */
  readonly txtImportFile?: TxtImportFilePort;
  /**
   * D-134 / D-135: absolute path of the engine `options.engine` wraps.
   *
   * Half of the supported-site cache identity (§3.2). Passed explicitly rather
   * than read off the engine object because `DownloadEngine` is FROZEN at five
   * methods and carries no path; this is the same value the bootstrap handed to
   * the engine factory, so the two cannot drift.
   *
   * REQUIRED, not optional (R1-02): while it was optional the caller could omit
   * it, the host filled in `''`, and the catalog slot was written with the
   * engine's own reported path but looked up with `''` — the two never matched,
   * so every panel open re-spawned `--list-extractors`. A required field turns
   * that silent write-off into a compile error at the call site.
   */
  readonly enginePath: string;
  /** D-134: where catalog/pre-check diagnostics go; absent = silent. */
  readonly siteSupportLogger?: {
    warn(scope: string, message: string, detail?: Record<string, unknown>): Promise<void> | void;
    error(scope: string, message: string, detail?: Record<string, unknown>): Promise<void> | void;
  };
  /**
   * D-134 / D-135: the network context a pre-check should run under.
   *
   * A function, not a value: the user can change proxy / cookies while the app
   * is open, and a pre-check that kept the startup snapshot would answer for a
   * network the download no longer uses.
   *
   * REQUIRED (R1-01): it was optional, the bootstrap simply omitted it, and the
   * pre-check then ran WITHOUT the user's proxy / cookies / UA — on a network
   * that needs a proxy every URL degrades to `INDETERMINATE` and the feature
   * looks implemented while doing nothing. Nothing failed, nothing was logged.
   * Making it required means "I have no network context" has to be stated as
   * `() => ({})` at the call site instead of happening by omission.
   */
  readonly siteSupportNetwork: () => {
    readonly proxy?: string;
    readonly cookiesFile?: string;
    readonly userAgent?: string;
  };
  /**
   * D-148: Electron `shell.openExternal`, injected by the entry file (the same
   * wrapper the app updater already uses). Absent = the "去 Star" button still
   * records its answer, just opens no page (unit-test builds).
   */
  readonly openExternal?: (url: string) => Promise<void>;
}

/**
 * Pure data for the About box (M5-4). No `electron` import, no timestamp —
 * it is a snapshot the renderer can render and a test can compare verbatim.
 */
export interface AboutInfo {
  readonly appVersion: string;
  readonly runtimeDir: string;
  readonly dataDir: string;
  readonly dataDirReason: string;
  readonly runtime: readonly ['yt-dlp', 'node', 'ffmpeg'];
  readonly license: 'LGPL-3.0';
}

export interface M5Host {
  readonly m4: M4Host;
  /** Merged gateway: M3 fixture channels + M5 service channels. */
  readonly gateway: IpcGateway;
  /** Channels added by M5 (for the preload whitelist assertion). */
  readonly channels: readonly string[];
  /** Main-process ticket store; cleared on `before-quit`. */
  readonly playlistPreview: PlaylistPreviewService;
  readonly appearance: () => Promise<AppearanceDto>;
  /** Static About-box payload (M5-4). */
  readonly aboutInfo: () => AboutInfo;
  /** Delegates to the M4 host; kept here so callers depend on one object. */
  readonly taskDetail: M4Host['taskDetail'];
  readonly dispose: () => void;
}

/** Compose several handler maps into one gateway (first registration wins). */
export function mergeGateways(...gateways: readonly IpcGateway[]): IpcGateway {
  const handlers = new Map<string, IpcHandler>();
  for (const gateway of gateways) {
    for (const [channel, handler] of gateway.handlers) {
      if (handlers.has(channel)) throw new Error(`[m5-host] duplicate channel: ${channel}`);
      handlers.set(channel, handler);
    }
  }
  return {
    handlers,
    async dispatch(channel: string, payload: unknown): Promise<unknown> {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`[ipc] unregistered channel: ${channel}`);
      return handler(payload ?? {});
    },
    registerAll(registrar): void {
      for (const [channel, handler] of handlers) {
        registrar.register(channel, (payload: unknown) => handler(payload ?? {}));
      }
    },
  };
}

/** Adapt the M4 task detail service to the narrow port M5 channels need. */
function detailPort(host: M4Host): TaskDetailPort {
  return {
    perform: (taskId: string, action: TaskDetailAction) => host.taskDetail.perform(taskId, action),
  };
}

/**
 * D-131: adapt the existing D-120 recycle-bin port to the queue's narrow
 * cleanup hook. `trashed` / `missing` (and legacy string replies) mean the
 * file is no longer on disk; a real OS `error` keeps BOTH the file and its
 * artifact record. A thrown adapter degrades to "remove nothing" — cleanup is
 * cosmetic and must never fail a verified download.
 */
function makeSubtitleRecycler(
  port: TrashFilesPort,
): (paths: readonly string[]) => Promise<readonly string[]> {
  return async (paths) => {
    try {
      const outcomes = await port.trash(paths);
      return outcomes
        .filter((entry) => typeof entry === 'string'
          || entry.status === 'trashed' || entry.status === 'missing')
        .map((entry) => (typeof entry === 'string' ? entry : entry.path));
    } catch {
      return [];
    }
  };
}

export async function createM5Host(options: M5HostOptions): Promise<M5Host> {
  const m4 = await createM4Host({
    ...options,
    // D-131: the production queue now honours keepSubtitleFile=false through
    // the SAME `shell.trashItem` adapter as "also delete local files".
    ...(options.trashFiles === undefined
      ? {} : { recycleSubtitleFiles: makeSubtitleRecycler(options.trashFiles) }),
  });

  const queue: TaskListPort = {
    list: () => m4.task.queue.list(),
    get: (taskId: string) => m4.task.queue.get(taskId),
  };

  // Live playlist probe: the real yt-dlp engine, an opaque UUID ticket and the
  // same 5-minute / single-use / URL-bound cache contract as subtitle preview.
  const playlistPreview = new PlaylistPreviewService({
    probe: (url: string) => options.engine.probePlaylist(url, {
      jsRuntimePath: options.jsRuntimePath,
      noPlaylist: false,
      flatPlaylist: true,
    }),
    clock: options.ports.clock,
    newId: () => randomUUID(),
  });

  // D-134: supported-site discovery + the per-URL pre-check. Constructing it
  // costs nothing (no engine is spawned until the page or a submission asks),
  // so a user who never opens the panel pays no extra subprocess.
  //
  // The ENGINE IDENTITY comes from the same two values the bootstrap used to
  // build the engine — the resolved absolute path and the version it reads —
  // so a self-update changes the cache key and invalidates the list by
  // construction (§3.2), without anyone remembering to clear a cache.
  const siteSupport: SiteSupportPortLike = new SiteSupportService({
    engine: options.engine,
    // Required upstream (R1-02), so this can never silently become `''`.
    enginePath: options.enginePath,
    // The LIVE engine version, not `options.engineVersion` (a startup snapshot
    // string): the whole point of the cache identity is to notice a self-update,
    // and a frozen string could never change.
    engineVersion: () => options.engine.version(),
    jsRuntimePath: options.jsRuntimePath,
    clock: options.ports.clock,
    ...(options.siteSupportLogger === undefined ? {} : { logger: options.siteSupportLogger }),
    // Always forwarded: the option is required upstream (R1-01), so there is no
    // "forgot to pass it" branch left to compile.
    network: options.siteSupportNetwork,
  });

  // D-148: the "Star on GitHub" nudge. TIMING NOTE: this runs after
  // `createM4Host()` has awaited `config.load()` (task-host.ts), so the five
  // `advanced.starPrompt*` keys are already the user's real stored values when
  // `recordLaunch()` bumps the launch counter — the record happens during host
  // assembly, i.e. before the window finishes loading, and never delays it
  // (fire-and-forget: a failed config write must not block start-up).
  const starPrompt = createStarPromptService({
    config: m4.task.config,
    clock: options.ports.clock,
    appVersion: options.appVersion,
    ...(options.openExternal === undefined ? {} : { openExternal: options.openExternal }),
    ...(options.siteSupportLogger === undefined ? {} : { logger: options.siteSupportLogger }),
  });
  void starPrompt.recordLaunch().catch(() => undefined);

  const handlers = createM5Handlers({
    queue,
    taskDetail: detailPort(m4),
    templates: m4.commandTemplates,
    config: m4.task.config,
    systemAppearance: options.systemAppearance,
    ...(options.onAppearanceChanged === undefined ? {} : { onAppearanceChanged: options.onAppearanceChanged }),
    ...(options.componentUpdate === undefined ? {} : { componentUpdate: options.componentUpdate }),
    ...(options.appUpdate === undefined ? {} : { appUpdate: options.appUpdate }),
    ...(options.thumbnails === undefined ? {} : { thumbnails: options.thumbnails }),
    ...(options.expandPath === undefined ? {} : { expandPath: options.expandPath }),
    ...(options.pathPicker === undefined ? {} : { pathPicker: options.pathPicker }),
    ...(options.trashFiles === undefined ? {} : { trashFiles: options.trashFiles }),
    ...(options.fileStatus === undefined ? {} : { fileStatus: options.fileStatus }),
    ...(options.subtitlePreview === undefined ? {} : { subtitlePreview: options.subtitlePreview }),
    // D-114: the authoritative build identity. Sourced from the same
    // `app.getVersion()` the package metadata carries, never from a literal.
    appInfo: {
      version: options.appVersion,
      name: 'YTVDLT',
      packaged: options.ports.env.isPackaged(),
    },
    enqueueSingle: (input) => m4.enqueueSingle(input),
    playlistPreview,
    playlistBatch: (input) => m4.enqueuePlaylistBatchWithReport(input),
    siteSupport,
    // D-148: assembled above (config + clock + version + injected openExternal).
    starPrompt,
    // TXT import reuses the ENGINE's own URL whitelist (assertHttpUrl), the
    // same one `argv-builder-download.ts` calls before building argv. We do
    // not invent a site registry: whether yt-dlp supports a host is decided
    // by yt-dlp when the existing engine runs.
    ...(options.txtImportFile === undefined ? {} : {
      txtImport: createTxtImportService({
        pickFile: options.txtImportFile,
        validateUrl: assertHttpUrl,
        enqueueBatch: (input) => m4.enqueueTxtBatch(input),
        // D-134: the same pre-check the single path uses. Applied here because
        // the renderer never receives these URLs (D-129 trust boundary), so this
        // is the only place the rule can be enforced for a TXT import.
        siteSupport,
      }),
    }),
  });

  const m5Gateway: IpcGateway = {
    handlers,
    async dispatch(channel: string, payload: unknown): Promise<unknown> {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`[ipc] unregistered channel: ${channel}`);
      return handler(payload ?? {});
    },
    registerAll(registrar): void {
      for (const [channel, handler] of handlers) {
        registrar.register(channel, (payload: unknown) => handler(payload ?? {}));
      }
    },
  };

  const gateway = mergeGateways(m4.gateway, m5Gateway);

  const aboutInfo = (): AboutInfo => ({
    appVersion: options.appVersion,
    runtimeDir: options.ports.env.runtimeDir(),
    dataDir: options.dataDir ?? options.ports.env.appDataDir(),
    dataDirReason: options.dataDirReason ?? '',
    runtime: ['yt-dlp', 'node', 'ffmpeg'],
    license: 'LGPL-3.0',
  });

  return {
    m4,
    gateway,
    channels: M5_CHANNELS,
    playlistPreview,
    appearance: async () => gateway.dispatch(IPC_CHANNELS.SETTINGS_GET, {}) as Promise<AppearanceDto>,
    aboutInfo,
    taskDetail: m4.taskDetail,
    dispose: () => m4.dispose(),
  };
}
