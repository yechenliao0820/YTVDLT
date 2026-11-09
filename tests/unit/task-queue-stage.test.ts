/**
 * D-115: the queue must translate yt-dlp's stage markers into a MONOTONIC
 * record field, and must announce `verifying` before it verifies.
 *
 * The case that motivates the monotonic rule: a video+audio pair downloads as
 * two streams, so the engine reports `downloading` again after the first one
 * finished. Without the guard, a card that had already said "merging" would
 * snap back to a numeric download bar for a frame.
 */
import { describe, it, expect } from 'vitest';
import { HistoryStore, TaskQueue } from '@ytvdlt/core';
import type {
  Artifact, DownloadEngine, DownloadRequest, EngineStage, HistoryEntry, MediaInfo, TaskRecord,
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
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: request(taskId), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

/**
 * Engine that replays a fixed stage sequence, then completes. Every stage is
 * also reported on a `stage` event exactly as the real engine does.
 */
function stagedEngine(stages: readonly EngineStage[]): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('unused'); },
    download(req: DownloadRequest, onEvent) {
      let settled = false;
      queueMicrotask(() => {
        if (settled) return;
        for (const stage of stages) onEvent({ type: 'stage', taskId: req.taskId, stage });
        onEvent({
          type: 'progress', taskId: req.taskId, percent: 100, downloadedBytes: 10,
          totalBytes: 10, speedBps: 1, etaSec: 0, rawLine: 'YTVDLT|...',
        });
        const artifact: Artifact = {
          taskId: req.taskId, path: artifactFor(req.taskId), kind: 'video', sizeBytes: 10,
        };
        onEvent({ type: 'completed', taskId: req.taskId, artifacts: [artifact] });
      });
      return {
        pid: 1,
        async cancel() { settled = true; return true; },
      };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

function harness(stages: readonly EngineStage[]) {
  const mem = createInMemoryPorts();
  mem.state.files.set(artifactFor('t1'), 'bytes');
  const history = new HistoryStore({ ports: mem.ports });
  const stagesSeen: string[] = [];
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: stagedEngine(stages),
    verifier: {
      async verify() {
        return {
          taskId: 't1', artifacts: [artifactFor('t1')], postprocessed: false,
          criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
          ok: true, failureCode: null, durationMs: 1,
        };
      },
    },
    history,
    jsRuntimePath: 'C:/runtime/node.exe',
    persistIntervalMs: 0,
  });
  queue.onEvent((event) => {
    if (event.type === 'stage') stagesSeen.push(event.stage);
  });
  return { queue, history, stagesSeen };
}

/** Same replay, but never settles — lets a test read the live record. */
function hangingStagedEngine(stages: readonly EngineStage[]): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('unused'); },
    download(req: DownloadRequest, onEvent) {
      let settled = false;
      queueMicrotask(() => {
        if (settled) return;
        for (const stage of stages) onEvent({ type: 'stage', taskId: req.taskId, stage });
      });
      return { pid: 2, async cancel() { settled = true; return true; } };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('D-115 stage propagation through the queue', () => {
  it('records the forward sequence and announces verifying before Completed', async () => {
    const { queue, stagesSeen } = harness(['downloading', 'merging', 'postprocess']);
    await queue.enqueue(record('t1'));
    await tick();

    const task = queue.get('t1');
    expect(task?.state).toBe('Completed');
    // reaching `postprocess` proves merging was not skipped
    expect(task?.lastStage).toBe('verifying');
    expect(stagesSeen).toEqual(['downloading', 'merging', 'postprocess', 'verifying']);
  });

  it('ignores a backward stage (second stream restarting at 0%)', async () => {
    // Real order for a video+audio pair: the audio pass re-enters `downloading`
    // right before the merge. The record must stay at `merging`, so the card
    // cannot snap back to a numeric download bar for a frame.
    const mem = createInMemoryPorts();
    const history = new HistoryStore({ ports: mem.ports });
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: hangingStagedEngine(['downloading', 'merging', 'downloading']),
      verifier: {
        async verify() {
          return {
            taskId: 't1', artifacts: [], postprocessed: false,
            criteria: [], ok: true, failureCode: null, durationMs: 1,
          };
        },
      },
      history,
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
    });
    await queue.enqueue(record('t1'));
    await tick();
    // Still running: the engine deliberately never settles, so the record shows
    // exactly what the last accepted stage was.
    expect(queue.get('t1')?.state).toBe('Running');
    expect(queue.get('t1')?.lastStage).toBe('merging');
  });

  it('a failed verification keeps Error but never claims Completed', async () => {
    const mem = createInMemoryPorts();
    mem.state.files.set(artifactFor('t1'), 'bytes');
    const history = new HistoryStore({ ports: mem.ports });
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: stagedEngine(['downloading', 'merging']),
      verifier: {
        async verify() {
          return {
            taskId: 't1', artifacts: [artifactFor('t1')], postprocessed: false,
            criteria: [{ id: 'C1' as const, status: 'FAIL' as const, detail: 'bad' }],
            ok: false, failureCode: 'ARTIFACT_INCOMPLETE' as const, durationMs: 1,
          };
        },
      },
      history,
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
    });
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(await history.query({})).toHaveLength(0);
  });

  it('restart clears the stage so a retry does not claim "verifying"', async () => {
    // A verification failure leaves the record at `verifying` (that is the
    // truth about the attempt that just ended). Retrying is a NEW run: keeping
    // the old stage would make the fresh attempt claim it is already finishing.
    const mem = createInMemoryPorts();
    mem.state.files.set(artifactFor('t1'), 'bytes');
    const history = new HistoryStore({ ports: mem.ports });
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: stagedEngine(['downloading', 'merging']),
      verifier: {
        async verify() {
          return {
            taskId: 't1', artifacts: [artifactFor('t1')], postprocessed: false,
            criteria: [{ id: 'C1' as const, status: 'FAIL' as const, detail: 'bad' }],
            ok: false, failureCode: 'ARTIFACT_INCOMPLETE' as const, durationMs: 1,
          };
        },
      },
      history,
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
    });
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(queue.get('t1')?.lastStage).toBe('verifying');
    await queue.restart('t1');
    // The retry either sits in the FIFO (`null`) or has already re-entered the
    // transfer (`downloading`). What must NOT survive is the previous attempt's
    // `verifying` — that is the value the card would misreport.
    const stage = queue.get('t1')?.lastStage;
    expect(stage).not.toBe('verifying');
    expect([null, 'downloading']).toContain(stage);
  });
});

// Keep the type import honest: the fixture is what the queue serialises.
const _entryType: HistoryEntry | null = null;
void _entryType;
