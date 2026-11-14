/**
 * D-182 · intake gate — the queue only accepts artifact paths that lie inside
 * the task's own output roots, before anything is verified, historised or
 * handed to a later consumer.
 *
 * Layer 1 of the two enforcement points (intake reject). The action-time
 * defence lives in m5-channels (delete) and task-detail (open) and is tested
 * in artifact-containment-actions.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { TaskQueue, HistoryStore } from '@ytvdlt/core';
import type {
  DownloadEngine, EngineEvent, DownloadRequest, MediaInfo, TaskRecord,
} from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const VIDEO_DIR = 'C:/Videos';
const request = (tempDir = 'C:/temp/t1'): DownloadRequest => ({
  taskId: 't1', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: VIDEO_DIR, audioDir: 'C:/Music', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
});

const mediaInfo = (): MediaInfo => ({
  id: 'fixture', title: 'fixture', uploader: 'chan', uploader_id: null, duration: 10,
  thumbnail: null, webpage_url: 'http://127.0.0.1:1/fixture.mp4', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4',
  formats: [{ format_id: '0', ext: 'mp4', width: 320, height: 240, vcodec: 'h264', acodec: 'aac', filesize: 1, filesize_approx: null, tbr: 1, fps: 25, format_note: null }],
  subtitles: {}, automatic_captions: {}, chapters: null, _type: 'video',
});

const record = (): TaskRecord => ({
  id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Idle',
  createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
  mediaInfo: null, request: request(), artifacts: [], lastPercent: null,
  error: null, privateMode: false, postprocessed: false,
});

/** Engine that reports exactly `paths` as the completed artifacts. */
function engineOf(paths: readonly string[]): DownloadEngine {
  return {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() {
      throw { code: 'UNKNOWN', message: 'x', detail: '', retryable: false, report: 'x' };
    },
    download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
      const handle = {
        pid: 4242,
        cancel: async (): Promise<boolean> => {
          onEvent({ type: 'canceled', taskId: req.taskId });
          return true;
        },
      };
      queueMicrotask(() => {
        onEvent({
          type: 'completed', taskId: req.taskId,
          artifacts: paths.map((path) => ({ taskId: req.taskId, path, kind: 'video' as const, sizeBytes: 10 })),
        });
      });
      return handle;
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };
}

const okVerifier = () => ({
  async verify(input: { artifacts: readonly string[] }) {
    return {
      taskId: 'x', artifacts: [...input.artifacts], postprocessed: false,
      criteria: [{ id: 'C1' as const, status: 'PASS' as const, detail: 'ok' }],
      ok: true, failureCode: null, durationMs: 1,
    };
  },
});

function setup(paths: readonly string[], req: DownloadRequest = request()) {
  const mem = createInMemoryPorts();
  const history = new HistoryStore({ ports: mem.ports });
  const queue = new TaskQueue({
    ports: mem.ports, engine: engineOf(paths), verifier: okVerifier(),
    history, jsRuntimePath: 'C:/runtime/node.exe',
  });
  const base = record();
  const withRequest: TaskRecord = { ...base, request: req };
  return { mem, queue, history, record: withRequest };
}

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const outsideWarnings = (mem: ReturnType<typeof createInMemoryPorts>): Array<Record<string, unknown>> =>
  mem.state.logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['event'] === 'artifact.outsideRoots');

describe('D-182 intake gate · all manifest paths outside the roots', () => {
  it('fails the run with a precise ARTIFACT_INCOMPLETE and never writes history', async () => {
    const { mem, queue, history } = setup(['C:/Windows/evil.mp4', '\\\\srv\\share\\evil.mp4']);
    await queue.enqueue(record());
    await tick();

    const task = queue.get('t1');
    expect(task?.state).toBe('Error');
    expect(task?.error?.code).toBe('ARTIFACT_INCOMPLETE');
    expect(task?.error?.message).toContain('超出任务输出目录');
    expect(task?.artifacts).toEqual([]);
    expect(await history.get('t1')).toBeNull();
    // The rejection is logged, not silent: the paths are in logs/app-*.jsonl.
    const warnings = outsideWarnings(mem);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.['level']).toBe('WARNING');
    expect(warnings[0]?.['scope']).toBe('task-queue');
    const payload = warnings[0]?.['payload'] as Record<string, unknown>;
    expect(payload['rejected']).toBe(2);
    expect(payload['paths']).toEqual(['C:/Windows/evil.mp4', '\\\\srv\\share\\evil.mp4']);
  });

  it('a `..` traversal cannot smuggle itself past the gate', async () => {
    const { queue, history } = setup(['C:/Videos/../Windows/evil.mp4']);
    await queue.enqueue(record());
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(await history.get('t1')).toBeNull();
  });
});

describe('D-182 intake gate · mixed manifest', () => {
  it('keeps only the contained artifacts; record, subtitle links and history agree', async () => {
    const { mem, queue, history } = setup([
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Windows/evil.mp4',
      'C:/Videos/Title [id].en.srt',
    ]);
    await queue.enqueue(record());
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    expect(queue.get('t1')?.artifacts).toEqual([
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Videos/Title [id].en.srt',
    ]);
    // The foreign path never reaches history.
    const entry = await history.get('t1');
    expect(entry?.videoPath).toBe('C:/Videos/Title [id]_(1).mp4');
    expect(entry?.subtitlePaths).toEqual(['C:/Videos/Title [id].en.srt']);
    // …and the drop is logged.
    expect(outsideWarnings(mem)).toHaveLength(1);
  });
});

describe('D-182 intake gate · legitimate artifacts are never dropped', () => {
  it('copies, subtitles, chapter and per-task temp paths pass without a warning', async () => {
    const { mem, queue } = setup([
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Videos/Title [id].en.srt',
      'C:/Videos/YouTube/ch/01 Intro.mp4',
      'C:/temp/t1/notes.zip',
    ]);
    await queue.enqueue(record());
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    expect(queue.get('t1')?.artifacts).toHaveLength(4);
    expect(outsideWarnings(mem)).toHaveLength(0);
  });

  it('mixed-case / backslash spellings of an inside path are accepted', async () => {
    const { queue } = setup(['c:\\VIDEOS\\Title.MP4']);
    await queue.enqueue(record());
    await tick();
    expect(queue.get('t1')?.state).toBe('Completed');
    expect(queue.get('t1')?.artifacts).toEqual(['c:\\VIDEOS\\Title.MP4']);
  });

  it('D-193 · request 存在但三个路径全不可用 → 整批拒绝转 Error（不再 fail-open）', async () => {
    // 修前这条用例把「空 roots 静默放行任意路径」当现状钉住，正是 D-184
    // 未覆盖③ 与本次在线审计 P1 指出的绕过路径。收紧后方向更严。
    const bare = request();
    const noRoots: DownloadRequest = {
      ...bare,
      paths: { ...bare.paths, videoDir: '', audioDir: '', tempDir: '' },
    };
    const { mem, queue, history } = setup(['C:/anywhere/a.mp4'], noRoots);
    await queue.enqueue({ ...record(), request: noRoots });
    await tick();
    const task = queue.get('t1');
    expect(task?.state).toBe('Error');
    expect(task?.error?.code).toBe('ARTIFACT_INCOMPLETE');
    expect(task?.artifacts).toEqual([]);
    expect(await history.get('t1')).toBeNull();
    expect(outsideWarnings(mem)).toHaveLength(1); // 拒绝有日志，不静默
  });

  it('D-193 · 快照把输出根改成盘符根也不能放行整盘', async () => {
    const bare = request();
    const wide: DownloadRequest = {
      ...bare,
      paths: { ...bare.paths, videoDir: 'C:/', audioDir: '', tempDir: '' },
    };
    const { queue, history } = setup(['C:/Windows/evil.mp4'], wide);
    await queue.enqueue({ ...record(), request: wide });
    await tick();
    expect(queue.get('t1')?.state).toBe('Error');
    expect(queue.get('t1')?.artifacts).toEqual([]);
    expect(await history.get('t1')).toBeNull();
  });
});
