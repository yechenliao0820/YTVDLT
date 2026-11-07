/**
 * A-INF-10 · FakeEngine implements the SAME DownloadEngine interface and can
 * replay recorded fixtures. Proves engine replaceability.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeEngine, createEngine } from '@ytvdlt/engine-ytdlp';
import type { DownloadEngine, DownloadRequest } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url)).replace(/[\\/]+$/, '');

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

function seed() {
  const { ports, state } = createInMemoryPorts();
  state.files.set(`${FIXTURES_DIR}/info-video.json`, fixture('info-video.json'));
  state.files.set(`${FIXTURES_DIR}/info-flat-playlist.json`, fixture('info-flat-playlist.json'));
  state.files.set(`${FIXTURES_DIR}/progress-basic.log`, fixture('progress-basic.log'));
  return { ports, state };
}

const ENGINES: (keyof DownloadEngine)[] = [
  'version', 'probe', 'probePlaylist', 'download', 'selfUpdate',
];

describe('A-INF-10 FakeEngine · same DownloadEngine interface', () => {
  it('has exactly the 5 interface methods', () => {
    const { ports } = seed();
    const engine: DownloadEngine = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR });
    expect(ENGINES).toHaveLength(5);
    for (const method of ENGINES) expect(typeof engine[method]).toBe('function');
  });

  it('replays info-video.json -> complete MediaInfo', async () => {
    const { ports } = seed();
    const engine = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR });
    const info = await engine.probe('https://example.org/x', { jsRuntimePath: 'C:/node.exe' });
    expect(info.id).toBe('dQw4w9WgXcQ');
    expect(info.formats).toHaveLength(2);
    expect(info.chapters).toHaveLength(2);
  });

  it('replays info-flat-playlist.json -> PlaylistInfo with 3 entries', async () => {
    const { ports } = seed();
    const engine = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR });
    const playlist = await engine.probePlaylist('https://example.org/p', { jsRuntimePath: 'C:/node.exe' });
    expect(playlist._type).toBe('playlist');
    expect(playlist.entries).toHaveLength(3);
  });

  it('download() replays progress/completed events and returns a CancelHandle', async () => {
    const { ports } = seed();
    const engine = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR });
    const events: string[] = [];
    const req = { taskId: 't1', url: 'https://example.org/x' } as DownloadRequest;
    const handle = engine.download(req, (event) => events.push(event.type));
    expect(handle.pid).toBeNull();
    expect(typeof handle.cancel).toBe('function');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events[0]).toBe('stage');
    expect(events).toContain('progress');
    expect(events.at(-1)).toBe('completed');
  });

  it('version()/selfUpdate() return recorded values', async () => {
    const { ports } = seed();
    const engine = new FakeEngine({ ports, fixturesDir: FIXTURES_DIR, recordedVersion: 'fake-1.2.3' });
    expect(await engine.version()).toBe('fake-1.2.3');
    expect(await engine.selfUpdate('stable')).toMatchObject({ changed: false, channel: 'stable' });
  });

  it('createEngine("fake") returns a FakeEngine (factory switch)', () => {
    const { ports } = seed();
    const engine = createEngine('fake', {
      ports,
      logger: { logArgv: async () => {} } as never,
      mapper: { map: () => ({}) as never, fromCode: () => ({}) as never },
      enginePath: 'C:/yt-dlp.exe', jsRuntimePath: 'C:/node.exe',
      fixturesDir: FIXTURES_DIR, appVersion: '0.1.0',
    });
    expect(engine).toBeInstanceOf(FakeEngine);
  });
});
