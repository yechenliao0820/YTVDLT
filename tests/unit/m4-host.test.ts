/**
 * M4 assembly · createM4Host wires queue + restore + batch + notifications +
 * task detail + command templates + IPC, without any Electron import.
 */
import { describe, it, expect } from 'vitest';
import type {
  DownloadEngine, DownloadRequest, EngineEvent, PlaylistInfo, TaskRecord,
} from '@ytvdlt/shared';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { createM4Host } from '../../apps/desktop/src/main/m4-host.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const mediaInfo = () => ({
  id: 'fixture', title: 'fixture', uploader: null, uploader_id: null, duration: 1,
  thumbnail: null, webpage_url: 'https://example.org/v', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4', formats: [], subtitles: {},
  automatic_captions: {}, chapters: null, _type: 'video' as const,
});

const playlist = (): PlaylistInfo => ({
  id: 'PL_fixture_01', title: 'Recorded Flat Playlist', _type: 'playlist',
  extractor_key: 'generic', webpage_url: 'https://example.org/playlist?list=PL_fixture_01',
  entries: [
    { id: 'a1', title: 'E1', url: 'https://example.org/watch?v=a1', duration: 1, _type: 'url' },
    { id: 'a2', title: 'E2', url: 'https://example.org/watch?v=a2', duration: 2, _type: 'url' },
    { id: 'a3', title: 'E3', url: 'https://example.org/watch?v=a3', duration: 3, _type: 'url' },
  ],
});

const snapshotRecord = (): TaskRecord => ({
  id: 'old', url: 'https://example.org/old', kind: 'video', state: 'Running',
  createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
  mediaInfo: null, request: null, artifacts: [], lastPercent: 42, error: null,
  privateMode: false, postprocessed: false,
});

function engine(counter: { downloads: number; probes: number; playlistProbes: number }): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { counter.probes += 1; return mediaInfo(); },
    async probePlaylist() { counter.playlistProbes += 1; return playlist(); },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      counter.downloads += 1;
      queueMicrotask(() => {
        onEvent({
          type: 'progress', taskId: req.taskId, percent: 100, downloadedBytes: 1,
          totalBytes: 1, speedBps: 1, etaSec: 0, rawLine: 'x',
        });
        onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: [{ taskId: req.taskId, path: `C:/V/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
        });
      });
      return { pid: 1, cancel: async () => true };
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

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const CONFIG_DIR = 'C:/Users/test/AppData/Roaming/YTVDLT/config';
const SNAPSHOT = `${CONFIG_DIR}/tasks.json`;

async function setup(extra: Partial<Parameters<typeof createM4Host>[0]> = {}) {
  const mem = createInMemoryPorts();
  mem.state.files.set(SNAPSHOT, JSON.stringify({
    schemaVersion: 1, savedAt: '2026-11-06T00:00:00.000Z', tasks: [snapshotRecord()],
  }));
  const counter = { downloads: 0, probes: 0, playlistProbes: 0 };
  const clipboard: string[] = [];
  const shown: string[] = [];
  const host = await createM4Host({
    ports: mem.ports,
    engine: engine(counter),
    verifier,
    jsRuntimePath: 'C:/runtime/node.exe',
    videoFixturePath: 'C:/fixtures/info-video.json',
    playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
    appVersion: '0.1.0',
    engineVersion: '2026.10.26',
    clipboard: { async writeText(text: string) { clipboard.push(text); } },
    notificationAdapter: { show: (n) => { shown.push(n.kind); return true; } },
    ...extra,
  });
  return { mem, counter, clipboard, shown, host };
}

describe('M4 host · boot + restore', () => {
  it('restores the previous session and does not auto-start it', async () => {
    const { host, counter } = await setup();
    expect(host.restore).toMatchObject({ restored: 1, interrupted: 1 });
    expect(host.task.queue.get('old')?.state).toBe('Canceled');
    expect(host.task.queue.get('old')?.lastPercent).toBe(42);
    expect(counter.downloads).toBe(0);
    host.dispose();
  });

  it('initialises the command templates store', async () => {
    const { host } = await setup();
    expect(host.commandTemplates.list()).toEqual([]);
    const created = await host.commandTemplates.create({ name: 'MKV', args: ['--embed-subs'] });
    expect(host.commandTemplates.get(created.id)?.name).toBe('MKV');
    host.dispose();
  });
});

describe('M4 host · batch enqueue through the real IPC channel', () => {
  it('PLAYLIST_ENQUEUE probes, builds 3 tasks with playlist items, and enqueues them', async () => {
    const { host, counter } = await setup();
    const result = await host.gateway.dispatch(IPC_CHANNELS.PLAYLIST_ENQUEUE, {
      selectedIds: ['a1', 'a2', 'a3'],
      playlistUrl: 'https://example.org/playlist?list=PL_fixture_01',
      kind: 'video',
    }) as { enqueued: boolean; taskIds: string[] };

    expect(result.enqueued).toBe(true);
    expect(result.taskIds).toEqual(['PL_fixture_01-a1', 'PL_fixture_01-a2', 'PL_fixture_01-a3']);
    const created = result.taskIds.map((id) => host.task.queue.get(id));
    // D-69: production batches now use each entry's own URL (no position drift).
    expect(created.map((r) => r?.request?.advanced.playlistItems)).toEqual([null, null, null]);
    expect(created.map((r) => r?.url)).toEqual([
      'https://example.org/watch?v=a1',
      'https://example.org/watch?v=a2',
      'https://example.org/watch?v=a3',
    ]);

    await waitFor(() => counter.downloads === 3 && result.taskIds.every((id) => host.task.queue.get(id)?.state === 'Completed'));
    host.dispose();
  });

  it('feeds NotificationCenter and the injected adapter', async () => {
    const { host, shown } = await setup();
    await host.enqueuePlaylistBatch({
      selectedIds: ['a1', 'a2'],
      playlistUrl: 'https://example.org/playlist?list=PL_fixture_01',
      kind: 'video',
    });
    await waitFor(() => host.notifications.history().filter((n) => n.kind === 'completed').length === 2);
    const completed = host.notifications.history().filter((n) => n.kind === 'completed');
    expect(completed.map((n) => n.taskId).sort()).toEqual(['PL_fixture_01-a1', 'PL_fixture_01-a2']);
    expect(shown.filter((kind) => kind === 'completed')).toHaveLength(2);
    host.dispose();
  });

  it('rejects an empty selection without probing', async () => {
    const { host, counter } = await setup();
    const ids = await host.enqueuePlaylistBatch({
      selectedIds: [],
      playlistUrl: 'https://example.org/playlist?list=PL_fixture_01',
      kind: 'video',
    });
    expect(ids).toEqual([]);
    expect(counter.playlistProbes).toBe(0);
    host.dispose();
  });

  it('dispose() detaches the queue listener', async () => {
    const { host } = await setup();
    host.dispose();
    await host.enqueuePlaylistBatch({
      selectedIds: ['a1'],
      playlistUrl: 'https://example.org/playlist?list=PL_fixture_01',
      kind: 'video',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.notifications.history()).toHaveLength(0);
  });
});

describe('M4 host · task detail service', () => {
  it('copies a redacted URL through the injected clipboard', async () => {
    const { host, clipboard } = await setup();
    // Seed a signed-URL task directly (no probe/download side effects).
    await host.task.queue.restore({
      schemaVersion: 1, savedAt: '2026-11-06T00:00:00.000Z',
      tasks: [{
        ...snapshotRecord(),
        id: 'signed', state: 'Canceled',
        url: 'https://example.org/v?token=SECRET&sig=ABC&x=1',
        lastPercent: 10,
      }],
    });
    const result = await host.taskDetail.perform('signed', 'copy-url');
    expect(result.ok).toBe(true);
    expect(clipboard[0]).not.toContain('SECRET');
    expect(clipboard[0]).toContain('token=***REDACTED***');
    host.dispose();
  });
});

describe('M4 host · single enqueue applies the picked format (D-83)', () => {
  it('audio: extractAudio + container + bitrate land in the request', async () => {
    const { host } = await setup();
    const ids = await host.enqueueSingle({
      url: 'https://example.org/a', kind: 'audio', audioQuality: '128', audioFormat: 'mp3',
    });
    const record = host.task.queue.get(ids[0]);
    expect(record?.kind).toBe('audio');
    expect(record?.request?.format).toMatchObject({
      extractAudio: true, audioFormat: 'mp3', audioQuality: '128',
    });
    host.dispose();
  });

  it('video: the resolution preset lands and audio extraction stays off', async () => {
    const { host } = await setup();
    const ids = await host.enqueueSingle({
      url: 'https://example.org/v', kind: 'video', quality: '720p',
    });
    const record = host.task.queue.get(ids[0]);
    expect(record?.request?.format).toMatchObject({
      extractAudio: false, audioFormat: null, quality: '720p',
    });
    host.dispose();
  });

  it('audio with "auto" keeps the source codec (no transcode)', async () => {
    const { host } = await setup();
    const ids = await host.enqueueSingle({
      url: 'https://example.org/a', kind: 'audio', audioFormat: 'auto',
    });
    expect(host.task.queue.get(ids[0])?.request?.format).toMatchObject({
      extractAudio: true, audioFormat: null,
    });
    host.dispose();
  });
});

/**
 * D-118: the desktop host is the ONLY place that knows the app data dir and the
 * expanded user paths, so it is where the per-task temp dir gets resolved.
 *
 * The request is the contract the engine reads: `paths.tempDir` must be a
 * concrete, per-task directory, and it must be on the same volume as the final
 * media unless the user configured otherwise.
 */
describe('M4 host · per-task temp dir (D-118)', () => {
  const expandTo = (videos: string) => (raw: string) => raw
    .split('%USERVIDEOS%').join(videos)
    .split('%USERPROFILE%').join('C:/Users/leo')
    .split('%LOCALAPPDATA%').join('C:/Users/leo/AppData/Local');

  it('same volume: partials go to the app work dir, one folder per task', async () => {
    const { host } = await setup({
      expandPath: expandTo('C:/Users/leo/Videos'),
      internalWorkDir: 'C:/Users/leo/AppData/Roaming/YTVDLT/work',
    });
    const ids = await host.enqueueSingle({ url: 'https://example.org/v', kind: 'video' });
    const request = host.task.queue.get(ids[0])?.request;
    expect(request?.paths.tempDir).toBe(`C:/Users/leo/AppData/Roaming/YTVDLT/work/${ids[0]}`);
    host.dispose();
  });

  it('different volume: partials stay inside the output dir on that volume', async () => {
    const { host } = await setup({
      // `%USERVIDEOS%` is the Videos ROOT; the shipped template appends /YTVDLT.
      expandPath: expandTo('D:/Media'),
      internalWorkDir: 'C:/Users/leo/AppData/Roaming/YTVDLT/work',
    });
    const ids = await host.enqueueSingle({ url: 'https://example.org/v', kind: 'video' });
    const request = host.task.queue.get(ids[0])?.request;
    expect(request?.paths.tempDir).toBe(`D:/Media/YTVDLT/.ytvdlt-incomplete/${ids[0]}`);
    host.dispose();
  });

  it('audio tasks resolve against audioDir, not videoDir', async () => {
    const { host } = await setup({
      expandPath: (raw: string) => raw
        .split('%USERVIDEOS%').join('D:/Media')
        .split('%USERPROFILE%').join('C:/Users/leo'),
      internalWorkDir: 'C:/Users/leo/AppData/Roaming/YTVDLT/work',
    });
    const ids = await host.enqueueSingle({ url: 'https://example.org/a', kind: 'audio' });
    const request = host.task.queue.get(ids[0])?.request;
    // audioDir is `%USERVIDEOS%/YTVDLT/Audio` → D:, so the same-volume work dir
    // is unusable and the per-task folder lands next to the audio output.
    expect(request?.paths.tempDir).toBe(`D:/Media/YTVDLT/Audio/.ytvdlt-incomplete/${ids[0]}`);
    host.dispose();
  });

  it('two tasks never share a temp dir', async () => {
    const { host } = await setup({
      expandPath: expandTo('C:/Users/leo/Videos'),
      internalWorkDir: 'C:/Users/leo/AppData/Roaming/YTVDLT/work',
    });
    const first = await host.enqueueSingle({ url: 'https://example.org/1', kind: 'video' });
    const second = await host.enqueueSingle({ url: 'https://example.org/2', kind: 'video' });
    const a = host.task.queue.get(first[0])?.request?.paths.tempDir;
    const b = host.task.queue.get(second[0])?.request?.paths.tempDir;
    expect(a).not.toBe(b);
    expect(a).toContain(first[0] ?? '');
    expect(b).toContain(second[0] ?? '');
    host.dispose();
  });
});

describe('M4 host · subtitle patch + pre-probed MediaInfo (stage 3)', () => {
  it('merges the per-task subtitle patch into the request and skips the probe', async () => {
    const { host, counter } = await setup();
    const probesBefore = counter.probes;
    const ids = await host.enqueueSingle({
      url: 'https://example.org/watch?v=sub',
      kind: 'video',
      subtitlePatch: {
        enabled: true, languages: 'zh-Hans', autoCaptions: true, convertTo: 'srt', embed: false,
      },
      mediaInfo: mediaInfo(),
    });
    const record = host.task.queue.get(ids[0] as string);

    // The subtitle choice lives in THIS request only — no global config write.
    expect(record?.request?.subtitle).toMatchObject({
      enabled: true, languages: 'zh-Hans', autoCaptions: true, convertTo: 'srt', embed: false,
    });
    expect(record?.request?.subtitle.skipTranslated).toBe(true); // config default kept
    expect(record?.mediaInfo?.id).toBe('fixture');

    await waitFor(() => host.task.queue.get(ids[0] as string)?.state === 'Completed');
    // Requirement 13: a consumed preview means the queue never probes again.
    expect(counter.probes).toBe(probesBefore);
    host.dispose();
  });

  it('still probes when no MediaInfo is supplied (old behaviour)', async () => {
    const { host, counter } = await setup();
    const probesBefore = counter.probes;
    const ids = await host.enqueueSingle({ url: 'https://example.org/watch?v=plain', kind: 'video' });

    await waitFor(() => host.task.queue.get(ids[0] as string)?.state === 'Completed');
    expect(counter.probes).toBe(probesBefore + 1);
    expect(host.task.queue.get(ids[0] as string)?.request?.subtitle.enabled).toBe(false);
    host.dispose();
  });
});
