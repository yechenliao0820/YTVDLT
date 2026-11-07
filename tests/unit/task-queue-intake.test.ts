/**
 * M5-5 · queue intake switch (D-62, §3.4).
 *
 * The self-updater needs to stop NEW downloads from starting while it swaps
 * `yt-dlp.exe`. The contract that matters:
 *   - pausing never cancels, never touches a record, never writes `Canceled`;
 *   - a running task keeps its slot and finishes normally;
 *   - `resumeIntake()` refills free slots in FIFO order;
 *   - both calls are idempotent.
 */
import { describe, it, expect } from 'vitest';
import { TaskQueue, HistoryStore } from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord, TaskState,
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
  createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
  mediaInfo: null, request: request(taskId), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

/** Engine whose downloads stay open until the test calls `finish()`. */
function manualEngine() {
  const started: string[] = [];
  const open = new Map<string, (event: EngineEvent) => void>();
  const engine: DownloadEngine = {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('not used'); },
    download(req: DownloadRequest, onEvent: (event: EngineEvent) => void) {
      started.push(req.taskId);
      open.set(req.taskId, onEvent);
      return {
        pid: 1,
        cancel: async () => {
          onEvent({ type: 'canceled', taskId: req.taskId });
          open.delete(req.taskId);
          return true;
        },
      };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
  const finish = (taskId: string): void => {
    const emit = open.get(taskId);
    if (emit === undefined) throw new Error(`task ${taskId} is not running`);
    open.delete(taskId);
    emit({
      type: 'completed', taskId,
      artifacts: [{ taskId, path: `C:/out/${taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
    });
  };
  return { engine, started, finish, open };
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

function setup(concurrency = 2) {
  const mem = createInMemoryPorts();
  const manual = manualEngine();
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: manual.engine,
    verifier: okVerifier,
    history: new HistoryStore({ ports: mem.ports }),
    jsRuntimePath: 'C:/runtime/node.exe',
    concurrency,
  });
  return { queue, manual };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('M5-5 · intake pause blocks new work', () => {
  it('parks freshly enqueued tasks instead of starting them', async () => {
    const { queue, manual } = setup();
    queue.pauseIntake();
    expect(queue.intakePaused).toBe(true);
    await queue.enqueue(record('t1'));
    await queue.enqueue(record('t2'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manual.started).toEqual([]);
    expect(queue.pendingCount).toBe(2);
    expect(queue.activeTaskIds).toEqual([]);
  });

  it('leaves a task that is already running alone', async () => {
    const { queue, manual } = setup();
    await queue.enqueue(record('running'));
    await waitFor(() => manual.started.length === 1);
    queue.pauseIntake();
    await queue.enqueue(record('parked'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manual.started).toEqual(['running']);
    expect(queue.get('parked')?.state).toBe('Idle');
  });

  it('finishes the running task without writing Canceled anywhere', async () => {
    const { queue, manual } = setup();
    const states: TaskState[] = [];
    queue.onEvent((event) => {
      if (event.type === 'state') states.push(event.state);
    });
    await queue.enqueue(record('t1'));
    await waitFor(() => manual.started.length === 1);
    queue.pauseIntake();
    manual.finish('t1');
    await waitFor(() => queue.get('t1')?.state === 'Completed');
    expect(states).not.toContain('Canceled');
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  it('refills free slots in FIFO order once resumed', async () => {
    const { queue, manual } = setup(1);
    queue.pauseIntake();
    for (const id of ['a', 'b', 'c']) await queue.enqueue(record(id));
    expect(manual.started).toEqual([]);
    queue.resumeIntake();
    await waitFor(() => manual.started.length === 1);
    expect(manual.started).toEqual(['a']);
    manual.finish('a');
    await waitFor(() => manual.started.length === 2);
    expect(manual.started).toEqual(['a', 'b']);
    manual.finish('b');
    await waitFor(() => manual.started.length === 3);
    expect(manual.started).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent in both directions', async () => {
    const { queue, manual } = setup(1);
    queue.pauseIntake();
    queue.pauseIntake();
    expect(queue.intakePaused).toBe(true);
    await queue.enqueue(record('a'));
    queue.resumeIntake();
    queue.resumeIntake();
    expect(queue.intakePaused).toBe(false);
    await waitFor(() => manual.started.length === 1);
    expect(manual.started).toEqual(['a']);
  });

  it('keeps the task list intact while paused (no record is dropped)', async () => {
    const { queue } = setup();
    queue.pauseIntake();
    await queue.enqueue(record('kept'));
    expect(queue.list().map((entry) => entry.id)).toEqual(['kept']);
    queue.resumeIntake();
    expect(queue.list().map((entry) => entry.id)).toEqual(['kept']);
  });
});
