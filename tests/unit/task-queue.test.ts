/**
 * A-M2-01 / A-4.4-13 / A-4.4-14 · state machine + serial TaskQueue.
 * Exhaustively walks all 49 state pairs (13 legal, 36 rejected).
 */
import { describe, it, expect } from 'vitest';
import {
  canTransition, assertTransition, allTransitions, TASK_STATES,
  LEGAL_TRANSITIONS, IllegalTaskTransitionError, TaskQueue, HistoryStore, TaskStore,
  purgePrivateRecords, shouldPurgeOnPrivateClose,
} from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, HistoryEntry, HistoryQuery, MediaInfo, TaskRecord,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const PRIMARY = 'C:/out/Title [id].mp4';
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

const record = (taskId: string, privateMode = false): TaskRecord => ({
  id: taskId, url: 'https://example.org/v', kind: 'video', state: 'Idle',
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: request(taskId), artifacts: [], lastPercent: null,
  error: null, privateMode, postprocessed: false,
});

type Behaviour = 'completed' | 'failed' | 'hang' | 'probe-fail';

interface EngineState {
  behaviour: Behaviour;
  probeCalls: number;
  downloadCalls: number;
  active: number;
  maxActive: number;
  /** D-101: the request the engine was actually handed (output template etc.). */
  lastRequest: DownloadRequest | null;
  /**
   * On-disk size the fake engine reports for its completed artifact
   * (default 10). `null` simulates "engine could not stat the file".
   */
  completedSizeBytes?: number | null;
}

const newEngineState = (behaviour: Behaviour): EngineState => ({
  behaviour, probeCalls: 0, downloadCalls: 0, active: 0, maxActive: 0, lastRequest: null,
});

function fakeEngine(state: EngineState): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() {
      state.probeCalls += 1;
      if (state.behaviour === 'probe-fail') {
        throw { code: 'UNSUPPORTED_SITE', message: 'no', detail: '', retryable: false, report: 'x' };
      }
      return mediaInfo();
    },
    async probePlaylist() {
      throw { code: 'UNKNOWN', message: 'x', detail: '', retryable: false, report: 'x' };
    },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      state.downloadCalls += 1;
      state.lastRequest = req;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; state.active -= 1; } };
      const behaviour = state.behaviour;
      const handle = {
        pid: 4242,
        cancel: async () => {
          if (!settled) onEvent({ type: 'canceled', taskId: req.taskId });
          finish();
          return true;
        },
      };
      queueMicrotask(() => {
        if (settled) return;
        onEvent({
          type: 'progress', taskId: req.taskId, percent: 50, downloadedBytes: 5,
          totalBytes: 10, speedBps: 1, etaSec: 1, rawLine: 'YTVDLT|...',
        });
        if (behaviour === 'completed') {
          onEvent({
            type: 'completed', taskId: req.taskId,
            artifacts: [{
              taskId: req.taskId, path: artifactFor(req.taskId), kind: 'video',
              sizeBytes: state.completedSizeBytes === undefined ? 10 : state.completedSizeBytes,
            }],
          });
          finish();
        } else if (behaviour === 'failed') {
          onEvent({
            type: 'failed', taskId: req.taskId,
            error: { code: 'HTTP_403', message: 'no', detail: '', retryable: false, report: 'x' },
          });
          finish();
        }
      });
      return handle;
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

const okVerifier = (ok = true) => ({
  async verify() {
    return {
      taskId: 'x', artifacts: [PRIMARY], postprocessed: false,
      criteria: ok
        ? [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }]
        : [{ id: 'C1' as const, status: 'FAIL' as const, detail: 'bad' }],
      ok, failureCode: ok ? null : ('ARTIFACT_INCOMPLETE' as const), durationMs: 1,
    };
  },
});

function setup(behaviour: Behaviour, verifyOk = true, engineOverrides: Partial<EngineState> = {}) {
  const mem = createInMemoryPorts();
  mem.state.files.set(PRIMARY, 'video-bytes');
  mem.state.files.set(artifactFor('t1'), 'video-bytes');
  const engineState = { ...newEngineState(behaviour), ...engineOverrides };
  const history = new HistoryStore({ ports: mem.ports });
  const queue = new TaskQueue({
    ports: mem.ports, engine: fakeEngine(engineState), verifier: okVerifier(verifyOk),
    history, jsRuntimePath: 'C:/runtime/node.exe',
  });
  const events: string[] = [];
  queue.onEvent((event) => events.push(
    event.type === 'state-changed'
      ? `state:${event.from}->${event.to}`
      // D-115: the stage VALUE matters (a bare 'stage' would pass even if the
      // queue announced the wrong phase), so it is part of the recorded label.
      : event.type === 'stage' ? `stage:${event.stage}` : event.type,
  ));
  return { mem, queue, history, events, engineState };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('A-M2-01 state machine · exhaustive 7×7 walk', () => {
  it('has exactly 13 legal transitions and rejects the other 36', () => {
    const pairs = allTransitions();
    expect(pairs).toHaveLength(49);
    const legal = pairs.filter(([from, to]) => canTransition(from, to));
    const illegal = pairs.filter(([from, to]) => !canTransition(from, to));
    expect(legal).toHaveLength(13);
    expect(illegal).toHaveLength(36);
    expect(legal.map(([f, t]) => `${f}->${t}`).sort())
      .toEqual(LEGAL_TRANSITIONS.map(([f, t]) => `${f}->${t}`).sort());
  });

  it('assertTransition throws IllegalTaskTransitionError carrying from/to', () => {
    for (const [from, to] of allTransitions()) {
      if (canTransition(from, to)) {
        expect(() => assertTransition(from, to)).not.toThrow();
      } else {
        try {
          assertTransition(from, to);
          expect.unreachable(`${from}->${to} must throw`);
        } catch (error) {
          expect(error).toBeInstanceOf(IllegalTaskTransitionError);
          expect((error as IllegalTaskTransitionError).from).toBe(from);
          expect((error as IllegalTaskTransitionError).to).toBe(to);
        }
      }
    }
  });

  it('Completed is terminal — no outbound transition is legal', () => {
    for (const to of TASK_STATES) expect(canTransition('Completed', to)).toBe(false);
  });
});

describe('A-M2-01 TaskQueue · happy path', () => {
  it('walks Idle→FetchingInfo→ReadyWithInfo→Running→Completed and writes history', async () => {
    const { queue, events, history } = setup('completed');
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    expect(events).toEqual([
      'state:Idle->FetchingInfo',
      'state:FetchingInfo->ReadyWithInfo',
      'state:ReadyWithInfo->Running',
      'progress',
      'completed',
      // D-115: verification runs AFTER the engine exited and BEFORE the record
      // becomes `Completed`; the queue announces that window so the card can
      // show "finalizing" instead of a frozen 100%.
      'stage:verifying',
      'state:Running->Completed',
    ]);
    const entries = await history.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.videoPath).toBe(artifactFor('t1'));
    expect(entries[0]?.sizeBytes).toBe(10);
  });
});

describe('history sizeBytes · 完成任务的实测产物大小，未知保持 0', () => {
  it('一个非默认尺寸也如实落史（340 MiB 级别不被抹平）', async () => {
    const { queue, history } = setup('completed', true, { completedSizeBytes: 356_515_840 });
    await queue.enqueue(record('t1'));
    await tick();

    const entries = await history.query({});
    expect(entries[0]?.sizeBytes).toBe(356_515_840);
  });

  it('引擎无法 stat（sizeBytes: null）时保持 0 = 未知，不编造数字（D-107 精神）', async () => {
    const { queue, history } = setup('completed', true, { completedSizeBytes: null });
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    const entries = await history.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sizeBytes).toBe(0);
  });

  it('进度流里的 lastTotalBytes 不参与历史尺寸（合并场景它是最后一条流的量）', async () => {
    // The fake engine reports progress totalBytes: 10 (the "stream") while the
    // artifact measures 356 MiB ("the merged product"). The history must pin
    // the product's measured size, not the per-stream progress total.
    const { queue, history } = setup('completed', true, { completedSizeBytes: 356_515_840 });
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.lastTotalBytes).toBe(10);
    const entries = await history.query({});
    expect(entries[0]?.sizeBytes).toBe(356_515_840);
    expect(entries[0]?.sizeBytes).not.toBe(queue.get('t1')?.lastTotalBytes);
  });
});

describe('C12 · verification failure never completes or writes history', () => {
  it('goes Running→Error and leaves history empty when verify() fails', async () => {
    const { queue, history, events } = setup('completed', false);
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(queue.get('t1')?.error?.code).toBe('ARTIFACT_INCOMPLETE');
    expect(events).not.toContain('state:Running->Completed');
    expect(await history.query({})).toHaveLength(0);
  });

  it('goes to Error when the engine reports failure (no history)', async () => {
    const { queue, history } = setup('failed');
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(await history.query({})).toHaveLength(0);
  });

  it('goes to Error when the probe fails', async () => {
    const { queue } = setup('probe-fail');
    await queue.enqueue(record('t1'));
    expect(queue.get('t1')?.state).toBe('Error');
  });
});

describe('A-4.4-13 / A-4.4-14 · cancel and restart', () => {
  it('cancel() → Canceled with lastPercent preserved, no history', async () => {
    const { queue, history } = setup('hang');
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    expect(await queue.cancel('t1')).toBe(true);
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(queue.get('t1')?.lastPercent).toBe(50);
    expect(await history.query({})).toHaveLength(0);
  });

  it('enqueued with a pre-probed mediaInfo: no probe, still walks the two legal info edges', async () => {
    // Stage 3: a spent subtitle-preview ticket hands the queue a MediaInfo.
    // `enqueue()` stores `Idle`, and the machine has no `Idle -> Running` edge,
    // so the run must pass through FetchingInfo -> ReadyWithInfo WITHOUT spawning.
    const { queue, events, engineState } = setup('completed');
    const probesBefore = engineState.probeCalls;
    await queue.enqueue({ ...record('t9'), mediaInfo: mediaInfo() });
    await tick();

    expect(engineState.probeCalls).toBe(probesBefore);
    expect(events).toContain('state:Idle->FetchingInfo');
    expect(events).toContain('state:FetchingInfo->ReadyWithInfo');
    expect(queue.get('t9')?.state).toBe('Completed');
  });

  it('restart() from Canceled skips re-probing (cached mediaInfo) and completes', async () => {
    const { queue, history, engineState } = setup('hang');
    await queue.enqueue(record('t1'));
    await tick();
    await queue.cancel('t1');
    expect(queue.get('t1')?.state).toBe('Canceled');
    const probesBefore = engineState.probeCalls;

    engineState.behaviour = 'completed';
    await queue.restart('t1');
    await tick();

    expect(engineState.probeCalls).toBe(probesBefore); // mediaInfo was cached
    expect(queue.get('t1')?.state).toBe('Completed');
    expect(await history.query({})).toHaveLength(1);
  });

  it('restart() from Error without mediaInfo goes back to Idle and re-probes', async () => {
    const { queue, engineState } = setup('probe-fail');
    await queue.enqueue(record('t1'));
    expect(queue.get('t1')?.state).toBe('Error');
    const probesBefore = engineState.probeCalls;

    engineState.behaviour = 'completed';
    await queue.restart('t1');
    await tick();

    expect(engineState.probeCalls).toBeGreaterThan(probesBefore);
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  // D-107: a retry is a NEW run. The previous attempt's numbers must not be
  // presented as this run's progress while the new process is still starting.
  it('restart() clears the previous run’s progress (cancel keeps it)', async () => {
    const { queue } = setup('hang');
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.lastPercent).toBe(50);

    await queue.cancel('t1');
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(queue.get('t1')?.lastPercent).toBe(50);

    // Read the record exactly when the new run announces `Running`: that is the
    // window the card renders, and it must not carry the old percentage.
    let atRunning: TaskRecord | undefined;
    const off = queue.onEvent((event) => {
      if (event.type === 'state-changed' && event.to === 'Running') atRunning = queue.get('t1');
    });
    await queue.restart('t1');
    await tick();
    off();

    expect(atRunning?.state).toBe('Running');
    expect(atRunning?.lastPercent).toBeNull();
    expect(atRunning?.lastDownloadedBytes ?? null).toBeNull();
    expect(atRunning?.lastTotalBytes ?? null).toBeNull();
    expect(atRunning?.lastSpeedBps ?? null).toBeNull();
    expect(atRunning?.lastEtaSec ?? null).toBeNull();
    // ... and the new run still reports its own progress normally.
    expect(queue.get('t1')?.lastPercent).toBe(50);
  });

  it('cancel() on an unknown task returns false', async () => {
    const { queue } = setup('completed');
    expect(await queue.cancel('nope')).toBe(false);
  });

  it('restart() rejects an illegal source state (Completed is terminal)', async () => {
    const { queue } = setup('completed');
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Completed');
    await expect(queue.restart('t1')).rejects.toBeInstanceOf(IllegalTaskTransitionError);
  });
});

// D-199: restart() of a restored record used to throw
// `IllegalTaskTransitionError` — a restored `Idle` / `ReadyWithInfo` record
// already sits ON the recomputed target state and the machine has no self-loop
// edges. The UI gate (`isRestartable`) only covers Error/Canceled, but the IPC
// `TASK_ACTION restart` path reaches `restart()` directly.
describe('D-199 · restart() of restored Idle / ReadyWithInfo records', () => {
  const snapshotOf = (task: TaskRecord) => ({
    schemaVersion: 1 as const,
    savedAt: '2026-11-05T00:00:00.000Z',
    tasks: [task],
  });

  it('a restored Idle record ("queued, not started") restarts into a full run', async () => {
    const { queue, engineState } = setup('completed');
    await queue.restore(snapshotOf(record('t1')));
    expect(queue.get('t1')?.state).toBe('Idle');

    await queue.restart('t1');
    await tick();

    expect(engineState.probeCalls).toBe(1);
    expect(engineState.downloadCalls).toBe(1);
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  it('a restored ReadyWithInfo record restarts without re-probing (cached mediaInfo)', async () => {
    const { queue, engineState } = setup('completed');
    await queue.restore(snapshotOf({ ...record('t1'), state: 'ReadyWithInfo', mediaInfo: mediaInfo() }));
    const probesBefore = engineState.probeCalls;

    await queue.restart('t1');
    await tick();

    expect(engineState.probeCalls).toBe(probesBefore);
    expect(engineState.downloadCalls).toBe(1);
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  it('a restored Idle record carrying a pre-probed mediaInfo walks the two legal info edges', async () => {
    // No `Idle -> ReadyWithInfo` edge exists, so restart() must use the same
    // two-edge walk `run()` uses for pre-probed records.
    const { queue, engineState, events } = setup('completed');
    await queue.restore(snapshotOf({ ...record('t1'), mediaInfo: mediaInfo() }));
    const probesBefore = engineState.probeCalls;

    await queue.restart('t1');
    await tick();

    expect(engineState.probeCalls).toBe(probesBefore);
    expect(events).toContain('state:Idle->FetchingInfo');
    expect(events).toContain('state:FetchingInfo->ReadyWithInfo');
    expect(queue.get('t1')?.state).toBe('Completed');
  });
});

describe('A-M2-01 · serial execution (concurrency:1 keeps M2 semantics)', () => {
  it('never runs two downloads at once when three tasks are enqueued', async () => {
    const mem = createInMemoryPorts();
    for (const id of ['t1', 't2', 't3']) mem.state.files.set(artifactFor(id), 'video-bytes');
    const engineState = newEngineState('completed');
    const history = new HistoryStore({ ports: mem.ports });
    const queue = new TaskQueue({
      ports: mem.ports, engine: fakeEngine(engineState), verifier: okVerifier(true),
      history, jsRuntimePath: 'C:/runtime/node.exe',
      // M4-2: the default is now 3; the M2 serial contract is pinned explicitly.
      concurrency: 1,
    });
    void queue.enqueue(record('t1'));
    void queue.enqueue(record('t2'));
    void queue.enqueue(record('t3', true));
    await tick(120);

    expect(engineState.maxActive).toBe(1);
    expect(engineState.downloadCalls).toBe(3);
    for (const id of ['t1', 't2', 't3']) expect(queue.get(id)?.state).toBe('Completed');
  });

  it('private mode completes the task but does NOT write history', async () => {
    const { queue, history } = setup('completed');
    await queue.enqueue(record('t9', true));
    await tick();
    expect(queue.get('t9')?.state).toBe('Completed');
    expect(await history.query({})).toHaveLength(0);
  });

  it('exposes list() and get() as copies (no external mutation)', async () => {
    const { queue } = setup('completed');
    await queue.enqueue(record('t1'));
    await tick();
    const snapshot = queue.get('t1');
    if (snapshot !== undefined) snapshot.state = 'Idle';
    expect(queue.get('t1')?.state).toBe('Completed');
    expect(queue.list()).toHaveLength(1);
  });
});

// M3 B3 append-only (C11 / D-28 / D-42).
describe('M3 C11 · verify() receives a real historyEntry (C12 ordering preserved)', () => {
  it('backfills historyEntry with taskId + videoPath and still writes history only after verify.ok', async () => {
    const mem = createInMemoryPorts();
    mem.state.files.set(artifactFor('t1'), 'video-bytes');
    const engineState = newEngineState('completed');
    const seen: Array<{ historyEntry: unknown; artifacts: readonly string[] }> = [];
    const verifier = {
      async verify(input: { historyEntry: unknown; artifacts: readonly string[] }) {
        seen.push({ historyEntry: input.historyEntry, artifacts: input.artifacts });
        return {
          taskId: 'x', artifacts: [PRIMARY], postprocessed: false,
          criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
          ok: true, failureCode: null, durationMs: 1,
        };
      },
    };
    const history = new HistoryStore({ ports: mem.ports });
    const queue = new TaskQueue({
      ports: mem.ports, engine: fakeEngine(engineState), verifier,
      history, jsRuntimePath: 'C:/runtime/node.exe',
    });
    await queue.enqueue(record('t1'));
    await tick();

    expect(seen).toHaveLength(1);
    const entry = seen[0]?.historyEntry as Record<string, unknown> | null | undefined;
    expect(entry === null || entry === undefined).toBe(false);
    expect(entry?.['taskId']).toBe('t1');
    expect(entry?.['videoPath']).toBe(artifactFor('t1'));
    expect(entry?.['sizeBytes']).toBe(10);
    expect(queue.get('t1')?.state).toBe('Completed');
    expect(await history.query({})).toHaveLength(1);
  });

  it('verification failure still leaves history empty (C12 not regressed)', async () => {
    const mem = createInMemoryPorts();
    mem.state.files.set(artifactFor('t1'), 'video-bytes');
    const engineState = newEngineState('completed');
    const verifier = {
      async verify() {
        return {
          taskId: 'x', artifacts: [PRIMARY], postprocessed: false,
          criteria: [{ id: 'C1' as const, status: 'FAIL' as const, detail: 'bad' }],
          ok: false, failureCode: 'ARTIFACT_INCOMPLETE' as const, durationMs: 1,
        };
      },
    };
    const history = new HistoryStore({ ports: mem.ports });
    const queue = new TaskQueue({
      ports: mem.ports, engine: fakeEngine(engineState), verifier,
      history, jsRuntimePath: 'C:/runtime/node.exe',
    });
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(await history.query({})).toHaveLength(0);
  });
});

describe('D-101 · 重复下载：给出独立文件名，而不是报错', () => {
    /** The production template carries [%(id)s]; the default test one does not. */
  const recordWithIdTemplate = (taskId: string): TaskRecord => {
    const base = record(taskId);
    const req = base.request;
    if (req === null) return base;
    return { ...base, request: { ...req, paths: { ...req.paths, outputTemplate: '%(title)s [%(id)s].%(ext)s' } } };
  };

  const historyEntry = (videoPath: string): HistoryEntry => ({
    id: 'old-task', taskId: 'old-task', url: 'https://example.org/v', title: 'fixture',
    uploader: null, durationSec: 10, videoPath, audioPath: null, thumbnailPath: null,
    subtitlePaths: [], sizeBytes: 10, extractorKey: 'generic', downloadType: 'video',
    formatId: null, createdAt: '2026-11-05T00:00:00.000Z', completedAt: '2026-11-05T00:00:00.000Z',
  });

  it('第一次下载不加后缀（目录里没有同名产物）', async () => {
    const { queue, engineState } = setup('completed');
    await queue.enqueue(recordWithIdTemplate('t1'));
    await tick();
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s [%(id)s].%(ext)s');
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  it('同名产物已在目录里时，第二次下载自动变成 (1)', async () => {
    const { mem, queue, engineState } = setup('completed');
    mem.state.files.set('C:/out/Title [fixture].mp4', 'old-bytes');
    await queue.enqueue(recordWithIdTemplate('t1'));
    await tick();
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s [%(id)s]_(1).%(ext)s');
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  it('(1) 已存在时继续递增到 (2)', async () => {
    const { mem, queue, engineState } = setup('completed');
    mem.state.files.set('C:/out/Title [fixture].mp4', 'old');
    mem.state.files.set('C:/out/Title [fixture] (1).mp4', 'old-1');
    await queue.enqueue(recordWithIdTemplate('t1'));
    await tick();
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s [%(id)s]_(2).%(ext)s');
  });

  it('历史里已有同一产物时判完成，不再报 ALREADY_DOWNLOADED', async () => {
    const { queue, history, engineState } = setup('completed');
    await history.add(historyEntry('C:/out/t1.mp4'));
    await queue.enqueue(record('t1'));
    await tick();
    const finished = queue.get('t1');
    expect(finished?.state).toBe('Completed');
    expect(finished?.error).toBeNull();
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s.%(ext)s');
  });

  it('D-237 · 并发孪生对 readdir 不可见时也拿到独立名字（A 运行中，B 拿 (1)）', async () => {
    // A hangs and holds the base-name claim; B starts while A is still
    // running. A's partials live in its own tempDir (D-118), so readdir
    // alone sees nothing — the in-memory claim is what B must see. This is
    // the audited P2-1 window: default concurrency 3 sent two processes at
    // the SAME final file name.
    const { queue, engineState } = setup('hang');
    await queue.enqueue(recordWithIdTemplate('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s [%(id)s].%(ext)s');

    await queue.enqueue(recordWithIdTemplate('t2'));
    await tick();
    expect(queue.get('t2')?.state).toBe('Running');
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s [%(id)s]_(1).%(ext)s');
    // Both downloads were genuinely in flight at the same time.
    expect(engineState.active).toBe(2);
    await queue.cancel('t1');
    await queue.cancel('t2');
    await tick();
  });

  it('D-237 · 三个并发副本按序取基础名 (1) (2)', async () => {
    const { queue, engineState } = setup('hang');
    const templates: string[] = [];
    for (const id of ['t1', 't2', 't3']) {
      await queue.enqueue(recordWithIdTemplate(id));
      await tick();
      templates.push(engineState.lastRequest?.paths.outputTemplate ?? '');
    }
    expect(templates).toEqual([
      '%(title)s [%(id)s].%(ext)s',
      '%(title)s [%(id)s]_(1).%(ext)s',
      '%(title)s [%(id)s]_(2).%(ext)s',
    ]);
    for (const id of ['t1', 't2', 't3']) await queue.cancel(id);
    await tick();
  });

  it('D-237 · 运行结束释放预留：A 取消后，B 重新拿基础名', async () => {
    const { queue, engineState } = setup('hang');
    await queue.enqueue(recordWithIdTemplate('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    await queue.cancel('t1');
    await tick();
    expect(queue.get('t1')?.state).toBe('Canceled');

    await queue.enqueue(recordWithIdTemplate('t2'));
    await tick();
    // No claim (released in run()'s finally) and no `[id]` file on disk —
    // the base name is free again.
    expect(engineState.lastRequest?.paths.outputTemplate).toBe('%(title)s [%(id)s].%(ext)s');
    await queue.cancel('t2');
    await tick();
  });
});

// --- T2 · persistSnapshot failure is visible, never fatal -------------------

describe('T2 · persistSnapshot failure is visible but never fatal', () => {
  /**
   * Queue wired to a TaskStore whose `tasks.json` write fails while `fail` is
   * set. ONLY the snapshot path is sabotaged: history/config writes keep
   * working, so the task itself completes and the test isolates exactly the
   * persist-failure visibility being pinned.
   */
  const setupFailingStore = () => {
    const mem = createInMemoryPorts();
    mem.state.files.set(PRIMARY, 'video-bytes');
    mem.state.files.set(artifactFor('t1'), 'video-bytes');
    mem.state.files.set(artifactFor('t2'), 'video-bytes');
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    let fail = true;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail && path.endsWith('tasks.json')) {
        throw new Error('simulated snapshot write failure');
      }
      await inner(path, text);
    };
    const engineState = newEngineState('completed');
    const queue = new TaskQueue({
      ports: mem.ports, engine: fakeEngine(engineState), verifier: okVerifier(),
      history: new HistoryStore({ ports: mem.ports }), taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe', persistIntervalMs: 0,
    });
    return { mem, queue, setFail: (value: boolean) => { fail = value; } };
  };

  const warnings = (mem: ReturnType<typeof createInMemoryPorts>): string[] =>
    mem.state.logLines.filter((line) => line.includes('snapshot.persist.failed'));

  it('a completed download survives a failing store and emits exactly ONE warning', async () => {
    const { mem, queue, setFail } = setupFailingStore();
    // D-242: intake itself now reports a failed write, so the store works when
    // the task enters the queue and "fills up" while the download runs — that
    // is the shape this test is about (a broken disk must never turn a
    // finished download into a failed one).
    setFail(false);
    await queue.enqueue(record('t1'));
    setFail(true);
    await tick();

    // The download path is untouched by the persistence failure.
    const finished = queue.get('t1');
    expect(finished?.state).toBe('Completed');
    expect(finished?.error).toBeNull();
    // ONE warning per failure episode — not one per persist attempt
    // (persistIntervalMs: 0 makes the progress tick + the final finally both
    // persist; only the first failure may log).
    expect(warnings(mem)).toHaveLength(1);
    const line = JSON.parse(warnings(mem)[0] as string) as {
      ts: string; level: string; scope: string; event: string; payload: { error: string };
    };
    expect(line.level).toBe('WARNING');
    expect(line.scope).toBe('task-queue');
    expect(line.event).toBe('snapshot.persist.failed');
    expect(line.payload.error).toContain('simulated snapshot write failure');
  });

  it('a successful save resets the episode, so the NEXT failure warns again', async () => {
    const { mem, queue, setFail } = setupFailingStore();
    setFail(false);
    await queue.enqueue(record('t1'));
    await tick();
    expect(warnings(mem)).toHaveLength(0);

    // D-242: a failed intake is now REPORTED (it used to return normally).
    setFail(true);
    await expect(queue.enqueue(record('t2'))).rejects.toThrow(/快照未能写入磁盘/);
    await tick();
    expect(warnings(mem)).toHaveLength(1);

    // A later successful write ends the episode...
    setFail(false);
    await queue.enqueue(record('t3'));
    await tick();
    // ...so the next failure warns again instead of being folded into the old one.
    setFail(true);
    await expect(queue.enqueue(record('t4'))).rejects.toThrow(/快照未能写入磁盘/);
    expect(warnings(mem)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Audit fix (D-218 复核) · "错误设置发生在快照之后" — a run whose EXCEPTION is
// pinned by `runSafely` must reach the PERSISTED snapshot. Old sequencing:
// `run()`'s `finally` (persistSnapshot + pump) executed BEFORE the exception
// arrived in `runSafely`'s catch, so tasks.json still carried the pre-error
// record (Running, no error) and the pinned detail was lost on restart.
// `transition()` never persists (it only mutates + emits), so `runSafely` now
// re-persists once AFTER the error and terminal state are final.
// ---------------------------------------------------------------------------
describe('audit · an error pinned by runSafely reaches the persisted snapshot', () => {
  it('a throwing history.add() lands the task as Error and the error IS in tasks.json', async () => {
    const mem = createInMemoryPorts();
    mem.state.files.set(PRIMARY, 'video-bytes');
    mem.state.files.set(artifactFor('t1'), 'video-bytes');
    const engineState = newEngineState('completed');
    const history = new HistoryStore({ ports: mem.ports });
    // Gate fake: `add` throws while the flag is set, everything else delegates.
    let failAdd = false;
    const gatedHistory = {
      init: (): Promise<void> => history.init(),
      add: async (entry: HistoryEntry, opts?: { privateMode?: boolean }) => {
        if (failAdd) throw new Error('simulated history failure');
        return history.add(entry, opts);
      },
      query: (q: HistoryQuery) => history.query(q),
      get: (id: string) => history.get(id),
      remove: (id: string) => history.remove(id),
      exportJson: (): Promise<string> => history.exportJson(),
      importJson: (json: string): Promise<number> => history.importJson(json),
    };
    const queue = new TaskQueue({
      ports: mem.ports, engine: fakeEngine(engineState), verifier: okVerifier(),
      history: gatedHistory, jsRuntimePath: 'C:/runtime/node.exe',
      // Wire a store so the snapshot actually lands in the in-memory "disk".
      taskStore: new TaskStore({ ports: mem.ports }),
    });

    failAdd = true;
    await queue.enqueue(record('t1'));
    await tick();

    // The in-memory record carries the pinned error...
    const task = queue.get('t1');
    expect(task?.state).toBe('Error');
    expect(task?.error).not.toBeNull();
    expect(task?.error?.detail).toContain('simulated history failure');

    // ...and so does the PERSISTED tasks.json (the restart-survivable copy).
    const raw = mem.state.files.get(`${mem.ports.env.configDir()}/tasks.json`);
    expect(raw).toBeDefined();
    const persisted = JSON.parse(raw as string) as {
      tasks: Array<{ id: string; state: string; error: { detail: string } | null }>;
    };
    const persistedTask = persisted.tasks.find((candidate) => candidate.id === 't1');
    expect(persistedTask?.state).toBe('Error');
    expect(persistedTask?.error).not.toBeNull();
    expect(persistedTask?.error?.detail).toContain('simulated history failure');
  });
});

// ---------------------------------------------------------------------------
// D-209 · "取消即终态、不写历史" beyond the verification window: the two
// completion awaits AFTER verify().ok must honour the same contract.
//
//   窗口 A — the embedded-subtitle cleanup await (D-131 recycle hook): a
//            cancel landing there used to fall through into
//            buildHistoryEntry + history.add().
//   窗口 B — the history.add() await itself: the store appends the entry to
//            its in-memory list BEFORE the persist resolves, so the row was
//            already written when the post-add cancel check returned. The
//            queue now compensates by removing exactly that row (without
//            deleteFile — a cancel never touches user files).
//
// Both tests park the run on a manually resolved promise gate (no sleeps —
// the race is deterministic), cancel while parked, release the gate and then
// assert: Canceled, empty history, slot released, no junk error. Vitest fails
// the run on unhandled rejections, which pins the "no unhandled rejection"
// half of the contract.
// ---------------------------------------------------------------------------
describe('D-209 · cancel during cleanup / history write leaves no history row', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  const SUB = 'C:/out/t1.en.srt';

  /** embed + keepSubtitleFile=false → the D-131 cleanup path really runs. */
  const embeddedRecord = (): TaskRecord => {
    const base = record('t1');
    const req = base.request;
    if (req === null) return base;
    return {
      ...base,
      request: {
        ...req,
        subtitle: {
          ...req.subtitle,
          enabled: true,
          languages: 'en.*',
          convertTo: 'srt',
          embed: true,
          keepSubtitleFile: false,
        },
      },
    };
  };

  /** Completed transfer; `killTree` answers true for an already-exited child. */
  const completedEngine = (artifactPaths: readonly string[]): DownloadEngine => ({
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() {
      throw { code: 'UNKNOWN', message: 'x', detail: '', retryable: false, report: 'x' };
    },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      queueMicrotask(() => onEvent({
        type: 'completed', taskId: req.taskId,
        artifacts: artifactPaths.map((path) => ({
          taskId: req.taskId, path, kind: 'video' as const, sizeBytes: 10,
        })),
      }));
      return { pid: 4242, cancel: async () => true };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  });

  it('窗口 A · a cancel during the embedded-subtitle cleanup stays Canceled and writes no history', async () => {
    const mem = createInMemoryPorts();
    mem.state.files.set(artifactFor('t1'), 'video-bytes');
    mem.state.files.set(SUB, 'srt-bytes');
    const history = new HistoryStore({ ports: mem.ports });
    const gate = deferred();
    const reachedCleanup = deferred();
    const recyclerCalls: Array<{ paths: readonly string[]; roots: readonly string[] }> = [];
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: completedEngine([artifactFor('t1'), SUB]),
      verifier: okVerifier(true),
      history,
      jsRuntimePath: 'C:/runtime/node.exe',
      // The gate parks the run exactly inside the D-209 cleanup window (the
      // same point the production recycler awaits TrashFilesPort.preflight).
      recycleSubtitleFiles: async (paths: readonly string[], roots: readonly string[]) => {
        recyclerCalls.push({ paths, roots });
        reachedCleanup.resolve();
        await gate.promise;
        return paths;
      },
    });

    await queue.enqueue(embeddedRecord());
    // Deterministic: the run is parked inside the cleanup await.
    await reachedCleanup.promise;
    expect(queue.get('t1')?.state).toBe('Running');
    // Sanity: cleanup really ran for exactly this task's own subtitle.
    expect(recyclerCalls).toHaveLength(1);
    expect(recyclerCalls[0]?.paths).toEqual([SUB]);
    expect(recyclerCalls[0]?.roots).toContain('c:/out');

    // The engine handle is still registered here, so cancel() answers true and
    // walks the legal Running -> Canceled edge while the run is parked.
    expect(await queue.cancel('t1')).toBe(true);
    expect(queue.get('t1')?.state).toBe('Canceled');

    gate.resolve();
    await tick();

    const task = queue.get('t1');
    expect(task?.state).toBe('Canceled');
    expect(task?.error ?? null).toBeNull();
    expect(queue.activeTaskIds).not.toContain('t1');
    // The old code fell through into buildHistoryEntry + history.add() here.
    expect(await history.query({})).toEqual([]);
  });

  it('窗口 B · a cancel during history.add() compensates: the already-written row is removed again', async () => {
    const { mem, queue, history } = setup('completed');
    const historyPath = `${mem.ports.env.configDir()}/history.json`;
    const gate = deferred();
    const reachedAdd = deferred();
    let gated = false;
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (!gated && path === historyPath) {
        // First history.json write = add()'s persist; park the store mid-write.
        // The compensation's own persist (later on the HistoryStore write
        // queue) passes through the `gated` flag.
        gated = true;
        reachedAdd.resolve();
        await gate.promise;
      }
      await inner(path, text);
    };

    await queue.enqueue(record('t1'));
    // Deterministic: history.add() has already appended the entry in memory
    // and is parked inside its persist write.
    await reachedAdd.promise;
    expect(queue.get('t1')?.state).toBe('Running');

    expect(await queue.cancel('t1')).toBe(true);
    expect(queue.get('t1')?.state).toBe('Canceled');

    gate.resolve();
    await tick();

    const task = queue.get('t1');
    expect(task?.state).toBe('Canceled');
    expect(task?.error ?? null).toBeNull();
    expect(queue.activeTaskIds).not.toContain('t1');
    // Compensation: the in-memory store is clean again...
    expect(await history.query({})).toEqual([]);
    // ...and the persisted history.json is clean too (remove() re-persisted).
    const raw = mem.state.files.get(historyPath);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({ schemaVersion: 1, entries: [] });
  });
});

/**
 * D-232 (audit P2) · 无痕关闭只清「无痕任务」，绝不带走既有普通记录。
 *
 * The old hook removed every non-running row whenever the switch was on. A user
 * who turned private mode on for one video and closed the window lost the
 * ordinary downloads they had been keeping — and that loss was not recoverable
 * (the row is gone from `tasks.json` too). The rule is now carried by the
 * RECORD (captured at enqueue, persisted in the snapshot), not by the switch
 * position at close time.
 */
describe('D-232 · 无痕清理的作用域', () => {
  const settled = (id: string, privateMode: boolean) => record(id, privateMode);

  it('rules: only settled private records are targets', () => {
    expect(shouldPurgeOnPrivateClose(settled('p1', true))).toBe(true);
    expect(shouldPurgeOnPrivateClose(settled('n1', false))).toBe(false);
    expect(shouldPurgeOnPrivateClose({ ...settled('p2', true), state: 'Running' })).toBe(false);
    expect(shouldPurgeOnPrivateClose({ ...settled('p3', true), state: 'FetchingInfo' })).toBe(false);
  });

  it('purges private rows, keeps normal rows and running private rows, forgets covers only for removed ids', async () => {
    const rows = [
      settled('priv-done', true),
      settled('normal-done', false),
      { ...settled('priv-running', true), state: 'Running' as const },
      { ...settled('priv-error', true), state: 'Error' as const },
    ];
    const removed: string[] = [];
    const forgotten: string[] = [];
    const report = await purgePrivateRecords(
      {
        list: () => rows,
        remove: async (taskId: string) => { removed.push(taskId); return true; },
      },
      (taskId) => forgotten.push(taskId),
    );

    expect(removed).toEqual(['priv-done', 'priv-error']);
    expect(report.removed).toEqual(['priv-done', 'priv-error']);
    expect(report.keptRunning).toEqual(['priv-running']);
    expect(removed).not.toContain('normal-done');
    expect(forgotten).toEqual(['priv-done', 'priv-error']);
  });

  it('a refused removal is not reported as purged (queue keeps its slot holder)', async () => {
    const rows = [settled('priv-a', true)];
    const report = await purgePrivateRecords({
      list: () => rows,
      remove: async () => false,
    });
    expect(report.removed).toEqual([]);
    expect(report.keptRunning).toEqual([]);
  });
});
