/**
 * D-182 · action-time containment (layer 2, defence in depth).
 *
 * The intake gate (task-queue, layer 1) already keeps foreign paths out of
 * records created in this session; these tests pin what the DESTRUCTIVE
 * actions do when a record nevertheless carries one (restored / manipulated
 * snapshot):
 *   - `withFiles` removal refuses the WHOLE batch before anything is trashed;
 *   - `open-file` / `open-folder` refuse an outside target (core task-detail);
 *   - D-203 (breaking change, supersedes the frozen D-120 tolerance): a record
 *     without a usable request has no trustworthy roots, and the recycle gate
 *     now fails CLOSED for it — the batch is refused and the record is kept.
 *
 * The D-203 suite below also exercises the real trash adapter
 * (`createTrashFilesPort`) against REAL filesystem entries under `os.tmpdir()`:
 * a plain file still recycles, and a real NTFS junction is refused before the
 * destructive call (junctions need no administrator rights to create).
 *
 * D-207 closes the two A-D206 findings this suite's fixtures could not express:
 * a MIDDLE-path junction escapes the name-level containment (the kernel
 * resolves it silently) — the whole batch is now pre-flighted (realpath
 * re-check) and refused before the recycle bin is ever reached; and a mixed
 * batch (legit file + link) can no longer push the legit file into the bin
 * first and then fail the batch without saying so. A provably-gone file
 * (deleted externally, parent intact) keeps the D-120 idempotent `missing`
 * flow through the same pre-flight.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { DownloadRequest, TaskRecord } from '@ytvdlt/shared';
import {
  CommandTemplateStore, ConfigStore, TaskDetailService, TaskStore,
  buildErrorReport, formatErrorReport,
} from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import type { IShellPort } from '@ytvdlt/shared';
import {
  createM5Handlers, type M5ChannelDeps, type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createTrashFilesPort } from '../../apps/desktop/src/main/adapters/local-file-status-port.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const REQUEST: DownloadRequest = {
  taskId: 't1', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/Videos', audioDir: 'C:/Music', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp/t1' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
};

const record = (artifacts: readonly string[], withRequest: boolean = true): TaskRecord => ({
  id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Completed',
  createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
  mediaInfo: null, request: withRequest ? REQUEST : null, artifacts: [...artifacts],
  lastPercent: 100, error: null, privateMode: false, postprocessed: false,
});

const appearance: SystemAppearancePort = {
  prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
};

interface Harness {
  dispatch(channel: string, payload: unknown): Promise<Record<string, unknown>>;
  trashCalls: string[][];
  shellCalls: Array<{ op: string; path: string }>;
  performCalls: string[];
  recordGone(): boolean;
}

async function harness(
  initial: TaskRecord,
  /** D-203: lets a suite wire the REAL trash adapter instead of the fake. */
  overrides: Partial<M5ChannelDeps> = {},
): Promise<Harness> {
  const mem = createInMemoryPorts();
  for (const artifact of initial.artifacts) mem.state.files.set(artifact, 'video-bytes');
  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();

  const trashCalls: string[][] = [];
  const shellCalls: Array<{ op: string; path: string }> = [];
  const performCalls: string[] = [];
  let current: TaskRecord | undefined = initial;
  const shell: IShellPort = {
    async openPath(path: string) { shellCalls.push({ op: 'open', path }); },
    async showItemInFolder(path: string) { shellCalls.push({ op: 'reveal', path }); },
  };
  const taskDetail = new TaskDetailService({
    ports: mem.ports,
    queue: {
      async enqueue() {}, async enqueueBatch() { return []; },
      async cancel() { return true; }, async restart() {},
      async remove(id: string) {
        if (current?.id === id) current = undefined;
        return true;
      },
      get: (id) => (current?.id === id ? current : undefined),
      list: () => (current === undefined ? [] : [current]),
      onEvent: () => () => {},
      concurrency: 1, activeTaskIds: [], pendingCount: 0, setConcurrency: () => 1,
    },
    shell,
    buildReport: (task) => buildErrorReport({
      task, appVersion: '0.0.0', engineVersion: 'fake', os: 'win32', stderr: '',
    }, '2026-11-14T00:00:00.000Z'),
    formatReport: formatErrorReport,
  });

  const deps: M5ChannelDeps = {
    queue: {
      list: () => (current === undefined ? [] : [current]),
      get: (id) => (current?.id === id ? current : undefined),
    },
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        performCalls.push(`${taskId}:${action}`);
        return taskDetail.perform(taskId, action);
      },
    },
    templates,
    config,
    systemAppearance: appearance,
    trashFiles: {
      async trash(paths) {
        trashCalls.push([...paths]);
        return paths.map((path) => ({ path, status: 'trashed' as const }));
      },
    },
    ...overrides,
  };
  const handlers = createM5Handlers(deps);
  return {
    dispatch: async (channel: string, payload: unknown) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`unregistered channel: ${channel}`);
      return (await handler(payload)) as Record<string, unknown>;
    },
    trashCalls,
    shellCalls,
    performCalls,
    recordGone: () => current === undefined,
  };
}

describe('D-182 · withFiles removal refuses paths outside the record roots', () => {
  it('refuses the WHOLE batch before any trash and keeps the record', async () => {
    const h = await harness(record(['C:/Videos/a.mp4', 'C:/Windows/evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(String(result['reason'])).toContain('超出任务输出目录');
    expect(result['failureKind']).toBe('file-cleanup');
    // Nothing was trashed, nothing was removed, the refusal is not silent.
    expect(h.trashCalls).toEqual([]);
    expect(h.performCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });

  it('a `..` traversal recorded in a snapshot cannot be trashed either', async () => {
    const h = await harness(record(['C:/Videos/../../evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(h.trashCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });

  it('all-contained artifacts still flow through D-120 unchanged', async () => {
    const h = await harness(record([
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Videos/Title [id].en.srt',
      'C:/Music/Title [id].mp3',
    ]));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(true);
    expect(h.trashCalls).toEqual([[
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Videos/Title [id].en.srt',
      'C:/Music/Title [id].mp3',
    ]]);
    expect(h.recordGone()).toBe(true);
  });

  it('D-203 · a record without a request now fails CLOSED (was D-120 fail-open)', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4'], false));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['failureKind']).toBe('file-cleanup');
    expect(String(result['reason'])).toContain('无法验证产物文件归属');
    expect(String(result['message'])).toContain('任务记录已保留');
    // Nothing is trashed and the record (with its history) is kept — the user
    // falls back to "history only" removal by unticking the option.
    expect(h.trashCalls).toEqual([]);
    expect(h.performCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });
});

describe('D-182 · open actions refuse an outside target (core task-detail)', () => {
  it('open-file returns REFUSED and never calls the shell', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('REFUSED');
    expect(h.shellCalls).toEqual([]);
    expect(h.performCalls).toEqual(['t1:open-file']);
  });

  it('open-folder refuses the same way (it would reveal the parent dir)', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('REFUSED');
    expect(h.shellCalls).toEqual([]);
  });

  it('an inside target keeps the D-120 open behaviour (file present → shell)', async () => {
    const h = await harness(record(['C:/Videos/a.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result['ok']).toBe(true);
    expect(h.shellCalls).toEqual([{ op: 'open', path: 'C:/Videos/a.mp4' }]);
  });

  it('D-204: a request-less record is REFUSED by open too (fail-closed)', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4'], false));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    // D-204 closed the last fail-open: no request → no verdict → REFUSED,
    // shell 零调用（与 D-203 的删除链路语义一致：归属无法验证就不动手）。
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('REFUSED');
    expect(h.shellCalls).toEqual([]);
    expect(h.performCalls).toEqual(['t1:open-file']);
  });
});

// ---------------------------------------------------------------------------
// D-193 · 在线审计 P1：恢复/损坏快照不得让两道门同时失效
// 两道门的 roots 都来自同一条记录；request 存在但 paths 无可用根时，
// 旧的 fail-open 会让任意路径进回收站 / 被 shell 打开。
// ---------------------------------------------------------------------------
describe('D-193 · damaged/restored snapshots cannot bypass the action gate', () => {
  /** A record WITH a request (so it is not the request-less D-203 case). */
  const damaged = (overrides: Partial<DownloadRequest['paths']>): TaskRecord => {
    const base = record(['C:/Windows/evil.mp4']);
    return { ...base, request: { ...REQUEST, paths: { ...REQUEST.paths, ...overrides } } };
  };

  it('paths 三个目录全空 → withFiles 整批拒绝，零回收且记录保留', async () => {
    const h = await harness(damaged({ videoDir: '', audioDir: '', tempDir: '' }));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    // D-203 unified message: unusable request info = ownership unverifiable.
    expect(String(result['message'])).toContain('无法验证产物文件归属');
    expect(String(result['message'])).toContain('任务记录已保留');
    expect(h.trashCalls).toEqual([]);
    expect(h.performCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });

  it('paths 被改成盘符根 → 同样拒绝（不能让 inside 等于整盘）', async () => {
    const h = await harness(damaged({ videoDir: 'C:/', audioDir: '', tempDir: '' }));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(h.trashCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });

  it('损坏快照的 open-file 返回 REFUSED，shell 零调用', async () => {
    const h = await harness(damaged({ videoDir: '', audioDir: '', tempDir: '' }));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('REFUSED');
    expect(h.shellCalls).toEqual([]);
  });

  it('D-203 · request-less legacy 不再 fail-open：整批拒绝、零回收、记录保留', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4'], false));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['failureKind']).toBe('file-cleanup');
    expect(String(result['reason'])).toContain('无法验证产物文件归属');
    expect(result['failedCount']).toBe(1);
    expect(h.trashCalls).toEqual([]);
    expect(h.performCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-195 · 在线审计 P2：损坏快照 → 恢复 → 文件删除的完整链路
// 修前：sanitizeRecord 把结构非法的 request 置 null，却留下 artifacts；
// 动作层把 request===null 当旧版兼容记录 fail-open → 任意路径进回收站。
// D-203 起该链路 fail-closed：request===null（无论 artifacts 是否已被清洗为
// 空）→ 整批拒绝、记录保留；用户可取消勾选仅删历史。
// ---------------------------------------------------------------------------
describe('D-195 · damaged snapshot → recovery → withFiles (end to end)', () => {
  it('被清洗为 request=null 的记录：产物路径不会到达回收站，记录保留（D-203 fail-closed）', async () => {
    const mem = createInMemoryPorts();
    const store = new TaskStore({ ports: mem.ports });
    const damaged = {
      id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Completed',
      createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
      mediaInfo: null,
      // 非空但结构非法：advanced 不是对象 → D-161 把整个 request 置 null。
      request: { format: {}, subtitle: {}, paths: {}, network: {}, advanced: 'bad' },
      artifacts: ['C:/Windows/evil.mp4'],
      lastPercent: 100, error: null, privateMode: false, postprocessed: false,
    };
    mem.state.files.set(
      `${mem.state.env.configDir}/tasks.json`,
      JSON.stringify({ schemaVersion: 1, savedAt: '2026-11-14T00:00:00.000Z', tasks: [damaged] }),
    );

    const snapshot = await store.load();
    const recovered = snapshot.tasks[0];
    expect(recovered?.request).toBeNull();
    expect(recovered?.artifacts).toEqual([]);
    expect(recovered?.id).toBe('t1'); // 任务历史仍在

    // TaskQueue.restore() 只做 shallow copy + 状态归一，不改 artifacts；把
    // 恢复结果直接交给动作层，即该链路的终点。D-203：request 为 null 时
    // 归属不可验证 → 整批拒绝，记录（连同其历史）原样保留。
    const h = await harness(recovered as TaskRecord);
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);        // 拒绝，不再假装“已删除”
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(String(result['message'])).toContain('无法验证产物文件归属');
    expect(h.trashCalls.flat()).toEqual([]); // 零个本地文件被回收
    expect(h.recordGone()).toBe(false);      // 记录保留，等用户明确选择仅删历史
  });

  it('D-203 · 对照组：真正的旧版无 request 记录同样整批拒绝、零回收', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4'], false));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(h.trashCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-203 · request-less records fail CLOSED + the adapter's link guard, checked
// against the REAL filesystem (os.tmpdir) and the REAL trash adapter with a
// recording (non-destructive) trashItem. Junctions are used because file
// symlinks need administrator/developer-mode rights; a junction is
// indistinguishable from a symlink under lstat.
// ---------------------------------------------------------------------------
describe('D-203 · recycle gate vs real filesystem entries', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); // self-created tmp only
    }
  });

  /** A real temp tree: <root>/videos is the request's (trustworthy) output root. */
  const makeRealTree = (): { root: string; videoDir: string } => {
    const root = mkdtempSync(join(tmpdir(), 'ytvdlt-d203-'));
    cleanup.push(root);
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    return { root, videoDir };
  };

  const requestFor = (videoDir: string, tempDir: string): DownloadRequest => ({
    ...REQUEST,
    paths: { ...REQUEST.paths, videoDir, audioDir: videoDir, tempDir },
  });

  it('request===null + a plausible output path is refused WITHOUT touching the file', async () => {
    const { videoDir } = makeRealTree();
    const plausible = join(videoDir, 'holiday.mp4');
    await fs.writeFile(plausible, 'x');
    const h = await harness(record([plausible], false), {
      trashFiles: createTrashFilesPort(async () => {
        throw new Error('trashItem must never be called for an unverifiable record');
      }),
    });
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(String(result['message'])).toContain('缺少可用的下载请求信息');
    expect(h.recordGone()).toBe(false);
    expect(await fs.readFile(plausible, 'utf8')).toBe('x'); // the file is untouched
  });

  it('a real file inside determinable roots still recycles (no regression)', async () => {
    const { root, videoDir } = makeRealTree();
    const artifact = join(videoDir, 'episode.mp4');
    await fs.writeFile(artifact, 'video-bytes');
    const trashed: string[] = [];
    // The harness record() helper carries REQUEST (C:/Videos roots); swap in
    // the real temp roots so the real file is contained.
    const target = { ...record([artifact], true), request: requestFor(videoDir, join(root, 'temp')) };
    const h = await harness(target, {
      trashFiles: createTrashFilesPort(async (path) => { trashed.push(path); }),
    });
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(true);
    expect(result['filesTrashed']).toBe(1);
    expect(trashed).toEqual([artifact]);
    expect(h.recordGone()).toBe(true);
  });

  it('a real NTFS junction inside the roots is refused and the count is honest', async () => {
    const { root, videoDir } = makeRealTree();
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    await fs.writeFile(join(outside, 'external.mp4'), 'foreign');
    const junction = join(videoDir, 'evil-link');
    // junction = directory link; lstat reports it as a symlink, no admin needed.
    await fs.symlink(join(root, 'outside'), junction, 'junction');
    const trashed: string[] = [];
    const target = { ...record([junction], true), request: requestFor(videoDir, join(root, 'temp')) };
    const h = await harness(target, {
      trashFiles: createTrashFilesPort(async (path) => { trashed.push(path); }),
    });
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['failureKind']).toBe('file-cleanup');
    expect(result['failedCount']).toBe(1); // the honest per-outcome count
    expect(String(result['reason'])).toContain('符号链接/联接无法验证归属');
    expect(trashed).toEqual([]); // trashItem was never reached
    expect(h.recordGone()).toBe(false);
    // The junction and its target both survive.
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(outside, 'external.mp4'), 'utf8')).toBe('foreign');
  });

  // -------------------------------------------------------------------------
  // D-207 · 批内混合的诚实计数：合法根内文件 + 根内 junction → 整批拒绝、
  // 回收站零调用。修复前：通道层先调 trash（合法文件先进回收站），随后才因
  // 链接错误整批拒绝，拒绝结果不含 filesTrashed——用户不知道部分文件已进
  // 回收站。修复后：预检在 trash 之前对整批校验，任何一个路径不可证明归属
  // → 整批拒绝，回收站从未被调用。
  // -------------------------------------------------------------------------
  it('D-207 · a MIXED batch (legit file + inside junction) is refused as a WHOLE — nothing enters the bin first', async () => {
    const { root, videoDir } = makeRealTree();
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    await fs.writeFile(join(outside, 'external.mp4'), 'foreign');
    const legit = join(videoDir, 'episode.mp4');
    await fs.writeFile(legit, 'video-bytes');
    const junction = join(videoDir, 'evil-link');
    await fs.symlink(join(root, 'outside'), junction, 'junction');
    const trashed: string[] = [];
    const target = { ...record([legit, junction], true), request: requestFor(videoDir, join(root, 'temp')) };
    const h = await harness(target, {
      trashFiles: createTrashFilesPort(async (path) => { trashed.push(path); }),
    });
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['failureKind']).toBe('file-cleanup');
    expect(result['failedCount']).toBe(1); // exactly one unprovable path; the WHOLE batch refused with it
    expect(String(result['reason'])).toContain('符号链接/联接无法验证归属');
    expect(result['filesTrashed']).toBeUndefined(); // honest counting: no trashed number on a refused batch
    expect(trashed).toEqual([]); // trashItem ZERO calls — the legit file did NOT enter the bin first
    expect(h.recordGone()).toBe(false); // record kept
    // Nothing on disk changed either: the legit file and the junction survive.
    expect(await fs.readFile(legit, 'utf8')).toBe('video-bytes');
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(outside, 'external.mp4'), 'utf8')).toBe('foreign');
  });

  // -------------------------------------------------------------------------
  // D-207 · 回归：普通缺失文件（父目录真实存在、上下文可判定）经预检仍走
  // D-120 幂等 missing → 记录移除。预检只把「不可判定」的缺失升级为拒绝，
  // 不改变合法的已删除场景。
  // -------------------------------------------------------------------------
  it('D-207 · a file deleted externally (parent intact) still flows missing → record removed (D-120 unchanged)', async () => {
    const { root, videoDir } = makeRealTree();
    const artifact = join(videoDir, 'gone.mp4');
    await fs.writeFile(artifact, 'gone');
    await fs.unlink(artifact); // deleted externally; videoDir itself still exists
    const trashed: string[] = [];
    const target = { ...record([artifact], true), request: requestFor(videoDir, join(root, 'temp')) };
    const h = await harness(target, {
      trashFiles: createTrashFilesPort(async (path) => { trashed.push(path); }),
    });
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(true);
    expect(result['filesMissing']).toBe(1); // counted by the pre-flight, honestly
    expect(result['filesTrashed']).toBe(0);
    expect(trashed).toEqual([]); // the provably-gone path never reaches the trash call
    expect(h.recordGone()).toBe(true); // D-120 idempotency intact: record removed
  });
});
