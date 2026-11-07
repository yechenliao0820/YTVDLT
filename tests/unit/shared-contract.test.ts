/**
 * A-INF-01 · @ytvdlt/shared DTO contract.
 * Frozen M1 surface: 17 error codes, 5 DownloadEngine methods, ports with
 * zero node imports, IPC channel constants, all runtime/media/request types.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as shared from '@ytvdlt/shared';
import type {
  AppError, ErrorCode, ErrorContext, EngineEvent, Artifact, CancelHandle,
  UpdateResult, MediaInfo, PlaylistInfo, MediaFormat, SubtitleTrack, Chapter,
  PlaylistEntry, ProbeOptions, ProbeRequest, FormatDomain, SubtitleDomain,
  PathsDomain, NetworkDomain, AdvancedDomain, DownloadRequest,
  RuntimeItem, RuntimeManifest, RuntimeStatus, RuntimeCheckReport,
  RuntimeFileResult, RuntimeKind, RuntimeGroupKind, ItemStatus,
  DownloadEngine, IpcChannel, CorePorts, FileSystemPort, HashPort,
  ProcessPort, ClockPort, EnvPort, LogSinkPort, SpawnOptions, SpawnResult,
} from '@ytvdlt/shared';

describe('A-INF-01 shared contract · ErrorCode', () => {
  it('exports EXACTLY 17 error codes, no duplicates', () => {
    expect(shared.ALL_ERROR_CODES).toHaveLength(17);
    expect(new Set(shared.ALL_ERROR_CODES).size).toBe(17);
  });

  it('contains the exact §6.7 enumeration in frozen order', () => {
    expect(shared.ALL_ERROR_CODES).toEqual([
      'INVALID_URL', 'UNSUPPORTED_SITE', 'FORMAT_UNAVAILABLE',
      'NETWORK_TIMEOUT', 'DNS_FAILURE', 'HTTP_403', 'HTTP_429',
      'ALREADY_DOWNLOADED', 'DISK_FULL', 'PERMISSION_DENIED',
      'ENGINE_MISSING', 'JS_RUNTIME_MISSING', 'FFMPEG_MISSING',
      'EJS_FAILED', 'ARTIFACT_INCOMPLETE', 'CUSTOM_COMMAND_REJECTED', 'UNKNOWN',
    ]);
  });

  it('RUNTIME_MISSING_CODES has exactly the 4 runtime-missing codes', () => {
    expect(shared.RUNTIME_MISSING_CODES).toEqual([
      'ENGINE_MISSING', 'JS_RUNTIME_MISSING', 'FFMPEG_MISSING', 'EJS_FAILED',
    ]);
    for (const code of shared.RUNTIME_MISSING_CODES) {
      expect(shared.ALL_ERROR_CODES).toContain(code);
    }
  });

  it('AppError is a plain object DTO (structured-clone friendly)', () => {
    const sample: AppError = {
      code: 'UNKNOWN', message: 'm', detail: 'd', retryable: true, report: 'r',
    };
    expect(Object.getPrototypeOf(sample)).toBe(Object.prototype);
    expect(sample.code satisfies ErrorCode).toBe('UNKNOWN');
    const ctx: ErrorContext = {
      url: 'https://example.com', stderr: '', engineVersion: '1', appVersion: '1', os: 'win32',
    };
    expect(ctx.os).toBe('win32');
  });
});

describe('A-INF-01 shared contract · DownloadEngine', () => {
  const METHODS: readonly (keyof DownloadEngine)[] = [
    'version', 'probe', 'probePlaylist', 'download', 'selfUpdate',
  ];

  it('declares EXACTLY 5 methods and no extras', () => {
    expect(METHODS).toHaveLength(5);
    expect([...METHODS].sort()).toEqual(
      ['download', 'probe', 'probePlaylist', 'selfUpdate', 'version'].sort(),
    );
  });

  it('is implemented by a structurally-typed stub (all 5 signatures)', () => {
    const stub: DownloadEngine = {
      version: async () => '1',
      probe: async () => ({}) as MediaInfo,
      probePlaylist: async () => ({}) as PlaylistInfo,
      download: () => ({ cancel: async () => true, pid: null }),
      selfUpdate: async () => ({ fromVersion: '', toVersion: '', channel: 'stable', changed: false }),
    };
    expect(Object.keys(stub)).toHaveLength(5);
    for (const method of METHODS) expect(typeof stub[method]).toBe('function');
  });
});

describe('A-INF-01 shared contract · IPC channels', () => {
  it('keeps the 9 frozen M1 channels and only appends namespaced ones', () => {
    // Append-only contract: the original M1 channel names must never change.
    expect(shared.IPC_CHANNELS.PROBE).toBe('ytvdlt:probe');
    expect(shared.IPC_CHANNELS.PROBE_PLAYLIST).toBe('ytvdlt:probePlaylist');
    expect(shared.IPC_CHANNELS.DOWNLOAD_START).toBe('ytvdlt:download:start');
    expect(shared.IPC_CHANNELS.DOWNLOAD_CANCEL).toBe('ytvdlt:download:cancel');
    expect(shared.IPC_CHANNELS.ENGINE_EVENT).toBe('ytvdlt:engine:event');
    expect(shared.IPC_CHANNELS.RUNTIME_STATUS).toBe('ytvdlt:runtime:status');
    expect(shared.IPC_CHANNELS.CONFIG_GET).toBe('ytvdlt:config:get');
    expect(shared.IPC_CHANNELS.CONFIG_SET).toBe('ytvdlt:config:set');
    expect(shared.IPC_CHANNELS.ERROR_REPORT).toBe('ytvdlt:error:report');

    const values = Object.values(shared.IPC_CHANNELS);
    expect(values.length).toBeGreaterThanOrEqual(9);
    for (const value of values) expect(value.startsWith('ytvdlt:')).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    const channel: IpcChannel = shared.IPC_CHANNELS.PROBE;
    expect(channel).toBe('ytvdlt:probe');
  });
});

describe('A-INF-01 shared contract · DTO type completeness', () => {
  it('compiles MediaInfo / PlaylistInfo / five request domains', () => {
    const format: MediaFormat = {
      format_id: '1', ext: 'mp4', width: 320, height: 240,
      vcodec: 'h264', acodec: 'aac', filesize: 1, filesize_approx: null,
      tbr: 1, fps: 25, format_note: null,
    };
    const sub: SubtitleTrack = { lang: 'en', ext: 'vtt', name: null };
    const chapter: Chapter = { start_time: 0, end_time: 10, title: 'intro' };
    const info: MediaInfo = {
      id: 'x', title: 't', uploader: null, uploader_id: null, duration: 10,
      thumbnail: null, webpage_url: 'https://e.com', extractor_key: 'generic',
      description: null, upload_date: null, ext: 'mp4', formats: [format],
      subtitles: { en: [sub] }, automatic_captions: {}, chapters: [chapter], _type: 'video',
    };
    const entry: PlaylistEntry = { id: '1', title: 't', url: 'u', duration: null, _type: 'url' };
    const playlist: PlaylistInfo = {
      id: 'p', title: 'P', _type: 'playlist', extractor_key: 'generic',
      webpage_url: 'https://e.com', entries: [entry],
    };
    expect(info.formats[0]?.format_id).toBe('1');
    expect(playlist.entries[0]?.id).toBe('1');

    const f: FormatDomain = {
      quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false,
    };
    const s: SubtitleDomain = {
      enabled: false, languages: 'en.*,.*-orig', autoCaptions: false,
      skipTranslated: false, convertTo: 'none', embed: false, keepSubtitleFile: false,
    };
    const p: PathsDomain = {
      videoDir: 'V', audioDir: 'A', commandDir: 'C', privateMode: false,
      subdirByExtractor: false, subdirByPlaylist: false,
      outputTemplate: '%(title).200B [%(id)s].%(ext)s', tempDir: 'T',
    };
    const n: NetworkDomain = {
      rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
      ipv4Only: false, concurrentFragments: null, aria2cPath: null,
    };
    const a: AdvancedDomain = {
      sponsorblockRemove: null, downloadSections: null, splitChapters: false,
      customTitle: null, debug: false, downloadArchive: null, customCommand: null,
    };
    const req: DownloadRequest = {
      taskId: 't1', url: 'https://e.com', format: f, subtitle: s, paths: p, network: n, advanced: a,
    };
    const opts: ProbeOptions = { jsRuntimePath: 'C:/node.exe' };
    const probeReq: ProbeRequest = { url: 'https://e.com', opts, enginePath: 'C:/yt-dlp.exe' };
    expect(req.taskId).toBe('t1');
    expect(probeReq.opts.jsRuntimePath).toBe('C:/node.exe');
  });

  it('compiles runtime manifest / check report and port types', () => {
    const item: RuntimeItem = {
      path: 'yt-dlp.exe', sha256: 'a'.repeat(64), sizeBytes: 1, version: '1',
      sourceUrl: 'https://e.com/x', releaseTag: 't', license: 'Unlicense',
      required: true, kind: 'ytdlp', group: 'ytdlp',
    };
    const manifest: RuntimeManifest = {
      schemaVersion: 1, platform: 'win-x64', generatedAt: new Date().toISOString(),
      toolVersions: { node: 'v22', npm: '10', pnpm: '9' }, items: [item],
    };
    const fileResult: RuntimeFileResult = {
      path: 'yt-dlp.exe', status: 'OK', sha256Expected: 'a'.repeat(64),
      sha256Actual: 'a'.repeat(64), sizeBytesExpected: 1, sizeBytesActual: 1,
    };
    const status: RuntimeStatus = {
      kind: 'ytdlp', label: 'yt-dlp.exe', required: true, status: 'OK',
      errorCode: null, absoluteDir: 'C:/r', version: '1', versionCommand: '--version',
      fileResults: [fileResult], message: 'OK',
    };
    const report: RuntimeCheckReport = {
      schemaVersion: 1, platform: 'win-x64', checkedAt: new Date().toISOString(),
      packaged: false, runtimeDir: 'C:/r', allRequiredOk: true,
      summary: { requiredOk: 3, requiredTotal: 3, optionalMissing: 1, failed: 0 },
      items: [status],
    };
    expect(manifest.items[0]?.path).toBe('yt-dlp.exe');
    expect(report.summary.requiredTotal).toBe(3);

    const kinds: RuntimeKind[] = ['ytdlp', 'node', 'ffmpeg', 'ffprobe', 'aria2c'];
    const groups: RuntimeGroupKind[] = ['ytdlp', 'ffmpeg', 'node', 'aria2c'];
    const statuses: ItemStatus[] = ['OK', 'MISSING', 'HASH_MISMATCH', 'NOT_EXECUTABLE', 'OPTIONAL'];
    expect(kinds).toHaveLength(5);
    expect(groups).toHaveLength(4);
    expect(statuses).toHaveLength(5);

    // Structural checks for ports / events / handles (compile-time contract).
    const spawnOpts: SpawnOptions = { shell: false, windowsHide: true };
    const spawnResult: SpawnResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    const cancel: CancelHandle = { cancel: async () => true, pid: null };
    const update: UpdateResult = { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    const artifact: Artifact = { taskId: 't', path: 'C:/f.mp4', kind: 'video', sizeBytes: 1 };
    const event: EngineEvent = { type: 'completed', taskId: 't', artifacts: [artifact] };
    expect(spawnOpts.shell).toBe(false);
    expect(spawnResult.exitCode).toBe(0);
    expect(cancel.pid).toBeNull();
    expect(update.changed).toBe(false);
    expect(event.type).toBe('completed');

    // These type aliases make the import explicit for `verbatimModuleSyntax`.
    const portsCheck:
      | CorePorts | FileSystemPort | HashPort | ProcessPort | ClockPort
      | EnvPort | LogSinkPort | null = null;
    expect(portsCheck).toBeNull();
  });
});

describe('A-INF-01 shared contract · zero node/electron imports', () => {
  it('has no `node:` / `electron` / fs / child_process import in packages/shared/src', () => {
    const root = fileURLToPath(new URL('../../packages/shared/src/', import.meta.url));
    const files = [
      'index.ts', 'errors.ts', 'events.ts', 'media.ts', 'request.ts',
      'runtime.ts', 'engine.ts', 'ipc.ts', 'ports.ts',
    ];
    const forbidden = /^\s*(import|export)\s.*from\s*['"](electron|node:[^'"]+|fs|child_process|crypto|os)['"]|require\(\s*['"](electron|node:[^'"]+|fs|child_process|crypto|os)['"]/m;
    for (const file of files) {
      const source = readFileSync(`${root}${file}`, 'utf8');
      expect(forbidden.test(source), `${file} must not import node/electron`).toBe(false);
    }
  });
});
