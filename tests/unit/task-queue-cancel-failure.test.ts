/**
 * D-142 · a failed cancel must never free a task for a second run.
 *
 * Old behaviour (the audited defect): `cancel()` whose tree kill FAILED pinned
 * a retryable `Error` on the record while the zombie process kept occupying
 * its slot. `restart()` never checked `running.has(taskId)`, so a retry started
 * a SECOND process for the same task id — both writing the same temp dir,
 * manifest and output file, each overwriting the other's handle.
 *
 * New contract:
 *  - `cancel() === false` leaves the record in its non-terminal state, the
 *    slot occupied, and no error attached; the user may retry the cancel.
 *  - `restart()` refuses while the task still occupies a slot (this also
 *    covers the window between a successful kill and the engine's close
 *    event).
 *  - `remove()` refuses (pre-existing guard, pinned here).
 *  - When the zombie process eventually exits, the queue self-heals: the
 *    engine has already latched `canceled`, so the run settles as `Canceled`
 *    and the slot is released to the FIFO.
 */
import { describe, it, expect } from 'vitest';
import { TaskQueue, HistoryStore } from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const artifactFor = (taskId: string): string => `C:/out/${taskId}.mp4`;

const mediaInfo = (): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: 'chan', uploader_id: null, duration: 10,
  thumbnail: null, webpage_url: 'http://127.0.0.1:1/fixture.mp4', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4',
  formats: [{ format_id: '0', ext: 'mp4', width: 320, height: 240, vcodec: 'h264', acodec: 'aac', filesize: 1, filesize_approx: null, tbr: 1, fps: 25, format_note: null }],
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
  createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
  mediaInfo: null, request: request(taskId), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

interface EngineState {
  /** Kill attempts that fail (tree survives) before the first success. */
  failNextCancels: number;
  cancelAttempts: number;
  downloadCalls: number;
  active: number;
  /**
   * Settle the in-flight download manually — the zombie's exit, whenever the
   * test decides it happens. The real engine latches `canceled` at cancel()
   * ENTRY, so even a process that finishes its download reports `canceled`.
   */
  settle: ((outcome: 'canceled') => void) | null;
  /** A successful kill is confirmed but the close event has not fired yet. */
  deferCloseOnKill: boolean;
}

const newEngineState = (): EngineState => ({
  failNextCancels: 0, cancelAttempts: 0, downloadCalls: 0, active: 0,
  settle: null, deferCloseOnKill: false,
});

function fakeEngine(state: EngineState): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() {
      throw { code: 'UNKNOWN', message: 'x', detail: '', retryable: false, report: 'x' };
    },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      state.downloadCalls += 1;
      state.active += 1;
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; state.active -= 1; } };
      state.settle = (outcome: 'canceled') => {
        if (settled) return;
        if (outcome === 'canceled') onEvent({ type: 'canceled', taskId: req.taskId });
        finish();
      };
      return {
        pid: 4242,
        cancel: async (): Promise<boolean> => {
          state.cancelAttempts += 1;
          if (state.failNextCancels > 0) {
            state.failNextCancels -= 1;
            // D-142: the tree survived taskkill; the download keeps running
            // and NO terminal event is emitted (the process is still alive).
            return false;
          }
          // Kill confirmed. Like the real engine: the outcome event only
          // arrives once the process actually exits (`handle.done`).
          if (state.deferCloseOnKill) return true;
          state.settle?.('canceled');
          return true;
        },
      };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

const okVerifier = {
  async verify() {
    return {
      taskId: 'x', artifacts: [artifactFor('t1')], postprocessed: false,
      criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
      ok: true, failureCode: null, durationMs: 1,
    };
  },
};

function setup(options: { concurrency?: number; deferCloseOnKill?: boolean } = {}) {
  const mem = createInMemoryPorts();
  mem.state.files.set(artifactFor('t1'), 'video-bytes');
  mem.state.files.set(artifactFor('t2'), 'video-bytes');
  const engineState = newEngineState();
  engineState.deferCloseOnKill = options.deferCloseOnKill ?? false;
  const queue = new TaskQueue({
    ports: mem.ports, engine: fakeEngine(engineState), verifier: okVerifier,
    history: new HistoryStore({ ports: mem.ports }), jsRuntimePath: 'C:/runtime/node.exe',
    concurrency: options.concurrency,
  });
  const events: string[] = [];
  queue.onEvent((event) => {
    if (event.type === 'state-changed') events.push(`state:${event.from}->${event.to}`);
  });
  return { queue, engineState, events };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('D-142 · cancel() === false keeps the task honest and unstartable', () => {
  it('leaves the record non-terminal, the slot occupied and no error attached', async () => {
    const { queue, engineState, events } = setup();
    engineState.failNextCancels = 1;
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');

    expect(await queue.cancel('t1')).toBe(false);

    // NOT `Error`: the process is still alive and writing bytes.
    expect(queue.get('t1')?.state).toBe('Running');
    expect(queue.get('t1')?.error ?? null).toBeNull();
    expect(queue.activeTaskIds).toContain('t1');
    expect(events).not.toContain('state:Running->Error');
    // The download was started exactly once.
    expect(engineState.downloadCalls).toBe(1);
  });

  it('restart() refuses while the zombie holds the slot, and works after it exits', async () => {
    const { queue, engineState } = setup();
    engineState.failNextCancels = 1;
    await queue.enqueue(record('t1'));
    await tick();
    expect(await queue.cancel('t1')).toBe(false);

    await expect(queue.restart('t1')).rejects.toThrow(/still running/);
    // The refusal happened BEFORE any second run was started.
    expect(engineState.downloadCalls).toBe(1);

    // The zombie eventually dies → the queue self-heals and frees the slot.
    engineState.settle?.('canceled');
    await tick();
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(queue.activeTaskIds).not.toContain('t1');

    // Only NOW is a retry legitimate — and it starts exactly one new run.
    await queue.restart('t1');
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    expect(engineState.downloadCalls).toBe(2);
  });

  it('remove() refuses while the zombie holds the slot, and works after it exits', async () => {
    const { queue, engineState } = setup();
    engineState.failNextCancels = 1;
    await queue.enqueue(record('t1'));
    await tick();
    expect(await queue.cancel('t1')).toBe(false);
    expect(await queue.remove('t1')).toBe(false);
    expect(queue.get('t1')).toBeDefined();

    engineState.settle?.('canceled');
    await tick();
    expect(await queue.remove('t1')).toBe(true);
    expect(queue.get('t1')).toBeUndefined();
  });

  it('a later cancel attempt may still succeed (kill retry), then the record settles', async () => {
    const { queue, engineState } = setup();
    engineState.failNextCancels = 1;
    await queue.enqueue(record('t1'));
    await tick();

    expect(await queue.cancel('t1')).toBe(false);
    expect(queue.get('t1')?.state).toBe('Running');
    expect(engineState.cancelAttempts).toBe(1);

    expect(await queue.cancel('t1')).toBe(true);
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(engineState.cancelAttempts).toBe(2);
    await tick();
    expect(queue.activeTaskIds).not.toContain('t1');
  });

  it('a zombie slot keeps blocking the FIFO: no second download for the same id, no start for queued tasks', async () => {
    const { queue, engineState } = setup({ concurrency: 1 });
    engineState.failNextCancels = 1;
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');

    await queue.enqueue(record('t2'));
    await tick();
    // concurrency 1: t2 must wait for t1's slot.
    expect(queue.pendingCount).toBe(1);
    expect(engineState.downloadCalls).toBe(1);

    expect(await queue.cancel('t1')).toBe(false);
    await tick();
    // The zombie still owns the only slot; t2 stays parked, t1 was not restarted.
    expect(queue.pendingCount).toBe(1);
    expect(engineState.downloadCalls).toBe(1);
    expect(queue.get('t1')?.state).toBe('Running');

    engineState.settle?.('canceled');
    await tick();
    expect(queue.get('t1')?.state).toBe('Canceled');
    // The freed slot immediately flows to the FIFO.
    expect(queue.get('t2')?.state).toBe('Running');
    expect(engineState.downloadCalls).toBe(2);
  });

  it('restart() is refused in the window between a successful kill and the close event', async () => {
    const { queue, engineState } = setup({ deferCloseOnKill: true });
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');

    // Kill confirmed, but the engine's close event has not settled the run yet.
    expect(await queue.cancel('t1')).toBe(true);
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(queue.activeTaskIds).toContain('t1');

    await expect(queue.restart('t1')).rejects.toThrow(/still running/);
    expect(engineState.downloadCalls).toBe(1);

    // The close event lands; the run settles without pinning a junk error on
    // the record (no `Canceled -> Canceled` re-transition).
    engineState.settle?.('canceled');
    await tick();
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(queue.get('t1')?.error ?? null).toBeNull();
    expect(queue.activeTaskIds).not.toContain('t1');

    await queue.restart('t1');
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    expect(engineState.downloadCalls).toBe(2);
  });

  it('a stale FIFO entry for an already-running id is dropped, never started twice', async () => {
    // Entry-point guards make this unreachable in production (single ids are
    // timestamp+seq unique); the pump() invariant is the last line of defence
    // and is pinned here directly.
    const { queue, engineState } = setup({ concurrency: 2 });
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');

    await queue.enqueue(record('t1')); // same id re-parked while running
    await tick();
    expect(engineState.downloadCalls).toBe(1);
    expect(queue.pendingCount).toBe(0);
  });
});
