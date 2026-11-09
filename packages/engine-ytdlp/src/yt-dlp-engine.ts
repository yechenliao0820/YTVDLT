/**
 * YtDlpEngine — the production `DownloadEngine` implementation.
 *
 * M1: `probe()` / `version()` (probe path unchanged).
 * M2: `download()` — streaming spawn → progress projection → precise artifact
 *      list via `--print-to-file` → completed/failed/canceled events.
 * `selfUpdate()` remains an explicit UNKNOWN placeholder; `probePlaylist()` is
 * implemented in M4-4 (flat playlist probe through the same injected ports).
 *
 * All process work goes through the injected `ProcessPort`; this file has no
 * `child_process` / `node:*` / `electron` import.
 */
import type {
  DownloadEngine, MediaInfo, PlaylistInfo, DownloadRequest, EngineEvent,
  CancelHandle, UpdateResult, ProbeOptions, CorePorts, AppError, ErrorContext,
  Artifact, EngineUpdateSource, QueueIntakeGate,
} from '@ytvdlt/shared';
import type { ILogger, IErrorMapper } from '@ytvdlt/core';
import { build } from './argv-builder.js';
import { buildDownload } from './argv-builder-download.js';
import { toMediaInfo, toPlaylistInfo } from './json-mapper.js';
import { parseProgressChunk } from './progress-parser.js';
import { createLineSplitter, detectStageFromLine, type DetectedStage } from './postprocess-parser.js';
import {
  artifactManifestPath, resolveArtifactManifestDir, parseArtifactManifestDetailed,
} from './artifact-manifest.js';
import { probeSucceeded, type RawProbeResult } from './probe-result.js';
import { assertAbsoluteRuntimePaths, assertSafeSpawnOptions, isAbsolutePath } from './runtime-check.js';
import { SelfUpdater } from './self-updater.js';

export interface YtDlpEngineDeps {
  ports: CorePorts;
  logger: ILogger;
  mapper: IErrorMapper;
  /** Absolute path of the bundled yt-dlp.exe. */
  enginePath: string;
  /** Absolute path of the bundled node.exe (EJS runtime). */
  jsRuntimePath: string;
  appVersion: string;
  engineVersion?: string;
  /** Test hook: override the ffmpeg directory (defaults to `<runtimeDir>/ffmpeg`). */
  ffmpegDir?: string;
  /**
   * M5-5 append-only (D-62): where engine bytes come from. Absent means
   * `selfUpdate()` reports "nothing changed" instead of pretending to update.
   */
  updateSource?: EngineUpdateSource;
  /** M5-5 append-only: queue intake switch driven by the self-updater. */
  intakeGate?: QueueIntakeGate;
}

export class YtDlpEngine implements DownloadEngine {
  private readonly deps: YtDlpEngineDeps;

  constructor(deps: YtDlpEngineDeps) {
    this.deps = deps;
  }

  private contextOf(url: string, stderr: string, argv: readonly string[]): ErrorContext {
    const { ports, appVersion, engineVersion } = this.deps;
    return {
      url,
      stderr,
      engineVersion: engineVersion ?? '2026.10.26',
      appVersion,
      os: `${ports.env.platform()} ${ports.env.osRelease()}`,
      argv,
    };
  }

  private ffmpegDir(): string {
    const runtimeDir = this.deps.ports.env.runtimeDir().replace(/[\\/]+$/, '');
    return this.deps.ffmpegDir ?? `${runtimeDir}/ffmpeg`;
  }

  /**
   * D-89: an NSIS install into `C:\Program Files\YTVDLT` is READ-ONLY for a
   * standard user, and Electron inherits that directory as `process.cwd()`.
   * yt-dlp's `tempfile.mkstemp()` (and any relative --print-to-file path) then
   * resolves against it and fails with `[Errno 13] Permission denied:
   * C:\Program Files\YTVDLT\tmpXXXX.tmp` — even though the download folder is
   * perfectly writable. No administrator rights are required or desired.
   *
   * Pin the child's CWD to an absolute, user-writable directory.
   *
   * D-118: the TEMP family is deliberately NOT overridden any more. Measured
   * with the bundled yt-dlp 2026.10.26: every start unpacks the ~29 MB
   * PyInstaller runtime into `%TEMP%\_MEI<pid>` and removes it on a clean exit.
   * While TEMP was pinned to the download/work folder, every cancelled or
   * crashed download left those 29 MB behind — and before D-117, next to the
   * user's videos (the `_MEI*` folders in the bug report). Leaving TEMP at the
   * inherited system value keeps that unpack in the Windows temp directory,
   * where it belongs and where the OS cleans it. `-P temp:` still decides where
   * `.part` / `.ytdl` go, so partial isolation is unaffected.
   */
  private writableWorkDir(preferred?: string): string {
    const candidate = typeof preferred === 'string' ? preferred.trim() : '';
    if (candidate !== '' && isAbsolutePath(candidate)) return candidate.replace(/[\\/]+$/, '');
    const inherited = this.deps.ports.env.get('TEMP') ?? this.deps.ports.env.get('TMP') ?? '';
    return typeof inherited === 'string' && isAbsolutePath(inherited)
      ? inherited.replace(/[\\/]+$/, '')
      : '';
  }

  /** Shared spawn base: PATH for the bundled tools + a writable CWD. */
  private spawnBase(pathDirs: readonly string[], preferredDir?: string): {
    shell: false;
    windowsHide: true;
    cwd?: string;
    env: Record<string, string>;
  } {
    const dir = this.writableWorkDir(preferredDir);
    const env: Record<string, string> = {
      PATH: `${pathDirs.join(';')};${this.deps.ports.env.get('PATH') ?? ''}`,
    };
    // Only step in when the inherited TEMP is unusable — otherwise the system
    // temp dir is the right home for a child process's scratch files.
    const inheritedTemp = this.deps.ports.env.get('TEMP') ?? this.deps.ports.env.get('TMP') ?? '';
    const usableTemp = typeof inheritedTemp === 'string'
      && inheritedTemp.trim() !== '' && isAbsolutePath(inheritedTemp.trim());
    if (!usableTemp && dir !== '') {
      env['TEMP'] = dir;
      env['TMP'] = dir;
      env['TMPDIR'] = dir;
    }
    return {
      shell: false as const,
      windowsHide: true as const,
      ...(dir !== '' ? { cwd: dir } : {}),
      env,
    };
  }

  async version(): Promise<string> {
    const result = await this.deps.ports.process.spawn(this.deps.enginePath, ['--version'], {
      ...this.spawnBase([this.ffmpegDir()]),
      timeoutMs: 30_000,
    });
    if (!probeSucceeded(result)) return '';
    return result.stdout.trim().split(/\r?\n/)[0] ?? '';
  }

  async probe(url: string, opts: ProbeOptions): Promise<MediaInfo> {
    let argv: string[];
    try {
      assertAbsoluteRuntimePaths(this.deps.enginePath, opts.jsRuntimePath);
      argv = build({ url, opts, enginePath: this.deps.enginePath });
    } catch (error) {
      const appError = error as Partial<AppError>;
      if (appError?.code === 'INVALID_URL') throw error;
      throw this.deps.mapper.fromCode('INVALID_URL', this.contextOf(url, String(error), []));
    }

    await this.deps.logger.logArgv('engine.probe', argv);

    const spawnOptions = {
      ...this.spawnBase([this.ffmpegDir()]),
      timeoutMs: 30_000,
    };
    assertSafeSpawnOptions(spawnOptions);

    const result = await this.deps.ports.process.spawn(this.deps.enginePath, argv, spawnOptions);
    const raw: RawProbeResult = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };

    if (!probeSucceeded(raw)) {
      await this.deps.logger.error('engine.probe', 'failed', { stderr: result.stderr });
      throw this.deps.mapper.map(result.stderr, this.contextOf(url, result.stderr, argv));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      await this.deps.logger.error('engine.probe', 'invalid-json');
      throw this.deps.mapper.fromCode('UNKNOWN', this.contextOf(url, result.stderr, argv));
    }
    return toMediaInfo(parsed);
  }

  /**
   * Download one task. Returns immediately with a CancelHandle; progress and
   * terminal state arrive through `onEvent`.
   */
  download(req: DownloadRequest, onEvent: (e: EngineEvent) => void): CancelHandle {
    let pid: number | null = null;
    let killTree: (() => Promise<boolean>) | null = null;
    let canceled = false;

    void this.runDownload(req, onEvent, (newPid, kill) => { pid = newPid; killTree = kill; }, () => canceled)
      .catch((error: unknown) => {
        // A download must never produce an unhandled rejection: surface it as a
        // failed event so the queue can move to Error deterministically.
        onEvent({
          type: 'failed',
          taskId: req.taskId,
          error: {
            code: 'UNKNOWN',
            message: '下载过程发生未预期错误',
            detail: error instanceof Error ? error.message : String(error),
            retryable: true,
            report: `UNKNOWN: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      });

    const handle: CancelHandle = {
      get pid() { return pid; },
      cancel: async (): Promise<boolean> => {
        canceled = true;
        if (killTree === null) return false;
        return killTree();
      },
    };
    return handle;
  }

  private async runDownload(
    req: DownloadRequest,
    onEvent: (e: EngineEvent) => void,
    register: (pid: number | null, kill: () => Promise<boolean>) => void,
    isCanceled: () => boolean,
  ): Promise<void> {
    const taskId = req.taskId;
    // D-68: never let an empty tempDir turn the manifest into a drive-root path.
    const configuredTempDir = typeof req.paths.tempDir === 'string' ? req.paths.tempDir.trim() : '';
    // D-118: `paths.tempDir` is now resolved BY THE CALLER and is already
    // per-task (`resolveDownloadTempDir()` guarantees it for every branch:
    // user config, app work dir, or `.ytvdlt-incomplete/<taskId>`). Adding a
    // second `<taskId>` here would nest the manifest one level too deep and
    // desynchronise it from where `-P temp:` actually points.
    const manifestDir = configuredTempDir === ''
      ? resolveArtifactManifestDir(undefined, req.paths.videoDir, req.paths.audioDir, req.format.extractAudio)
      : configuredTempDir.replace(/[\\/]+$/, '');
    const manifestPath = artifactManifestPath(manifestDir, taskId);

    // `--print-to-file` APPENDS; a stale manifest would leak old paths.
    //
    // D-108: these four preparations are independent — no path is a parent of
    // another's *target file*, every one is best-effort, and all four must
    // finish before the spawn (yt-dlp writes the manifest into `manifestDir`).
    // Issuing them as one batch removes three sequential round trips from the
    // launch path. When the manifest is still absent (first run into a folder)
    // the `unlink` resolves ENOENT, which was already swallowed here.
    await Promise.all([
      this.deps.ports.fs.unlink(manifestPath).catch(() => undefined),
      this.deps.ports.fs.mkdir(manifestDir).catch(() => undefined),
      this.deps.ports.fs.mkdir(req.paths.videoDir).catch(() => undefined),
      ...(req.format.extractAudio
        ? [this.deps.ports.fs.mkdir(req.paths.audioDir).catch(() => undefined)]
        : []),
    ]);

    const argv = buildDownload(req, {
      jsRuntimePath: this.deps.jsRuntimePath,
      ffmpegDir: this.ffmpegDir(),
      artifactManifestPath: manifestPath,
    });
    await this.deps.logger.logArgv('engine.download', argv);

    // yt-dlp resolves the external downloader through PATH, so the directory
    // that holds the bundled `aria2c.exe` has to be on it. ffmpeg's directory is
    // already prepended for the same reason; aria2c goes first because it is the
    // more specific request (a user-supplied aria2c must win over the bundled one).
    const pathDirs = [this.ffmpegDir()];
    const aria2cDir = aria2cDirOf(req.network.aria2cPath);
    if (aria2cDir !== null) pathDirs.unshift(aria2cDir);
    // D-89: the output directory is absolute and was mkdir'ed above. Using it
    // as the child's CWD/TEMP keeps every yt-dlp temp file out of the read-only
    // install directory, without changing a single download argument.
    //
    // D-117: when the request carries a private work dir (the app's
    // `<dataDir>/work`), that wins — the finished-media folder must not collect
    // `tmp*.tmp` / manifest files the user never asked for. The output root
    // stays the fallback so a request built by an older caller still works.
    const outputRoot = req.format.extractAudio ? req.paths.audioDir : req.paths.videoDir;
    // Same per-task folder as the manifest, so CWD / TEMP / manifest of one
    // download never overlap with another's.
    const workRoot = configuredTempDir !== '' ? manifestDir : outputRoot;
    const spawnOptions = this.spawnBase(pathDirs, typeof workRoot === 'string' ? workRoot : '');
    assertSafeSpawnOptions(spawnOptions);

    let stderrAll = '';
    let pending = '';
    // D-115: yt-dlp announces merge / post-process on stderr, one message per
    // line. A chunk can split a line, so the splitter keeps the tail; each
    // marker is emitted at most once per task and only forwards.
    const stderrLines = createLineSplitter();
    let emittedStage: DetectedStage | null = null;
    const emitStage = (line: string): void => {
      const stage = detectStageFromLine(line);
      if (stage === null || stage === emittedStage) return;
      emittedStage = stage;
      onEvent({ type: 'stage', taskId, stage });
    };
    const handle = this.deps.ports.process.spawnStreaming(
      this.deps.enginePath,
      argv,
      spawnOptions,
      (chunk) => {
        if (chunk.stream === 'stderr') {
          stderrAll += chunk.text;
          for (const line of stderrLines.push(chunk.text)) emitStage(line);
          return;
        }
        pending += chunk.text;
        const { events, rest } = parseProgressChunk(pending, taskId);
        pending = rest;
        for (const event of events) {
          // D-112: an HLS/DASH manifest is a "download" too, so yt-dlp reports it
          // as a completed 712-byte transfer before the real media starts. That
          // painted 100% for one frame and then dropped back to 3% (measured on a
          // 1496 s video). Anything that finishes below 64 KiB is metadata, not
          // media: skip it so the bar only ever shows the real stream.
          if (event.percent === 100 && event.downloadedBytes !== null
            && event.downloadedBytes < 64 * 1024) {
            continue;
          }
          // Project ProgressEvent onto the frozen EngineEvent 'progress' shape.
          onEvent({
            type: 'progress',
            taskId,
            percent: event.percent,
            downloadedBytes: event.downloadedBytes,
            totalBytes: event.totalBytes,
            speedBps: event.speedBps,
            etaSec: event.etaSec,
            rawLine: event.rawLine,
          });
        }
      },
    );
    register(handle.pid, () => handle.kill());

    const result = await handle.done;
    // A final marker without a trailing newline must still reach the queue.
    for (const line of stderrLines.flush()) emitStage(line);

    if (isCanceled()) {
      // yt-dlp keeps the `.part` file; we never touch it here.
      onEvent({ type: 'canceled', taskId });
      return;
    }
    if (result.timedOut || result.exitCode !== 0) {
      const error = this.deps.mapper.map(
        result.stderr || stderrAll,
        this.contextOf(req.url, result.stderr || stderrAll, argv),
      );
      await this.deps.logger.error('engine.download', 'failed', { stderr: result.stderr.slice(0, 2000) });
      onEvent({ type: 'failed', taskId, error });
      return;
    }

    // Precise artifact list from the manifest — never scan the directory.
    let manifestText = '';
    try { manifestText = await this.deps.ports.fs.readText(manifestPath); } catch { manifestText = ''; }
    const { paths, dropped } = parseArtifactManifestDetailed(manifestText);
    if (dropped.length > 0) {
      await this.deps.logger.warn('engine.download', 'manifest.droppedLines', {
        dropped: dropped.map((entry) => entry.reason),
      });
    }
    if (paths.length === 0) {
      onEvent({
        type: 'failed',
        taskId,
        error: {
          code: 'ARTIFACT_INCOMPLETE',
          message: '下载完成但未产出可用文件',
          detail: `artifact manifest empty: ${manifestPath}`,
          retryable: true,
          report: `ARTIFACT_INCOMPLETE: empty artifact manifest (${manifestPath})`,
        },
      });
      return;
    }

    const artifacts: Artifact[] = [];
    for (const path of paths) {
      let sizeBytes: number | null = null;
      try { sizeBytes = (await this.deps.ports.fs.stat(path)).sizeBytes; } catch { sizeBytes = null; }
      artifacts.push({ taskId, path, kind: kindOf(path), sizeBytes });
    }
    onEvent({ type: 'completed', taskId, artifacts });

    // D-117: the manifest has been read, parsed and handed over (the queue now
    // owns absolute artifact paths), so it is safe to remove. Only here — an
    // empty/failed parse returns above and deliberately KEEPS the file for
    // diagnosis. Failure to unlink is ignored: a leftover file must never fail
    // a download that already succeeded.
    await this.deps.ports.fs.unlink(manifestPath).catch(() => undefined);

    // D-118: yt-dlp moved every finished file out of the temp dir, and the
    // manifest is gone too, so an EMPTY directory is pure residue. `rmdir` is
    // non-recursive: if anything is left (a stray `.part`, a `.ytdl`, a
    // subdirectory) the call fails and the folder stays — leftovers are either
    // resumable data or evidence, never ours to destroy for tidiness.
    if (configuredTempDir !== '') {
      await this.deps.ports.fs.readdir(configuredTempDir)
        .then((entries) => (entries.length === 0
          ? this.deps.ports.fs.rmdir(configuredTempDir).catch(() => undefined)
          : undefined))
        .catch(() => undefined);
    }
  }

  async probePlaylist(url: string, opts: ProbeOptions): Promise<PlaylistInfo> {
    let argv: string[];
    try {
      assertAbsoluteRuntimePaths(this.deps.enginePath, opts.jsRuntimePath);
      argv = build({
        url,
        opts: { ...opts, noPlaylist: false, flatPlaylist: true },
        enginePath: this.deps.enginePath,
      });
    } catch (error) {
      const appError = error as Partial<AppError>;
      if (appError?.code === 'INVALID_URL') throw error;
      throw this.deps.mapper.fromCode('INVALID_URL', this.contextOf(url, String(error), []));
    }

    await this.deps.logger.logArgv('engine.probePlaylist', argv);

    const spawnOptions = {
      ...this.spawnBase([this.ffmpegDir()]),
      timeoutMs: 60_000,
    };
    assertSafeSpawnOptions(spawnOptions);

    const result = await this.deps.ports.process.spawn(this.deps.enginePath, argv, spawnOptions);
    const raw: RawProbeResult = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
    if (!probeSucceeded(raw)) {
      await this.deps.logger.error('engine.probePlaylist', 'failed', { stderr: result.stderr });
      throw this.deps.mapper.map(result.stderr, this.contextOf(url, result.stderr, argv));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      await this.deps.logger.error('engine.probePlaylist', 'invalid-json');
      throw this.deps.mapper.fromCode('UNKNOWN', this.contextOf(url, result.stderr, argv));
    }
    const info = toPlaylistInfo(parsed);
    if (info.entries.length === 0) {
      // A single video URL is not a playlist: surface it as UNSUPPORTED_SITE
      // instead of an empty selector the user cannot act on.
      throw this.deps.mapper.fromCode('UNSUPPORTED_SITE', this.contextOf(url, 'not a playlist', argv));
    }
    return info;
  }

  async selfUpdate(channel: 'stable' | 'nightly'): Promise<UpdateResult> {
    const { updateSource } = this.deps;
    if (updateSource === undefined) {
      await this.deps.logger.warn('self-update', 'no engine update source configured', { channel });
      return { fromVersion: '', toVersion: '', channel, changed: false, rolledBack: false };
    }
    const updater = new SelfUpdater({
      ports: this.deps.ports,
      logger: this.deps.logger,
      source: updateSource,
      intakeGate: this.deps.intakeGate ?? null,
      enginePath: this.deps.enginePath,
      channel,
    });
    return updater.update();
  }
}

/** Directory part of an absolute Windows/POSIX path, without importing `node:path`. */
function aria2cDirOf(aria2cPath: string | null): string | null {
  if (aria2cPath === null || aria2cPath.trim() === '') return null;
  const match = /^(.*)[\\/][^\\/]+$/.exec(aria2cPath.trim());
  return match?.[1] ?? null;
}

function kindOf(path: string): Artifact['kind'] {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  if (['m4a', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'aac'].includes(ext)) return 'audio';
  if (['vtt', 'srt', 'ass', 'lrc'].includes(ext)) return 'subtitle';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'thumbnail';
  if (ext === 'json') return 'infojson';
  return 'video';
}
