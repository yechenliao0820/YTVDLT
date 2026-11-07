/**
 * L1 download contract: FakeEngine and YtDlpEngine expose the same download
 * behaviour (event kinds, terminal event, CancelHandle shape). Zero real
 * processes — the real engine runs on the in-memory ProcessPort.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeEngine, YtDlpEngine, YTVDLT_PROGRESS_TEMPLATE } from '@ytvdlt/engine-ytdlp';
import { Logger, ErrorMapper } from '@ytvdlt/core';
import type { DownloadEngine, DownloadRequest } from '@ytvdlt/shared';
import { createInMemoryPorts } from '../unit/helpers/in-memory-ports.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url)).replace(/[\\/]+$/, '');
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const request = (taskId: string): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp' },
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
    const manifestPath = 'C:/temp/ytvdlt-artifacts-real-1.txt';
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
