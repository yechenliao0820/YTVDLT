/**
 * M4-3 · TaskHost boot wiring (config concurrency + snapshot restore).
 *
 * Verifies the production seam without Electron: injected ports, a real
 * ConfigStore and a real TaskStore over the in-memory filesystem.
 */
import { describe, it, expect } from 'vitest';
import { createDefaultConfig } from '@ytvdlt/core';
import type { DownloadEngine, DownloadRequest, EngineEvent, TaskRecord } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { createTaskHost } from '../../apps/desktop/src/main/task-host.js';

const mediaInfo = () => ({
  id: 'fixture', title: 'fixture', uploader: null, uploader_id: null, duration: 10,
  thumbnail: null, webpage_url: 'https://example.org/v', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4', formats: [], subtitles: {},
  automatic_captions: {}, chapters: null, _type: 'video' as const,
});

const request = (taskId: string): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

const record = (id: string, state: TaskRecord['state'], percent: number | null = null): TaskRecord => ({
  id, url: 'https://example.org/v', kind: 'video', state,
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: request(id), artifacts: [], lastPercent: percent,
  error: null, privateMode: false, postprocessed: false,
});

function engine(counter: { downloads: number }): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('not used'); },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      counter.downloads += 1;
      queueMicrotask(() => onEvent({
        type: 'completed', taskId: req.taskId,
        artifacts: [{ taskId: req.taskId, path: `C:/out/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
      }));
      return { pid: 1, cancel: async () => true };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

const verifier = {
  async verify() {
    return {
      taskId: 'x', artifacts: [], postprocessed: false,
      criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
      ok: true, failureCode: null, durationMs: 1,
    };
  },
};

const configWith = (concurrency: unknown): string => {
  const doc = createDefaultConfig('2026-11-05T00:00:00.000Z');
  doc.domains.general = { ...doc.domains.general, concurrency };
  return `${JSON.stringify(doc, null, 2)}\n`;
};

const CONFIG_PATH = 'C:/Users/test/AppData/Roaming/YTVDLT/config/config.json';
const SNAPSHOT_PATH = 'C:/Users/test/AppData/Roaming/YTVDLT/config/tasks.json';

const setup = (files: Array<[string, string]> = []) => {
  const mem = createInMemoryPorts();
  for (const [path, text] of files) mem.state.files.set(path, text);
  const counter = { downloads: 0 };
  return { mem, counter };
};

describe('M4-3 · TaskHost boot', () => {
  it('uses the default concurrency 3 on a clean install and performs no downloads', async () => {
    const { mem, counter } = setup();
    const host = await createTaskHost({
      ports: mem.ports, engine: engine(counter), verifier,
      jsRuntimePath: 'C:/runtime/node.exe',
    });
    expect(host.concurrency).toBe(3);
    expect(host.queue.concurrency).toBe(3);
    expect(host.restore).toEqual({
      restored: 0, interrupted: 0, skipped: 0, empty: true,
      load: { status: 'missing', skippedRecords: 0, backupPath: null, writeBlocked: false, error: null },
    });
    expect(counter.downloads).toBe(0);
  });

  it('honours general.concurrency from the config file', async () => {
    const { mem, counter } = setup([[CONFIG_PATH, configWith(5)]]);
    const host = await createTaskHost({
      ports: mem.ports, engine: engine(counter), verifier,
      jsRuntimePath: 'C:/runtime/node.exe',
    });
    expect(host.concurrency).toBe(5);
  });

  it('clamps an out-of-range configured value', async () => {
    for (const [stored, expected] of [[0, 1], [99, 8], ['4', 4]] as Array<[unknown, number]>) {
      const { mem, counter } = setup([[CONFIG_PATH, configWith(stored)]]);
      const host = await createTaskHost({
        ports: mem.ports, engine: engine(counter), verifier,
        jsRuntimePath: 'C:/runtime/node.exe',
      });
      expect(host.concurrency).toBe(expected);
    }
  });

  it('an explicit option overrides the config file', async () => {
    const { mem, counter } = setup([[CONFIG_PATH, configWith(5)]]);
    const host = await createTaskHost({
      ports: mem.ports, engine: engine(counter), verifier,
      jsRuntimePath: 'C:/runtime/node.exe', concurrency: 2,
    });
    expect(host.concurrency).toBe(2);
  });

  it('restores a previous snapshot without starting it', async () => {
    const { mem, counter } = setup([[
      SNAPSHOT_PATH,
      JSON.stringify({ schemaVersion: 1, savedAt: '2026-11-05T00:00:00.000Z', tasks: [record('t1', 'Running', 42)] }),
    ]]);
    const host = await createTaskHost({
      ports: mem.ports, engine: engine(counter), verifier,
      jsRuntimePath: 'C:/runtime/node.exe',
    });
    expect(host.restore).toMatchObject({ restored: 1, interrupted: 1 });
    expect(host.queue.get('t1')?.state).toBe('Canceled');
    expect(host.queue.get('t1')?.lastPercent).toBe(42);
    expect(counter.downloads).toBe(0);
  });
});
