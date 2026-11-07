/**
 * L1 contract (A-INF-10): run the SAME interface assertions against BOTH
 * YtDlpEngine and FakeEngine to prove the hard engine-replaceability requirement.
 * Zero network, zero real processes (FakeProcess replay via in-memory ports).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { YtDlpEngine, FakeEngine } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import type { DownloadEngine, ProbeOptions } from '@ytvdlt/shared';
import { createInMemoryPorts } from '../unit/helpers/in-memory-ports.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url)).replace(/[\\/]+$/, '');
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const OPTS: ProbeOptions = { jsRuntimePath: 'C:/runtime/node.exe' };

const validRequest = (taskId: string) => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best' as const, videoCodecPref: 'auto' as const, formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best' as const, audioCodecPref: 'auto' as const, audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none' as const, embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

function realEngine() {
  const { ports, state } = createInMemoryPorts();
  state.spawnResults.set('yt-dlp.exe', {
    exitCode: 0, stdout: fixture('info-video.json'), stderr: '', timedOut: false,
  });
  const logger = new Logger({ ports, appVersion: '0.1.0' });
  const mapper = new ErrorMapper({ clock: ports.clock });
  return {
    engine: new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    }),
    state,
  };
}

function fakeEngine() {
  const { ports, state } = createInMemoryPorts();
  state.files.set(`${FIXTURES_DIR}/info-video.json`, fixture('info-video.json'));
  state.files.set(`${FIXTURES_DIR}/info-flat-playlist.json`, fixture('info-flat-playlist.json'));
  return { engine: new FakeEngine({ ports, fixturesDir: FIXTURES_DIR }), state };
}

const ENGINES: readonly (keyof DownloadEngine)[] = [
  'version', 'probe', 'probePlaylist', 'download', 'selfUpdate',
];

function assertInterface(engine: DownloadEngine): void {
  expect(ENGINES).toHaveLength(5);
  for (const method of ENGINES) expect(typeof engine[method]).toBe('function');
}

describe('L1 DownloadEngine contract · both implementations', () => {
  it('YtDlpEngine and FakeEngine both expose exactly the 5 methods', () => {
    assertInterface(realEngine().engine);
    assertInterface(fakeEngine().engine);
  });

  it('both probe() implementations return the SAME MediaInfo contract', async () => {
    const real = await realEngine().engine.probe('https://example.org/v', OPTS);
    const fake = await fakeEngine().engine.probe('https://example.org/v', OPTS);
    for (const info of [real, fake]) {
      expect(info.id).toBe('dQw4w9WgXcQ');
      expect(info.title).toBe('Recorded Fixture Video');
      expect(info.formats).toHaveLength(2);
      expect(info.subtitles['en']?.[0]?.ext).toBe('vtt');
      expect(info.chapters).toHaveLength(2);
    }
    expect(real).toEqual(fake);
  });

  it('YtDlpEngine.probe uses absolute path + argv[] + shell:false + windowsHide:true', async () => {
    const { engine, state } = realEngine();
    await engine.probe('https://example.org/v', OPTS);
    const call = state.spawnCalls[0];
    expect(call?.file).toBe('C:/runtime/yt-dlp.exe');
    expect(call?.opts.shell).toBe(false);
    expect(call?.opts.windowsHide).toBe(true);
    expect(call?.argv).toContain('--no-js-runtimes');
    expect(call?.argv).toContain('--js-runtimes');
    expect(call?.argv).toContain(`node:${OPTS.jsRuntimePath}`);
    expect(call?.argv).toContain('--');
    expect(call?.argv[call.argv.length - 1]).toBe('https://example.org/v');
    expect(call?.opts.env?.PATH).toContain('ffmpeg');
  });

  it('YtDlpEngine.probe maps a failed spawn to a structured AppError (no raw throw)', async () => {
    const { ports, state } = createInMemoryPorts();
    state.spawnResults.set('yt-dlp.exe', {
      exitCode: 1, stdout: '', stderr: 'HTTP Error 403: Forbidden', timedOut: false,
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });
    await expect(engine.probe('https://example.org/v', OPTS)).rejects.toMatchObject({
      code: 'HTTP_403',
      retryable: false,
    });
  });

  it('M4-4: probePlaylist is real (flat playlist argv); selfUpdate degrades without a source', async () => {
    const { ports, state } = createInMemoryPorts();
    state.spawnResults.set('yt-dlp.exe', {
      exitCode: 0, stdout: fixture('info-flat-playlist.json'), stderr: '', timedOut: false,
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });

    const playlist = await engine.probePlaylist('https://example.org/p', OPTS);
    expect(playlist.entries).toHaveLength(3);
    expect(playlist._type).toBe('playlist');
    const call = state.spawnCalls.at(-1);
    expect(call?.argv).toContain('--flat-playlist');
    expect(call?.argv).not.toContain('--no-playlist');
    expect(call?.argv.at(-1)).toBe('https://example.org/p');

    // M5-5 (D-62): selfUpdate() is implemented. With no update source injected
    // it must report "nothing changed" rather than throw or pretend to update.
    expect(await engine.selfUpdate('stable')).toMatchObject({ changed: false, channel: 'stable' });

    // M2: download() is implemented and returns a CancelHandle instead of throwing.
    const handle = engine.download(validRequest('t'), () => {});
    expect(typeof handle.cancel).toBe('function');
    expect(typeof handle.pid).toBe('object'); // null is typeof 'object'
  });

  it('M5/D-65: bundled aria2c is selected by name and exposed through PATH, never as an argument', async () => {
    const { ports, state } = createInMemoryPorts();
    state.spawnResults.set('yt-dlp.exe', {
      exitCode: 0, stdout: fixture('info-video.json'), stderr: '', timedOut: false,
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: 'C:/runtime/yt-dlp.exe',
      jsRuntimePath: 'C:/runtime/node.exe', appVersion: '0.1.0',
    });

    const base = validRequest('t-aria2c');
    const request = {
      ...base,
      network: { ...base.network, aria2cPath: 'C:/runtime/aria2c.exe' },
    };
    engine.download(request, () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const call = state.streamCalls.at(-1);
    expect(call?.argv).toContain('--downloader');
    expect(call?.argv[call.argv.indexOf('--downloader') + 1]).toBe('aria2c');
    expect(call?.argv).not.toContain('--downloader-args');
    expect(call?.argv).not.toContain('C:/runtime/aria2c.exe');

    // yt-dlp resolves the downloader through PATH: the exe's directory must lead.
    const pathValue = String(call?.opts.env?.['PATH'] ?? '');
    expect(pathValue.split(';')[0]).toBe('C:/runtime');
    expect(pathValue.split(';')[1]).toBe('C:/runtime/ffmpeg');
  });

  it('FakeEngine can replace YtDlpEngine for L2 replay (C1–C12 unchanged)', async () => {
    const { engine } = fakeEngine();
    const playlist = await engine.probePlaylist('https://example.org/p', OPTS);
    expect(playlist.entries).toHaveLength(3);
    expect(await engine.version()).toContain('fake-engine');
  });
});
