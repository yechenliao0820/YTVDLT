/**
 * A-M2-01 / A-4.4-13 / A-4.4-14 · state machine + serial TaskQueue.
 * Exhaustively walks all 49 state pairs (13 legal, 36 rejected).
 */
import { describe, it, expect } from 'vitest';
import {
  canTransition, assertTransition, allTransitions, TASK_STATES,
  LEGAL_TRANSITIONS, IllegalTaskTransitionError, TaskQueue, HistoryStore,
} from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord,
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
}

const newEngineState = (behaviour: Behaviour): EngineState => ({
  behaviour, probeCalls: 0, downloadCalls: 0, active: 0, maxActive: 0,
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
    event.type === 'state-changed' ? `state:${event.from}->${event.to}` : event.type,
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
