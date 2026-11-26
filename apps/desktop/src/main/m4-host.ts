/**
 * M4Host — main-process assembly of the M4 capabilities (no `electron` import).
 *
 * Before this file, the queue / notifications / task detail / command templates
 * existed but nothing assembled them. `createM4Host()` wires them over injected
 * ports so:
 *   - boot restores the previous session's tasks;
 *   - `PLAYLIST_ENQUEUE` actually creates tasks (probe → build → enqueueBatch);
 *   - queue events feed `NotificationCenter`;
 *   - the seven task-detail actions have a real service;
 *   - command templates are loaded and ready for the M5 IPC surface.
 *
 * The desktop entry (`app-host.ts`, which imports `electron`) should pass
 * `createAppHost()` ports into this function once a window exists (M5-4).
 */
import type {
  CorePorts, DownloadEngine, DownloadKind, DownloadRequest, FormatDomain, SubtitleDomain,
  PathsDomain, NetworkDomain, AdvancedDomain, PlaylistInfo, TaskRecord, MediaInfo,
} from '@ytvdlt/shared';
import {
  CommandTemplateStore, NotificationCenter, TaskDetailService,
  buildDownloadRequest, buildErrorReport, buildPlaylistBatchRecordsByUrl, expandEnvVars, formatErrorReport,
  hasUnresolvedEnvToken, PRIVATE_OUTPUT_DIR, resolveDownloadTempDir, toRateLimit,
  DEFAULT_PATH_TOKENS,
  type ClipboardPort, type IArtifactVerifier, type DesktopNotification,
} from '@ytvdlt/core';
import { createTaskHost, type TaskHost } from './task-host.js';
import { createIpcGateway, type IpcGateway } from './ipc-gateway.js';
import type { TxtBatchRequest, TxtBatchResult, TxtBatchFailure } from './txt-import-service.js';

export interface M4HostOptions {
  ports: CorePorts;
  engine: DownloadEngine;
  verifier: IArtifactVerifier;
  jsRuntimePath: string;
  /** D-167: dev-only L1 fixtures. Absent in a packaged build → no PROBE channel. */
  videoFixturePath?: string;
  playlistFixturePath?: string;
  appVersion: string;
  engineVersion: string;
  snapshotPath?: string;
  configPath?: string;
  concurrency?: number;
  clipboard?: ClipboardPort;
  /** Injected Electron adapter; absent = notifications are only recorded. */
  notificationAdapter?: { show(notification: DesktopNotification): boolean };
  /**
   * M5 append-only: absolute path of the bundled `aria2c.exe`.
   *
   * D-111: NO LONGER used implicitly. It is only handed to a request when
   * `network.aria2cPath` says `'bundled'` (explicit opt-in); the default path is
   * yt-dlp's own downloader, because an external downloader suppresses the
   * byte-level progress the queue card depends on. See `resolveAria2cPath`.
   */
  bundledAria2cPath?: string;
  /**
   * D-117: `%USERVIDEOS%` and friends. Injected by the Electron entry (which is
   * the only layer allowed to call `app.getPath`); absent in unit tests, where
   * the token stays literal exactly as before.
   */
  expandPath?: (raw: string) => string;
  /**
   * D-117 / D-118: the app-private, always-writable directory (`<dataDir>/work`).
   *
   * Used for two things: the artefact manifest, and — when it is on the same
   * volume as the output — the per-task temp folder that holds `.part` /
   * `.ytdl`. Empty/absent keeps the legacy behaviour (manifest next to the
   * media, no temp dir at all).
   */
  internalWorkDir?: string;
  /**
   * D-131: recycle-bin hook for `keepSubtitleFile=false` cleanup. Wired by
   * `createM5Host()` from the existing D-120 `TrashFilesPort`; absent in the
   * M4-only unit tests, which keep the pre-D-131 behaviour.
   * D-209: the second argument carries the task's own trusted output roots so
   * the adapter can run the D-207 realpath pre-flight before trashing.
   */
  recycleSubtitleFiles?: (
    paths: readonly string[],
    roots: readonly string[],
  ) => Promise<readonly string[]>;
}

export interface PlaylistEnqueueInput {
  readonly selectedIds: readonly string[];
  readonly playlistUrl: string;
  readonly kind: 'video' | 'audio';
  /**
   * Playlist batch import: the CACHED probe result. When present the batch
   * skips the second network probe entirely; the legacy M3 channel omits it
   * and keeps its original `resolvePlaylist()` behaviour.
   */
  readonly playlist?: PlaylistInfo;
  /** Per-batch format choices, folded in exactly like `enqueueSingle()`. */
  readonly quality?: FormatDomain['quality'];
  readonly audioQuality?: FormatDomain['audioQuality'];
  readonly audioFormat?: 'auto' | 'mp3' | 'm4a';
}

/** Real outcome of one batch; never rounded up to "all succeeded". */
export interface PlaylistBatchFailure {
  readonly id: string;
  readonly reason: string;
}
export interface PlaylistBatchReport {
  readonly requested: number;
  readonly enqueued: number;
  readonly failed: number;
  readonly taskIds: readonly string[];
  readonly failures: readonly PlaylistBatchFailure[];
}

export interface M4Host {
  readonly ports: CorePorts;
  readonly task: TaskHost;
  readonly notifications: NotificationCenter;
  readonly taskDetail: TaskDetailService;
  readonly commandTemplates: CommandTemplateStore;
  readonly gateway: IpcGateway;
  /** Real batch enqueue used by the `PLAYLIST_ENQUEUE` IPC channel. */
  enqueuePlaylistBatch(input: PlaylistEnqueueInput): Promise<readonly string[]>;
  /** Same implementation, with the honest per-item outcome for the live UI. */
  enqueuePlaylistBatchWithReport(input: PlaylistEnqueueInput): Promise<PlaylistBatchReport>;
  /** D-69: real single-video enqueue backing the `DOWNLOAD_START` IPC channel. */
  enqueueSingle(input: SingleEnqueueInput): Promise<readonly string[]>;
  /** TXT batch import: N independent TaskRecords via `TaskQueue.enqueueBatch()`. */
  enqueueTxtBatch(input: TxtBatchRequest): Promise<TxtBatchResult>;
  /** Restore result from the boot path. */
  readonly restore: TaskHost['restore'];
  /** Detach the queue listener (tests / hot reload). */
  dispose(): void;
}

/**
 * D-83: a single download now carries the user's choice.
 *
 * Until 0.1.6 `kind` was written into the `TaskRecord` and then ignored by
 * `buildDownloadRequest()`, so "音频" produced a video file, and no field
 * existed for a resolution preset at all — every task used the config default.
 */
export interface SingleEnqueueInput {
  readonly url: string;
  readonly kind: DownloadKind;
  readonly quality?: FormatDomain['quality'];
  readonly audioQuality?: FormatDomain['audioQuality'];
  readonly audioFormat?: 'auto' | 'mp3' | 'm4a';
  /**
   * Stage 3: the subtitle domain patch produced by `mergeSubtitleChoice()`.
   *
   * Already validated against a consumed preview — this layer only merges it
   * over the config defaults; it never re-derives availability and never writes
   * a global setting.
   */
  readonly subtitlePatch?: Partial<SubtitleDomain>;
  /**
   * Stage 3: `MediaInfo` obtained from a consumed preview ticket.
   *
   * Prefilling `TaskRecord.mediaInfo` is the ONLY thing that makes `TaskQueue`
   * skip its own probe (`task-queue.ts`: `if (record.mediaInfo === null)`).
   */
  readonly mediaInfo?: MediaInfo;
}

/**
 * D-254: stable refusal code for a private-output directory that could not be
 * expanded to an absolute path. `expandEnvVars` keeps an unresolvable token
 * verbatim, so on a box where `%LOCALAPPDATA%` is missing (or an injected
 * expander that does not know the token) the private dir would degrade to the
 * LITERAL string `%LOCALAPPDATA%/YTVDLT/private` — a relative path that spawn
 * would turn into a real folder named `%LOCALAPPDATA%` (D-79 failure mode, pit
 * 3/43) and that the artifact containment gate would refuse wholesale. The
 * intake refuses BEFORE any request is built: no tokened path ever reaches
 * argv, an output root, or a TaskRecord.
 */
export const PRIVATE_DIR_UNRESOLVABLE = 'PRIVATE_DIR_UNRESOLVABLE';

/** D-254: the user-facing sentence carried by the refusal (renderer shows it verbatim). */
const PRIVATE_DIR_UNRESOLVABLE_MESSAGE =
  '无痕下载目录无法展开（系统缺少 %LOCALAPPDATA% 环境变量），已取消本次下载，避免文件写入字面量目录';

/** D-254: the tagged refusal error — stable code on the object, Chinese message inside. */
function privateDirUnresolvableError(): Error {
  const error = new Error(PRIVATE_DIR_UNRESOLVABLE_MESSAGE);
  (error as Error & { code?: string }).code = PRIVATE_DIR_UNRESOLVABLE;
  return error;
}

/**
 * D-254: type guard for the refusal above. The DOWNLOAD_START handler uses it
 * to answer the renderer with `{code, reason}` instead of letting the error
 * surface as a raw IPC rejection (`IPC_ERROR` + an Electron-prefixed sentence).
 */
export function isPrivateDirUnresolvableError(error: unknown): error is Error {
  return error instanceof Error
    && (error as Error & { code?: string }).code === PRIVATE_DIR_UNRESOLVABLE;
}

/**
 * D-279: the SAME fail-closed rule, now for the ordinary download roots.
 *
 * `expandEnvVars()` keeps an unresolvable `%NAME%` verbatim ON PURPOSE (a typo
 * stays visible in the settings field). D-254 already refused to let that reach
 * `-P` for the private directory; the configured `videoDir` / `audioDir` had no
 * such gate. A hand-edited or imported config carrying `%FOO%/Videos` therefore
 * spawned yt-dlp with a RELATIVE, literal `-P` (spawn never goes through a
 * shell, D-79): the app created a folder literally named `%FOO%` and every
 * artifact then failed the containment gate — a download that "worked" but
 * landed nowhere the app would accept, with no explanation.
 *
 * Refuse at intake instead, exactly like the private root: nothing is
 * enqueued, and the renderer receives a stable code it can localise.
 */
export const DOWNLOAD_DIR_UNRESOLVABLE = 'DOWNLOAD_DIR_UNRESOLVABLE';

const DOWNLOAD_DIR_UNRESOLVABLE_MESSAGE =
  '下载目录无法展开（配置里仍有无法识别的 %变量%），已取消本次下载，避免文件写入字面量目录；请在设置中重新选择下载位置';

function downloadDirUnresolvableError(): Error {
  const error = new Error(DOWNLOAD_DIR_UNRESOLVABLE_MESSAGE);
  (error as Error & { code?: string }).code = DOWNLOAD_DIR_UNRESOLVABLE;
  return error;
}

export function isDownloadDirUnresolvableError(error: unknown): error is Error {
  return error instanceof Error
    && (error as Error & { code?: string }).code === DOWNLOAD_DIR_UNRESOLVABLE;
}

/**
 * D-279: both refusals mean "a configured root still carries an unresolved
 * `%VAR%`". The batch paths only need the code (they build `<code>：<reason>`
 * rows), so one accessor keeps them from listing the two guards every time.
 */
export function dirUnresolvableCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === PRIVATE_DIR_UNRESOLVABLE || code === DOWNLOAD_DIR_UNRESOLVABLE) {
    return String(code);
  }
  return null;
}

function dirUnresolvableReason(error: Error, code: string): string {
  return `${code}：${error.message}`;
}

function readDefaults(
  config: TaskHost['config'],
  bundledAria2cPath?: string,
  expandPath?: (raw: string) => string,
): {
  format: Partial<FormatDomain>;
  subtitle: Partial<SubtitleDomain>;
  paths: Partial<PathsDomain>;
  network: Partial<NetworkDomain>;
  advanced: Partial<AdvancedDomain>;
} {
  const cast = <T>(domain: 'format' | 'subtitle' | 'paths' | 'network' | 'advanced'): T =>
    config.getDomain(domain) as unknown as T;
  const rawNetwork = config.getDomain('network') as Record<string, unknown>;
  const network = cast<Partial<NetworkDomain>>('network');
  // D-118: `paths.tempDir` stays EXACTLY as the user stored it (usually '').
  // Resolving it to a concrete directory is the per-task job of
  // `resolveTempDirFor()` — filling it here would make an internal default
  // indistinguishable from a user decision and defeat the volume check.
  //
  // D-229 (audit P1): private mode has ONE source — `general.privateMode`, the
  // key the queue toolbar writes through SETTINGS_SET and SETTINGS_GET reads
  // back. `paths.privateMode` is a legacy schema key that no writer ever set,
  // so reading it here silently produced `false` while the UI said "on": the
  // task went to the normal folder AND history.add() persisted it. The overlay
  // below is the only place config becomes a request, so every intake path
  // (single / playlist / TXT) now inherits the same answer.
  const general = config.getDomain('general') as Record<string, unknown>;
  const privateMode = general['privateMode'] === true;
  const expandedPaths = withExpandedPaths(cast<Partial<PathsDomain>>('paths'), expandPath);
  // D-279: the ordinary roots get the same fail-closed check as the private
  // one below, but ONLY for values the user actually changed. The shipped
  // defaults (`%USERVIDEOS%/…`) are resolved by the host contract — the
  // Electron entry injects `USERVIDEOS` before any request exists (D-117) —
  // and an environment that does not inject it (unit harnesses, CLI smoke)
  // must not be turned into "every download is refused", which is exactly what
  // an unconditional check did. Anything else still carrying a `%NAME%` after
  // expansion is a typo or an imported config: refuse at intake instead of
  // spawning a literal relative `-P` whose artifacts the containment gate then
  // rejects one by one.
  if (!privateMode) {
    const shippedDefaults = new Set<string>([DEFAULT_PATH_TOKENS.videoDir, DEFAULT_PATH_TOKENS.audioDir]);
    for (const root of [expandedPaths.videoDir, expandedPaths.audioDir]) {
      if (typeof root !== 'string' || root === '' || shippedDefaults.has(root)) continue;
      if (hasUnresolvedEnvToken(root)) throw downloadDirUnresolvableError();
    }
  }
  // D-229 part 2: the private ROOT is resolved HERE, not in the planner. The
  // request is the only place the engine and the artifact-containment gate both
  // look, so writing the expanded directory into `videoDir` / `audioDir` keeps
  // three things true at once: `-P` is absolute (no `%LOCALAPPDATA%` literal —
  // spawn never goes through a shell, D-79), the recorded artifacts stay inside
  // the request's own roots (D-184/D-203), and "open folder" points at where the
  // file really is.
  const privateDir = privateMode
    ? (expandPath ?? ((raw: string): string => expandEnvVars(raw, process.env)))(PRIVATE_OUTPUT_DIR)
      .replace(/[\\/]+$/, '')
    : '';
  // D-254: fail-closed. `expandEnvVars` leaves a missing variable verbatim, so
  // when the token cannot resolve the string above is STILL a `%…%` token —
  // relative, never absolute. Writing it into the request would put the literal
  // directory into `-P` (spawn has no shell, D-79) and every artifact would be
  // judged outside the request's own roots (D-184/203). Refuse HERE, before the
  // request exists: callers answer with `PRIVATE_DIR_UNRESOLVABLE` instead of
  // silently enqueuing a download that cannot land where promised.
  if (privateMode && hasUnresolvedEnvToken(privateDir)) {
    throw privateDirUnresolvableError();
  }
  const paths: Partial<PathsDomain> = {
    ...expandedPaths,
    privateMode,
    ...(privateMode ? { videoDir: privateDir, audioDir: privateDir } : {}),
  };
  return {
    format: cast<Partial<FormatDomain>>('format'),
    subtitle: cast<Partial<SubtitleDomain>>('subtitle'),
    paths,
    // D-111: configured downloader only — '' / unset means "use yt-dlp's own",
    // a path means "the user's exe", and 'bundled' opts into the shipped one.
    // D-165: `maxRate` (KB/s) becomes the plan's `rateLimit` here — this is the
    // one place config turns into a request, so the translation lives here and
    // nowhere else.
    network: {
      ...network,
      rateLimit: toRateLimit(rawNetwork['maxRate']),
      aria2cPath: resolveAria2cPath(network.aria2cPath, bundledAria2cPath),
    },
    advanced: cast<Partial<AdvancedDomain>>('advanced'),
  };
}

/**
 * D-83: fold the renderer's choice into the format domain.
 *
 * Two rules that are easy to get wrong:
 *  - `kind: 'audio'` MUST set `extractAudio`: `buildDownloadRequest()` never
 *    derives it from `kind`, which is exactly why 0.1.6's "音频" produced a
 *    video file — the flag stayed `false` and `-x` was never emitted.
 *  - an explicit preset must clear `formatId` / `sortingFields`, otherwise the
 *    P3 priority chain (explicit id > preset) silently ignores the dropdown.
 */
export function applyFormatChoice(
  base: Partial<FormatDomain> | undefined,
  input: SingleEnqueueInput,
): Partial<FormatDomain> {
  const format: Partial<FormatDomain> = { ...base };
  if (input.kind === 'audio') {
    format.extractAudio = true;
    format.audioFormat = input.audioFormat === 'mp3' || input.audioFormat === 'm4a'
      ? input.audioFormat
      : null;
    if (input.audioQuality !== undefined) format.audioQuality = input.audioQuality;
    // A video resolution preset means nothing for an audio task.
    format.quality = 'best';
    format.formatId = null;
    format.sortingFields = null;
    return format;
  }
  format.extractAudio = false;
  format.audioFormat = null;
  if (input.quality !== undefined) {
    format.quality = input.quality;
    format.formatId = null;
    format.sortingFields = null;
  }
  return format;
}

/**
 * D-118: resolve THIS task's temp directory and write it into the request.
 *
 * The request is the only place the engine and the plan both read, so resolving
 * it once here keeps three things in lockstep: `-P temp:` (argv), the child's
 * cwd/TEMP, and the artifact manifest. Every branch returns a directory that is
 * on the same volume as the final media, except an explicit user setting.
 *
 * `''` means "no safe directory" — callers must then fall back to yt-dlp's own
 * behaviour rather than inventing a path.
 */
function resolveTempDirFor(
  request: DownloadRequest,
  taskId: string,
  expandPath: ((raw: string) => string) | undefined,
  internalWorkDir: string | undefined,
): string {
  const expand = expandPath ?? ((raw: string) => expandEnvVars(raw, process.env));
  const paths = request.paths;
  // Private mode writes into %LOCALAPPDATA%; comparing volumes against the
  // user's Videos folder would be wrong there.
  const outputDir = paths.privateMode === true
    ? expand(PRIVATE_OUTPUT_DIR)
    : (request.format.extractAudio ? paths.audioDir : paths.videoDir);
  const resolved = resolveDownloadTempDir({
    outputDir,
    configuredTempDir: typeof paths.tempDir === 'string' ? paths.tempDir : '',
    internalWorkDir: internalWorkDir ?? '',
    taskId,
  });
  return resolved ?? '';
}

/**
 * D-79: expand `%USERPROFILE%`-style tokens in the user-facing directories.
 *
 * The shipped defaults carry those tokens, and a spawned `yt-dlp` never expands
 * them: the download landed in a literal `%USERPROFILE%` folder and the artifact
 * manifest was empty, so every fresh install failed with `ARTIFACT_INCOMPLETE`.
 * The stored config keeps the author's original string — only the request gets
 * the absolute path — so the settings UI still shows what the user typed.
 *
 * D-117: the expander is injected so `%USERVIDEOS%` (the real Windows Videos
 * folder, which is NOT an environment variable) resolves to the same path the
 * settings page shows and the engine writes to.
 */
function withExpandedPaths(
  paths: Partial<PathsDomain>,
  expandPath?: (raw: string) => string,
): Partial<PathsDomain> {
  const expand = expandPath ?? ((raw: string): string => expandEnvVars(raw, process.env));
  const expanded: Partial<PathsDomain> = { ...paths };
  const keys = ['videoDir', 'audioDir', 'commandDir', 'tempDir'] as const;
  for (const key of keys) {
    const value = expanded[key];
    if (typeof value === 'string') {
      (expanded as Record<string, unknown>)[key] = expand(value);
    }
  }
  return expanded;
}

/**
 * D-111: which external downloader (if any) a request may use.
 *
 * Three cases, deliberately:
 *   ''        = explicitly OFF (same as the default now);
 *   'bundled' = explicit opt-in to the shipped `aria2c.exe`;
 *   a path    = the user's own `aria2c.exe`.
 *
 * Anything else — including "not configured" — resolves to `null`: yt-dlp uses
 * its own downloader. Until 0.2.4 the bundled binary was selected implicitly
 * for every task, and that silently broke the progress bar: with
 * `--downloader aria2c` yt-dlp gets no byte counters for single-file formats,
 * so `--progress-template` emits nothing and the queue card can only show the
 * indeterminate "preparing" animation until the task jumps to Completed.
 * The native downloader (with `--concurrent-fragments`) reports
 * downloaded/total/speed/ETA continuously and measured ~3.7x faster on HLS
 * downloads, so aria2c is now an explicit choice instead of the default.
 */
export function resolveAria2cPath(
  configured: NetworkDomain['aria2cPath'] | undefined,
  bundled: string | undefined,
): NetworkDomain['aria2cPath'] {
  if (configured === '') return null;
  if (configured === 'bundled') {
    return bundled !== undefined && bundled.trim() !== '' ? bundled : null;
  }
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  return null;
}

/**
 * Process-global sequence for production playlist task ids. Module scope (not
 * per-host) so two hosts in one process can never mint the same id.
 */
let playlistSeq = 0;

export async function createM4Host(options: M4HostOptions): Promise<M4Host> {
  const { ports } = options;
  const task = await createTaskHost({
    ports,
    engine: options.engine,
    verifier: options.verifier,
    jsRuntimePath: options.jsRuntimePath,
    ...(options.snapshotPath === undefined ? {} : { snapshotPath: options.snapshotPath }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.recycleSubtitleFiles === undefined
      ? {} : { recycleSubtitleFiles: options.recycleSubtitleFiles }),
  });

  const commandTemplates = new CommandTemplateStore({ ports });
  await commandTemplates.init();

  const notifications = new NotificationCenter({ ports });
  const unsubscribe = task.queue.onEvent((event) => {
    const notification = notifications.handle(event);
    if (notification !== null) options.notificationAdapter?.show(notification);
  });

  const taskDetail = new TaskDetailService({
    ports,
    queue: task.queue,
    ...(ports.shell === undefined ? {} : { shell: ports.shell }),
    ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard }),
    buildReport: (record) => buildErrorReport({
      task: record,
      appVersion: options.appVersion,
      engineVersion: options.engineVersion,
      os: `${ports.env.platform()} ${ports.env.osRelease()}`,
      stderr: record.error?.detail ?? '',
    }, ports.clock.nowIso()),
    formatReport: formatErrorReport,
  });

  /** D-69: a single-video URL is not a playlist; probe it directly instead of failing. */
  const resolvePlaylist = async (url: string): Promise<PlaylistInfo> => {
    try {
      return await options.engine.probePlaylist(url, {
        jsRuntimePath: options.jsRuntimePath,
        noPlaylist: false,
        flatPlaylist: true,
      });
    } catch {
      const info = await options.engine.probe(url, {
        jsRuntimePath: options.jsRuntimePath,
        noPlaylist: true,
        flatPlaylist: false,
      });
      const videoUrl = info.webpage_url !== '' ? info.webpage_url : url;
      return {
        id: info.id,
        title: info.title,
        _type: 'playlist',
        extractor_key: info.extractor_key,
        webpage_url: videoUrl,
        entries: [{
          id: info.id, title: info.title, url: videoUrl,
          duration: info.duration, _type: 'url',
        }],
      };
    }
  };

  /** D-69: real single-video download entry (registered on DOWNLOAD_START). */
  let singleSeq = 0;
  const enqueueSingle = async (
    input: SingleEnqueueInput,
  ): Promise<readonly string[]> => {
    const defaults = readDefaults(task.config, options.bundledAria2cPath, options.expandPath);
    // Stage 3: the per-task subtitle choice is a PATCH over the config defaults.
    // It is applied here (not written back to ConfigStore) so two concurrent
    // downloads cannot see each other's language choice.
    const subtitle: Partial<SubtitleDomain> = input.subtitlePatch === undefined
      ? defaults.subtitle
      : { ...defaults.subtitle, ...input.subtitlePatch };
    const base = buildDownloadRequest({
      taskId: 'single-template',
      url: input.url,
      kind: input.kind,
      defaults: { ...defaults, format: applyFormatChoice(defaults.format, input), subtitle },
    });
    const now = ports.clock.nowIso();
    const taskId = `single-${now.replace(/[^0-9]/g, '')}-${++singleSeq}`;
    // D-118: one resolved temp dir per task, shared by `-P temp:`, the child's
    // cwd/TEMP and the artefact manifest.
    const request: DownloadRequest = {
      ...base,
      taskId,
      url: input.url,
      paths: {
        ...base.paths,
        tempDir: resolveTempDirFor({ ...base, taskId, url: input.url }, taskId, options.expandPath, options.internalWorkDir),
      },
    };
    const record: TaskRecord = {
      id: taskId,
      url: input.url,
      kind: input.kind,
      state: 'Idle',
      createdAt: now,
      updatedAt: now,
      // Stage 3: a consumed preview fills this and the queue skips its probe.
      mediaInfo: input.mediaInfo ?? null,
      request,
      artifacts: [],
      lastPercent: null,
      error: null,
      privateMode: base.paths.privateMode,
      postprocessed: false,
    };
    await task.queue.enqueue(record);
    return [taskId];
  };

  /**
   * The ONE playlist batch implementation. Both the frozen M3 channel and the
   * new ticket-bound channel end up here; there is no parallel batch engine.
   *
   * D-130 fixes two production defects without touching the frozen pure
   * planner (`core/src/playlist/batch.ts`):
   *   1. `defaultBatchTaskId()` returns `<playlistId>-<entryId>`, so enqueuing
   *      the same collection twice produced identical ids and the second run
   *      silently replaced the first record. The production `makeTaskId`
   *      below adds a timestamp + a process-global sequence + a random suffix.
   *   2. The old path re-probed the URL on enqueue. With a cached `playlist`
   *      we use the ALREADY validated result, so confirm cannot diverge from
   *      what the user previewed.
   */
  const runPlaylistBatch = async (input: PlaylistEnqueueInput): Promise<PlaylistBatchReport> => {
    const requested = input.selectedIds.length;
    const empty: PlaylistBatchReport = {
      requested, enqueued: 0, failed: 0, taskIds: [], failures: [],
    };
    if (requested === 0) return empty;

    let playlist: PlaylistInfo;
    try {
      playlist = input.playlist ?? await resolvePlaylist(input.playlistUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        requested, enqueued: 0, failed: requested, taskIds: [],
        failures: input.selectedIds.map((id) => ({ id, reason })),
      };
    }

    // D-254: the private-dir refusal is a WHOLE-BATCH refusal — every entry
    // would have received the same unresolvable root. Same honest shape as the
    // probe failure above: nothing enqueued, one per-id reason the dialog can
    // render, instead of a throw that the renderer only sees as a raw IPC error.
    let defaults: ReturnType<typeof readDefaults>;
    try {
      defaults = readDefaults(task.config, options.bundledAria2cPath, options.expandPath);
    } catch (error) {
      // D-279: the private root and the ordinary roots share this refusal
      // shape — both are "a configured root still carries an unresolved %VAR%".
      const code = dirUnresolvableCode(error);
      if (code === null) throw error;
      return {
        requested, enqueued: 0, failed: requested, taskIds: [],
        failures: input.selectedIds.map((id) => ({
          id, reason: dirUnresolvableReason(error as Error, code),
        })),
      };
    }
    const hasChoice = input.quality !== undefined
      || input.audioQuality !== undefined || input.audioFormat !== undefined;
    // Absent choices keep the legacy M3 behaviour byte-for-byte; present ones
    // are folded in by the SAME helper a normal single download uses.
    const format = hasChoice
      ? applyFormatChoice(defaults.format, {
        url: input.playlistUrl,
        kind: input.kind,
        ...(input.quality === undefined ? {} : { quality: input.quality }),
        ...(input.audioQuality === undefined ? {} : { audioQuality: input.audioQuality }),
        ...(input.audioFormat === undefined ? {} : { audioFormat: input.audioFormat }),
      })
      : undefined;
    const base = buildDownloadRequest({
      taskId: 'batch-template',
      url: input.playlistUrl,
      kind: input.kind,
      defaults: format === undefined ? defaults : { ...defaults, format },
    });
    const stamp = ports.clock.nowIso().replace(/[^0-9]/g, '');
    const uniqueTaskId = (_playlistId: string, entryId: string): string => {
      playlistSeq += 1;
      const safeEntry = String(entryId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
      return `pl-${stamp}-${playlistSeq}-${Math.random().toString(36).slice(2, 8)}-${safeEntry}`;
    };
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist,
      selectedIds: input.selectedIds,
      baseRequest: base,
      kind: input.kind,
      createdAt: ports.clock.nowIso(),
      privateMode: base.paths.privateMode,
      // ONLY the ticket-bound production path gets unique ids. The frozen M3
      // PLAYLIST_ENQUEUE channel keeps `defaultBatchTaskId()` exactly as its
      // existing unit/contract tests expect.
      ...(input.playlist === undefined ? {} : { makeTaskId: uniqueTaskId }),
    });

    const failures: PlaylistBatchFailure[] = plan.unknownIds
      .map((id) => ({ id, reason: 'UNKNOWN_ENTRY_ID' }));
    const records: TaskRecord[] = [];
    for (const record of plan.records) {
      try {
        if (record.request === null) { records.push(record); continue; }
        // D-118: one temp dir PER TASK → own `.part` / `.ytdl` AND own
        // artifact manifest. No two members can collide.
        records.push({
          ...record,
          request: {
            ...record.request,
            paths: {
              ...record.request.paths,
              tempDir: resolveTempDirFor(
                record.request, record.id, options.expandPath, options.internalWorkDir,
              ),
            },
          },
        });
      } catch (error) {
        failures.push({
          id: record.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let ids: readonly string[] = [];
    let batchReason = '';
    try {
      ids = await task.queue.enqueueBatch(records);
    } catch (error) {
      // `enqueueBatch` awaits `enqueue()` one record at a time; a throw halfway
      // through leaves earlier records live. Ask the queue what really landed.
      batchReason = error instanceof Error ? error.message : String(error);
      ids = records
        .filter((candidate) => task.queue.get(candidate.id) !== undefined)
        .map((candidate) => candidate.id);
    }
    const idSet = new Set(ids);
    for (const candidate of records) {
      if (!idSet.has(candidate.id)) {
        failures.push({ id: candidate.id, reason: batchReason || 'ENQUEUE_FAILED' });
      }
    }
    return {
      requested,
      enqueued: ids.length,
      failed: Math.max(0, requested - ids.length),
      taskIds: ids,
      failures,
    };
  };

  /** Frozen M3 channel contract: only ids, no report. */
  const enqueuePlaylistBatch = async (input: PlaylistEnqueueInput): Promise<readonly string[]> =>
    (await runPlaylistBatch(input)).taskIds;
  /** New ticket-bound channel: honest per-item outcome. */
  const enqueuePlaylistBatchWithReport = async (input: PlaylistEnqueueInput): Promise<PlaylistBatchReport> =>
    runPlaylistBatch(input);

  /**
   * TXT batch import. Deliberately does NOT touch `enqueueSingle`: the single
   * download path stays byte-for-byte as it was, so this feature cannot regress
   * a normal download. Every batch member is built with the SAME ingredients
   * (`readDefaults` → `applyFormatChoice` → `buildDownloadRequest` →
   * `resolveTempDirFor`) and then handed to the existing
   * `TaskQueue.enqueueBatch()`, which parks them in the shared FIFO so the
   * concurrency limit, per-task progress, cancel, retry and persistence all
   * come from the queue itself.
   */
  const enqueueTxtBatch = async (input: TxtBatchRequest): Promise<TxtBatchResult> => {
    const failures: TxtBatchFailure[] = [];
    // D-254: same whole-batch refusal as the playlist path — the private root
    // is shared by every member, so all URLs get the tagged reason (code +
    // Chinese message) and nothing is enqueued.
    let defaults: ReturnType<typeof readDefaults>;
    try {
      defaults = readDefaults(task.config, options.bundledAria2cPath, options.expandPath);
    } catch (error) {
      // D-279: private root OR ordinary root — same whole-batch refusal.
      const code = dirUnresolvableCode(error);
      if (code === null) throw error;
      return {
        enqueued: 0, taskIds: [],
        failures: input.urls.map((url) => ({ url, reason: dirUnresolvableReason(error as Error, code) })),
      };
    }
    const choice: SingleEnqueueInput = {
      url: input.urls[0] ?? '',
      kind: input.kind,
      ...(input.quality === undefined ? {} : { quality: input.quality }),
      ...(input.audioQuality === undefined ? {} : { audioQuality: input.audioQuality }),
      ...(input.audioFormat === undefined ? {} : { audioFormat: input.audioFormat }),
    };
    // One resolved format/subtitle/paths/network/advanced set for the batch,
    // exactly the values a single download would have received.
    const format = applyFormatChoice(defaults.format, choice);
    const now = ports.clock.nowIso();
    const records: TaskRecord[] = [];
    for (const url of input.urls) {
      try {
        // Sharing `singleSeq` with the single path keeps ids globally unique.
        const taskId = `txt-${now.replace(/[^0-9]/g, '')}-${++singleSeq}`;
        const base = buildDownloadRequest({
          taskId: 'txt-template',
          url,
          kind: input.kind,
          defaults: { ...defaults, format },
        });
        // D-118: one temp dir PER TASK, or two downloads collide on `.part`.
        const request: DownloadRequest = {
          ...base,
          taskId,
          url,
          paths: {
            ...base.paths,
            tempDir: resolveTempDirFor(
              { ...base, taskId, url }, taskId, options.expandPath, options.internalWorkDir,
            ),
          },
        };
        records.push({
          id: taskId,
          url,
          kind: input.kind,
          state: 'Idle',
          createdAt: now,
          updatedAt: now,
          mediaInfo: null,
          request,
          artifacts: [],
          lastPercent: null,
          error: null,
          privateMode: base.paths.privateMode,
          postprocessed: false,
        });
      } catch (error) {
        failures.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    let ids: readonly string[] = [];
    let batchReason = '';
    try {
      ids = await task.queue.enqueueBatch(records);
    } catch (error) {
      // `enqueueBatch` awaits `enqueue()` one record at a time, so a throw
      // halfway through leaves the earlier records live. Ask the queue which
      // ids really exist instead of reporting either "0" or "all N".
      batchReason = error instanceof Error ? error.message : String(error);
      ids = records
        .filter((candidate) => task.queue.get(candidate.id) !== undefined)
        .map((candidate) => candidate.id);
    }
    const idSet = new Set(ids);
    for (const candidate of records) {
      if (!idSet.has(candidate.id)) {
        failures.push({ url: candidate.url, reason: batchReason || 'ENQUEUE_FAILED' });
      }
    }
    return { enqueued: ids.length, taskIds: ids, failures };
  };

  const gateway = createIpcGateway({
    readText: (path: string) => ports.fs.readText(path),
    ...(options.videoFixturePath === undefined ? {} : { videoFixturePath: options.videoFixturePath }),
    ...(options.playlistFixturePath === undefined ? {} : { playlistFixturePath: options.playlistFixturePath }),
    config: task.config,
    enqueuePlaylistBatch,
  });

  return {
    ports,
    task,
    notifications,
    taskDetail,
    commandTemplates,
    gateway,
    enqueuePlaylistBatch,
    enqueuePlaylistBatchWithReport,
    enqueueSingle,
    enqueueTxtBatch,
    restore: task.restore,
    dispose: unsubscribe,
  };
}
