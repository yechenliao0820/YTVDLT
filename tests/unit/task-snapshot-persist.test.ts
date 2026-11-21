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
  it('六个进度 tick 只多落一次结构性快照，其余全部跳过', async () => {
    const { queue, rewrites } = session('jitter');
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.state).toBe('Running');
    // D-242: TWO structural writes now — the record itself at enqueue (the
    // audit P2 gap: an immediately-started task used to reach disk only on its
    // first tick) and the one tick that first shows `Running` /
    // `lastStage=downloading`. Ticks 2-6 change only numbers.
    expect(rewrites).toHaveLength(2);
    const persisted = parse(rewrites[1] ?? '{}');
    expect(persisted.tasks).toHaveLength(1);
    expect(persisted.tasks[0]?.state).toBe('Running');
    expect(persisted.tasks[0]?.lastStage).toBe('downloading');
    // The one structural write captured the FIRST tick; ticks 2-6 changed only
    // numbers, which is exactly the D-163 contract under test.
    expect(persisted.tasks[0]?.lastPercent).toBe(1);
  });
});

describe('D-163 · 结构性变化仍及时落盘', () => {
  it('stage 推进在下一个进度 tick 落盘，其后恢复跳过', async () => {
    const { queue, rewrites } = session('stage');
    await queue.enqueue(record('t1'));
    await tick();

    // enqueue record (D-242) → tick 1 writes `downloading` → the next tick
    // after the marker writes `merging`; the remaining progress ticks change
    // nothing structural.
    expect(rewrites).toHaveLength(3);
    const second = parse(rewrites[2] ?? '{}');
    expect(second.tasks[0]?.lastStage).toBe('merging');
    expect(second.tasks[0]?.lastPercent).toBe(20);
  });

  it('任务结束（状态 + 产物）强制落盘，投影保持脱敏且 thumbnail 保留', async () => {
    const { queue, rewrites } = session('complete');
    await queue.enqueue(record('t1'));
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    // enqueue record (D-242) + mid-run tick + the unconditional
    // `run().finally` write.
    expect(rewrites).toHaveLength(3);
    const final = parse(rewrites[2] ?? '{}');
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

/**
 * Task-2 audit follow-up (checklist §14「同一序列化边界」): a throttled `void`
 * progress persist (t1, held by the gate) racing another task's awaited
 * `run().finally` persist (t2). Every snapshot is a full-state view, so the
 * NEWER snapshot must be the LAST bytes on disk. Before the snapshot write
 * queue this test was RED: the held write let the t2 snapshot complete first,
 * leaving the older full snapshot as the final file content until the next
 * structural change happened to persist again.
 */
describe('Task-2 audit · 并发快照按提交顺序落盘（新快照必是最后字节）', () => {
  it('进度节流写与另一任务的结束写重叠时，较旧快照先落盘、较新快照最后落盘', async () => {
    const mem = createInMemoryPorts();
    const rewrites: string[] = [];
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    // 钉住第一份（不含 t2 的）快照写；含 t2 的较新快照不拦。
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    // D-242: the FIRST tasks.json write is t1's own enqueue record; the one to
    // pin is the next one (t1's `Running` tick), which is what makes the
    // ordering hazard observable.
    let tasksWrites = 0;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (path.endsWith('tasks.json')) {
        tasksWrites += 1;
        if (tasksWrites === 2) await firstHeld;
        rewrites.push(text);
      }
      await inner(path, text);
    };

    // t1 = jitter（六个 tick 后挂在 Running，产生被节流放行的 void 持久化）；
    // t2 = complete（很快结束，run().finally 触发结束持久化）。
    const engine: DownloadEngine = {
      async version() { return 'fake'; },
      async probe() { return mediaInfo(); },
      async probePlaylist() { throw new Error('not used'); },
      download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
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
        if (req.taskId === 't1') {
          for (let i = 1; i <= 6; i += 1) onEvent(progress(i, i * 10, 99 - i));
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
    const queue = new TaskQueue({
      ports: mem.ports,
      engine,
      verifier: okVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
    });

    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    // W1（t1 的进度快照）此刻被钉在写入口，尚未落地。
    //
    // D-242: `enqueue()` now awaits its OWN snapshot write, so t2's intake
    // cannot be awaited while W1 is pinned (it would queue behind it). Start it
    // without awaiting — the ordering guarantee under test is about the writes,
    // not about the intake call returning.
    const t2Intake = queue.enqueue(record('t2'));
    await tick();
    // D-259: t2's intake write (W2) is queued behind the held W1, so t2 must
    // NOT have started — write-then-start means a record that has not reached
    // disk never competes for a slot. The old order pumped t2 immediately and
    // it completed inside this tick.
    expect(queue.get('t2')?.state).toBe('Idle');
    expect(queue.activeTaskIds).not.toContain('t2');
    // 写队列（新）里 W2 排在 W1 之后——两者都还没落盘。
    // 旧实现这里 rewrites 已有 1 条（W2 抢在 W1 之前完成），本断言即红。
    // D-242: rewrites[0] is t1's enqueue record, still the only landed write.
    expect(rewrites).toHaveLength(1);

    releaseFirst();
    await t2Intake;
    await tick();
    // W2 flushed, the intake resumed, and only NOW did pump() start t2.
    expect(queue.get('t2')?.state).toBe('Completed');
    // 提交序：W1（t1 进度，无 t2）→ W2（t2 入队，未完成）→ …（t2 自己的 tick）
    // → 最后一份（t2 Completed）。关键不变量：最新的全量快照必是最后落盘的
    // 字节，且在它之前落盘的快照绝不能宣称 t2 已完成。
    expect(rewrites.length).toBeGreaterThanOrEqual(4);
    expect(parse(rewrites[1] ?? '{}').tasks.some((task) => task.id === 't2')).toBe(false);
    for (const text of rewrites.slice(1, -1)) {
      const state = parse(text).tasks.find((task) => task.id === 't2')?.state;
      expect(state).not.toBe('Completed');
    }
    const last = parse(rewrites[rewrites.length - 1] ?? '{}');
    expect(last.tasks.find((task) => task.id === 't2')?.state).toBe('Completed');
  });
});

/**
 * D-231 (audit P2) · a task the user already confirmed must not exist only in
 * memory while it waits for a slot.
 *
 * The old `enqueue()` updated the record map, pushed the id into the FIFO and
 * called `pump()` — and wrote nothing. A parked task emits no progress and has
 * no `run().finally`, so until ANOTHER task happened to tick, the waiting row
 * lived only in RAM: quitting (or crashing) in that window lost a download the
 * UI had already shown as queued.
 *
 * The fix persists the record inside `enqueue()` before it returns. D-242
 * extended it to the immediately-started case: a run's first snapshot is its
 * first progress tick, so a crash during `probe()` left that task in no file at
 * all. `enqueueBatch()` nests the same rule so a 200-line TXT import costs ONE
 * serialisation instead of 200.
 */
describe('D-231 · 排队任务在 enqueue 返回前落盘', () => {
  /** A download that never emits an event: the run hangs in `Running`. */
  const silentEngine: DownloadEngine = {
    async version() { return 'fake'; },
    async probe() { return mediaInfo(); },
    async probePlaylist() { throw new Error('not used'); },
    download() {
      return { pid: 1, cancel: async () => true };
    },
    async selfUpdate() {
      return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
    },
  };

  const parkedSession = (concurrency: number) => {
    const mem = createInMemoryPorts();
    const rewrites: string[] = [];
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (path.endsWith('tasks.json')) rewrites.push(text);
      await inner(path, text);
    };
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: silentEngine,
      verifier: okVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
      concurrency,
    });
    return { mem, queue, rewrites };
  };

  it('并发已满时，第二个任务的入队立刻写进 tasks.json', async () => {
    const { queue, rewrites } = parkedSession(1);
    await queue.enqueue(record('t1'));
    expect(queue.activeTaskIds).toEqual(['t1']);

    await queue.enqueue(record('t2'));
    // Parked, and already on disk — no tick, no task end required.
    // D-242: t1's own enqueue record is write #1 now; t2 lands in write #2.
    expect(queue.get('t2')?.state).toBe('Idle');
    expect(rewrites).toHaveLength(2);
    const persisted = parse(rewrites[1] ?? '{}');
    expect(persisted.tasks.map((task) => task.id).sort()).toEqual(['t1', 't2']);
    expect(persisted.tasks.find((task) => task.id === 't2')?.state).toBe('Idle');
  });

  it('批量入队只写一次，且每个排队成员都在这次写入里', async () => {
    const { queue, rewrites } = parkedSession(1);
    await queue.enqueue(record('b1'));
    await queue.enqueueBatch([record('b2'), record('b3')]);

    // D-242: b1's intake is write #1; the whole batch is still ONE write.
    expect(rewrites).toHaveLength(2);
    const persisted = parse(rewrites[1] ?? '{}');
    expect(persisted.tasks.map((task) => task.id).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(persisted.tasks.filter((task) => task.state === 'Idle')).toHaveLength(2);
  });

  it('槽位空闲时启动的任务同样在 enqueue 返回前落盘（D-242）', async () => {
    const { queue, rewrites } = parkedSession(3);
    await queue.enqueue(record('s1'));
    // Started, not parked — and STILL on disk before `enqueue()` returned. The
    // old rule ("a started task is covered by its run lifecycle") left the
    // whole probe phase unpersisted, so a crash there lost the row entirely.
    expect(queue.activeTaskIds).toEqual(['s1']);
    expect(rewrites).toHaveLength(1);
    expect(parse(rewrites[0] ?? '{}').tasks.map((task) => task.id)).toEqual(['s1']);
  });
});

/**
 * D-231 · the same rule covers `restart()`: a retry that parks behind a busy
 * slot changes the record (Error → ReadyWithInfo) and has no other writer, so
 * a crash before the next tick used to restore the OLD terminal state — the
 * retry silently vanished while the card already showed it.
 */
describe('D-231 · 排队中的重试同样落盘', () => {
  it('restart 一个失败任务、槽位被占时，新状态立刻写进 tasks.json', async () => {
    const mem = createInMemoryPorts();
    const rewrites: string[] = [];
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (path.endsWith('tasks.json')) rewrites.push(text);
      await inner(path, text);
    };
    // `slow` never finishes (it holds the only slot); every other id completes
    // with an artifact that the verifier rejects, so the record settles as Error.
    const engine: DownloadEngine = {
      async version() { return 'fake'; },
      async probe() { return mediaInfo(); },
      async probePlaylist() { throw new Error('not used'); },
      download(req: DownloadRequest, onEvent: (e: EngineEvent) => void) {
        const handle = { pid: 1, cancel: async () => true };
        if (req.taskId === 'slow') return handle;
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
    const failingVerifier = {
      async verify() {
        return {
          taskId: 'x', artifacts: [], postprocessed: false,
          criteria: [{ id: 'C1' as const, status: 'FAIL' as const, detail: 'rejected' }],
          ok: false, failureCode: 'ARTIFACT_INCOMPLETE' as const, durationMs: 1,
        };
      },
    };
    const queue = new TaskQueue({
      ports: mem.ports,
      engine,
      verifier: failingVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
      concurrency: 1,
    });

    await queue.enqueue(record('bad'));
    for (let i = 0; i < 100 && queue.get('bad')?.state !== 'Error'; i += 1) await tick(5);
    expect(queue.get('bad')?.state).toBe('Error');

    // A second task takes the only slot and never finishes.
    await queue.enqueue(record('slow'));
    expect(queue.activeTaskIds).toEqual(['slow']);

    await queue.restart('bad');
    // Parked behind `slow`, but the new state is already durable.
    expect(queue.get('bad')?.state).not.toBe('Error');
    expect(queue.get('bad')?.error ?? null).toBeNull();
    const last = parse(rewrites[rewrites.length - 1] ?? '{}');
    expect(last.tasks.find((task) => task.id === 'bad')?.state).toBe('ReadyWithInfo');
    expect(last.tasks.find((task) => task.id === 'bad')?.error ?? null).toBeNull();
  });
});

describe('D-236 · tasks.json 不携带代理密码', () => {
  const PROXY = 'http://user:SuperSecretPw@proxy.local:8080';
  const BACKFILL = 'http://fresh:BackfilledPw@proxy.local:8080';

  const recordWithProxy = (taskId: string, proxy: string | null): TaskRecord => {
    const base = record(taskId);
    const req = base.request;
    if (req === null) return base;
    return { ...base, request: { ...req, network: { ...req.network, proxy } } };
  };

  it('落盘的投影 proxy 置空，内存记录原样保留（本轮 argv 还要用）', async () => {
    const { queue, rewrites } = session('complete');
    await queue.enqueue(recordWithProxy('t1', PROXY));
    await tick();

    expect(queue.get('t1')?.state).toBe('Completed');
    // The in-memory request keeps the proxy — THIS session's argv needs it.
    expect(queue.get('t1')?.request?.network.proxy).toBe(PROXY);
    // The persisted copy never carries it: D-163's "signed links never touch
    // disk" now covers the one credential-bearing request field. tasks.json
    // is exactly the file users attach to bug reports.
    const persisted = parse(rewrites[rewrites.length - 1] ?? '{}');
    expect(persisted.tasks[0]?.request?.network.proxy).toBeNull();
    expect(JSON.stringify(persisted)).not.toContain('SuperSecretPw');
  });

  it('restore 经宿主钩子回填当前配置的 proxy（当前配置为准）', async () => {
    const mem = createInMemoryPorts();
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: fakeEngine({ mode: 'complete', downloadCalls: 0 }),
      verifier: okVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
      // The production shape of the hook (task-host.ts): re-inject the live
      // config proxy so a restart neither loses the proxy nor revives a
      // removed one.
      repairRestoredRequest: (request) => ({
        ...request,
        network: { ...request.network, proxy: BACKFILL },
      }),
    });
    const snapshot = parse(JSON.stringify({ tasks: [recordWithProxy('t1', null)] }));
    await queue.restore(snapshot);
    expect(queue.get('t1')?.request?.network.proxy).toBe(BACKFILL);
    // The rehydrated request is what restart() runs on — the fake engine
    // completes within the tick, which proves the run actually happened.
    await queue.restart('t1');
    await tick();
    expect(queue.get('t1')?.state).toBe('Completed');
  });

  it('无钩子时 restore 原样保留（core 层无配置可读，缺省安全）', async () => {
    const { queue } = session('complete');
    const snapshot = parse(JSON.stringify({ tasks: [recordWithProxy('t1', null)] }));
    await queue.restore(snapshot);
    expect(queue.get('t1')?.request?.network.proxy).toBeNull();
  });
});

/**
 * D-240 (audit P1) · a private-mode row never reaches the snapshot.
 *
 * The old cleanup hook only ran on window close, and skipped running tasks —
 * but the running task was ALREADY in `tasks.json`, so a crash / kill (no hook
 * at all) restored it as a `Canceled` row on the next launch: the very record
 * the user asked not to keep. Privacy is now a property of the WRITE, so every
 * shutdown path is covered without killing a live download.
 */
describe('D-240 · 无痕任务不落盘，重启不会复活', () => {
  it('privateMode 记录被排除在 tasks.json 之外，普通记录照常落盘', async () => {
    const { queue, rewrites } = session('complete');
    await queue.enqueue({ ...record('normal'), privateMode: false });
    await queue.enqueue({ ...record('secret'), privateMode: true });
    await tick();

    const persisted = parse(rewrites[rewrites.length - 1] ?? '{}');
    expect(persisted.tasks.map((task) => task.id)).toEqual(['normal']);
    expect(JSON.stringify(persisted)).not.toContain('secret');
    // In memory it still exists and behaves like any other task.
    expect(queue.get('secret')?.privateMode).toBe(true);
  });

  it('只有无痕任务时，快照里一条都不剩', async () => {
    const { queue, rewrites } = session('complete');
    await queue.enqueue({ ...record('only-private'), privateMode: true });
    await tick();

    expect(rewrites.length).toBeGreaterThan(0);
    expect(parse(rewrites[rewrites.length - 1] ?? '{}').tasks).toHaveLength(0);
  });

  it('旧快照里的无痕记录在 restore 时被丢弃，且不再出现在重写后的文件里', async () => {
    const { queue, rewrites } = session('complete');
    const legacy = parse(JSON.stringify({
      tasks: [
        { ...record('old-private'), privateMode: true, state: 'Running' },
        { ...record('old-normal'), privateMode: false, state: 'Canceled' },
      ],
    }));
    const restored = await queue.restore(legacy);

    expect(restored).toBe(1);
    expect(queue.get('old-private')).toBeUndefined();
    expect(queue.get('old-normal')?.state).toBe('Canceled');
    const persisted = parse(rewrites[rewrites.length - 1] ?? '{}');
    expect(persisted.tasks.map((task) => task.id)).toEqual(['old-normal']);
  });
});

/**
 * D-242 (audit P2) · a swallowed snapshot failure must not be reported as
 * success. The two user-visible lies were "the task is queued" (nothing on
 * disk) and "the private row was cleaned up" (the row was still on disk).
 */
describe('D-242 · 快照写盘失败不再谎报成功', () => {
  /**
   * Ports whose tasks.json write fails WHILE `fail` is set, like a full /
   * locked disk. Toggleable so a test can first put a record into a known
   * good state and only then break the disk for the mutation under test.
   */
  const failingSession = (mode: Mode = 'complete') => {
    const mem = createInMemoryPorts();
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    let fail = true;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail && path.endsWith('tasks.json')) throw new Error('ENOSPC: no space left on device');
      await inner(path, text);
    };
    const engineState: EngineState = { mode, downloadCalls: 0 };
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: fakeEngine(engineState),
      verifier: okVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
    });
    return { mem, queue, engineState, setFail: (value: boolean): void => { fail = value; } };
  };

  it('入队时快照写失败 → enqueue 抛错、任务零启动、内存零残留（D-259）', async () => {
    const { queue, engineState } = failingSession();
    await expect(queue.enqueue(record('t1'))).rejects.toThrow(/任务未能加入队列：队列快照未能写入磁盘/);
    // D-259: the intake is ROLLED BACK — memory agrees with the disk the
    // write never reached, and "未能加入队列" is literally true now: the
    // record never entered the FIFO, pump() never ran, nothing spawned. (The
    // pre-D-259 order pumped first, so the download ran while the caller was
    // told the enqueue had failed — and the record was left in memory.)
    expect(queue.get('t1')).toBeUndefined();
    expect(queue.pendingCount).toBe(0);
    expect(queue.activeTaskIds).toEqual([]);
    expect(engineState.downloadCalls).toBe(0);
    await tick();
    // The rolled-back state is stable: no run is in flight to resurrect it.
    expect(queue.get('t1')).toBeUndefined();
    expect(engineState.downloadCalls).toBe(0);
  });

  it('删除时快照写失败 → remove 抛错且记录留在内存（与磁盘一致）', async () => {
    const { queue, setFail } = failingSession();
    setFail(false);
    await queue.enqueue(record('t1'));
    await tick(); // let the run finish so the slot is free

    setFail(true);
    await expect(queue.remove('t1')).rejects.toThrow(/未能从队列快照中删除/);
    expect(queue.get('t1')).toBeDefined();
  });

  it('重试时快照写失败 → restart 抛错、任务零启动、记录回到重启前状态（D-263）', async () => {
    const { queue, engineState, setFail } = failingSession('jitter');
    setFail(false);
    await queue.enqueue(record('t1'));
    await tick();
    expect(queue.get('t1')?.state).toBe('Running');
    expect(await queue.cancel('t1')).toBe(true);
    await tick();
    // Completed is terminal and restartable states are Error/Canceled — a
    // killed-true cancel is the deterministic way here to land on `Canceled`.
    expect(queue.get('t1')?.state).toBe('Canceled');
    expect(queue.activeTaskIds).not.toContain('t1');
    const canceled = queue.get('t1');

    setFail(true);
    await expect(queue.restart('t1')).rejects.toThrow(/任务未能重试：队列快照未能写入磁盘/);
    // D-263: the retry is ROLLED BACK to the exact pre-restart record — same
    // defect shape as D-259's enqueue, plus restart mutates the live record in
    // place (transitions + D-107/D-115 resets), so the old order left memory
    // (Canceled→Idle, fields wiped) disagreeing with the disk while a fresh
    // process was already spawning. Now: nothing spawned, nothing parked, and
    // 「任务未能重试」 is literally true.
    expect(queue.get('t1')).toEqual(canceled);
    expect(queue.isPending('t1')).toBe(false);
    expect(queue.activeTaskIds).toEqual([]);
    expect(engineState.downloadCalls).toBe(1); // only the pre-cancel run
    await tick();
    // The rolled-back state is stable: no run is in flight to resurrect it.
    expect(queue.get('t1')).toEqual(canceled);
    expect(engineState.downloadCalls).toBe(1);

    // Disk heals → the same restart now proceeds end to end (Canceled → Idle,
    // pump fills the slot, the run starts probing).
    setFail(false);
    await queue.restart('t1');
    await tick();
    expect(['Idle', 'FetchingInfo', 'ReadyWithInfo', 'Running']).toContain(queue.get('t1')?.state);
    await queue.cancel('t1');
    await tick();
    expect(queue.get('t1')?.state).toBe('Canceled');
  });
});

/**
 * D-259 (audit P3) · a failed snapshot write must not rewrite the queue's own
 * bookkeeping behind the caller's back.
 *
 *   ① `remove()` on a QUEUED task: the write-failure path restored the record
 *      into the map but NOT into the FIFO — the task became a ghost (a record
 *      no pump() can ever reach, a card that can neither run nor cancel).
 *      The fix restores the EXACT pre-remove FIFO position, the same shape
 *      the cancel() pending branch has had since D-242.
 *   ② For contrast, a D-231 batch is EXEMPT from write-then-start on purpose:
 *      members park + start per member and ONE write at batch end reports the
 *      failure for members that legitimately already started. Pinned here so
 *      the exemption cannot drift into "batch members never start either".
 */
describe('D-259 · 写失败不改变队列事实：FIFO 原位还原 / 批量豁免', () => {
  /** Downloads run until the test finishes them, so the slot stays occupied. */
  function manualEngine() {
    const started: string[] = [];
    const open = new Map<string, (event: EngineEvent) => void>();
    const engine: DownloadEngine = {
      async version() { return 'fake'; },
      async probe() { return mediaInfo(); },
      async probePlaylist() { throw new Error('not used'); },
      download(req: DownloadRequest, onEvent: (event: EngineEvent) => void) {
        started.push(req.taskId);
        open.set(req.taskId, onEvent);
        return {
          pid: 1,
          cancel: async () => {
            onEvent({ type: 'canceled', taskId: req.taskId });
            open.delete(req.taskId);
            return true;
          },
        };
      },
      async selfUpdate() {
        return { fromVersion: '', toVersion: '', channel: 'stable', changed: false };
      },
    };
    const finish = (taskId: string): void => {
      const emit = open.get(taskId);
      if (emit === undefined) throw new Error(`task ${taskId} is not running`);
      open.delete(taskId);
      emit({
        type: 'completed', taskId,
        artifacts: [{ taskId, path: `C:/out/${taskId}.mp4`, kind: 'video', sizeBytes: 1 }],
      });
    };
    return { engine, started, finish };
  }

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  /** concurrency 1 + a toggleable tasks.json sabotage + the manual engine. */
  const parkedFailingSession = () => {
    const mem = createInMemoryPorts();
    const inner = mem.ports.fs.writeTextAtomic.bind(mem.ports.fs);
    let fail = false;
    mem.ports.fs.writeTextAtomic = async (path: string, text: string): Promise<void> => {
      if (fail && path.endsWith('tasks.json')) throw new Error('ENOSPC: no space left on device');
      await inner(path, text);
    };
    const manual = manualEngine();
    const queue = new TaskQueue({
      ports: mem.ports,
      engine: manual.engine,
      verifier: okVerifier,
      history: new HistoryStore({ ports: mem.ports }),
      taskStore: new TaskStore({ ports: mem.ports }),
      jsRuntimePath: 'C:/runtime/node.exe',
      persistIntervalMs: 0,
      concurrency: 1,
    });
    return { mem, queue, manual, setFail: (value: boolean): void => { fail = value; } };
  };

  it('① 删除排队任务写失败 → 记录与 FIFO 原位都还原，之后仍按原顺序被 pump', async () => {
    const { queue, manual, setFail } = parkedFailingSession();
    setFail(false);
    await queue.enqueue(record('t1')); // takes the only slot and hangs there
    await waitFor(() => manual.started.includes('t1'));
    await queue.enqueue(record('t2')); // FIFO: [t2]
    await queue.enqueue(record('t3')); // FIFO: [t2, t3]
    await queue.enqueue(record('t4')); // FIFO: [t2, t3, t4]
    expect(queue.pendingCount).toBe(3);
    expect(queue.isPending('t3')).toBe(true);

    setFail(true);
    await expect(queue.remove('t3')).rejects.toThrow(/未能从队列快照中删除/);
    // D-259 ①: BOTH halves of the pre-remove state are back — the record in
    // the map AND its exact FIFO slot between t2 and t4. The pre-fix code put
    // the record back but left the FIFO without the id: a ghost that pump()
    // can never reach again.
    expect(queue.get('t3')).toBeDefined();
    expect(queue.isPending('t3')).toBe(true);
    expect(queue.pendingCount).toBe(3);

    // Drain the queue and prove the ghost claim wrong: t3 runs, in its
    // original order (t2 → t3 → t4). No restore at all would hang this
    // waitFor; a restore at the wrong end would reorder the starts.
    setFail(false);
    manual.finish('t1');
    await waitFor(() => manual.started.includes('t2'));
    manual.finish('t2');
    await waitFor(() => manual.started.includes('t3'));
    expect(manual.started.slice(0, 3)).toEqual(['t1', 't2', 't3']);
    manual.finish('t3');
    await waitFor(() => manual.started.includes('t4'));
    expect(manual.started).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('② D-231 批量豁免保持：批次成员照常启动，批次末尾的写失败如实上报', async () => {
    const { queue, manual, setFail } = parkedFailingSession();
    setFail(false);
    await queue.enqueue(record('t1')); // occupies the only slot
    await waitFor(() => manual.started.includes('t1'));

    // The disk breaks BEFORE the batch — members still park and (as slots
    // allow) start; the batch-end write reports the failure once, for the
    // whole batch, without faking success.
    setFail(true);
    await expect(queue.enqueueBatch([record('b1'), record('b2')]))
      .rejects.toThrow(/批量任务已入队，但队列快照未能写入磁盘/);
    // Members are parked behind the busy slot exactly as D-231 prescribes.
    expect(queue.isPending('b1')).toBe(true);
    expect(queue.isPending('b2')).toBe(true);
    expect(queue.pendingCount).toBe(2);

    // And they still start when the slot frees — the exemption is about the
    // write order, never about freezing the queue.
    setFail(false);
    manual.finish('t1');
    await waitFor(() => manual.started.includes('b1'));
    manual.finish('b1');
    await waitFor(() => manual.started.includes('b2'));
    expect(manual.started).toEqual(['t1', 'b1', 'b2']);
  });
});
