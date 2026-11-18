/**
 * D-245 · config/plugin isolation prefix on EVERY yt-dlp spawn.
 *
 * The bundled yt-dlp.exe auto-loads configuration files (user dir + portable
 * dir next to the binary) and default plugin directories. Whatever those files
 * contain (`--exec`, proxy, output templates, extractor plugins) never passes
 * the app's argv whitelists — so every spawn must START with
 * `--ignore-config --no-plugin-dirs`, before every other token.
 *
 * Three layers of assertions:
 *   1. the shared `CONFIG_ISOLATION_FLAGS` constant is exactly the two flags;
 *   2. EVERY argv builder (probe / download / custom template) emits them as
 *      the first two elements;
 *   3. the ENGINE records the prefix on every real spawn call it makes
 *      (version / probe / probePlaylist / listExtractors / checkUrlSupport /
 *      download streaming) — driven through the in-memory ProcessPort, the
 *      same way the L1 contract tests drive it.
 *
 * Semantics boundary (verified against the bundled 2026.10.26 `--help`):
 * `--ignore-config` switches off DEFAULT config loading only. An explicit
 * `--config-locations` later on the same command line would still be honoured
 * — which is why that option stays forbidden on both whitelists
 * (`M3_FORBIDDEN_OPTIONS`, core `DENIED_CUSTOM_OPTIONS`): no app path can
 * inject it, so no config file can be loaded at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  build, buildDownload, buildCustomDownload, CONFIG_ISOLATION_FLAGS,
  YtDlpEngine, SelfUpdater,
} from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import type { DownloadRequest, ProbeOptions } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url)).replace(/[\\/]+$/, '');
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const NODE = 'C:/runtime/node.exe';
const ENGINE = 'C:/runtime/yt-dlp.exe';
const CTX = {
  jsRuntimePath: NODE,
  ffmpegDir: 'C:/runtime/ffmpeg',
  artifactManifestPath: 'C:/temp/ytvdlt-artifacts-t1.txt',
};

const OPTS: ProbeOptions = { jsRuntimePath: NODE };

const validRequest = (taskId = 't1'): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

function assertIsolationPrefix(argv: readonly string[], label: string): void {
  expect(argv[0], `${label}: argv[0]`).toBe('--ignore-config');
  expect(argv[1], `${label}: argv[1]`).toBe('--no-plugin-dirs');
  expect(argv.slice(0, 2)).toEqual([...CONFIG_ISOLATION_FLAGS]);
}

/** Poll until `predicate()` holds (the engine settles asynchronously). */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('D-245 · CONFIG_ISOLATION_FLAGS constant', () => {
  it('is exactly --ignore-config then --no-plugin-dirs', () => {
    expect([...CONFIG_ISOLATION_FLAGS]).toEqual(['--ignore-config', '--no-plugin-dirs']);
  });
});

describe('D-245 · every argv builder starts with the isolation prefix', () => {
  it('probe builder (build)', () => {
    const argv = build({ url: 'https://example.org/v', opts: OPTS, enginePath: ENGINE });
    assertIsolationPrefix(argv, 'build()');
    // The prefix is in front of the A-INF-05 frozen options.
    expect(argv[2]).toBe('-J');
  });

  it('probePlaylist variant (build with flatPlaylist) keeps the prefix', () => {
    const argv = build({
      url: 'https://example.org/p',
      opts: { ...OPTS, noPlaylist: false, flatPlaylist: true },
      enginePath: ENGINE,
    });
    assertIsolationPrefix(argv, 'build(flatPlaylist)');
    expect(argv[argv.length - 1]).toBe('https://example.org/p');
  });

  it('download builder (buildDownload), minimal and rich requests', () => {
    assertIsolationPrefix(buildDownload(validRequest(), CTX), 'buildDownload(minimal)');
    assertIsolationPrefix(buildDownload(validRequest('t2'), {
      ...CTX,
      subtitleManifestPath: 'C:/temp/ytvdlt-subs-t2.txt',
    }), 'buildDownload(with subtitle manifest)');
  });

  it('custom command template builder (buildCustomDownload) carries the prefix BEFORE user args', () => {
    const argv = buildCustomDownload(['-f', 'best', '--embed-subs'], 'https://example.org/v', CTX);
    assertIsolationPrefix(argv, 'buildCustomDownload()');
    // The user's own tokens come strictly after the isolation prefix.
    expect(argv.indexOf('-f')).toBeGreaterThan(1);
    expect(argv).toContain('--embed-subs');
  });
});

describe('D-245 · every YtDlpEngine spawn carries the isolation prefix', () => {
  function realEngine(spawnStdout = '') {
    const { ports, state } = createInMemoryPorts();
    if (spawnStdout !== '') {
      state.spawnResults.set('yt-dlp.exe', {
        exitCode: 0, stdout: spawnStdout, stderr: '', timedOut: false,
      });
    }
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    return {
      engine: new YtDlpEngine({
        ports, logger, mapper, enginePath: ENGINE,
        jsRuntimePath: NODE, appVersion: '0.1.0',
      }),
      state,
    };
  }

  it('version()', async () => {
    const { engine, state } = realEngine('2026.10.26\n');
    await engine.version();
    expect(state.spawnCalls).toHaveLength(1);
    assertIsolationPrefix(state.spawnCalls[0]?.argv ?? [], 'version()');
    expect(state.spawnCalls[0]?.argv.slice(2)).toEqual(['--version']);
  });

  it('probe()', async () => {
    const { engine, state } = realEngine(fixture('info-video.json'));
    await engine.probe('https://example.org/v', OPTS);
    expect(state.spawnCalls.length).toBeGreaterThanOrEqual(1);
    assertIsolationPrefix(state.spawnCalls[0]?.argv ?? [], 'probe()');
    expect(state.spawnCalls[0]?.argv[state.spawnCalls[0]!.argv.length - 1]).toBe('https://example.org/v');
  });

  it('probePlaylist()', async () => {
    const { engine, state } = realEngine(fixture('info-flat-playlist.json'));
    await engine.probePlaylist('https://example.org/p', OPTS);
    expect(state.spawnCalls.length).toBeGreaterThanOrEqual(1);
    assertIsolationPrefix(state.spawnCalls[0]?.argv ?? [], 'probePlaylist()');
    expect(state.spawnCalls[0]?.argv).toContain('--flat-playlist');
  });

  it('listExtractors()', async () => {
    const { engine, state } = realEngine('example\nother\n');
    const result = await engine.listExtractors();
    expect(result.ok).toBe(true);
    // Two spawns: the extractor list itself + the trailing version() call that
    // fills catalog.engineVersion. BOTH must carry the isolation prefix.
    expect(state.spawnCalls).toHaveLength(2);
    assertIsolationPrefix(state.spawnCalls[0]?.argv ?? [], 'listExtractors()');
    expect(state.spawnCalls[0]?.argv.slice(2)).toEqual(['--list-extractors']);
    assertIsolationPrefix(state.spawnCalls[1]?.argv ?? [], 'listExtractors()->version()');
    expect(state.spawnCalls[1]?.argv.slice(2)).toEqual(['--version']);
  });

  it('checkUrlSupport() (the pre-check spawn)', async () => {
    const { engine, state } = realEngine(fixture('info-video.json'));
    const result = await engine.checkUrlSupport('https://example.org/v', { jsRuntimePath: NODE });
    expect(result.state).toBe('SUPPORTED');
    expect(state.spawnCalls).toHaveLength(1);
    assertIsolationPrefix(state.spawnCalls[0]?.argv ?? [], 'checkUrlSupport()');
  });

  it('download() (the streaming spawn)', async () => {
    const { ports, state } = createInMemoryPorts();
    // The streaming child "writes" the artifact manifest and exits 0, so the
    // run reaches a terminal event; the argv is recorded at spawn time either way.
    state.streamScripts.set('yt-dlp.exe', {
      chunks: [],
      exitCode: 0,
      writeFiles: { 'C:/temp/ytvdlt-artifacts-t1.txt': 'C:/out/video.mp4\n' },
    });
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const mapper = new ErrorMapper({ clock: ports.clock });
    const engine = new YtDlpEngine({
      ports, logger, mapper, enginePath: ENGINE,
      jsRuntimePath: NODE, appVersion: '0.1.0',
    });
    const events: string[] = [];
    engine.download(validRequest(), (event) => events.push(event.type));
    await waitFor(() => events.includes('completed') || events.includes('failed'), 'terminal engine event');
    expect(state.streamCalls).toHaveLength(1);
    assertIsolationPrefix(state.streamCalls[0]?.argv ?? [], 'download()');
    expect(state.streamCalls[0]?.argv[state.streamCalls[0]!.argv.length - 1]).toBe('https://example.org/v');
  });
});

describe('D-245 · the self-updater version probe follows the component', () => {
  const brokenSource = {
    kind: 'local-dir' as const,
    async fetchChecksums(): Promise<string> { throw new Error('unavailable'); },
    async fetchEngineBinary(): Promise<Uint8Array> { return new Uint8Array(); },
  };

  /** Run one update() far enough to observe the installedVersion() spawn. */
  async function recordVersionSpawn(enginePath: string, fileName?: string) {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const updater = new SelfUpdater({
      ports, logger, source: brokenSource, intakeGate: null,
      enginePath, channel: 'stable',
      ...(fileName === undefined ? {} : { componentFileName: fileName }),
    });
    // fetchChecksums throws, so update() stops right after the version probe —
    // exactly the spawn this test wants to observe.
    await updater.update();
    return state.spawnCalls;
  }

  it('yt-dlp.exe gets --ignore-config/--no-plugin-dirs before --version', async () => {
    const calls = await recordVersionSpawn(ENGINE);
    expect(calls).toHaveLength(1);
    assertIsolationPrefix(calls[0]?.argv ?? [], 'SelfUpdater(yt-dlp.exe)');
    expect(calls[0]?.argv.slice(2)).toEqual(['--version']);
  });

  it('aria2c.exe does NOT receive yt-dlp-only flags', async () => {
    // aria2c has its own config system (`--no-conf`); passing yt-dlp's flags
    // would break its version probe and blank the component version display.
    const calls = await recordVersionSpawn('C:/runtime/aria2c.exe', 'aria2c.exe');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(['--version']);
  });
});
