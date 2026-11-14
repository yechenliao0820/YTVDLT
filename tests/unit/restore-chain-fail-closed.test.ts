/**
 * A-D203 · D-195 完整启动恢复链的 fail-closed 收口（restore-chain-fail-closed）。
 *
 * 既有覆盖各自只接了半条链：
 *   - `task-store.test.ts` 到 `TaskStore.load()` 的清洗为止（D-151/D-161/D-195）；
 *   - `artifact-containment-actions.test.ts` 把恢复记录手工塞进桩 queue 再驱动动作层。
 * 本文件把真实启动链一次接全，每个用例独立走完全程：
 *
 *   tasks.json 原始快照 → TaskStore.load()（结构清洗）
 *     → restoreTasks(bootQueue(...), store)（恢复报告 + Running→Canceled）
 *     → TaskQueue.restore(snapshot)（真记录表 + 写回 tasks.json）
 *     → m5-channels IPC_CHANNELS.TASK_ACTION（remove+withFiles / open-file / open-folder）
 *
 * 钉住的行为：
 *   - D-195（已落地）：损坏 request 清洗为 null 并清空 artifacts；恢复链任何一环
 *     都不让路径复活（队列记录与写回快照均为空数组）；
 *   - D-203（并行 Agent 落地中）：withFiles 删除门对 request===null 的恢复记录
 *     fail-closed —— 整批拒绝、回收站零调用、任务记录保留；
 *   - D-204（并行 Agent 落地中）：open 门对 request===null 的恢复记录 fail-closed；
 *   - D-184（既有语义，对照）：request 完好但产物越界 → withFiles 照旧整批拒绝；
 *   - 合法任务恢复后照常回收、记录照常移除（恢复链不得误伤既有用户数据）。
 *
 * 标注【依赖 D-203】/【依赖 D-204】的用例在并行行为落地前为红：这是登记的等待项，
 * 不允许为变绿而放松断言或跳过（登记见 scripts/acceptance.mjs::A-D203）。
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type {
  DownloadRequest, DownloadEngine, IShellPort,
} from '@ytvdlt/shared';
import {
  CommandTemplateStore, ConfigStore, HistoryStore, TaskDetailService, TaskQueue, TaskStore,
  buildErrorReport, formatErrorReport, restoreTasks,
} from '@ytvdlt/core';
import type {
  IArtifactVerifier, RestoreTasksResult, TaskDetailAction, TaskDetailResult,
} from '@ytvdlt/core';
import {
  createM5Handlers, type M5ChannelDeps, type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const NOW = '2026-11-05T00:00:00.000Z';

/** 与 artifact-containment-actions.test.ts 相同的完整合法 request（输出根可判定）。 */
const REQUEST: DownloadRequest = {
  taskId: 't1', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/Videos', audioDir: 'C:/Music', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp/t1' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
};

/**
 * tasks.json 里的一条原始记录（清洗前的自由形状）。默认字段全部合法，
 * 只有调用者显式覆盖的域才是被测的损坏点。
 */
const rawRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Completed',
  createdAt: NOW, updatedAt: NOW, mediaInfo: null,
  request: REQUEST, artifacts: [], lastPercent: 100, error: null,
  privateMode: false, postprocessed: false,
  ...overrides,
});

/** boot 阶段绝不引擎/校验（与 task-store.test.ts 的 D-159 链路同一约束）。 */
const BOOT_ENGINE: DownloadEngine = {
  async version() { return 'fake'; },
  async probe() { throw new Error('boot must not probe'); },
  async probePlaylist() { throw new Error('boot must not probe'); },
  download() { throw new Error('boot must not download'); },
  async selfUpdate() { return { fromVersion: '', toVersion: '', channel: 'stable', changed: false }; },
};
const BOOT_VERIFIER: IArtifactVerifier = {
  async verify() { throw new Error('boot must not verify'); },
};

const appearance: SystemAppearancePort = {
  prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
};

type Mem = ReturnType<typeof createInMemoryPorts>;

interface RestoreChainHarness {
  /** restoreTasks 的启动报告（load 诊断 + restored/interrupted 计数）。 */
  report: RestoreTasksResult;
  dispatch(channel: string, payload: unknown): Promise<Record<string, unknown>>;
  /** 每次 trashFiles.trash 调用的完整路径批次，按调用顺序。 */
  trashCalls: string[][];
  shellCalls: Array<{ op: string; path: string }>;
  /** 真实 TaskQueue 的当前记录投影（id/state/artifacts/request/lastPercent）。 */
  queueList(): Array<{ id: string; state: string; artifacts: string[]; request: unknown; lastPercent: number | null }>;
  /** 恢复链写回磁盘的 tasks.json（restore → persistSnapshot 的产物）。 */
  persistedSnapshot(): { tasks?: Array<Record<string, unknown>> } | null;
}

/**
 * 完整启动恢复链 harness：与既有两个 harness 的差异只有一点 —— queue 不再是
 * 桩，而是接在同一 TaskStore 上的真实 TaskQueue，经 restoreTasks 完成恢复，
 * m5 handlers / TaskDetailService 直接消费这条真队列。
 */
async function bootRestoreChain(rawTasks: readonly unknown[]): Promise<RestoreChainHarness> {
  const mem: Mem = createInMemoryPorts();
  mem.state.files.set(
    `${mem.state.env.configDir}/tasks.json`,
    JSON.stringify({ schemaVersion: 1, savedAt: NOW, tasks: rawTasks }),
  );

  const store = new TaskStore({ ports: mem.ports });
  const queue = new TaskQueue({
    ports: mem.ports,
    engine: BOOT_ENGINE,
    verifier: BOOT_VERIFIER,
    history: new HistoryStore({ ports: mem.ports }),
    taskStore: store,
    jsRuntimePath: 'C:/runtime/node.exe',
    persistIntervalMs: 0,
  });
  const report = await restoreTasks(queue, store);

  // 动作层看到的产物文件在假 fs 上真实存在：拒绝只能来自门本身，
  // 不是 FILE_MISSING / 文件缺席的假阳性。
  for (const task of queue.list()) {
    for (const artifact of task.artifacts) mem.state.files.set(artifact, 'video-bytes');
  }

  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();

  const trashCalls: string[][] = [];
  const shellCalls: Array<{ op: string; path: string }> = [];
  const shell: IShellPort = {
    async openPath(path: string) { shellCalls.push({ op: 'open', path }); },
    async showItemInFolder(path: string) { shellCalls.push({ op: 'reveal', path }); },
  };
  const taskDetail = new TaskDetailService({
    ports: mem.ports,
    queue,
    shell,
    buildReport: (task) => buildErrorReport({
      task, appVersion: '0.0.0', engineVersion: 'fake', os: 'win32', stderr: '',
    }, NOW),
    formatReport: formatErrorReport,
  });

  const deps: M5ChannelDeps = {
    queue,
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
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
  };
  const handlers = createM5Handlers(deps);
  const snapshotPath = `${mem.state.env.configDir}/tasks.json`;

  return {
    report,
    dispatch: async (channel: string, payload: unknown) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`unregistered channel: ${channel}`);
      return (await handler(payload)) as Record<string, unknown>;
    },
    trashCalls,
    shellCalls,
    queueList: () => queue.list().map((task) => ({
      id: task.id, state: task.state, artifacts: [...task.artifacts], request: task.request,
      lastPercent: task.lastPercent,
    })),
    persistedSnapshot: () => {
      const text = mem.state.files.get(snapshotPath);
      return text === undefined
        ? null
        : JSON.parse(text) as { tasks?: Array<Record<string, unknown>> };
    },
  };
}

describe('D-203/D-195 · 完整启动恢复链：tasks.json → load → restoreTasks → TaskQueue.restore → TASK_ACTION', () => {
  it('损坏 request 快照：清洗为 request=null + artifacts=[]，恢复链不复活，写回快照同样干净', async () => {
    const h = await bootRestoreChain([rawRecord({
      state: 'Running', lastPercent: 42,
      // 非空但结构非法：advanced 不是对象 → sanitizeRecord 把整个 request 置 null。
      request: { format: {}, subtitle: {}, paths: {}, network: {}, advanced: 'bad' },
      artifacts: ['C:/Windows/evil.mp4'],
    })]);

    // 恢复报告：load 修复 1 处（request 域），原字节有备份，Running 被恢复为 Canceled。
    expect(h.report.restored).toBe(1);
    expect(h.report.interrupted).toBe(1);
    expect(h.report.load.status).toBe('repaired-fields');
    expect(h.report.load.repairedFields).toBe(1);
    expect(h.report.load.backupPath).toMatch(/tasks\.corrupt-/);

    // 恢复进真队列的记录：request===null、artifacts===[]（D-195 清洗随链保留），
    // 任务本身与进度仍在 —— 隔离的是路径，不是用户数据。
    const restored = h.queueList();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.request).toBeNull();
    expect(restored[0]?.artifacts).toEqual([]);
    expect(restored[0]?.state).toBe('Canceled');
    expect(restored[0]?.lastPercent).toBe(42);

    // TaskQueue.restore() 写回磁盘的快照同样不携带产物路径 —— 重启循环不能让路径复活。
    const persisted = h.persistedSnapshot();
    expect(persisted?.tasks).toHaveLength(1);
    expect(persisted?.tasks?.[0]?.request).toBeNull();
    expect(persisted?.tasks?.[0]?.artifacts).toEqual([]);
  });

  it('同链路终点：清洗后的记录 withFiles 拒绝（D-203：ok:false、回收站零调用、记录保留）【依赖 D-203】', async () => {
    const h = await bootRestoreChain([rawRecord({
      state: 'Running', lastPercent: 42,
      request: { format: {}, subtitle: {}, paths: {}, network: {}, advanced: 'bad' },
      artifacts: ['C:/Windows/evil.mp4'],
    })]);
    // 前置：这条链确实清洗掉了 request 与 artifacts（D-195 语义成立才有本用例）。
    expect(h.queueList()[0]?.request).toBeNull();
    expect(h.queueList()[0]?.artifacts).toEqual([]);

    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    // D-203：request===null 的恢复记录不再是 D-120 legacy fail-open 通道。
    expect(result['ok']).toBe(false);
    expect(h.trashCalls).toEqual([]);
    // 记录保留，恢复出的状态未被破坏。
    const kept = h.queueList();
    expect(kept.map((task) => task.id)).toEqual(['t1']);
    expect(kept[0]?.state).toBe('Canceled');
    expect(kept[0]?.artifacts).toEqual([]);
  });

  it('request=null 的历史快照（产物指向可信根外）：恢复后 withFiles 整批拒绝【依赖 D-203】', async () => {
    const h = await bootRestoreChain([rawRecord({
      state: 'Completed', request: null,
      artifacts: ['C:/Windows/evil.mp4'],
    })]);

    // 旧版语义记录原样通过清洗与恢复（load 无修复、无备份），产物仍在记录里
    // —— 危险路径确实到达了动作层门口，拒绝必须由 D-203 的门做出。
    expect(h.report.load.status).toBe('ok');
    expect(h.report.restored).toBe(1);
    expect(h.queueList()[0]?.artifacts).toEqual(['C:/Windows/evil.mp4']);

    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(h.trashCalls).toEqual([]);
    // fail-closed：整批拒绝，记录与其产物清单原样保留。
    const kept = h.queueList();
    expect(kept.map((task) => task.id)).toEqual(['t1']);
    expect(kept[0]?.state).toBe('Completed');
    expect(kept[0]?.artifacts).toEqual(['C:/Windows/evil.mp4']);
  });

  it('对照 · D-184 既有语义：request 完好但产物在可信根外 → withFiles 整批拒绝、记录保留', async () => {
    const h = await bootRestoreChain([rawRecord({
      state: 'Completed',
      artifacts: ['C:/Windows/evil.mp4'], // REQUEST 的输出根：C:/Videos、C:/Music、C:/temp/t1
    })]);

    // 恢复链不动合法 request 的产物 —— 路径原样进入动作层，拒绝来自动作副门。
    expect(h.report.load.status).toBe('ok');
    expect(h.report.restored).toBe(1);
    expect(h.queueList()[0]?.artifacts).toEqual(['C:/Windows/evil.mp4']);

    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['failureKind']).toBe('file-cleanup');
    expect(String(result['reason'])).toContain('超出任务输出目录');
    expect(h.trashCalls).toEqual([]);
    const kept = h.queueList();
    expect(kept.map((task) => task.id)).toEqual(['t1']);
    expect(kept[0]?.state).toBe('Completed');
    expect(kept[0]?.artifacts).toEqual(['C:/Windows/evil.mp4']);
  });

  it('对照 · 合法任务：恢复后 withFiles 正常回收、记录按既有契约移除', async () => {
    const h = await bootRestoreChain([rawRecord({
      state: 'Completed',
      artifacts: ['C:/Videos/Title [id].mp4'],
    })]);

    expect(h.report.load.status).toBe('ok');
    expect(h.report.restored).toBe(1);
    expect(h.queueList()[0]?.request).toEqual(REQUEST);

    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(true);
    expect(result['filesTrashed']).toBe(1);
    expect(h.trashCalls).toEqual([['C:/Videos/Title [id].mp4']]);
    // 记录按既有契约移除；写回磁盘的快照同步为空。
    expect(h.queueList()).toEqual([]);
    expect(h.persistedSnapshot()?.tasks).toEqual([]);
  });

  it('D-204：request=null 恢复记录的 open-file / open-folder REFUSED，shell 零调用【依赖 D-204】', async () => {
    const h = await bootRestoreChain([rawRecord({
      state: 'Completed', request: null,
      artifacts: ['C:/Windows/evil.mp4'],
    })]);
    // 前置：记录带着产物进了真队列，且文件在假 fs 上真实存在 ——
    // 拒绝只能来自 D-204 的门，而不是 FILE_MISSING。
    expect(h.report.restored).toBe(1);
    expect(h.queueList()[0]?.artifacts).toEqual(['C:/Windows/evil.mp4']);

    const openFile = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(openFile['ok']).toBe(false);
    expect(openFile['code']).toBe('REFUSED');

    const openFolder = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' });
    expect(openFolder['ok']).toBe(false);
    expect(openFolder['code']).toBe('REFUSED');

    // shell 一次都没被碰；open 不删记录，任务仍在队列里。
    expect(h.shellCalls).toEqual([]);
    expect(h.queueList().map((task) => task.id)).toEqual(['t1']);
  });
});
