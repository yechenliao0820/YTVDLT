/**
 * L1 download contract: FakeEngine and YtDlpEngine expose the same download
 * behaviour (event kinds, terminal event, CancelHandle shape). Zero real
 * processes — the real engine runs on the in-memory ProcessPort.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeEngine, YtDlpEngine, YTVDLT_PROGRESS_TEMPLATE } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper, TaskQueue, HistoryStore } from '@ytvdlt/core';
import type { DownloadEngine, DownloadRequest, EngineEvent, MediaInfo, TaskRecord } from '@ytvdlt/shared';
import { createInMemoryPorts } from '../unit/helpers/in-memory-ports.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url)).replace(/[\\/]+$/, '');
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

/**
 * D-118: `paths.tempDir` is resolved BY THE CALLER and is already per-task, so
 * this fixture mirrors what the desktop host produces (`<work>/<taskId>`).
 * The engine must use it verbatim — no second `<taskId>` level.
 */
const request = (taskId: string): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: `C:/temp/${taskId}` },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

async function runToCompletion(engine: DownloadEngine, taskId: string): Promise<string[]> {
  const kinds: string[] = [];
  await new Promise<void>((resolve, reject) => {
    engine.download(request(taskId), (event) => {
      kinds.push(event.type);
      if (event.type === 'completed') resolve();
      if (event.type === 'failed') reject(new Error(event.error.code));
    });
    setTimeout(() => reject(new Error('download did not settle')), 10_000);
  });
  return kinds;
}

describe('L1 download contract · FakeEngine and YtDlpEngine agree', () => {
  it('FakeEngine emits stage → progress… → completed', async () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(`${FIXTURES_DIR}/progress-basic.log`, fixture('progress-basic.log'));
    state.files.set(`${FIXTURES_DIR}/media/fixture.mp4`, 'fixture-bytes');
    const engine = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR });
    const kinds = await runToCompletion(engine, 'fake-1');
    expect(kinds[0]).toBe('stage');
    expect(kinds).toContain('progress');
    expect(kinds.at(-1)).toBe('completed');
    expect(kinds.filter((k) => k === 'completed')).toHaveLength(1);
  });

  it('YtDlpEngine emits progress… → completed and reads artifacts from the manifest', async () => {
    const { ports, state } = createInMemoryPorts();
    const artifact = 'C:/out/fixture.mp4';
    state.files.set(artifact, 'fixture-bytes');
    // Emit a progress line then succeed; the manifest is written by "yt-dlp".
    // D-118: `paths.tempDir` IS this task's directory (the caller resolves
    // it), so the manifest lands directly in it — no second taskId level.
    const manifestPath = 'C:/temp/real-1/ytvdlt-artifacts-real-1.txt';
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|50|100|NA|10|1|0.5\nYTVDLT|100|100|NA|10|0|1\n' }],
      exitCode: 0,
      // The engine unlinks the stale manifest first, so the child must write it.
      writeFiles: { [manifestPath]: `"${artifact}"\n` },
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const kinds = await runToCompletion(engine, 'real-1');
    expect(kinds).toContain('progress');
    expect(kinds.at(-1)).toBe('completed');
  });

  /**
   * D-118: after a successful run yt-dlp has moved every finished file out of
   * the temp dir and the manifest is unlinked, so an empty folder is residue.
   * A NON-empty one is never touched — leftovers are resumable bytes or
   * evidence, and `rmdir` is deliberately non-recursive.
   */
  it('D-118: retires the per-task temp dir only when it is empty', async () => {
    const { ports, state } = createInMemoryPorts();
    const artifact = 'C:/out/fixture.mp4';
    const tempDir = 'C:/temp/clean-1';
    state.files.set(artifact, 'fixture-bytes');
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|100|100|NA|10|0|1\n' }],
      exitCode: 0,
      writeFiles: { [`${tempDir}/ytvdlt-artifacts-clean-1.txt`]: `"${artifact}"\n` },
    });
    const rmdirCalls: string[] = [];
    const realRmdir = ports.fs.rmdir.bind(ports.fs);
    ports.fs.rmdir = async (path: string): Promise<void> => {
      rmdirCalls.push(path);
      await realRmdir(path);
    };
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const kinds = await runToCompletion(engine, 'clean-1');
    expect(kinds.at(-1)).toBe('completed');
    // The cleanup is deliberately AFTER the `completed` event (the queue must
    // own the artifact paths before anything is removed), so let the microtask
    // chain finish before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rmdirCalls).toEqual([tempDir]);
  });

  it('D-118: keeps a temp dir that still holds a leftover `.part`', async () => {
    const { ports, state } = createInMemoryPorts();
    const artifact = 'C:/out/fixture.mp4';
    const tempDir = 'C:/temp/dirty-1';
    state.files.set(artifact, 'fixture-bytes');
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|100|100|NA|10|0|1\n' }],
      exitCode: 0,
      writeFiles: {
        [`${tempDir}/ytvdlt-artifacts-dirty-1.txt`]: `"${artifact}"\n`,
        // A leftover from another format: the folder must survive it.
        [`${tempDir}/fixture.f137.mp4.part`]: 'partial-bytes',
      },
    });
    const rmdirCalls: string[] = [];
    const realRmdir = ports.fs.rmdir.bind(ports.fs);
    ports.fs.rmdir = async (path: string): Promise<void> => {
      rmdirCalls.push(path);
      await realRmdir(path);
    };
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const kinds = await runToCompletion(engine, 'dirty-1');
    // A leftover must never turn a successful download into a failure…
    expect(kinds.at(-1)).toBe('completed');
    // …and must never be removed either.
    expect(rmdirCalls).toEqual([]);
    expect(state.files.has(`${tempDir}/fixture.f137.mp4.part`)).toBe(true);
  });

  it('D-112: a manifest-sized “completed” transfer is not forwarded as 100%', async () => {
    const { ports, state } = createInMemoryPorts();
    const artifact = 'C:/out/fixture.mp4';
    state.files.set(artifact, 'fixture-bytes');
    const manifestPath = 'C:/temp/d112-1/ytvdlt-artifacts-d112-1.txt';
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{
        stream: 'stdout',
        // Real capture: the 712-byte HLS manifest completes first, then the
        // media stream restarts at ~3%. Forwarding both made the bar show 100%
        // for one frame and drop back.
        text: 'YTVDLT|712|712|NA|1000|0|0.1\n'
          + 'YTVDLT|1736|NA|58028|4000|12|0.4\n'
          + 'YTVDLT|29014|NA|58028|9000|3|1.0\n',
      }],
      exitCode: 0,
      writeFiles: { [manifestPath]: `"${artifact}"\n` },
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const percents: (number | null)[] = [];
    await new Promise<void>((resolve) => {
      engine.download(request('d112-1'), (event) => {
        if (event.type === 'progress') percents.push(event.percent);
        if (event.type === 'completed' || event.type === 'failed') resolve();
      });
    });
    expect(percents).toEqual([3, 50]);
  });

  it('both engines return a CancelHandle with cancel() and pid', () => {
    const { ports, state } = createInMemoryPorts();
    state.files.set(`${FIXTURES_DIR}/progress-basic.log`, fixture('progress-basic.log'));
    const fake = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const real = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    for (const engine of [fake, real]) {
      const handle = engine.download(request('h1'), () => {});
      expect(typeof handle.cancel).toBe('function');
      expect(handle.pid === null || typeof handle.pid === 'number').toBe(true);
    }
  });

  it('the frozen progress template is shared by the argv builder', () => {
    expect(YTVDLT_PROGRESS_TEMPLATE.startsWith('download:YTVDLT|')).toBe(true);
    expect(YTVDLT_PROGRESS_TEMPLATE.split('|')).toHaveLength(7);
  });
});

describe('D-89 · NSIS install into a read-only Program Files', () => {
  it('pins the child cwd and the whole TEMP family to a writable dir, never the install dir', async () => {
    const { ports, state } = createInMemoryPorts();
    // Simulate the VM: the inherited TEMP/CWD point at the install directory.
    state.env.vars['TEMP'] = 'C:\\Program Files\\YTVDLT';
    state.env.vars['TMP'] = 'C:\\Program Files\\YTVDLT';
    const base = request('d89-1');
    const outputDir = 'C:/Users/leo/Downloads/YTVDLT';
    const req: DownloadRequest = {
      ...base,
      paths: { ...base.paths, videoDir: outputDir, audioDir: `${outputDir}/Audio` },
    };
    const artifact = `${outputDir}/video.mp4`;
    state.files.set(artifact, 'bytes');
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|100|100|NA|10|0|1\n' }],
      exitCode: 0,
      writeFiles: { 'C:/temp/d89-1/ytvdlt-artifacts-d89-1.txt': `"${artifact}"\n` },
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    await new Promise<void>((resolve, reject) => {
      engine.download(req, (event) => {
        if (event.type === 'completed') resolve();
        if (event.type === 'failed') reject(new Error(event.error.code));
      });
      setTimeout(() => reject(new Error('download did not settle')), 10_000);
    });
    const call = state.streamCalls.at(-1);
    expect(call).toBeDefined();
    // D-118: the request carries `tempDir: 'C:/temp/d89-1'`, so the child is
    // pinned to that writable PER-TASK folder. The invariant D-89 actually
    // requires is "cwd is writable and never Program Files"; the concrete
    // directory is not the contract.
    expect(call?.opts.cwd).toBe('C:/temp/d89-1');
    expect(call?.opts.cwd).not.toContain('Program Files');
    // D-118: TEMP is left ALONE once the parent has a usable one. Pinning it
    // used to park yt-dlp's 29 MB `_MEI*` unpack inside the download folder
    // whenever a download was cancelled or crashed.
    expect(call?.opts.env?.['TEMP']).toBeUndefined();
    expect(call?.opts.env?.['TMP']).toBeUndefined();
    expect(call?.opts.env?.['TMPDIR']).toBeUndefined();
  });

  /**
   * D-118: only when the inherited TEMP is missing/unusable does the engine
   * substitute its own writable directory — otherwise a child on a machine with
   * no TEMP would have nowhere to unpack.
   */
  it('D-118: substitutes TEMP only when the inherited one is unusable', async () => {
    const { ports, state } = createInMemoryPorts();
    state.env.vars['TEMP'] = '';
    state.env.vars['TMP'] = '';
    const base = request('d89-3');
    const outputDir = 'C:/Users/leo/Videos/YTVDLT';
    const req: DownloadRequest = {
      ...base,
      paths: { ...base.paths, videoDir: outputDir, audioDir: `${outputDir}/Audio` },
    };
    const artifact = `${outputDir}/video.mp4`;
    state.files.set(artifact, 'bytes');
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|100|100|NA|10|0|1\n' }],
      exitCode: 0,
      writeFiles: { [`${base.paths.tempDir}/ytvdlt-artifacts-d89-3.txt`]: `"${artifact}"\n` },
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    await new Promise<void>((resolve, reject) => {
      engine.download(req, (event) => {
        if (event.type === 'completed') resolve();
        if (event.type === 'failed') reject(new Error(event.error.code));
      });
      setTimeout(() => reject(new Error('download did not settle')), 10_000);
    });
    const call = state.streamCalls.at(-1);
    expect(call?.opts.env?.['TEMP']).toBe(base.paths.tempDir);
    expect(call?.opts.env?.['TMP']).toBe(base.paths.tempDir);
  });

  /**
   * D-117: a request WITHOUT a tempDir must keep the pre-0.2.6 behaviour —
   * pinning to the output dir — so an older caller (or a user who cleared the
   * setting) can never end up with `cwd` undefined and yt-dlp temp files in the
   * install directory.
   */
  it('falls back to the output dir when the request carries no tempDir', async () => {
    const { ports, state } = createInMemoryPorts();
    const base = request('d89-2');
    const outputDir = 'C:/Users/leo/Movies/YTVDLT';
    const req: DownloadRequest = {
      ...base,
      paths: { ...base.paths, tempDir: '', videoDir: outputDir, audioDir: `${outputDir}/Audio` },
    };
    const artifact = `${outputDir}/video.mp4`;
    state.files.set(artifact, 'bytes');
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|100|100|NA|10|0|1\n' }],
      exitCode: 0,
      writeFiles: { [`${outputDir}/ytvdlt-artifacts-d89-2.txt`]: `"${artifact}"\n` },
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    await new Promise<void>((resolve, reject) => {
      engine.download(req, (event) => {
        if (event.type === 'completed') resolve();
        if (event.type === 'failed') reject(new Error(event.error.code));
      });
      setTimeout(() => reject(new Error('download did not settle')), 10_000);
    });
    const call = state.streamCalls.at(-1);
    expect(call?.opts.cwd).toBe(outputDir);
    // This fake has NO inherited TEMP, so the engine substitutes the writable
    // dir it already pinned — the "no TEMP at all" fallback of D-118.
    expect(call?.opts.env?.['TEMP']).toBe(outputDir);
  });
});

/**
 * Pre-spawn cancel window (audit P2-1): a cancel that landed between
 * `download()` and the `spawnStreaming` call used to return `false`
 * ("cancel failed") while the child STILL started and ran to completion — the
 * engine only checked `canceled` after the process had exited. The engine now
 * checks `canceled` after every pre-spawn await, so the window can no longer
 * start an unwanted child: the cancel is accepted, no child is spawned, the
 * `canceled` event settles the run and the queue lands the task in `Canceled`.
 */
describe('Pre-spawn cancel window · cancel is accepted and no child starts', () => {
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  /** Let every pending microtask (cleanup, queue persistence) drain. */
  const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it('cancel during the fs preparation: accepted, no spawn, canceled event, empty temp dir retired', async () => {
    const { ports, state } = createInMemoryPorts();
    // Hold the engine inside the pre-spawn fs batch (the first mkdir call).
    let enteredPrep = false;
    let releasePrep: () => void = () => undefined;
    const prepGate = new Promise<void>((resolve) => { releasePrep = resolve; });
    const realMkdir = ports.fs.mkdir.bind(ports.fs);
    ports.fs.mkdir = async (dir: string): Promise<void> => {
      enteredPrep = true;
      await prepGate;
      await realMkdir(dir);
    };
    const tempDir = 'C:/temp/p2-fs-1';
    const rmdirCalls: string[] = [];
    const realRmdir = ports.fs.rmdir.bind(ports.fs);
    ports.fs.rmdir = async (path: string): Promise<void> => {
      rmdirCalls.push(path);
      await realRmdir(path);
    };
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const events: EngineEvent[] = [];
    const handle = engine.download(request('p2-fs-1'), (event) => events.push(event));

    await waitFor(() => enteredPrep, 'engine reached the fs preparation');
    // The pre-spawn cancel is ACCEPTED — `false` is reserved for a kill that
    // was attempted and failed (D-142); nothing was ever started here.
    expect(await handle.cancel()).toBe(true);
    expect(handle.pid).toBeNull();
    releasePrep();

    await waitFor(() => events.some((event) => event.type === 'canceled'), 'canceled event');
    await drain();
    expect(state.streamCalls).toHaveLength(0); // the child never started
    expect(state.killed).toBe(0); // …and no kill was attempted either
    expect(events.map((event) => event.type)).toEqual(['canceled']);
    // The prep created the empty per-task dir; the D-118 empty-dir rule
    // retires it. A dir with leftovers is never touched (see D-118 tests).
    expect(rmdirCalls).toEqual([tempDir]);
  });

  it('cancel during logArgv (the last pre-spawn await): still accepted and the child never starts', async () => {
    const { ports, state } = createInMemoryPorts();
    // Hold the engine right after the fs preparation, inside the argv log
    // write — the LAST await before the (synchronous) spawn + register.
    let enteredLog = false;
    let releaseLog: () => void = () => undefined;
    const logGate = new Promise<void>((resolve) => { releaseLog = resolve; });
    const realAppend = ports.logSink.appendJsonl.bind(ports.logSink);
    ports.logSink.appendJsonl = async (line: string): Promise<void> => {
      enteredLog = true;
      await logGate;
      await realAppend(line);
    };
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const events: EngineEvent[] = [];
    const handle = engine.download(request('p2-log-1'), (event) => events.push(event));

    await waitFor(() => enteredLog, 'engine reached the argv log');
    expect(await handle.cancel()).toBe(true);
    releaseLog();

    await waitFor(() => events.some((event) => event.type === 'canceled'), 'canceled event');
    await drain();
    expect(state.streamCalls).toHaveLength(0);
    expect(state.killed).toBe(0);
    expect(events.map((event) => event.type)).toEqual(['canceled']);
  });

  it('cancel after the spawn keeps the existing killTree behaviour', async () => {
    const { ports, state } = createInMemoryPorts();
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [{ stream: 'stdout', text: 'YTVDLT|50|100|NA|10|5|0.5\n' }],
      exitCode: 0,
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    const events: EngineEvent[] = [];
    let cancelResult: boolean | null = null;
    const handle = engine.download(request('p2-run-1'), (event) => {
      events.push(event);
      // The in-memory child settles one microtask after spawnStreaming, so the
      // only deterministic "child is running" moment is the first progress
      // chunk — cancel from inside it, before the fake's own finish() runs.
      if (event.type === 'progress' && cancelResult === null) {
        void handle.cancel().then((accepted) => { cancelResult = accepted; });
      }
    });

    await waitFor(() => cancelResult !== null, 'cancel() resolved');
    expect(handle.pid).not.toBeNull();
    expect(cancelResult).toBe(true); // killTree's answer, unchanged
    expect(state.killedPids).toHaveLength(1); // the tree kill WAS attempted
    await waitFor(() => events.at(-1)?.type === 'canceled', 'canceled event');
    await drain();
    // The killed run settles as `canceled`, never as a failure (exitCode is
    // null after the kill and `canceled` wins the post-run check).
    expect(events.map((event) => event.type)).toEqual(['progress', 'canceled']);
  });

  // Queue-level wiring for the pre-spawn window: the task must land in
  // `Canceled` — `cancel()` returning `true` transitions Running → Canceled
  // immediately, and the engine's late `canceled` event must NOT re-transition
  // (the D-142 guard checks `record.state === 'Running'`).
  const okVerifier = {
    async verify() {
      return {
        taskId: 'x', artifacts: [] as string[], postprocessed: false,
        criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
        ok: true, failureCode: null, durationMs: 1,
      };
    },
  };
  const fixtureMediaInfo = (): MediaInfo => ({
    id: 'fixture', title: 'fixture', uploader: 'chan', uploader_id: null, duration: 10,
    thumbnail: null, webpage_url: 'https://example.org/v', extractor_key: 'generic',
    description: null, upload_date: null, ext: 'mp4',
    formats: [{ format_id: '0', ext: 'mp4', width: 320, height: 240, vcodec: 'h264', acodec: 'aac', filesize: 1, filesize_approx: null, tbr: 1, fps: 25, format_note: null }],
    subtitles: {}, automatic_captions: {}, chapters: null, _type: 'video',
  });
  const recordWithMediaInfo = (taskId: string): TaskRecord => ({
    id: taskId, url: 'https://example.org/v', kind: 'video', state: 'Idle',
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
    // Preset so the run skips the probe phase and goes straight to the
    // download — the phase this describe block is about.
    mediaInfo: fixtureMediaInfo(), request: request(taskId), artifacts: [],
    lastPercent: null, error: null, privateMode: false, postprocessed: false,
  });

  it('queue-level: a pre-spawn cancel lands the task in Canceled and starts no child', async () => {
    const { ports, state } = createInMemoryPorts();
    let enteredPrep = false;
    let releasePrep: () => void = () => undefined;
    const prepGate = new Promise<void>((resolve) => { releasePrep = resolve; });
    const realMkdir = ports.fs.mkdir.bind(ports.fs);
    ports.fs.mkdir = async (dir: string): Promise<void> => {
      enteredPrep = true;
      await prepGate;
      await realMkdir(dir);
    };
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    // The queue drives the REAL engine. The verifier is never reached: the
    // task cancels before the spawn.
    const queue = new TaskQueue({
      ports, engine, verifier: okVerifier, history: new HistoryStore({ ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
    });
    await queue.enqueue(recordWithMediaInfo('p2-queue-1'));

    await waitFor(() => enteredPrep, 'engine reached the fs preparation');
    expect(await queue.cancel('p2-queue-1')).toBe(true);
    releasePrep();

    await waitFor(() => queue.get('p2-queue-1')?.state === 'Canceled', 'Canceled state');
    await drain();
    expect(state.streamCalls).toHaveLength(0); // no child for the withdrawn run
    expect(queue.get('p2-queue-1')?.state).toBe('Canceled');
    // A clean cancellation never pins a junk error on the record.
    expect(queue.get('p2-queue-1')?.error).toBeNull();
  });
});
