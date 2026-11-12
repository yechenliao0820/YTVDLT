/**
 * TXT import · real batch enqueue through createM4Host + TaskQueue.
 *
 * No new engine, no new queue: every URL becomes one TaskRecord handed to the
 * existing `TaskQueue.enqueueBatch()`. These cases prove the records are
 * independent, inherit the current download settings, obey the concurrency
 * limit and remain individually cancellable / retryable — and that a normal
 * single download still works.
 */
import { describe, it, expect } from 'vitest';
import type {
  DownloadEngine, DownloadRequest, EngineEvent, MediaInfo,
} from '@ytvdlt/shared';
import { createM4Host, type M4HostOptions } from '../../apps/desktop/src/main/m4-host.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const V = (n: number): string => `https://www.youtube.com/watch?v=video${String(n).padStart(3, '0')}`;
const SNAPSHOT = 'C:/Users/test/AppData/Roaming/YTVDLT/config/tasks.json';
const WORK_DIR = 'C:/Users/test/AppData/Roaming/YTVDLT/work';

const mediaInfo = (): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: null, uploader_id: null, duration: 1,
  thumbnail: null, webpage_url: 'https://example.org/v', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4', formats: [], subtitles: {},
  automatic_captions: {}, chapters: null, _type: 'video',
});

interface Stats { active: number; maxActive: number; started: string[] }

/** Downloads hold their slot until cancelled, so concurrency is observable. */
function holdingEngine(stats: Stats): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('unused by TXT import'); },
    download(req: DownloadRequest, onEvent: (event: EngineEvent) => void) {
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      stats.started.push(req.taskId);
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

async function setup(extra: Partial<M4HostOptions> = {}) {
  const mem = createInMemoryPorts();
  mem.state.files.set(SNAPSHOT, JSON.stringify({
    schemaVersion: 1, savedAt: '2026-11-06T00:00:00.000Z', tasks: [],
  }));
  const stats: Stats = { active: 0, maxActive: 0, started: [] };
  const host = await createM4Host({
    ports: mem.ports,
    engine: holdingEngine(stats),
    verifier,
    jsRuntimePath: 'C:/runtime/node.exe',
    videoFixturePath: 'C:/fixtures/info-video.json',
    playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
    appVersion: '0.2.9',
    engineVersion: 'fake',
    internalWorkDir: WORK_DIR,
    expandPath: (raw) => raw,
    ...extra,
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

describe('TXT import · independent TaskRecords', () => {
  it('creates one task per URL with unique ids, urls and temp dirs', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const urls = [V(1), V(2), V(3)];
    const result = await host.enqueueTxtBatch({ urls, kind: 'video' });
    expect(result.enqueued).toBe(3);
    expect(result.failures).toEqual([]);
    expect(new Set(result.taskIds).size).toBe(3);

    const records = host.task.queue.list().filter((r) => r.id.startsWith('txt-'));
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.url)).size).toBe(3);
    expect(records.map((r) => r.url).sort()).toEqual([...urls].sort());
    const tempDirs = records.map((r) => r.request?.paths.tempDir);
    expect(tempDirs.every((dir) => typeof dir === 'string' && dir !== '')).toBe(true);
    expect(new Set(tempDirs).size).toBe(3);
    // Every record is Idle: enqueueBatch parks tasks; it never bypasses pump().
    expect(records.every((r) => r.state === 'Idle')).toBe(true);
    host.dispose();
  });

  it('inherits the chosen quality and the configured subtitle/path domains', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    await host.enqueueTxtBatch({ urls: [V(1), V(2)], kind: 'video', quality: '1080p' });
    const records = host.task.queue.list().filter((r) => r.id.startsWith('txt-'));
    expect(records.every((r) => r.request?.format.quality === '1080p')).toBe(true);
    const configuredSubtitle = host.task.config.getDomain('subtitle') as { languages: string };
    expect(records.every((r) => r.request?.subtitle.languages === configuredSubtitle.languages)).toBe(true);
    expect(records.every((r) => r.kind === 'video')).toBe(true);
    host.dispose();
  });

  it('audio mode keeps the existing extractAudio / audioFormat behaviour', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    await host.enqueueTxtBatch({
      urls: [V(1)], kind: 'audio', audioQuality: '192', audioFormat: 'mp3',
    });
    const record = host.task.queue.list().find((r) => r.id.startsWith('txt-'));
    expect(record?.request?.format.extractAudio).toBe(true);
    expect(record?.request?.format.audioFormat).toBe('mp3');
    expect(record?.request?.format.audioQuality).toBe('192');
    host.dispose();
  });

  it('does not regress a normal single download', async () => {
    const { host } = await setup();
    host.task.queue.pauseIntake();
    const ids = await host.enqueueSingle({ url: V(99), kind: 'video' });
    expect(ids).toHaveLength(1);
    expect(host.task.queue.get(ids[0] ?? '')?.url).toBe(V(99));
    expect(host.task.queue.get(ids[0] ?? '')?.state).toBe('Idle');
    host.dispose();
  });
});

describe('TXT import · concurrency, cancel and retry', () => {
  it('never exceeds the configured concurrency and cancels / retries ONE task', async () => {
    const { host, stats } = await setup({ concurrency: 2 });
    const result = await host.enqueueTxtBatch({
      urls: [V(1), V(2), V(3), V(4), V(5)], kind: 'video',
    });
    expect(result.enqueued).toBe(5);
    expect(host.task.queue.concurrency).toBe(2);
    await waitFor(() => stats.started.length >= 2);
    expect(stats.maxActive).toBe(2);
    expect(stats.maxActive).toBeLessThanOrEqual(2);

    const first = stats.started[0] ?? '';
    const cancel = await host.taskDetail.perform(first, 'cancel');
    expect(cancel.ok).toBe(true);
    expect(host.task.queue.get(first)?.state).toBe('Canceled');

    const retry = await host.taskDetail.perform(first, 'retry');
    expect(retry.ok).toBe(true);
    // Cancelling / retrying one member leaves every other member untouched.
    const others = result.taskIds.filter((id) => id !== first);
    expect(others.every((id) => host.task.queue.get(id) !== undefined)).toBe(true);
    expect(others.every((id) => host.task.queue.get(id)?.state !== 'Canceled')).toBe(true);
    host.dispose();
  });
});
