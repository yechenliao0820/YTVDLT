/**
 * Playlist batch · the REAL createM4Host path (no parallel engine).
 *
 * Uses the cached-playlist input (the new ticket path), so a fake
 * `probePlaylist` that THROWS also proves confirm does not re-probe the URL.
 */
import { describe, it, expect } from 'vitest';
import type {
  DownloadEngine, DownloadRequest, EngineEvent, MediaInfo, PlaylistInfo,
} from '@ytvdlt/shared';
import { defaultBatchTaskId } from '@ytvdlt/core';
import { createM4Host, type M4HostOptions } from '../../apps/desktop/src/main/m4-host.js';
import { createInMemoryPorts, type InMemoryPorts } from './helpers/in-memory-ports.js';

const SNAPSHOT = 'C:/Users/test/AppData/Roaming/YTVDLT/config/tasks.json';
const WORK_DIR = 'C:/Users/test/AppData/Roaming/YTVDLT/work';
const URL_A = 'https://www.youtube.com/playlist?list=PL_GTA_65';

const mediaInfo = (url: string): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: null, uploader_id: null, duration: 1,
  thumbnail: null, webpage_url: url, extractor_key: 'generic', description: null,
  upload_date: null, ext: 'mp4', formats: [], subtitles: {}, automatic_captions: {},
  chapters: null, _type: 'video',
});

function playlist(count: number, options: { failUrlAt?: number } = {}): PlaylistInfo {
  return {
    id: 'PL_GTA_65', title: 'GTA 游戏合集', _type: 'playlist',
    extractor_key: 'youtube:playlist', webpage_url: URL_A, playlistCount: count,
    entries: Array.from({ length: count }, (_v, i) => ({
      id: `ep${i + 1}`,
      title: `第 ${i + 1} 集`,
      url: `https://cdn.example.org/v${i + 1}.mp4`,
      duration: 600 + i,
      _type: 'url',
    })),
  };
}

interface Stats { active: number; maxActive: number; started: string[]; probeCalls: number }

function engine(stats: Stats, failUrl?: string, autoComplete = false): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe(url: string) {
      stats.probeCalls += 1;
      if (failUrl !== undefined && url === failUrl) throw new Error('probe failed for one entry');
      return mediaInfo(url);
    },
    async probePlaylist() { throw new Error('cached playlist must not be re-probed'); },
    download(req: DownloadRequest, onEvent: (event: EngineEvent) => void) {
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      stats.started.push(req.taskId);
      if (autoComplete) {
        queueMicrotask(() => {
          onEvent({
            type: 'completed', taskId: req.taskId,
            artifacts: [{ taskId: req.taskId, path: `C:/out/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
          });
        });
      }
      return {
        pid: 1,
        // D-142: a confirmed kill always settles the run (the process exits and
        // the engine reports `canceled`), releasing the slot for a retry.
        cancel: async () => {
          stats.active -= 1;
          onEvent({ type: 'canceled', taskId: req.taskId });
          return true;
        },
      };
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

async function setup(extra: Partial<M4HostOptions> & {
  failUrl?: string; autoComplete?: boolean;
} = {}) {
  const { failUrl, autoComplete, ...hostOptions } = extra;
  const mem: InMemoryPorts = createInMemoryPorts();
  mem.state.files.set(SNAPSHOT, JSON.stringify({
    schemaVersion: 1, savedAt: '2026-11-06T00:00:00.000Z', tasks: [],
  }));
  const stats: Stats = { active: 0, maxActive: 0, started: [], probeCalls: 0 };
  const host = await createM4Host({
    ports: mem.ports,
    engine: engine(stats, failUrl, autoComplete),
    verifier,
    jsRuntimePath: 'C:/runtime/node.exe',
    videoFixturePath: 'C:/fixtures/info-video.json',
    playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
    appVersion: '0.2.9',
    engineVersion: 'fake',
    internalWorkDir: WORK_DIR,
    expandPath: (raw) => raw,
    ...hostOptions,
  });
  return { host, stats, mem };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('Playlist batch · independent TaskRecords', () => {
  it('3 entries → 3 tasks, unique ids, own URL and own tempDir', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const report = await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1', 'ep2', 'ep3'], playlistUrl: URL_A, kind: 'video',
      playlist: playlist(3),
    });
    expect(report.enqueued).toBe(3);
    expect(report.failed).toBe(0);
    expect(new Set(report.taskIds).size).toBe(3);

    const records = host.task.queue.list().filter((r) => r.id.startsWith('pl-'));
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.url)).size).toBe(3);
    const temps = records.map((r) => r.request?.paths.tempDir);
    expect(temps.every((dir) => typeof dir === 'string' && dir !== '')).toBe(true);
    expect(new Set(temps).size).toBe(3);
    expect(records.every((r) => r.state === 'Idle')).toBe(true);
    // The cached playlist was used: no second probePlaylist() call.
    host.dispose();
  });

  it('65 entries → 65 queued tasks', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const ids = Array.from({ length: 65 }, (_v, i) => `ep${i + 1}`);
    const report = await host.enqueuePlaylistBatchWithReport({
      selectedIds: ids, playlistUrl: URL_A, kind: 'video', playlist: playlist(65),
    });
    expect(report.requested).toBe(65);
    expect(report.enqueued).toBe(65);
    expect(report.taskIds).toHaveLength(65);
    host.dispose();
  });

  it('re-enqueueing the SAME collection twice never reuses a taskId', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const input = {
      selectedIds: ['ep1', 'ep2', 'ep3'], playlistUrl: URL_A,
      kind: 'video' as const, playlist: playlist(3),
    };
    const first = await host.enqueuePlaylistBatchWithReport(input);
    const second = await host.enqueuePlaylistBatchWithReport(input);
    expect(new Set([...first.taskIds, ...second.taskIds]).size).toBe(6);
    expect(host.task.queue.list().filter((r) => r.id.startsWith('pl-'))).toHaveLength(6);
    // The frozen pure planner really would collide — this is why production
    // injects its own makeTaskId instead of changing `defaultBatchTaskId`.
    expect(defaultBatchTaskId('PL_GTA_65', 'ep1')).toBe('PL_GTA_65-ep1');
    expect(defaultBatchTaskId('PL_GTA_65', 'ep1')).toBe(defaultBatchTaskId('PL_GTA_65', 'ep1'));
    host.dispose();
  });

  it('inherits quality, audio format, paths and the configured subtitle domain', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1', 'ep2'], playlistUrl: URL_A, kind: 'video', quality: '1080p',
      playlist: playlist(2),
    });
    const configured = host.task.config.getDomain('subtitle') as { languages: string };
    const records = host.task.queue.list().filter((r) => r.id.startsWith('pl-'));
    expect(records.every((r) => r.request?.format.quality === '1080p')).toBe(true);
    expect(records.every((r) => r.request?.subtitle.languages === configured.languages)).toBe(true);
    expect(records.every((r) => typeof r.request?.paths.videoDir === 'string')).toBe(true);

    await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1'], playlistUrl: URL_A, kind: 'audio',
      audioQuality: '192', audioFormat: 'mp3', playlist: playlist(2),
    });
    const audio = host.task.queue.list().find((r) => r.kind === 'audio');
    expect(audio?.request?.format.extractAudio).toBe(true);
    expect(audio?.request?.format.audioFormat).toBe('mp3');
    expect(audio?.request?.format.audioQuality).toBe('192');
    host.dispose();
  });

  it('unknown entry ids are reported as failures, not silently dropped', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const report = await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1', 'does-not-exist'], playlistUrl: URL_A, kind: 'video',
      playlist: playlist(3),
    });
    expect(report.enqueued).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.failures.some((f) => f.id === 'does-not-exist')).toBe(true);
    host.dispose();
  });

  it('does not regress a normal single download', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const ids = await host.enqueueSingle({ url: 'https://example.org/watch?v=plain', kind: 'video' });
    expect(ids).toHaveLength(1);
    expect(host.task.queue.get(ids[0] ?? '')?.state).toBe('Idle');
    host.dispose();
  });
});

describe('Playlist batch · concurrency, cancellation, failure isolation', () => {
  it('never exceeds the configured concurrency of 3', async () => {
    const { host, stats } = await setup({ concurrency: 3 });
    expect(host.task.queue.concurrency).toBe(3);
    await host.enqueuePlaylistBatchWithReport({
      selectedIds: Array.from({ length: 8 }, (_v, i) => `ep${i + 1}`),
      playlistUrl: URL_A, kind: 'video', playlist: playlist(8),
    });
    await waitFor(() => stats.started.length >= 3);
    expect(stats.maxActive).toBe(3);
    host.dispose();
  });

  it('one failing video becomes Error while the others keep running', async () => {
    const failing = 'https://cdn.example.org/v2.mp4';
    const { host } = await setup({ concurrency: 2, failUrl: failing });
    const report = await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1', 'ep2', 'ep3'], playlistUrl: URL_A, kind: 'video',
      playlist: playlist(3),
    });
    expect(report.enqueued).toBe(3);
    await waitFor(() => host.task.queue.list().some((r) => r.state === 'Error'));
    const errored = host.task.queue.list().filter((r) => r.state === 'Error');
    expect(errored).toHaveLength(1);
    expect(errored[0]?.url).toBe(failing);
    expect(host.task.queue.list().filter((r) => r.state !== 'Error').length).toBeGreaterThanOrEqual(2);
    host.dispose();
  });

  it('one member can be cancelled and retried without touching the others', async () => {
    const { host, stats } = await setup({ concurrency: 2 });
    const report = await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1', 'ep2', 'ep3'], playlistUrl: URL_A, kind: 'video',
      playlist: playlist(3),
    });
    await waitFor(() => stats.started.length >= 2);
    const target = stats.started[0] ?? '';
    expect((await host.taskDetail.perform(target, 'cancel')).ok).toBe(true);
    expect(host.task.queue.get(target)?.state).toBe('Canceled');
    expect((await host.taskDetail.perform(target, 'retry')).ok).toBe(true);
    const others = report.taskIds.filter((id) => id !== target);
    expect(others.every((id) => host.task.queue.get(id) !== undefined)).toBe(true);
    expect(others.every((id) => host.task.queue.get(id)?.state !== 'Canceled')).toBe(true);
    host.dispose();
  });

  it('tasks survive a host restart (existing snapshot / restore path)', async () => {
    // Real persistence happens when a run settles (`TaskQueue.persistSnapshot`
    // in the `finally` of run()), so let the fake engine complete its tasks.
    const { host, mem } = await setup({ autoComplete: true });
    const report = await host.enqueuePlaylistBatchWithReport({
      selectedIds: ['ep1', 'ep2', 'ep3'], playlistUrl: URL_A, kind: 'video',
      playlist: playlist(3),
    });
    await waitFor(() => (mem.state.files.get(SNAPSHOT) ?? '').includes(report.taskIds[0] ?? 'never'));
    host.dispose();

    const second = await createM4Host({
      ports: mem.ports,
      engine: engine({ active: 0, maxActive: 0, started: [], probeCalls: 0 }),
      verifier,
      jsRuntimePath: 'C:/runtime/node.exe',
      videoFixturePath: 'C:/fixtures/info-video.json',
      playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
      appVersion: '0.2.9',
      engineVersion: 'fake',
      internalWorkDir: WORK_DIR,
      expandPath: (raw) => raw,
    });
    expect(second.restore.restored).toBeGreaterThanOrEqual(3);
    expect(report.taskIds.every((id) => second.task.queue.get(id) !== undefined)).toBe(true);
    second.dispose();
  });
});
