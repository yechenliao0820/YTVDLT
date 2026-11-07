/**
 * M4-2 · bounded concurrency kernel (原始验收 ①).
 *
 * Contract:
 *  - enqueue 7 tasks → at most `concurrency` run at once, the rest auto-fill;
 *  - `concurrency: 1` is strict serial (the M2 behaviour, pinned in task-queue.test.ts);
 *  - `setConcurrency()` raises/lowers the limit at runtime without killing work;
 *  - the default is 3 and every input is clamped to 1..8.
 */
import { describe, it, expect } from 'vitest';
import {
  TaskQueue, HistoryStore, normalizeConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY,
} from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const mediaInfo = (): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: 'chan', uploader_id: null, duration: 10,
  thumbnail: null, webpage_url: 'http://127.0.0.1:1/fixture.mp4', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4',
  formats: [{
    format_id: '0', ext: 'mp4', width: 320, height: 240, vcodec: 'h264', acodec: 'aac',
    filesize: 1, filesize_approx: null, tbr: 1, fps: 25, format_note: null,
  }],
  subtitles: {}, automatic_captions: {}, chapters: null, _type: 'video',
});

const request = (taskId: string): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

const record = (taskId: string): TaskRecord => ({
  id: taskId, url: 'https://example.org/v', kind: 'video', state: 'Idle',
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: request(taskId), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

interface Stats {
  active: number;
  maxActive: number;
  started: string[];
  finished: string[];
  downloadCalls: number;
}

/** Fake engine whose downloads occupy a slot for `delayMs`. */
function fakeEngine(stats: Stats, delayMs: number): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('not used'); },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      stats.downloadCalls += 1;
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      stats.started.push(req.taskId);
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        stats.active -= 1;
        stats.finished.push(req.taskId);
      };
      const handle = {
        pid: 1,
        cancel: async () => {
          if (!settled) onEvent({ type: 'canceled', taskId: req.taskId });
          finish();
          return true;
        },
      };
      setTimeout(() => {
        if (settled) return;
        onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: [{ taskId: req.taskId, path: `C:/out/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
        });
        finish();
      }, delayMs);
      return handle;
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

const okVerifier = {
  async verify() {
    return {
      taskId: 'x', artifacts: [], postprocessed: false,
      criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
      ok: true, failureCode: null, durationMs: 1,
    };
  },
};

function setup(concurrency?: number, delayMs = 25) {
  const mem = createInMemoryPorts();
  const stats: Stats = { active: 0, maxActive: 0, started: [], finished: [], downloadCalls: 0 };
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: fakeEngine(stats, delayMs),
    verifier: okVerifier,
    history: new HistoryStore({ ports: mem.ports }),
    jsRuntimePath: 'C:/runtime/node.exe',
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  return { mem, queue, stats };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('M4-2 · normalizeConcurrency (pure clamp)', () => {
  it('defaults to 3 and clamps every input into 1..8', () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);
    expect(MAX_CONCURRENCY).toBe(8);
    expect(normalizeConcurrency(undefined)).toBe(3);
    expect(normalizeConcurrency(Number.NaN)).toBe(3);
    expect(normalizeConcurrency(0)).toBe(1);
    expect(normalizeConcurrency(-5)).toBe(1);
    expect(normalizeConcurrency(99)).toBe(8);
    expect(normalizeConcurrency(2.9)).toBe(2);
    expect(normalizeConcurrency('4')).toBe(4);
  });

  it('a fresh queue reports the default limit and no active tasks', () => {
    const { queue } = setup();
    expect(queue.concurrency).toBe(3);
    expect(queue.activeTaskIds).toHaveLength(0);
    expect(queue.pendingCount).toBe(0);
  });
});

describe('M4-2 · 原始验收 ① — enqueue 7, at most 3 at once, auto-fill', () => {
  it('never exceeds the limit and eventually completes all 7', async () => {
    const { queue, stats } = setup(3, 20);
    for (let i = 1; i <= 7; i += 1) void queue.enqueue(record(`t${i}`));

    // The first three occupy the slots synchronously.
    expect(queue.activeTaskIds).toHaveLength(3);
    expect(queue.pendingCount).toBe(4);

    await waitFor(() => queue.list().every((r) => r.state === 'Completed'));
    expect(stats.maxActive).toBe(3);
    expect(stats.downloadCalls).toBe(7);
    expect(stats.started).toHaveLength(7);
    expect(queue.activeTaskIds).toHaveLength(0);
  });

  it('starts parked tasks in FIFO order once a slot frees up', async () => {
    const { queue, stats } = setup(2, 15);
    for (let i = 1; i <= 5; i += 1) void queue.enqueue(record(`t${i}`));
    await waitFor(() => stats.started.length >= 2);
    expect(stats.started.slice(0, 2)).toEqual(['t1', 't2']);
    await waitFor(() => stats.started.length >= 3);
    expect(stats.started.slice(0, 3)).toEqual(['t1', 't2', 't3']);
    await waitFor(() => queue.list().every((r) => r.state === 'Completed'));
    expect(stats.started).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('concurrency:1 stays strictly serial', async () => {
    const { queue, stats } = setup(1, 10);
    for (let i = 1; i <= 4; i += 1) void queue.enqueue(record(`t${i}`));
    await waitFor(() => queue.list().length === 4 && queue.list().every((r) => r.state === 'Completed'));
    expect(stats.maxActive).toBe(1);
    expect(stats.started).toEqual(['t1', 't2', 't3', 't4']);
  });
});

describe('M4-2 · setConcurrency at runtime', () => {
  it('raising the limit starts parked tasks immediately', async () => {
    const { queue, stats } = setup(1, 40);
    for (let i = 1; i <= 4; i += 1) void queue.enqueue(record(`t${i}`));
    expect(queue.activeTaskIds).toHaveLength(1);
    expect(queue.pendingCount).toBe(3);

    expect(queue.setConcurrency(4)).toBe(4);
    expect(queue.activeTaskIds).toHaveLength(4);
    expect(queue.pendingCount).toBe(0);
    await waitFor(() => queue.list().every((r) => r.state === 'Completed'));
    expect(stats.maxActive).toBe(4);
  });

  it('lowering the limit never kills running work, it only stops new starts', async () => {
    const { queue, stats } = setup(3, 30);
    for (let i = 1; i <= 6; i += 1) void queue.enqueue(record(`t${i}`));
    expect(queue.activeTaskIds).toHaveLength(3);

    expect(queue.setConcurrency(1)).toBe(1);
    // The three already running are untouched.
    expect(queue.activeTaskIds).toHaveLength(3);
    await waitFor(() => queue.list().every((r) => r.state === 'Completed'), 5000);
    // The limit was honoured for every task that started after the change.
    expect(stats.maxActive).toBeGreaterThanOrEqual(3);
    expect(stats.downloadCalls).toBe(6);
    expect(queue.activeTaskIds).toHaveLength(0);
  });

  it('clamps the value passed to setConcurrency', () => {
    const { queue } = setup(3);
    expect(queue.setConcurrency(0)).toBe(1);
    expect(queue.setConcurrency(100)).toBe(8);
    expect(queue.setConcurrency(Number.NaN)).toBe(3);
  });
});

describe('M4-2 · queue bookkeeping (cancel / remove / re-enqueue)', () => {
  it('canceling a queued (not yet started) task drops it without touching the matrix', async () => {
    const { queue } = setup(1, 40);
    void queue.enqueue(record('t1'));
    void queue.enqueue(record('t2'));
    expect(queue.pendingCount).toBe(1);

    expect(await queue.cancel('t2')).toBe(true);
    expect(queue.get('t2')).toBeUndefined();
    expect(queue.pendingCount).toBe(0);
    await waitFor(() => queue.get('t1')?.state === 'Completed');
  });

  it('remove() refuses a running task and accepts a settled one', async () => {
    const { queue } = setup(1, 35);
    void queue.enqueue(record('t1'));
    void queue.enqueue(record('t2'));
    expect(await queue.remove('t1')).toBe(false);
    await waitFor(() => queue.get('t1')?.state === 'Completed');
    expect(await queue.remove('t1')).toBe(true);
    expect(queue.get('t1')).toBeUndefined();
    expect(await queue.remove('missing')).toBe(false);
  });

  it('re-enqueueing the same id does not duplicate the FIFO entry', async () => {
    const { queue, stats } = setup(1, 15);
    void queue.enqueue(record('t1'));
    void queue.enqueue(record('t2'));
    void queue.enqueue(record('t2'));
    expect(queue.pendingCount).toBe(1);
    await waitFor(() => queue.list().every((r) => r.state === 'Completed'));
    expect(stats.downloadCalls).toBe(2);
  });
});
