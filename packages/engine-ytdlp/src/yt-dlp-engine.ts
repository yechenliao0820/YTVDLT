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
  Artifact, EngineUpdateSource, QueueIntakeGate, ProbeControl,
  ExtractorCatalogResult, UrlSupportResult,
} from '@ytvdlt/shared';
import {
  METADATA_MAX_STDOUT_BYTES, METADATA_MAX_STDERR_BYTES,
  OUTPUT_LIMIT_MARKER,
  EXTRACTOR_LIST_MAX_STDOUT_BYTES, EXTRACTOR_LIST_MAX_STDERR_BYTES,
  URL_PRECHECK_TIMEOUT_MS,
  STREAM_TAIL_MAX_BYTES, STREAM_TAIL_TRUNCATED_MARKER,
  PROGRESS_PENDING_MAX_BYTES,
} from '@ytvdlt/shared';
import type { ILogger, IErrorMapper } from '@ytvdlt/core';
import { classifyArtifact } from '@ytvdlt/core';
import { build } from './argv-builder.js';
import { buildDownload } from './argv-builder-download.js';
import { toMediaInfo, toPlaylistInfo } from './json-mapper.js';
import { parseProgressChunk } from './progress-parser.js';
import { createLineSplitter, detectStageFromLine, type DetectedStage } from './postprocess-parser.js';
import {
  artifactManifestPath, resolveArtifactManifestDir, parseArtifactManifestDetailed,
  subtitleManifestPath,
} from './artifact-manifest.js';
import { parseSubtitlePathList } from './subtitle-manifest.js';
import { probeSucceeded, type RawProbeResult } from './probe-result.js';
import { assertAbsoluteRuntimePaths, assertSafeSpawnOptions, isAbsolutePath } from './runtime-check.js';
import { SelfUpdater } from './self-updater.js';
import { parseExtractorList, classifySupportFailure, extractorClaimedUrl } from './extractor-list.js';
import type { SiteDiscovery, UrlSupportCheckOptions } from './site-discovery.js';

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

export class YtDlpEngine implements DownloadEngine, SiteDiscovery {
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
      // D-133: `--version` prints one short line; a bounded spawn keeps it out of
      // the unbounded path for free (the ceiling can never be reached in
      // practice — it exists so every bounded metadata job looks the same).
      maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
      maxStderrBytes: METADATA_MAX_STDERR_BYTES,
    });
    if (!probeSucceeded(result)) return '';
    return result.stdout.trim().split(/\r?\n/)[0] ?? '';
  }

  async probe(url: string, opts: ProbeOptions, control?: ProbeControl): Promise<MediaInfo> {
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
      // D-133: `--dump-single-json` prints ONE complete JSON document and exits.
      // The output is therefore proportional to the metadata, and the whole
      // buffer used to be an unbounded `+=` before it was handed to
      // `JSON.parse`. Ceilings are ~24x the largest document measured
      // (678,386 B, `reports/live-audit/video.json`), so no legitimate probe is
      // affected while a runaway body is turned into a bounded failure.
      maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
      maxStderrBytes: METADATA_MAX_STDERR_BYTES,
      // D-162: a probe the user cancelled must die with its subprocess. Same
      // kill path as the timeout (the adapter owns it), so there is exactly one
      // implementation of "stop this child".
      ...(control?.signal === undefined ? {} : { signal: control.signal }),
    };
    assertSafeSpawnOptions(spawnOptions);

    const result = await this.deps.ports.process.spawn(this.deps.enginePath, argv, spawnOptions);
    const raw: RawProbeResult = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };

    // D-133: an overflow is NOT a yt-dlp error — the child was killed mid-write,
    // so its stderr says nothing about the real cause. Detect the marker the
    // adapter appended and say so plainly, instead of letting the keyword table
    // fall through to a misleading `UNKNOWN`/`NETWORK_TIMEOUT`.
    if (result.stderr.includes(OUTPUT_LIMIT_MARKER)) {
      await this.deps.logger.error('engine.probe', 'output-limit-exceeded', {
        maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
        receivedBytes: byteLengthOf(result.stdout),
      });
      throw this.deps.mapper.fromCode(
        'UNKNOWN',
        this.contextOf(url, `probe output exceeded ${METADATA_MAX_STDOUT_BYTES} bytes`, argv),
      );
    }

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
    // The subtitle manifest pairs post_process move maps with after_move paths.
    const subtitlePath = subtitleManifestPath(manifestDir, taskId);

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
      this.deps.ports.fs.unlink(subtitlePath).catch(() => undefined),
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
      subtitleManifestPath: subtitlePath,
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

    // D-144: `stderrAll` used to be an unbounded `+=` accumulator — a verbose
    // or long-batch download kept every stderr byte in memory for the whole
    // run. The diagnostic copy is now a byte-counted TAIL (appendUtf8Tail
    // below): the realtime stage parser still sees every chunk, and the
    // ending lines — which is what the error mapper reads on failure — are
    // exactly what the tail preserves. The bounded metadata path (D-133,
    // `spawn` + maxStdoutBytes + OUTPUT_LIMIT_MARKER) is untouched.
    const stderrAll: Utf8Tail = { parts: [], headIndex: 0, bytes: 0, truncated: false };
    // D-153: `pending` used to be an unbounded `+=` — `parseProgressChunk`
    // keeps the last unterminated line in `rest`, so stdout that never emits
    // a newline grew this string without limit for as long as the child ran
    // (the stdout sibling of the D-144 stderrAll fix above). Byte accounting
    // is INCREMENTAL (手册坑 23): `+=` the chunk's own UTF-8 byte length on
    // arrival — exact because the adapter's `setEncoding('utf8')` never splits
    // a multi-byte sequence across chunks, the same guarantee `appendUtf8Tail`
    // relies on — and recomputed only from the small remainder after a line
    // completes, never by walking the whole buffer on every chunk.
    let pending = '';
    let pendingBytes = 0;
    const pendingDrops = { times: 0, bytes: 0 };
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
          appendUtf8Tail(stderrAll, chunk.text, STREAM_TAIL_MAX_BYTES);
          for (const line of stderrLines.push(chunk.text)) emitStage(line);
          return;
        }
        pending += chunk.text;
        pendingBytes += utf8ByteLength(chunk.text);
        // D-153 fast path: `parseProgressChunk` splits on /\r?\n/, so a buffer
        // without any newline parses to `{ events: [], rest: buffer }` — an
        // O(pending) no-op. `pending` never retains a '\n' (the parser's `rest`
        // is the text after the LAST separator, and the skip below only fires
        // when the chunk itself carries none), so a newline-free chunk cannot
        // complete a line and skipping the call is observably identical — while
        // a no-newline flood (the case the ceiling exists for) stays O(chunk)
        // per chunk instead of re-splitting a ~1 MiB buffer every time. Chunks
        // WITHOUT a newline still accumulate below; nothing is ever dropped by
        // this branch.
        if (chunk.text.includes('\n')) {
          const { events, rest } = parseProgressChunk(pending, taskId);
          pending = rest;
          // The parsed prefix (complete lines + separators) is gone; only the
          // tail remains, which on real yt-dlp output is one partial line.
          pendingBytes = utf8ByteLength(pending);
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
        }
        // D-153: bound the retained remainder — drop the OLDEST prefix so at
        // most PROGRESS_PENDING_MAX_BYTES of the latest bytes survive (same
        // keep-the-tail policy as the D-144 diagnostic tail, but on a WORKING
        // parse buffer: real progress lines are ~100 bytes and always end in a
        // newline, so only a pathological no-newline flood can ever be clipped,
        // never a legitimate line). Counted and logged once after the run — the
        // chunk callback itself stays allocation-free (D-144 performance
        // contract) and silent.
        if (pendingBytes > PROGRESS_PENDING_MAX_BYTES) {
          const cut = dropUtf8Prefix(pending, pendingBytes - PROGRESS_PENDING_MAX_BYTES);
          pending = cut.rest;
          pendingBytes -= cut.droppedBytes;
          pendingDrops.times += 1;
          pendingDrops.bytes += cut.droppedBytes;
        }
      },
    );
    register(handle.pid, () => handle.kill());

    const result = await handle.done;
    // A final marker without a trailing newline must still reach the queue.
    for (const line of stderrLines.flush()) emitStage(line);

    // D-153: report the pending-buffer trims once per task, after the run and
    // for every outcome (including cancellation). Normal yt-dlp output never
    // triggers this — every progress line ends in a newline — so the absence
    // of this line is the healthy case, and its presence means stdout arrived
    // without line breaks for longer than the 1 MiB ceiling allows.
    if (pendingDrops.times > 0) {
      await this.deps.logger.warn('engine.download', 'progress.pendingTruncated', {
        drops: pendingDrops.times,
        droppedBytes: pendingDrops.bytes,
        limitBytes: PROGRESS_PENDING_MAX_BYTES,
        retainedBytes: pendingBytes,
      });
    }

    if (isCanceled()) {
      // yt-dlp keeps the `.part` file; we never touch it here.
      onEvent({ type: 'canceled', taskId });
      return;
    }
    if (result.timedOut || result.exitCode !== 0) {
      // D-144: `result.stderr` is the adapter's bounded tail; this fallback is
      // the engine's own bounded tail of the SAME stream. Both carry the
      // shared truncation marker in front when bytes were dropped, so the
      // error report never presents a clipped log as complete.
      const diagnosticStderr = result.stderr || assembleUtf8Tail(stderrAll);
      const error = this.deps.mapper.map(
        diagnosticStderr,
        this.contextOf(req.url, diagnosticStderr, argv),
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
      artifacts.push({ taskId, path, kind: classifyArtifact(path), sizeBytes });
    }
    // Stage 4: subtitle files are appended AFTER the media artifacts. Keeping
    // index 0 = media preserves every legacy `artifacts[0]` reader while the new
    // links give exact ownership; both are needed until stage 5 rewires the UI.
    const subtitleFiles = await this.readSubtitleArtifacts(subtitlePath);
    for (const path of subtitleFiles) {
      let sizeBytes: number | null = null;
      try { sizeBytes = (await this.deps.ports.fs.stat(path)).sizeBytes; } catch { sizeBytes = null; }
      artifacts.push({ taskId, path, kind: 'subtitle', sizeBytes });
    }
    onEvent({ type: 'completed', taskId, artifacts });

    // D-117: the manifest has been read, parsed and handed over (the queue now
    // owns absolute artifact paths), so it is safe to remove. Only here — an
    // empty/failed parse returns above and deliberately KEEPS the file for
    // diagnosis. Failure to unlink is ignored: a leftover file must never fail
    // a download that already succeeded.
    await this.deps.ports.fs.unlink(manifestPath).catch(() => undefined);
    // Same lifetime rule for the subtitle list: it has been read and handed
    // over, so it is residue. A failed parse never reaches this line.
    await this.deps.ports.fs.unlink(subtitlePath).catch(() => undefined);

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

  /**
   * Stage 4: turn yt-dlp's reported subtitle paths into files that really exist.
   *
   * Rules (why each one is here):
   *  - The list comes from THIS process (`--print-to-file`), so a file is never
   *    claimed from a folder listing.
   *  - Only exact reported paths or their explicit move targets are checked.
   *    Missing paths never fall back to another directory or guessed basename.
   *  - A file that exists but is EMPTY is not declared as an artifact: the
   *    verifier treats a declared-but-empty attachment as a failure (C9), and a
   *    site handing out an empty subtitle must not fail the video's download.
   *    It is logged instead, and the task's `subtitleOutcome` reports it.
   *  - Anything unreadable/missing is dropped silently: a subtitle problem may
   *    never abort a download that already produced its media file.
   */
  private async readSubtitleArtifacts(
    manifestPath: string,
  ): Promise<string[]> {
    let text = '';
    try { text = await this.deps.ports.fs.readText(manifestPath); } catch { return []; }
    const reported = parseSubtitlePathList(text);
    if (reported.length === 0) return [];

    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const candidate of reported) {
      let stat: { sizeBytes: number; isFile: boolean };
      try {
        stat = await this.deps.ports.fs.stat(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile) continue;
      if (stat.sizeBytes <= 0) {
        await this.deps.logger.warn('engine.download', 'subtitle.empty', { path: candidate });
        continue;
      }
      const key = candidate.replace(/\//g, '\\').toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push(candidate);
      }
    }
    return resolved;
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
      // D-133 (TASK-02) — the target of this round. A flat playlist probe prints
      // ONE JSON document whose size grows with the entry count, and the whole
      // thing used to accumulate in an unbounded `+=` before `JSON.parse`. With
      // `MAX_PLAYLIST_ITEMS = 500` and ~1,502 B per entry measured
      // (`reports/live-audit/playlist.json`, 20 entries = 30,045 B), 16 MiB
      // covers ~11,000 entries — comfortably above any list the app will accept
      // — while a site that streams an endless body is cut off instead of
      // growing the main process until it stalls.
      maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
      maxStderrBytes: METADATA_MAX_STDERR_BYTES,
    };
    assertSafeSpawnOptions(spawnOptions);

    const result = await this.deps.ports.process.spawn(this.deps.enginePath, argv, spawnOptions);
    const raw: RawProbeResult = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };

    // D-133: the adapter killed the child mid-write, so whatever reached stderr
    // describes the truncation, not the site. Report the ceiling explicitly.
    // NOTE: the JSON that DID arrive is deliberately not parsed — a truncated
    // playlist would silently look like a short one, and enqueueing a partial
    // list without telling the user is worse than failing the probe.
    if (result.stderr.includes(OUTPUT_LIMIT_MARKER)) {
      await this.deps.logger.error('engine.probePlaylist', 'output-limit-exceeded', {
        maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
        receivedBytes: byteLengthOf(result.stdout),
      });
      throw this.deps.mapper.fromCode(
        'UNKNOWN',
        this.contextOf(url, `playlist probe output exceeded ${METADATA_MAX_STDOUT_BYTES} bytes`, argv),
      );
    }

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

  /**
   * TASK-03 (A) — ask the RUNNING engine what it can parse.
   *
   * `--list-extractors` is the one authoritative answer available offline: it
   * prints the extractors compiled into THIS binary, so a shipped list can never
   * drift from the engine that will actually run (which is the failure mode the
   * requirement is about).
   *
   * Measured on the bundled 2026.10.26: 1755 lines / 23,500 bytes, pure ASCII,
   * `(CURRENTLY BROKEN)` on 136 of them. The ceiling is set far above that
   * (4 MiB ≈ 300,000 lines) because the count grows with every yt-dlp release.
   *
   * NEVER THROWS: a caller that cannot read the list must render "unknown", not
   * a fabricated one — hence the discriminated result instead of an exception
   * that a caller might catch and paper over.
   */
  async listExtractors(): Promise<ExtractorCatalogResult> {
    const argv = ['--list-extractors'];
    const spawnOptions = {
      ...this.spawnBase([this.ffmpegDir()]),
      timeoutMs: 30_000,
      maxStdoutBytes: EXTRACTOR_LIST_MAX_STDOUT_BYTES,
      maxStderrBytes: EXTRACTOR_LIST_MAX_STDERR_BYTES,
    };
    assertSafeSpawnOptions(spawnOptions);

    const result = await this.deps.ports.process.spawn(this.deps.enginePath, argv, spawnOptions);

    if (result.stderr.includes(OUTPUT_LIMIT_MARKER)) {
      await this.deps.logger.error('engine.listExtractors', 'output-limit-exceeded', {
        maxStdoutBytes: EXTRACTOR_LIST_MAX_STDOUT_BYTES,
        receivedBytes: utf8ByteLength(result.stdout),
      });
      return {
        ok: false,
        reason: 'OUTPUT_LIMIT_EXCEEDED',
        detail: `extractor list exceeded ${EXTRACTOR_LIST_MAX_STDOUT_BYTES} bytes`,
      };
    }
    if (result.timedOut) {
      await this.deps.logger.warn('engine.listExtractors', 'timeout');
      return { ok: false, reason: 'ENGINE_TIMEOUT', detail: 'engine did not answer in 30s' };
    }
    if (result.exitCode !== 0) {
      await this.deps.logger.error('engine.listExtractors', 'failed', {
        stderr: result.stderr.slice(0, 500),
      });
      return {
        ok: false,
        reason: 'ENGINE_FAILED',
        detail: `engine exited ${String(result.exitCode)}`,
      };
    }

    const parsed = parseExtractorList(result.stdout);
    if (parsed.empty) {
      // A zero-exit run with no output is a broken answer, not an empty world:
      // reporting "0 supported sites" for a working engine would be a lie the
      // UI could not recover from.
      await this.deps.logger.error('engine.listExtractors', 'empty');
      return { ok: false, reason: 'ENGINE_EMPTY', detail: 'engine listed no extractors' };
    }

    return {
      ok: true,
      // This method ALWAYS runs the engine; it has no cache of its own, so a
      // caller that sees this answer is looking at a fresh list (R1-06).
      cached: false,
      catalog: {
        // The engine's own version, so the cache identity is complete: a self
        // update swaps the binary and invalidates the list by construction.
        engineVersion: await this.version(),
        enginePath: this.deps.enginePath,
        extractors: parsed.extractors,
        siteCount: parsed.siteCount,
        subExtractorCount: parsed.subExtractorCount,
        brokenCount: parsed.brokenCount,
        empty: false,
        fetchedAt: this.deps.ports.clock.nowIso(),
      },
    };
  }

  /**
   * TASK-03 (B) — resolve ONE url's metadata WITHOUT downloading (§3.3).
   *
   * Same engine, same argv builder, `--simulate`: this is a real extraction, so
   * the answer reflects exactly what a download would face — cookies, proxy and
   * user agent are threaded through from the same `ProbeOptions` shape the
   * download uses, which is what keeps the pre-check honest about a URL that
   * only works with a session.
   *
   * NEVER THROWS: a pre-check that fails is an ADVISORY outcome, never a task
   * failure. The queue must keep working when this returns INDETERMINATE.
   */
  async checkUrlSupport(
    url: string,
    opts: UrlSupportCheckOptions,
  ): Promise<UrlSupportResult> {
    // T5: read through a lambda — the flag can flip while we await the child,
    // and a fresh call per check never inherits the stale narrowing TS would
    // otherwise carry across the await.
    const signalAborted = (): boolean => opts.signal?.aborted === true;
    // T5: a caller that already cancelled gets the CANCELLED state without
    // spawning anything. Still a VALUE, never an exception (fail-open contract).
    if (signalAborted()) {
      return {
        url, state: 'CANCELLED', extractor: '', cached: false,
        reason: 'pre-check cancelled by the user',
      };
    }
    const timeoutMs = opts.timeoutMs ?? URL_PRECHECK_TIMEOUT_MS;
    let argv: string[];
    try {
      assertAbsoluteRuntimePaths(this.deps.enginePath, opts.jsRuntimePath);
      argv = build({
        url,
        opts: {
          jsRuntimePath: opts.jsRuntimePath,
          timeoutMs,
          noPlaylist: true,
          ...(opts.proxy === undefined ? {} : { proxy: opts.proxy }),
          ...(opts.cookiesFile === undefined ? {} : { cookiesFile: opts.cookiesFile }),
          ...(opts.userAgent === undefined ? {} : { userAgent: opts.userAgent }),
        },
        enginePath: this.deps.enginePath,
      });
    } catch (error) {
      // An invalid url is knowable without asking the engine, and it is the one
      // case where we are certain: nothing can download it.
      const appError = error as Partial<AppError>;
      const state = appError?.code === 'INVALID_URL' ? 'UNSUPPORTED' : 'INDETERMINATE';
      return {
        url, state, extractor: '', cached: false,
        reason: state === 'UNSUPPORTED' ? 'rejected by URL whitelist' : 'could not build pre-check',
      };
    }

    const spawnOptions = {
      ...this.spawnBase([this.ffmpegDir()]),
      timeoutMs,
      maxStdoutBytes: METADATA_MAX_STDOUT_BYTES,
      maxStderrBytes: METADATA_MAX_STDERR_BYTES,
      // T5: forward the caller's signal so the ADAPTER kills the tree on abort
      // (one kill implementation, the same one the timeout uses). The result of
      // an aborted run is decided below from the signal itself.
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    };
    assertSafeSpawnOptions(spawnOptions);

    const result = await this.deps.ports.process.spawn(this.deps.enginePath, argv, spawnOptions);

    // T5: the caller cancelled while the pre-check was in flight. Checked FIRST
    // so an aborted run can never be reported as TIMEOUT (or anything else) —
    // abort wins. The adapter has already killed the child via the signal.
    if (signalAborted()) {
      return {
        url, state: 'CANCELLED', extractor: '', cached: false,
        reason: 'pre-check cancelled by the user',
      };
    }

    if (result.timedOut) {
      return { url, state: 'TIMEOUT', extractor: '', cached: false, reason: 'pre-check timed out' };
    }
    if (result.stderr.includes(OUTPUT_LIMIT_MARKER)) {
      return {
        url, state: 'INDETERMINATE', extractor: '', cached: false,
        reason: 'pre-check output limit exceeded',
      };
    }

    if (result.exitCode === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        // A clean exit with unparseable metadata: the engine DID find something
        // (exit 0), so this is not an unsupported site — leave it indeterminate
        // rather than blocking a URL that is probably fine.
        return {
          url, state: 'INDETERMINATE', extractor: '', cached: false,
          reason: 'engine returned unparseable metadata',
        };
      }
      const extractor = readExtractorKey(parsed);
      // A result with no formats is a real answer: the extractor matched but
      // there is nothing to download (a live stream not yet started, a page the
      // GenericIE read as media-less). Blocking is still wrong — enqueue it and
      // let the download report the truth.
      if (!hasDownloadableFormat(parsed)) {
        return {
          url, state: 'NO_MEDIA', extractor, cached: false,
          reason: 'extractor matched but reported no downloadable format',
        };
      }
      return { url, state: 'SUPPORTED', extractor, cached: false, reason: 'engine resolved media' };
    }

    // Non-zero exit: classify from the engine's own stderr. Only wording that
    // explicitly means "no extractor" yields UNSUPPORTED; see
    // `classifySupportFailure` for why a bare `Unsupported URL:` does not.
    const state = classifySupportFailure(result.stderr);
    const claimed = extractorClaimedUrl(result.stderr);
    const reason = state === 'UNSUPPORTED'
      ? 'engine reported no extractor for this URL'
      : state === 'NO_MEDIA'
        ? (claimed
          ? 'extractor claimed this URL but found no downloadable media'
          : 'engine found no downloadable media at this URL')
        : (claimed
          ? 'extractor failed on this URL for an unclassified reason'
          : 'pre-check could not classify this URL');
    return { url, state, extractor: readExtractorKeyFromStderr(result.stderr), cached: false, reason };
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

/**
 * D-134: which extractor did the engine attribute this URL to?
 *
 * Surfaced because it is what makes GenericIE TRANSPARENT: when this returns
 * `generic`, the engine guessed at the page rather than a dedicated extractor
 * matching it — a materially weaker guarantee that the UI must be able to state.
 */
export function readExtractorKey(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const record = raw as Record<string, unknown>;
  for (const key of ['extractor_key', 'extractor']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * A pre-check that exits 0 but reports no usable format is `NO_MEDIA`, not
 * `SUPPORTED`. `formats` and `url` are both checked: a progressive result may
 * carry `url` with no separate format list.
 *
 * MEASURED, NOT ASSUMED (D-134): the top-level `url` branch looked suspicious on
 * `/plain.txt` (`extractor=Generic`, `formats=undefined`, `url=...`, exit 0), so
 * the case was put through a REAL download — the engine wrote
 * `plain.unknown_video` to disk. The bytes genuinely are retrievable, so
 * SUPPORTED is the honest answer here and the branch stays. (This is the
 * GenericIE trade-off §3.1 warns about: it will happily fetch a text file.)
 *
 * `is_live` is deliberately NOT treated as media-less: a live stream that has
 * not started yet still returns formats, and one that has is downloadable as far
 * as the pre-check can tell. Judging live-ness belongs to the download.
 */
function hasDownloadableFormat(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  const formats = record['formats'];
  if (Array.isArray(formats)) {
    for (const format of formats) {
      if (typeof format === 'object' && format !== null) return true;
    }
  }
  // A direct/progressive result carries the media URL at the top level.
  const direct = record['url'];
  if (typeof direct === 'string' && direct !== '') return true;
  // A playlist-shaped answer is not one downloadable item, but it is certainly
  // not "no media" — leave that judgement to the playlist preview.
  return record['_type'] === 'playlist';
}

/**
 * Best-effort extractor name from a FAILED pre-check's stderr.
 *
 * yt-dlp names the extractor inside its own error lines. The prefix is NOT at
 * the start of the line: the engine writes `ERROR: [generic] …`, `WARNING: …`
 * or `[debug] [youtube] …`. An earlier `^\s*\[…\]` pattern therefore NEVER
 * matched a real failure — caught by running the bundled engine, see D-134.
 * Purely informational: an empty result is fine and must never change the state.
 */
function readExtractorKeyFromStderr(stderr: string): string {
  const match = /(?:^|\n)\s*(?:(?:ERROR|WARNING|DEBUG):\s*)?\[([A-Za-z0-9_.:-]+)\]/.exec(stderr);
  return match?.[1] ?? '';
}

/** Directory part of an absolute Windows/POSIX path, without importing `node:path`. */
function aria2cDirOf(aria2cPath: string | null): string | null {
  if (aria2cPath === null || aria2cPath.trim() === '') return null;
  const match = /^(.*)[\\/][^\\/]+$/.exec(aria2cPath.trim());
  return match?.[1] ?? null;
}

/**
 * D-133: UTF-8 byte length of an already-decoded string, WITHOUT `TextEncoder`.
 *
 * Why not `TextEncoder`: this package compiles with `lib: ["ES2022"]` and
 * `types: []` (no DOM, no `@types/node`), so the global is outside its type
 * surface — the layering gate exists precisely to keep this package free of
 * runtime globals. Why not `String.length`: that counts UTF-16 code units, so a
 * CJK glyph costs 1-2 units but 3 UTF-8 bytes, which is the exact 3x
 * understatement this decision is about.
 *
 * Only used for the diagnostic payload on an overflow — the enforcement itself
 * happens on raw Buffers in the adapter, which is always exact.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a valid pair is one code point at 4 bytes; consume the
      // low surrogate too. A lone surrogate is emitted as 3 bytes by every
      // well-behaved encoder (WHATWG replacement), which is what we book here.
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * D-153: drop the OLDEST prefix of `text` that covers at least `drop` UTF-8
 * bytes, cutting on a code-point boundary — the working-buffer sibling of
 * `appendUtf8Tail` (D-144 keeps a tail of stderr diagnostics; this trims the
 * head of the stdout line-assembly buffer). When the requested cut lands
 * inside a multi-byte glyph the cut moves FORWARD to the next boundary, so
 * the retained tail can be a few bytes SHORTER than the caller's ceiling but
 * is never malformed: the byte walk books exactly what `utf8ByteLength` books
 * (1/2/3 bytes per code point, a surrogate pair as one 4-byte unit, a lone
 * surrogate as 3), which keeps the caller's incremental accounting exact:
 * `droppedBytes + utf8ByteLength(rest) === utf8ByteLength(text)`.
 *
 * O(drop) — the walk stops once the overflow is covered and never rescans the
 * retained tail, so the per-chunk cost of the flood guard stays proportional
 * to the arriving chunk, not to the buffer (same performance contract as
 * appendUtf8Tail, 手册坑 23).
 *
 * Exported for the D-153 unit tests (pure byte-accounting, no child process).
 */
export function dropUtf8Prefix(
  text: string,
  drop: number,
): { rest: string; droppedBytes: number } {
  if (drop <= 0 || text.length === 0) return { rest: text, droppedBytes: 0 };
  const total = utf8ByteLength(text);
  if (drop >= total) return { rest: '', droppedBytes: total };
  // Identical classification to utf8ByteLength / appendUtf8Tail: advance by
  // WHOLE code points until the requested byte count is covered.
  let index = 0;
  let walked = 0;
  while (walked < drop && index < text.length) {
    const code = text.charCodeAt(index);
    let unitBytes: number;
    let units = 1;
    if (code < 0x80) unitBytes = 1;
    else if (code < 0x800) unitBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { unitBytes = 4; units = 2; }
      else unitBytes = 3;
    } else {
      unitBytes = 3;
    }
    walked += unitBytes;
    index += units;
  }
  return { rest: text.slice(index), droppedBytes: walked };
}

/**
 * D-144: bounded tail accumulator for the DOWNLOAD path's stderr.
 *
 * The old `stderrAll += chunk.text` kept every byte of every job, so a verbose
 * or long-batch download grew memory for as long as it ran. The realtime stage
 * parser still sees the full stream (the `onChunk` callback forwards every
 * chunk unchanged); only this diagnostic copy is bounded: when appending a
 * chunk would push `bytes` past the ceiling, whole code points are dropped
 * from the HEAD — failure lines sit at the end of stderr, which is exactly
 * what `result.stderr || stderrAll` feeds the error mapper — and `truncated`
 * latches so `assembleUtf8Tail` stamps STREAM_TAIL_TRUNCATED_MARKER once, in
 * front, and a clipped log can never be mistaken for a complete one.
 *
 * This package may not import `node:*`, so byte accounting reuses the D-133
 * `utf8ByteLength` walk — never `String.length` (UTF-16 units understate CJK
 * by 3x, 手册坑 23). `setEncoding('utf8')` in the adapter guarantees a
 * multi-byte sequence is never split across chunks, so per-chunk byte lengths
 * add up exactly. The desktop adapter enforces the same discipline with
 * `Buffer.byteLength` (`process-streaming.ts`), so both copies of the stream
 * are bounded.
 *
 * PERFORMANCE CONTRACT (why the retained content is a deque, not one string):
 * every append must cost O(chunk), never O(retained) — the shared event loop
 * also drives the cancel/kill path, and the adapter's measured evidence
 * (probe-output-limit 9a) shows an O(retained) per-chunk bookkeeping starves
 * it for seconds under a flood. Hence whole chunks are dropped by index bump
 * (O(1)) and only the ONE boundary chunk is walked and re-sliced (O(chunk));
 * the retained text is materialized once, at assembly.
 */
interface Utf8Tail {
  /** Retained chunks in order; everything before `headIndex` is dropped. */
  parts: string[];
  headIndex: number;
  /** Exact UTF-8 bytes of the retained text (parts[headIndex..]). */
  bytes: number;
  truncated: boolean;
}

/** Exported for the D-144 unit tests (pure byte-accounting, no child process). */
export function appendUtf8Tail(tail: Utf8Tail, chunk: string, limit: number): void {
  if (chunk.length === 0) return;
  tail.parts.push(chunk);
  tail.bytes += utf8ByteLength(chunk);
  if (tail.bytes <= limit) return;
  tail.truncated = true;
  // Drop whole head parts while that alone covers the overflow (O(1) each),
  // then cut inside the ONE boundary part for the remainder. A surrogate pair
  // moves as one 4-byte unit; a lone surrogate books 3 bytes, matching
  // `utf8ByteLength`.
  let drop = tail.bytes - limit;
  while (drop > 0 && tail.headIndex < tail.parts.length) {
    const head = tail.parts[tail.headIndex] as string;
    const headBytes = utf8ByteLength(head);
    if (headBytes <= drop) {
      drop -= headBytes;
      tail.bytes -= headBytes;
      tail.headIndex += 1;
    } else {
      // Walk the head of THIS chunk only, until the overflow is covered.
      let index = 0;
      let walked = 0;
      while (walked < drop && index < head.length) {
        const code = head.charCodeAt(index);
        let unitBytes: number;
        let units = 1;
        if (code < 0x80) unitBytes = 1;
        else if (code < 0x800) unitBytes = 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
          const next = index + 1 < head.length ? head.charCodeAt(index + 1) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) { unitBytes = 4; units = 2; }
          else unitBytes = 3;
        } else {
          unitBytes = 3;
        }
        walked += unitBytes;
        index += units;
      }
      tail.parts[tail.headIndex] = head.slice(index);
      tail.bytes -= walked;
      drop = 0;
    }
  }
  // The dropped prefix is garbage; keep the deque from growing without bound
  // without ever copying retained bytes (references only, and only when the
  // dropped prefix has outgrown the retained part).
  if (tail.headIndex > 64 && tail.headIndex * 2 > tail.parts.length) {
    tail.parts = tail.parts.slice(tail.headIndex);
    tail.headIndex = 0;
  }
}

/** The retained tail text, materialized (one join; O(retained), call-site only). */
export function utf8TailText(tail: Utf8Tail): string {
  return tail.headIndex === 0 ? tail.parts.join('') : tail.parts.slice(tail.headIndex).join('');
}

/** Diagnostic value for the error mapper: the marker (once, in front) + tail. */
export function assembleUtf8Tail(tail: Utf8Tail): string {
  const text = utf8TailText(tail);
  return tail.truncated ? `${STREAM_TAIL_TRUNCATED_MARKER}\n${text}` : text;
}

/** Alias kept local to this file's call sites. */
const byteLengthOf = utf8ByteLength;
