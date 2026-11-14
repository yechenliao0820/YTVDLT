/**
 * D-163 · tasks.json write discipline.
 *
 * Two guarantees live or die here:
 *   1. A full-file rewrite happens only for STRUCTURAL change (state / stage /
 *      artifacts / error / subtitle outcome). Progress numbers move on every
 *      tick, so they are not fingerprinted — pure progress jitter must not
 *      rewrite the file, while a stage change lands with the next throttled
 *      tick and a task end always writes its final state.
 *   2. The persisted projection keeps stripping the signed CDN links
 *      (`formats[].url` / `subtitles[].url` / `automatic_captions[].url`),
 *      while `thumbnail` deliberately STAYS: the main process re-fetches
 *      covers at boot from the restored records and the cache is keyed by
 *      `sha1(url)` (see snapshot-media.ts for the full trade-off).
 *
 * Write counting intercepts `writeTextAtomic` for the tasks.json path — the
 * same sabotage point the T2 tests use — so a "rewrite" here means a real
 * full-file serialization, not a persist attempt.
 */
import { describe, it, expect } from 'vitest';
import { TaskQueue, TaskStore, HistoryStore } from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord, TaskSnapshot,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const SIGNED_MEDIA_URL = 'https://cdn.example.org/v/abc.m3u8?sig=aaa&expire=999';
const SIGNED_SUB_URL = 'https://cdn.example.org/s/en.vtt?sig=bbb&expire=999';
const SIGNED_CAPTION_URL = 'https://cdn.example.org/a/en.vtt?sig=ccc&expire=999';
const THUMBNAIL_URL = 'https://i.ytimg.com/vi/fixture/hqdefault.jpg';

const mediaInfo = (): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: 'chan', uploader_id: null, duration: 10,
  thumbnail: THUMBNAIL_URL, webpage_url: 'http://127.0.0.1:1/fixture.mp4', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4',
  formats: [{
    format_id: '0', ext: 'mp4', width: 320, height: 240, vcodec: 'h264', acodec: 'aac',
    filesize: 1, filesize_approx: null, tbr: 1, fps: 25, format_note: null,
    url: SIGNED_MEDIA_URL,
  }],
  subtitles: { en: [{ lang: 'en', ext: 'vtt', name: null, url: SIGNED_SUB_URL }] },
  automatic_captions: { en: [{ lang: 'en', ext: 'vtt', name: null, url: SIGNED_CAPTION_URL }] },
  chapters: null, _type: 'video',
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

type Mode = 'jitter' | 'stage' | 'complete';

interface EngineState {
  mode: Mode;
  downloadCalls: number;
}

/**
 * `jitter`   — six progress ticks, every number different, then hangs.
 * `stage`    — progress, a forward stage marker, more progress, hangs.
 * `complete` — one progress tick, then a completed manifest.
 */
function fakeEngine(state: EngineState): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
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
      const progress = (percent: number, speedBps: number, etaSec: number): EngineEvent => ({
        type: 'progress', taskId: req.taskId, percent, downloadedBytes: percent,
        totalBytes: 100, speedBps, etaSec, rawLine: 'YTVDLT|...',
      });
      if (state.mode === 'jitter') {
        for (let i = 1; i <= 6; i += 1) onEvent(progress(i, i * 10, 99 - i));
        return handle;
      }
      if (state.mode === 'stage') {
        onEvent(progress(10, 100, 90));
        onEvent({ type: 'stage', taskId: req.taskId, stage: 'merging' });
        onEvent(progress(20, 110, 80));
        onEvent(progress(30, 120, 70));
        return handle;
      }
      onEvent(progress(37, 42, 5));
      queueMicrotask(() => onEvent({
        type: 'completed', taskId: req.taskId,
        artifacts: [{ taskId: req.taskId, path: `C:/out/${req.taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
      }));
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

/** One session: own ports, a real TaskStore, and the tasks.json rewrite log. */
function session(mode: Mode) {
  const mem = createInMemoryPorts();
  const rewrites: string[] = [];
  const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
  mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
    if (path.endsWith('tasks.json')) rewrites.push(text);
    await inner(path, text);
  };
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: fakeEngine({ mode, downloadCalls: 0 }),
    verifier: okVerifier,
    history: new HistoryStore({ ports: mem.ports }),
    taskStore: new TaskStore({ ports: mem.ports }),
    jsRuntimePath: 'C:/runtime/node.exe',
    persistIntervalMs: 0,
  });
  return { mem, queue, rewrites };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const parse = (text: string): TaskSnapshot => JSON.parse(text) as TaskSnapshot;

describe('D-163 · 纯进度抖动不重写 tasks.json', () => {
  it('六个进度 tick 只落盘一次：首次结构写，之后全部跳过', async () => {
    const { queue, rewrites } = session('jitter');
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.state).toBe('Running');
    expect(rewrites).toHaveLength(1);
    const persisted = parse(rewrites[0] ?? '{}');
    expect(persisted.tasks).toHaveLength(1);
    expect(persisted.tasks[0]?.state).toBe('Running');
    expect(persisted.tasks[0]?.lastStage).toBe('downloading');
    // The one write captured the FIRST tick; ticks 2-6 changed only numbers.
    expect(persisted.tasks[0]?.lastPercent).toBe(1);
  });
});

describe('D-163 · 结构性变化仍及时落盘', () => {
  it('stage 推进在下一个进度 tick 落盘，其后恢复跳过', async () => {
    const { queue, rewrites } = session('stage');
    await queue.enqueue(record('t1'));
    await tick();

    // tick 1 writes `downloading`; the next tick after the marker writes
    // `merging`; the remaining progress ticks change nothing structural.
    expect(rewrites).toHaveLength(2);
    const second = parse(rewrites[1] ?? '{}');
    expect(second.tasks[0]?.lastStage).toBe('merging');
    expect(second.tasks[0]?.lastPercent).toBe(20);
  });

  it('任务结束（状态 + 产物）强制落盘，投影保持脱敏且 thumbnail 保留', async () => {
    const { queue, rewrites } = session('complete');
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    // mid-run tick + the unconditional `run().finally` write.
    expect(rewrites).toHaveLength(2);
    const final = parse(rewrites[1] ?? '{}');
    expect(final.tasks[0]?.state).toBe('Completed');
    expect(final.tasks[0]?.artifacts).toEqual(['C:/out/t1.mp4']);

    // Signed CDN links never reach disk (D-163)...
    const media = final.tasks[0]?.mediaInfo;
    expect(media?.formats[0]).not.toHaveProperty('url');
    expect(media?.subtitles.en?.[0]).not.toHaveProperty('url');
    expect(media?.automatic_captions.en?.[0]).not.toHaveProperty('url');
    // ...but the thumbnail stays: the boot cover re-fetch is keyed by sha1(url)
    // and reads it from the restored records (see snapshot-media.ts).
    expect(media?.thumbnail).toBe(THUMBNAIL_URL);
    // In-memory keeps the full object so restart() can reuse the probe.
    expect(queue.get('t1')?.mediaInfo?.formats[0]?.url).toBe(SIGNED_MEDIA_URL);
  });
});
