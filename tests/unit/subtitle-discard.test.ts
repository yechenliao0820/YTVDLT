/**
 * D-131 · `keepSubtitleFile=false` must actually remove the standalone
 * subtitle files that `--embed-subs` leaves behind.
 *
 * The bundled yt-dlp (2026.10.26) has no "delete subtitles after embedding"
 * switch; before D-131 the checkbox only decided whether to ADD `--write-subs`
 * and the files always survived. These tests drive the REAL TaskQueue run()
 * (probe → download → verify → history → Completed) with a fake engine and a
 * fake recycle-bin hook, so they assert the queue's bookkeeping, not just a
 * helper function.
 *
 * Deliberately covered here: none of the cleanup may (a) touch the media file,
 * (b) touch a plain external subtitle, (c) guess a path from a directory,
 * (d) delete a file another task still references, or (e) fail a verified
 * download when the recycle-bin adapter fails.
 */
import { describe, it, expect } from 'vitest';
import { HistoryStore, TaskQueue } from '@ytvdlt/core';
import type {
  AttachmentProbe, DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord,
} from '@ytvdlt/shared';
import { createM5Host } from '../../apps/desktop/src/main/m5-host.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { bucketOf, mediaInfo as mediaFixture, trackOf } from './helpers/subtitle-media.js';

const MEDIA = 'C:/out/Clip [id].mkv';
const EN = 'C:/out/Clip [id].en.srt';
const ZH = 'C:/out/Clip [id].zh-Hans.srt';
/** A file left by an earlier run: no language segment, so ownership is unproven. */
const STALE = 'C:/out/Clip [id].srt';

type Recycle = (paths: readonly string[]) => Promise<readonly string[]>;

const baseSubtitle: DownloadRequest['subtitle'] = {
  enabled: true, languages: 'en,zh-Hans', autoCaptions: false,
  skipTranslated: true, convertTo: 'srt', embed: false, keepSubtitleFile: false,
};

/** The exact user choice under audit: embed, do NOT keep standalone files. */
const embeddedNoKeep = (over: Partial<DownloadRequest['subtitle']> = {}): DownloadRequest['subtitle'] => ({
  ...baseSubtitle, embed: true, keepSubtitleFile: false, ...over,
});

const request = (taskId: string, subtitle: DownloadRequest['subtitle']): DownloadRequest => ({
  taskId, url: 'https://example.org/v',
  format: {
    quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
    extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
    audioFormat: null, audioMultistreams: false,
  },
  subtitle,
  paths: {
    videoDir: 'C:/out', audioDir: 'C:/out', commandDir: 'C:/cmd', privateMode: false,
    subdirByExtractor: false, subdirByPlaylist: false,
    outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp',
  },
  network: {
    rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
    ipv4Only: false, concurrentFragments: null, aria2cPath: null,
  },
  advanced: {
    sponsorblockRemove: null, downloadSections: null, splitChapters: false,
    customTitle: null, debug: false, downloadArchive: null, customCommand: null,
  },
});

const record = (taskId: string, subtitle: DownloadRequest['subtitle']): TaskRecord => ({
  id: taskId, url: 'https://example.org/v', kind: 'video', state: 'Idle',
  createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
  mediaInfo: null, request: request(taskId, subtitle), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

const probedMedia = (): MediaInfo => mediaFixture({
  subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('zh-Hans', 'vtt')),
  automatic_captions: bucketOf(trackOf('de', 'vtt')),
});

interface Runs {
  script: string[][];
  calls: DownloadRequest[];
}

function engineWith(runs: Runs): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return probedMedia(); },
    async probePlaylist() { throw new Error('unused'); },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      runs.calls.push(req);
      const paths = runs.script.shift() ?? [MEDIA];
      queueMicrotask(() => {
        onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: paths.map((path) => ({
            taskId: req.taskId, path, kind: 'video' as const, sizeBytes: 10,
          })),
        });
      });
      return { pid: 1, cancel: async () => true };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

function verifier(ok = true, attachments: readonly AttachmentProbe[] = []) {
  return {
    async verify(input: { taskId: string; artifacts: string[] }) {
      return {
        taskId: input.taskId, artifacts: input.artifacts, postprocessed: false,
        criteria: [], ok, failureCode: ok ? null : ('ARTIFACT_INCOMPLETE' as const),
        durationMs: 1, attachments,
      };
    },
  };
}

/** An embedded-stream PASS keeps `subtitleOutcome=ok` before and after cleanup. */
const EMBEDDED_OK: readonly AttachmentProbe[] = [
  { path: MEDIA, kind: 'subtitle', status: 'PASS', detail: '2 embedded streams' },
];

interface SetupOptions {
  script: string[][];
  recycle?: Recycle;
  attachments?: readonly AttachmentProbe[];
  verifyOk?: boolean;
}

function setup(options: SetupOptions) {
  const mem = createInMemoryPorts();
  for (const path of [MEDIA, EN, ZH, STALE]) mem.state.files.set(path, 'bytes');
  const runs: Runs = { script: [...options.script], calls: [] };
  const history = new HistoryStore({ ports: mem.ports });
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: engineWith(runs),
    verifier: verifier(options.verifyOk ?? true, options.attachments ?? EMBEDDED_OK),
    history,
    jsRuntimePath: 'C:/runtime/node.exe',
    ...(options.recycle === undefined ? {} : { recycleSubtitleFiles: options.recycle }),
  });
  return { mem, queue, history, runs };
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('D-131 · keepSubtitleFile=false discards embedded-download sidecars', () => {
  it('recycles exactly the paths this task reported, and keeps media + outcome + history consistent', async () => {
    const recycled: string[][] = [];
    const { queue, history } = setup({
      script: [[MEDIA, EN, ZH]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
    });
    await queue.enqueue(record('t1', embeddedNoKeep()));
    await tick();

    expect(recycled).toEqual([[EN, ZH]]);
    const task = queue.get('t1');
    expect(task?.state).toBe('Completed');
    expect(task?.artifacts).toEqual([MEDIA]);
    expect(task?.subtitleFiles).toEqual([]);
    // The run DID deliver the subtitles; the user's cleanup preference must
    // not retroactively rewrite that verdict into "missing"/"partial".
    expect(task?.subtitleOutcome).toBe('ok');
    const entries = await history.query({});
    expect(entries[0]?.videoPath).toBe(MEDIA);
    expect(entries[0]?.subtitlePaths).toEqual([]);
  });

  it('keeps the standalone files when the user checked keep=true', async () => {
    const recycled: string[][] = [];
    const { queue } = setup({
      script: [[MEDIA, EN, ZH]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
    });
    await queue.enqueue(record('keep', embeddedNoKeep({ keepSubtitleFile: true })));
    await tick();

    expect(recycled).toEqual([]);
    expect(queue.get('keep')?.artifacts).toEqual([MEDIA, EN, ZH]);
    expect(queue.get('keep')?.subtitleFiles).toHaveLength(2);
  });

  it('never recycles a plain external-subtitle download (embed=false)', async () => {
    const recycled: string[][] = [];
    const { queue } = setup({
      script: [[MEDIA, EN, ZH]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
    });
    await queue.enqueue(record('external', { ...baseSubtitle, embed: false }));
    await tick();

    expect(recycled).toEqual([]);
    expect(queue.get('external')?.artifacts).toEqual([MEDIA, EN, ZH]);
  });

  it('without a recycle port behaves exactly as before D-131 (no cleanup)', async () => {
    const { queue } = setup({ script: [[MEDIA, EN, ZH]] });
    await queue.enqueue(record('no-port', embeddedNoKeep()));
    await tick();

    const task = queue.get('no-port');
    expect(task?.state).toBe('Completed');
    expect(task?.artifacts).toEqual([MEDIA, EN, ZH]);
    expect(task?.subtitleFiles).toHaveLength(2);
  });

  it('keeps BOTH file and record when the recycle bin reports a real OS error', async () => {
    const { queue } = setup({
      script: [[MEDIA, EN, ZH]],
      // Adapter returned no successfully removed path (all `error` outcomes).
      recycle: async () => [],
    });
    await queue.enqueue(record('os-error', embeddedNoKeep()));
    await tick();

    const task = queue.get('os-error');
    expect(task?.state).toBe('Completed');
    expect(task?.artifacts).toEqual([MEDIA, EN, ZH]);
    expect(task?.subtitleFiles).toHaveLength(2);
  });

  it('a thrown recycle adapter cannot fail a verified download', async () => {
    const { queue } = setup({
      script: [[MEDIA, EN, ZH]],
      recycle: async () => { throw new Error('recycle bin unavailable'); },
    });
    await queue.enqueue(record('thrown', embeddedNoKeep()));
    await tick();

    const task = queue.get('thrown');
    expect(task?.state).toBe('Completed');
    expect(task?.error).toBeNull();
    expect(task?.artifacts).toEqual([MEDIA, EN, ZH]);
  });

  it('skips a subtitle path another live task still references', async () => {
    const recycled: string[][] = [];
    const { queue } = setup({
      // Task A (external subtitles) owns EN; task B (embed, no keep) must not
      // recycle that shared physical file.
      script: [[MEDIA, EN], [MEDIA, EN, ZH]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
    });
    await queue.enqueue(record('other', { ...baseSubtitle, embed: false }));
    await tick();
    expect(queue.get('other')?.state).toBe('Completed');

    await queue.enqueue(record('shared', embeddedNoKeep()));
    await tick();

    expect(recycled).toEqual([[ZH]]);
    expect(queue.get('shared')?.artifacts).toEqual([MEDIA, EN]);
    expect(queue.get('shared')?.subtitleFiles?.map((link) => link.path)).toEqual([EN]);
  });

  it('spares a stale sidecar whose filename cannot prove it belongs to this run', async () => {
    const recycled: string[][] = [];
    const { queue } = setup({
      script: [[MEDIA, STALE]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
    });
    await queue.enqueue(record('stale', embeddedNoKeep()));
    await tick();

    expect(recycled).toEqual([]);
    expect(queue.get('stale')?.artifacts).toEqual([MEDIA, STALE]);
  });

  it('a plain download with no subtitles never invokes the hook', async () => {
    const recycled: string[][] = [];
    const { queue } = setup({
      script: [[MEDIA]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
    });
    await queue.enqueue(record('plain', embeddedNoKeep({ enabled: false, languages: '' })));
    await tick();

    expect(recycled).toEqual([]);
    expect(queue.get('plain')?.artifacts).toEqual([MEDIA]);
  });

  it('production wiring: createM5Host connects trashFiles to the queue hook', async () => {
    const seen: string[][] = [];
    const mem = createInMemoryPorts();
    for (const path of [MEDIA, EN, ZH]) mem.state.files.set(path, 'bytes');
    const runs: Runs = { script: [[MEDIA, EN, ZH]], calls: [] };
    const host = await createM5Host({
      ports: mem.ports,
      engine: engineWith(runs),
      verifier: verifier(true, EMBEDDED_OK),
      // R1-02: required host option — the pre-check's cache identity.
      enginePath: 'C:/runtime/yt-dlp.exe',
      // R1-01: required host option — the pre-check's network context.
      siteSupportNetwork: () => ({}),
      jsRuntimePath: 'C:/runtime/node.exe',
      videoFixturePath: 'C:/fixtures/info-video.json',
      playlistFixturePath: 'C:/fixtures/info-flat-playlist.json',
      appVersion: '0.2.9',
      engineVersion: '2026.10.26',
      systemAppearance: {
        prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
      },
      // The SAME D-120 adapter the real Electron entry injects.
      trashFiles: {
        async trash(paths) {
          seen.push([...paths]);
          return paths.map((path) => ({ path, status: 'trashed' as const }));
        },
      },
    });
    await host.m4.task.queue.enqueue(record('wired', embeddedNoKeep()));
    await tick();

    expect(seen).toEqual([[EN, ZH]]);
    expect(host.m4.task.queue.get('wired')?.state).toBe('Completed');
    expect(host.m4.task.queue.get('wired')?.artifacts).toEqual([MEDIA]);
    host.dispose();
  });

  it('a failed verification never triggers cleanup', async () => {
    const recycled: string[][] = [];
    const { queue } = setup({
      script: [[MEDIA, EN, ZH]],
      recycle: async (paths) => { recycled.push([...paths]); return paths; },
      verifyOk: false,
    });
    await queue.enqueue(record('verify-fail', embeddedNoKeep()));
    await tick();

    expect(recycled).toEqual([]);
    expect(queue.get('verify-fail')?.state).toBe('Error');
    expect(queue.get('verify-fail')?.artifacts).toEqual([MEDIA, EN, ZH]);
  });
});
