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
  CorePorts, DownloadEngine, DownloadKind, FormatDomain, SubtitleDomain,
  PathsDomain, NetworkDomain, AdvancedDomain, PlaylistInfo, TaskRecord,
} from '@ytvdlt/shared';
import {
  CommandTemplateStore, NotificationCenter, TaskDetailService,
  buildDownloadRequest, buildErrorReport, buildPlaylistBatchRecordsByUrl, expandEnvVars, formatErrorReport,
  type ClipboardPort, type IArtifactVerifier, type DesktopNotification,
} from '@ytvdlt/core';
import { createTaskHost, type TaskHost } from './task-host.js';
import { createIpcGateway, type IpcGateway } from './ipc-gateway.js';

export interface M4HostOptions {
  ports: CorePorts;
  engine: DownloadEngine;
  verifier: IArtifactVerifier;
  jsRuntimePath: string;
  videoFixturePath: string;
  playlistFixturePath: string;
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
}

export interface PlaylistEnqueueInput {
  readonly selectedIds: readonly string[];
  readonly playlistUrl: string;
  readonly kind: 'video' | 'audio';
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
  /** D-69: real single-video enqueue backing the `DOWNLOAD_START` IPC channel. */
  enqueueSingle(input: SingleEnqueueInput): Promise<readonly string[]>;
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
}

function readDefaults(config: TaskHost['config'], bundledAria2cPath?: string): {
  format: Partial<FormatDomain>;
  subtitle: Partial<SubtitleDomain>;
  paths: Partial<PathsDomain>;
  network: Partial<NetworkDomain>;
  advanced: Partial<AdvancedDomain>;
} {
  const cast = <T>(domain: 'format' | 'subtitle' | 'paths' | 'network' | 'advanced'): T =>
    config.getDomain(domain) as unknown as T;
  const network = cast<Partial<NetworkDomain>>('network');
  return {
    format: cast<Partial<FormatDomain>>('format'),
    subtitle: cast<Partial<SubtitleDomain>>('subtitle'),
    paths: withExpandedPaths(cast<Partial<PathsDomain>>('paths')),
    // D-111: configured downloader only — '' / unset means "use yt-dlp's own",
    // a path means "the user's exe", and 'bundled' opts into the shipped one.
    network: { ...network, aria2cPath: resolveAria2cPath(network.aria2cPath, bundledAria2cPath) },
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
 * D-79: expand `%USERPROFILE%`-style tokens in the user-facing directories.
 *
 * The shipped defaults carry those tokens, and a spawned `yt-dlp` never expands
 * them: the download landed in a literal `%USERPROFILE%` folder and the artifact
 * manifest was empty, so every fresh install failed with `ARTIFACT_INCOMPLETE`.
 * The stored config keeps the author's original string — only the request gets
 * the absolute path — so the settings UI still shows what the user typed.
 */
function withExpandedPaths(paths: Partial<PathsDomain>): Partial<PathsDomain> {
  const expanded: Partial<PathsDomain> = { ...paths };
  const keys = ['videoDir', 'audioDir', 'commandDir', 'tempDir'] as const;
  for (const key of keys) {
    const value = expanded[key];
    if (typeof value === 'string') {
      (expanded as Record<string, unknown>)[key] = expandEnvVars(value, process.env);
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
    const defaults = readDefaults(task.config, options.bundledAria2cPath);
    const base = buildDownloadRequest({
      taskId: 'single-template',
      url: input.url,
      kind: input.kind,
      defaults: { ...defaults, format: applyFormatChoice(defaults.format, input) },
    });
    const now = ports.clock.nowIso();
    const taskId = `single-${now.replace(/[^0-9]/g, '')}-${++singleSeq}`;
    const record: TaskRecord = {
      id: taskId,
      url: input.url,
      kind: input.kind,
      state: 'Idle',
      createdAt: now,
      updatedAt: now,
      mediaInfo: null,
      request: { ...base, taskId, url: input.url },
      artifacts: [],
      lastPercent: null,
      error: null,
      privateMode: base.paths.privateMode,
      postprocessed: false,
    };
    await task.queue.enqueue(record);
    return [taskId];
  };

  const enqueuePlaylistBatch = async (input: PlaylistEnqueueInput): Promise<readonly string[]> => {
    // Empty selection must not cost a network probe.
    if (input.selectedIds.length === 0) return [];
    const playlist = await resolvePlaylist(input.playlistUrl);
    const base = buildDownloadRequest({
      taskId: 'batch-template',
      url: input.playlistUrl,
      kind: input.kind,
      defaults: readDefaults(task.config, options.bundledAria2cPath),
    });
    // D-69: use each entry's own URL instead of a --playlist-items position.
    // The legacy position-based planner remains exported for the M4-4 contract.
    const plan = buildPlaylistBatchRecordsByUrl({
      playlist,
      selectedIds: input.selectedIds,
      baseRequest: base,
      kind: input.kind,
      createdAt: ports.clock.nowIso(),
      privateMode: base.paths.privateMode,
    });
    if (plan.records.length === 0) return [];
    return task.queue.enqueueBatch(plan.records);
  };

  const gateway = createIpcGateway({
    readText: (path: string) => ports.fs.readText(path),
    videoFixturePath: options.videoFixturePath,
    playlistFixturePath: options.playlistFixturePath,
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
    enqueueSingle,
    restore: task.restore,
    dispose: unsubscribe,
  };
}
