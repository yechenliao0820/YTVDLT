/**
 * Stage 4 · the queue's subtitle bookkeeping.
 *
 * The record must answer two questions the renderer cannot answer itself:
 * which subtitle files exist (and for which language / from which bucket), and
 * whether the request's languages were actually delivered. A retry must forget
 * both — a second run that produced no subtitle may not inherit the first run's
 * links.
 */
import { describe, it, expect } from 'vitest';
import { ArtifactVerifier, HistoryStore, TaskQueue } from '@ytvdlt/core';
import type {
  AttachmentProbe, DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { bucketOf, mediaInfo as mediaFixture, trackOf } from './helpers/subtitle-media.js';

const MEDIA = 'C:/out/Clip [id].mp4';
const EN = 'C:/out/Clip [id].en.srt';
const ZH = 'C:/out/Clip [id].zh-Hans.srt';

const subtitleDomain: DownloadRequest['subtitle'] = {
  enabled: true, languages: 'en,zh-Hans', autoCaptions: false,
  skipTranslated: true, convertTo: 'srt', embed: false, keepSubtitleFile: false,
};

const request = (taskId: string, subtitle = subtitleDomain): DownloadRequest => ({
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

const record = (taskId: string): TaskRecord => ({
  id: taskId, url: 'https://example.org/v', kind: 'video', state: 'Idle',
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  mediaInfo: null, request: request(taskId), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

/** The media info carries BOTH buckets, so `source` has real evidence. */
const probedMedia = (): MediaInfo => mediaFixture({
  subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('zh-Hans', 'vtt')),
  automatic_captions: bucketOf(trackOf('de', 'vtt')),
});

interface Runs {
  /** Artifacts of the NEXT download call, in order. */
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
      const handle = { pid: 1, cancel: async () => true };
      queueMicrotask(() => {
        onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: paths.map((path) => ({
            taskId: req.taskId, path, kind: 'video' as const, sizeBytes: 10,
          })),
        });
      });
      return handle;
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

/**
 * Verifier whose verdict is scripted per call: `[true]` always passes, `[false, true]`
 * fails the first run (→ `Error`, which is the only state `restart()` accepts
 * from a finished task) and passes the retry.
 */
const scriptedVerifier = (verdicts: boolean[], attachments: readonly AttachmentProbe[]) => ({
  async verify(input: { taskId: string; artifacts: string[] }) {
    const ok = verdicts.length === 0 ? true : (verdicts.length === 1 ? verdicts[0] : verdicts.shift());
    return {
      taskId: input.taskId, artifacts: input.artifacts, postprocessed: false,
      criteria: [{ id: 'C1' as const, status: (ok ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL', detail: 'ok' }],
      ok: ok as boolean, failureCode: ok ? null : ('ARTIFACT_INCOMPLETE' as const), durationMs: 1,
      attachments,
    };
  },
});

function setup(script: string[][], verdicts: boolean[] = [true], attachments: readonly AttachmentProbe[] = [], realVerifier = false) {
  const mem = createInMemoryPorts();
  for (const path of [MEDIA, EN, ZH]) mem.state.files.set(path, 'bytes');
  const runs: Runs = { script: [...script], calls: [] };
  const history = new HistoryStore({ ports: mem.ports });
  const queue = new TaskQueue({
    ports: mem.ports, engine: engineWith(runs),
    verifier: realVerifier ? new ArtifactVerifier({ ports: mem.ports }) : scriptedVerifier([...verdicts], attachments),
    history, jsRuntimePath: 'C:/runtime/node.exe',
  });
  return { mem, queue, history, runs };
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stage 4 · TaskQueue subtitle bookkeeping', () => {
  it('rejects HTML subtitle delivery without failing the media or losing history', async () => {
    const { queue, mem, history } = setup([[MEDIA, EN]], [true], [], true);
    mem.state.files.set(EN, '<!DOCTYPE html><html>Sign in</html>');
    mem.state.spawnResults.set('ffprobe.exe', {
      exitCode: 0, stdout: JSON.stringify({
        format: { duration: '212' },
        streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }],
      }), stderr: '', timedOut: false,
    });
    mem.state.spawnResults.set('-f null -', { exitCode: 0, stdout: '', stderr: '', timedOut: false });
    mem.state.spawnResults.set('framemd5', { exitCode: 0, stdout: 'x\n', stderr: '', timedOut: false });
    const task = record('html');
    task.request = request('html', { ...subtitleDomain, languages: 'en' });
    await queue.enqueue(task);
    await tick();
    expect(queue.get('html')?.state).toBe('Completed');
    expect(queue.get('html')?.error).toBeNull();
    expect(queue.get('html')?.subtitleOutcome).toBe('missing');
    expect((await history.query({}))).toHaveLength(1);
  });

  it('reports partial when only one delivered subtitle fails its advisory probe', async () => {
    const { queue } = setup([[MEDIA, EN, ZH]], [true], [
      { path: EN, kind: 'subtitle', status: 'FAIL', detail: 'HTML' },
      { path: ZH, kind: 'subtitle', status: 'PASS', detail: 'SRT' },
    ]);
    await queue.enqueue(record('partial'));
    await tick();
    expect(queue.get('partial')?.state).toBe('Completed');
    expect(queue.get('partial')?.subtitleOutcome).toBe('partial');
  });

  it.each(['PASS', 'FAIL', 'SKIPPED'] as const)('reconciles embed-only delivery with %s probe', async (status) => {
    const { queue } = setup([[MEDIA]], [true], [{ path: MEDIA, kind: 'subtitle', status, detail: 'embedded probe' }]);
    const task = record('embed');
    task.request = request('embed', { ...subtitleDomain, enabled: false, embed: true });
    await queue.enqueue(task);
    await tick();
    expect(queue.get('embed')?.state).toBe('Completed');
    expect(queue.get('embed')?.subtitleOutcome).toBe(status === 'PASS' ? 'ok' : 'missing');
  });

  it('reports partial when sidecars arrive but requested embedding fails', async () => {
    const { queue } = setup([[MEDIA, EN, ZH]], [true], [
      { path: MEDIA, kind: 'subtitle', status: 'FAIL', detail: 'no subtitle stream' },
    ]);
    const task = record('embed-fail');
    task.request = request('embed-fail', { ...subtitleDomain, embed: true });
    await queue.enqueue(task);
    await tick();
    expect(queue.get('embed-fail')?.state).toBe('Completed');
    expect(queue.get('embed-fail')?.subtitleOutcome).toBe('partial');
  });

  it.each(['audio', 'sections', 'chapters'] as const)('does not expect suppressed embed-only delivery for %s', async (mode) => {
    const { queue } = setup([[MEDIA]]);
    const task = record(mode);
    const base = request(mode, { ...subtitleDomain, enabled: false, embed: true });
    task.request = {
      ...base,
      format: { ...base.format, extractAudio: mode === 'audio' },
      advanced: { ...base.advanced, splitChapters: mode === 'chapters', downloadSections: mode === 'sections' ? '*0-5' : null },
    };
    await queue.enqueue(task);
    await tick();
    expect(queue.get(mode)?.state).toBe('Completed');
    expect(queue.get(mode)?.subtitleOutcome).toBe('none');
  });

  it('links the subtitle files and reports "ok" when all requested languages arrived', async () => {
    const { queue, history } = setup([[MEDIA, EN, ZH]]);
    await queue.enqueue(record('t1'));
    await tick();

    const task = queue.get('t1');
    expect(task?.state).toBe('Completed');
    expect(task?.subtitleFiles).toEqual([
      { path: EN, language: 'en', ext: 'srt', source: 'manual', mediaPath: MEDIA },
      { path: ZH, language: 'zh-Hans', ext: 'srt', source: 'manual', mediaPath: MEDIA },
    ]);
    expect(task?.subtitleOutcome).toBe('ok');

    // History: the video is the media, the subtitles are attachments.
    const entries = await history.query({});
    expect(entries[0]?.videoPath).toBe(MEDIA);
    expect(entries[0]?.subtitlePaths).toEqual([EN, ZH]);
  });

  it('reports "none" when the request never asked for subtitles', async () => {
    const { queue } = setup([[MEDIA]]);
    const plain = record('t2');
    plain.request = request('t2', { ...subtitleDomain, enabled: false });
    await queue.enqueue(plain);
    await tick();
    expect(queue.get('t2')?.subtitleFiles).toEqual([]);
    expect(queue.get('t2')?.subtitleOutcome).toBe('none');
  });

  it('reports "missing" when a subtitle request produced no file', async () => {
    const { queue } = setup([[MEDIA]]);
    await queue.enqueue(record('t3'));
    await tick();
    expect(queue.get('t3')?.subtitleFiles).toEqual([]);
    expect(queue.get('t3')?.subtitleOutcome).toBe('missing');
  });

  it('forgets the previous run on retry (no stale links, no stale outcome)', async () => {
    // First run: artifacts include the subtitles, but verification fails → the
    // task is `Error` (the only state a retry is allowed from). The links are
    // still on the record, which is exactly what must not survive the retry.
    const { queue } = setup([[MEDIA, EN, ZH], [MEDIA]], [false, true]);
    await queue.enqueue(record('t4'));
    await tick();
    expect(queue.get('t4')?.state).toBe('Error');
    expect(queue.get('t4')?.subtitleOutcome).toBe('ok');

    await queue.restart('t4');
    // The retry clears the links immediately…
    expect(queue.get('t4')?.subtitleFiles).toEqual([]);
    expect(queue.get('t4')?.subtitleOutcome).toBeUndefined();

    await tick();
    // …and the second run (media only) ends as "missing", not as the old "ok".
    expect(queue.get('t4')?.subtitleOutcome).toBe('missing');
  });

  it('keeps the history pointing at the media even when the engine lists a subtitle first', async () => {
    const { queue, history } = setup([[EN, MEDIA]]);
    await queue.enqueue(record('t5'));
    await tick();
    const task = queue.get('t5');
    // The queue does not reorder the engine's list…
    expect(task?.artifacts?.[0]).toBe(EN);
    // …but nothing downstream treats index 0 as "the file": the link and the
    // history both resolve to the video.
    expect(task?.subtitleFiles?.[0]?.mediaPath).toBe(MEDIA);
    const entries = await history.query({});
    expect(entries[0]?.videoPath).toBe(MEDIA);
  });
});
