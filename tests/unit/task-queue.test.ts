/**
 * A-M2-01 / A-4.4-13 / A-4.4-14 · state machine + serial TaskQueue.
 * Exhaustively walks all 49 state pairs (13 legal, 36 rejected).
 */
import { describe, it, expect } from 'vitest';
import {
  canTransition, assertTransition, allTransitions, TASK_STATES,
  LEGAL_TRANSITIONS, IllegalTaskTransitionError, TaskQueue, HistoryStore, TaskStore,
} from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, HistoryEntry, MediaInfo, TaskRecord,
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
            artifacts: [{ taskId: req.taskId, path: artifactFor(req.taskId), kind: 'video', sizeBytes: 10 }],
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

function setup(behaviour: Behaviour, verifyOk = true) {
  const mem = createInMemoryPorts();
  mem.state.files.set(PRIMARY, 'video-bytes');
  mem.state.files.set(artifactFor('t1'), 'video-bytes');
  const engineState = newEngineState(behaviour);
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
    const { mem, queue } = setupFailingStore();
    await queue.enqueue(record('t1'));
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
    expect(queue.get('t1')?.state).toBe('Completed');
    expect(warnings(mem)).toHaveLength(0);

    setFail(true);
    await queue.enqueue(record('t2'));
    await tick();
    expect(queue.get('t2')?.state).toBe('Completed');
    expect(warnings(mem)).toHaveLength(1);
  });
});
