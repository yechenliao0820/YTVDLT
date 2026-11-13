/**
 * M4-3 · snapshot persistence + crash recovery (原始验收 ②).
 *
 * Scenario under test: a download is at 37 % → process is killed → a NEW app
 * session loads `tasks.json`, the task is still there, shows the prior
 * progress, is `Canceled` (not `Running`), and one `restart()` completes it.
 */
import { describe, it, expect } from 'vitest';
import {
  TaskQueue, TaskStore, HistoryStore, restoreTasks, countInterrupted,
} from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord, TaskSnapshot,
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

const record = (
  taskId: string,
  state: TaskRecord['state'],
  lastPercent: number | null = null,
  media: MediaInfo | null = null,
): TaskRecord => ({
  id: taskId, url: 'https://example.org/v', kind: 'video', state,
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: media, request: request(taskId), artifacts: [], lastPercent,
  error: null, privateMode: false, postprocessed: false,
});

const snapshot = (tasks: TaskRecord[], savedAt = '2026-11-05T00:00:00.000Z'): TaskSnapshot => ({
  schemaVersion: 1, savedAt, tasks,
});

interface EngineState {
  mode: 'complete' | 'hang';
  probeCalls: number;
  downloadCalls: number;
}

function fakeEngine(state: EngineState): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { state.probeCalls += 1; return mediaInfo(); },
    async probePlaylist() { throw new Error('not used'); },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      state.downloadCalls += 1;
      const handle = {
        pid: 1,
        cancel: async () => {
          onEvent({ type: 'canceled', taskId: req.taskId });
          return true;
        },
      };
      onEvent({
        type: 'progress', taskId: req.taskId, percent: 37, downloadedBytes: 37,
        totalBytes: 100, speedBps: 1, etaSec: 1, rawLine: 'YTVDLT|...',
      });
      if (state.mode === 'complete') {
        queueMicrotask(() => onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: [{ taskId: req.taskId, path: `C:/out/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
        }));
      }
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

/** One "app session": its own ports (shared state), store and queue. */
function session(files: Map<string, string>, mode: 'complete' | 'hang' = 'complete') {
  const mem = createInMemoryPorts();
  for (const [path, text] of files) mem.state.files.set(path, text);
  const engineState: EngineState = { mode, probeCalls: 0, downloadCalls: 0 };
  const store = new TaskStore({ ports: mem.ports });
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: fakeEngine(engineState),
    verifier: okVerifier,
    history: new HistoryStore({ ports: mem.ports }),
    taskStore: store,
    jsRuntimePath: 'C:/runtime/node.exe',
    persistIntervalMs: 0,
  });
  return { mem, store, queue, engineState };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const SNAPSHOT_PATH = 'C:/Users/test/AppData/Roaming/YTVDLT/config/tasks.json';

describe('M4-3 · countInterrupted', () => {
  it('counts only Running + FetchingInfo', () => {
    expect(countInterrupted(snapshot([
      record('a', 'Running'), record('b', 'FetchingInfo'), record('c', 'Canceled'),
      record('d', 'Completed'), record('e', 'Error'), record('f', 'ReadyWithInfo'), record('g', 'Idle'),
    ]))).toBe(2);
    expect(countInterrupted(snapshot([]))).toBe(0);
  });
});

describe('M4-3 · 原始验收 ② — restore after a hard kill', () => {
  it('restores every task, turns the two interrupted ones into Canceled, keeps progress', async () => {
    const files = new Map<string, string>([[
      SNAPSHOT_PATH,
      JSON.stringify(snapshot([
        record('running', 'Running', 42, mediaInfo()),
        record('fetching', 'FetchingInfo', 7),
        record('done', 'Completed', 100),
        record('failed', 'Error', null),
        record('stopped', 'Canceled', 12),
      ])),
    ]]);
    const { queue, engineState, store } = session(files);

    const result = await restoreTasks(queue, store);
    expect(result).toEqual({
      restored: 5, interrupted: 2, skipped: 0, empty: false,
      load: { status: 'ok', skippedRecords: 0, backupPath: null, writeBlocked: false, error: null },
    });
    // Booting must never start a download behind the user's back.
    expect(engineState.downloadCalls).toBe(0);
    expect(queue.activeTaskIds).toHaveLength(0);

    expect(queue.get('running')?.state).toBe('Canceled');
    expect(queue.get('running')?.lastPercent).toBe(42);
    expect(queue.get('running')?.mediaInfo?.id).toBe('fixture');
    expect(queue.get('fetching')?.state).toBe('Canceled');
    expect(queue.get('fetching')?.lastPercent).toBe(7);
    expect(queue.get('done')?.state).toBe('Completed');
    expect(queue.get('failed')?.state).toBe('Error');
    expect(queue.get('stopped')?.state).toBe('Canceled');
    expect(queue.list()).toHaveLength(5);
  });

  it('persists the recovered states — the file no longer claims Running/FetchingInfo', async () => {
    const files = new Map<string, string>([[
      SNAPSHOT_PATH,
      JSON.stringify(snapshot([record('running', 'Running', 42), record('fetching', 'FetchingInfo', 7)])),
    ]]);
    const { queue, store, mem } = session(files);
    await restoreTasks(queue, store);

    const persisted = JSON.parse(mem.state.files.get(SNAPSHOT_PATH) ?? '{}') as TaskSnapshot;
    expect(persisted.tasks.map((t) => t.state)).toEqual(['Canceled', 'Canceled']);
    expect(persisted.tasks.map((t) => t.lastPercent)).toEqual([42, 7]);
  });

  it('a restored Canceled task is retryable and completes', async () => {
    const files = new Map<string, string>([[
      SNAPSHOT_PATH,
      JSON.stringify(snapshot([record('running', 'Running', 42, mediaInfo())])),
    ]]);
    const { queue, store, engineState } = session(files);
    await restoreTasks(queue, store);
    expect(queue.get('running')?.state).toBe('Canceled');

    await queue.restart('running');
    await tick();
    expect(engineState.probeCalls).toBe(0); // mediaInfo was cached → no re-probe
    expect(queue.get('running')?.state).toBe('Completed');
  });

  it('first run (no snapshot file) restores nothing and reports empty', async () => {
    const { queue, store } = session(new Map());
    expect(await restoreTasks(queue, store)).toEqual({
      restored: 0, interrupted: 0, skipped: 0, empty: true,
      load: { status: 'missing', skippedRecords: 0, backupPath: null, writeBlocked: false, error: null },
    });
    expect(queue.list()).toHaveLength(0);
  });

  it('ids already known to the queue are skipped, never duplicated', async () => {
    const { queue } = session(new Map());
    void queue.enqueue(record('a', 'Idle'));
    await tick();
    // Restore a snapshot that overlaps the live queue by one id.
    const restored = await queue.restore(snapshot([record('a', 'Completed'), record('b', 'Canceled')]));
    expect(restored).toBe(1);
    expect(queue.list().filter((t) => t.id === 'a')).toHaveLength(1);
    expect(queue.get('a')?.state).toBe('Completed');
    expect(queue.get('b')?.state).toBe('Canceled');
    expect(queue.list()).toHaveLength(2);
  });
});

describe('M4-3 · mid-download snapshot (kill while transferring)', () => {
  it('writes progress to disk while Running, so a restart still has the task', async () => {
    const files = new Map<string, string>();
    const first = session(files, 'hang');
    void first.queue.enqueue(record('live', 'Idle'));
    await tick(60);

    const raw = JSON.parse(first.mem.state.files.get(SNAPSHOT_PATH) ?? '{}') as TaskSnapshot;
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0]?.state).toBe('Running');
    expect(raw.tasks[0]?.lastPercent).toBe(37);

    // Hard kill = the old session is simply abandoned; a new one reads the file.
    const second = session(new Map(first.mem.state.files), 'complete');
    const result = await restoreTasks(second.queue, second.store);
    expect(result).toMatchObject({ restored: 1, interrupted: 1 });
    expect(second.queue.get('live')?.state).toBe('Canceled');
    expect(second.queue.get('live')?.lastPercent).toBe(37);

    await second.queue.restart('live');
    await tick();
    expect(second.queue.get('live')?.state).toBe('Completed');
  });
});
