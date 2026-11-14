/**
 * A-D206 · Windows 真实文件系统符号链接 / NTFS junction 安全测试
 * 被测行为：D-203 删除守卫（createTrashFilesPort 的 trashItem 前 lstat）
 *         + D-204 realpath 打开守卫（TaskDetailService.open 经 node-ports realpath 重过 containment）。
 *
 * 与 artifact-containment-actions.test.ts（M5 全链 / 假 trashItem）和
 * task-detail*.test.ts（假 fs）互补：本套件在【真实文件系统层】用 node:fs
 * 真实创建 junction / symlink fixture（一律位于 os.tmpdir() 自建目录，用后
 * 自清理），驱动真实 adapter 与真实 realpath，验证安全语义在 Windows 真实
 * 文件系统语义（大小写不敏感、reparse point、路径前缀、UNC）下成立。
 *
 * 能力探测与跳过策略（C 节，不静默跳过）：
 *   - junction 用 fs.symlink(target, link, 'junction') 创建，无需管理员权限
 *     ——所有 junction 用例【永远执行】；
 *   - 文件 / 目录符号链接在无开发者模式 / 管理员权限的 Windows 上 EPERM
 *     ——beforeAll 在 tmpdir 试建探测，无能力时相关用例用 ctx.skip(带 reason)
 *     跳过（输出显示 skipped 而非 passed，可数）；
 *   - 每个 describe 保留一条永远执行的「能力探测」用例，断言探测逻辑本身
 *     工作并输出能力状态；
 *   - 非 Windows 平台整组 describe.skipIf——CI 是 windows-latest，本套件
 *     本来就是 Windows 专项。
 *
 * 诚实边界（D 节）：
 *   1. TOCTOU：stat→trashItem 之间的真实竞态窗口无法在不依赖时序抖动的测试
 *      里钉住——登记为已知边界，本套件不写抖动测试假装覆盖。
 *   2. 【已发现缺口 → D-207 已关闭】矩阵 A-2 的字面构造（产物路径
 *      `<videoDir>/link/file.mp4`，junction 为路径【中间】组件指向根外）：
 *      D-203 守卫的 lstat 只检查路径【末段】，Windows 内核解析会静默穿透中间
 *      reparse point——真实 adapter 决策序列显示该路径会到达 trashItem（悬空
 *      变体则误入 missing 幂等分支，记录会在"以为已清理"下被移除）。D-207
 *      按建议方向修复：删除链路在 m5 withFiles 分支、trash 调用之前，对整条
 *      eligible 批做 realpath 解析后重过 isPathInsideRoots 的【整批预检】
 *      （TrashFilesPort.preflight，实现在 local-file-status-port.ts），任一路径
 *      不可证明归属 → 整批拒绝、回收站零调用、记录保留。A-2b / A-2c 已从
 *      it.fails 反向登记升级为【严格拒绝用例】（m5 全链：拒绝、reason 带真因、
 *      trashItem 零调用、记录保留），另增 A-2d 钉住「父目录可解析但真实位置
 *      越界」的判定树分支。与 D-204 的对称性：打开面跟随解析目标校验（目标
 *      在根内即放行），删除面整批预检拒绝（任一路径不可证明即不动手）。
 *   3. UNC（`\\localhost\<盘符>$\…` 管理员共享）：本地可构造性取决于 SMB
 *      会话且实测【不稳定】（可达 / UNKNOWN 抖动）——按矩阵第 8 项只做显式
 *      能力判定：探测要求连续多次 stat 成功才判"可稳定构造"；不可稳定时
 *      相关用例 ctx.skip 登记，本套件不写假用例，留给 CI / 真机。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandTemplateStore, ConfigStore,
  TaskDetailService, buildErrorReport, formatErrorReport,
  isPathInsideRoots, trustedArtifactRoots,
} from '@ytvdlt/core';
import type { DownloadRequest, IShellPort, ITaskQueue, TaskRecord } from '@ytvdlt/shared';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import { createTrashFilesPort } from '../../apps/desktop/src/main/adapters/local-file-status-port.js';
import { createNodePorts } from '../../apps/desktop/src/main/adapters/node-ports.js';
import { createM5Handlers } from '../../apps/desktop/src/main/m5-channels.js';
import type { TrashFileOutcome } from '../../apps/desktop/src/main/m5-channels.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const onWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// C 节 · 能力探测（file-level beforeAll，一次执行，全部用例共享结论）
// ---------------------------------------------------------------------------
const capabilities = {
  probed: false,
  /** 文件符号链接创建能力（无开发者模式 / 管理员的 Windows 上为 false + EPERM 原因）。 */
  fileSymlink: false,
  fileSymlinkReason: '',
  /** junction 创建能力（正常 Windows 恒 true——套件前提）。 */
  junction: false,
  junctionReason: '',
  /** UNC 管理员共享是否【稳定】可达（连续多次 stat 成功才判 true）。 */
  uncStable: false,
  uncReason: '',
};

let probeDir: string | null = null;
const tempDirs: string[] = [];

/** UNC 形态：`\\localhost\<盘符>$<剩余路径>`（要求输入为盘符绝对路径）。 */
function uncFormOf(path: string): string | null {
  const match = /^[A-Za-z]:/.exec(path);
  if (match === null) return null;
  return `\\\\localhost\\${path.slice(0, 2)}$${path.slice(2)}`;
}

/** UNC 抖动容错：小间隔重试的 stat / lstat（探测与用例内复测共用）。 */
async function stableProbe(path: string, attempts = 3, gapMs = 250): Promise<{ ok: boolean; reason: string }> {
  let lastReason = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.stat(path);
      return { ok: true, reason: '' };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? 'UNKNOWN';
      lastReason = `${code}（第 ${attempt}/${attempts} 次）`;
      if (attempt < attempts) await new Promise((resolve) => { setTimeout(resolve, gapMs); });
    }
  }
  return { ok: false, reason: lastReason };
}

async function probeCapabilities(): Promise<void> {
  capabilities.probed = true;
  const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-d206-probe-'));
  probeDir = dir;
  const targetFile = join(dir, 'target.mp4');
  await fs.writeFile(targetFile, 'probe-bytes');
  // 1) 文件符号链接能力（EPERM 是无开发者模式 / 非管理员 Windows 的预期形态）。
  const fileLink = join(dir, 'link-file');
  try {
    await fs.symlink(targetFile, fileLink, 'file');
    capabilities.fileSymlink = (await fs.lstat(fileLink)).isSymbolicLink();
    if (!capabilities.fileSymlink) capabilities.fileSymlinkReason = '创建成功但 lstat 未报符号链接（异常平台形态）';
  } catch (error) {
    capabilities.fileSymlink = false;
    const code = (error as { code?: string } | null)?.code ?? 'UNKNOWN';
    capabilities.fileSymlinkReason = `${code}: ${String((error as Error).message).split('\n')[0]}`;
  }
  // 2) junction 能力（无需权限；这是「junction 用例永远执行」的前提）。
  const junctionLink = join(dir, 'link-junction');
  try {
    await fs.symlink(dir, junctionLink, 'junction');
    capabilities.junction = (await fs.lstat(junctionLink)).isSymbolicLink();
    if (!capabilities.junction) capabilities.junctionReason = '创建成功但 lstat 未报符号链接（异常平台形态）';
  } catch (error) {
    capabilities.junction = false;
    capabilities.junctionReason = `${(error as { code?: string } | null)?.code ?? 'UNKNOWN'}`;
  }
  // 3) UNC 管理员共享稳定性（`\\localhost\<盘符>$<tmpdir>` 必须真实存在）。
  const uncTmp = uncFormOf(tmpdir());
  if (uncTmp === null) {
    capabilities.uncStable = false;
    capabilities.uncReason = 'tmpdir 非盘符路径，无法构造 \\\\localhost\\<盘符>$ 形态';
  } else {
    const verdict = await stableProbe(uncTmp);
    capabilities.uncStable = verdict.ok;
    if (!verdict.ok) capabilities.uncReason = `\\\\localhost\\<盘符>$ 对 tmpdir 不可稳定 stat：${verdict.reason}`;
  }
}

beforeAll(async () => {
  await probeCapabilities();
  console.info(
    `[A-D206] 能力状态: fileSymlink=${capabilities.fileSymlink} junction=${capabilities.junction} `
    + `uncStable=${capabilities.uncStable} | fileSymlinkReason=${capabilities.fileSymlinkReason || 'n/a'} `
    + `| uncReason=${capabilities.uncReason || 'n/a'}`,
  );
});

afterAll(() => {
  if (probeDir !== null) {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* probe hygiene only */ }
  }
});

/** 每个用例独立建/清临时目录；只清理 os.tmpdir() 下自建目录，绝不触碰仓库路径。 */
function makeCaseDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ytvdlt-d206-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

async function unlinkIfExists(path: string): Promise<void> {
  try { await fs.unlink(path); } catch { /* already gone */ }
}

afterEach(async () => {
  // junction 一律先被各用例显式 unlink；这里只兜底清理自建目录树（Node 的
  // rimraf 对 reparse point 只删链接本身、不进目标目录）。Windows 文件锁
  // 抖动时等待后重试一次；清理失败只告警不判红（卫生问题，不是安全断言）。
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[A-D206] 临时目录清理失败（仅卫生问题）: ${dir} — ${String(error)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 公共 fixture 形状（与 artifact-containment-actions.test.ts 同款 DownloadRequest）
// ---------------------------------------------------------------------------
const REQUEST: DownloadRequest = {
  taskId: 't1', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/Videos', audioDir: 'C:/Music', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp/t1' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
};

/** 真实临时目录的 roots：videoDir + tempDir 都在 os.tmpdir() 自建树下。 */
function requestFor(videoDir: string, tempDir: string): DownloadRequest {
  return { ...REQUEST, paths: { ...REQUEST.paths, videoDir, audioDir: videoDir, tempDir } };
}

function recordWith(artifacts: readonly string[], request: DownloadRequest): TaskRecord {
  return {
    id: 't1', url: request.url, kind: 'video', state: 'Completed',
    createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    mediaInfo: null, request, artifacts: [...artifacts],
    lastPercent: 100, error: null, privateMode: false, postprocessed: false,
  };
}

/** 真实删除面环境：真实 createTrashFilesPort（真实 nodeStat）+ 记录式 trashItem spy（不真正删）。 */
function trashWithSpy() {
  const received: string[] = [];
  const port = createTrashFilesPort(async (path: string) => { received.push(path); });
  return {
    port,
    received,
    async trashOne(path: string): Promise<readonly TrashFileOutcome[]> {
      return (await port.trash([path])) as readonly TrashFileOutcome[];
    },
  };
}

/** 真实打开面环境：真实 createNodePorts().fs（含 D-204 realpath）+ 真实 TaskDetailService + spy shell。 */
function openHarness(task: TaskRecord) {
  const base = mkdtempSync(join(tmpdir(), 'ytvdlt-d206-env-'));
  tempDirs.push(base);
  const ports = createNodePorts({
    packaged: false, resourcesPath: '', runtimeDir: '',
    appDataDir: base, configDir: base, logsDir: base, appVersion: '0.0.0',
  });
  const shellCalls: Array<{ op: string; path: string }> = [];
  const shell: IShellPort = {
    async openPath(path: string) { shellCalls.push({ op: 'open', path }); },
    async showItemInFolder(path: string) { shellCalls.push({ op: 'reveal', path }); },
  };
  const queue: ITaskQueue = {
    async enqueue() {}, async enqueueBatch() { return []; },
    async cancel() { return true; }, async restart() {}, async remove() { return true; },
    get: (id: string) => (id === task.id ? task : undefined),
    list: () => [task],
    onEvent: () => () => {},
    concurrency: 1, activeTaskIds: [], pendingCount: 0, setConcurrency: () => 1,
  };
  const service = new TaskDetailService({
    ports, queue, shell,
    buildReport: (t) => buildErrorReport({ task: t, appVersion: '0.0.0', engineVersion: 'fake', os: 'win32', stderr: '' }, '2026-11-14T00:00:00.000Z'),
    formatReport: formatErrorReport,
  });
  return { service, shellCalls, ports };
}

const slash = (path: string): string => path.replace(/\\/g, '/');
const reasonText = (outcome: TrashFileOutcome | undefined): string => outcome?.reason ?? '';

/**
 * D-207 全链 harness：真实 createTrashFilesPort（自带 preflight 预检）+ 记录式
 * trashItem spy（不真正删）+ 假 queue / taskDetail，驱动 createM5Handlers 的
 * TASK_ACTION `withFiles` 分支。通道层的预检接线（校验 → 拒绝 → 记录保留）
 * 只有经过这条链路才被真实覆盖——A-2b / A-2c / A-2d 用它做严格拒绝断言。
 */
function m5Harness(task: TaskRecord) {
  const mem = createInMemoryPorts();
  const config = new ConfigStore({ ports: mem.ports });
  const templates = new CommandTemplateStore({ ports: mem.ports });
  const received: string[] = [];      // trashItem spy 收到的路径
  const performCalls: string[] = [];  // taskDetail.perform 调用（含 remove）
  let current: TaskRecord | undefined = task;
  const handlers = createM5Handlers({
    queue: {
      list: () => (current === undefined ? [] : [current]),
      get: (id) => (current?.id === id ? current : undefined),
    },
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        performCalls.push(`${taskId}:${action}`);
        if (action === 'remove') current = undefined;
        return { action, ok: true, code: 'OK', message: '已删除' };
      },
    },
    templates,
    config,
    systemAppearance: { prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null },
    trashFiles: createTrashFilesPort(async (path: string) => { received.push(path); }),
  });
  const handler = handlers.get(IPC_CHANNELS.TASK_ACTION);
  if (handler === undefined) throw new Error('TASK_ACTION handler missing');
  return {
    received,
    performCalls,
    recordGone: () => current === undefined,
    removeWithFiles: (): Promise<Record<string, unknown>> =>
      handler({ taskId: task.id, action: 'remove', withFiles: true }) as Promise<Record<string, unknown>>,
  };
}

// ===========================================================================
// A · 删除面 — 真实 adapter（createTrashFilesPort）+ 记录式 trashItem spy，
// 断言 spy 零误收。Junction 用例永远执行；文件符号链接用例按能力探测跳过。
// ===========================================================================
describe.skipIf(!onWindows)('A · 删除面：真实 createTrashFilesPort + 记录式 trashItem spy（A-D206 · D-203）', () => {
  it('A-0 能力探测（永远执行）：探测逻辑工作并输出能力状态；junction 无需权限', () => {
    expect(capabilities.probed).toBe(true);
    expect(typeof capabilities.fileSymlink).toBe('boolean');
    expect(typeof capabilities.junction).toBe('boolean');
    expect(capabilities.junction).toBe(true); // junction 无需管理员——套件前提
    if (!capabilities.fileSymlink) expect(capabilities.fileSymlinkReason).not.toBe('');
    console.info(
      `[A-D206][A] symlink 用例 ${capabilities.fileSymlink ? '执行' : 'skipped（能力不可用）'}，`
      + `UNC 用例 ${capabilities.uncStable ? '执行' : 'skipped（不可稳定构造）'}`,
    );
  });

  it('A-1 可信目录内普通文件 → trashed：spy 精确收到，真实 fs 证明文件在盘', async () => {
    const root = makeCaseDir('a1');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const artifact = join(videoDir, 'episode.mp4');
    await fs.writeFile(artifact, 'real-video-bytes');
    // 真实 fs 场景证明文件真实存在（非假端口内存态）。
    const stat = await fs.stat(artifact);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe('real-video-bytes'.length);
    expect(await fs.readFile(artifact, 'utf8')).toBe('real-video-bytes');

    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(roots).not.toBeNull();
    expect(isPathInsideRoots(artifact, roots as readonly string[])).toBe(true);

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(artifact);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({ path: artifact, status: 'trashed' });
    expect(received).toEqual([artifact]); // spy 精确收到、无多收
    // 记录式 spy 非破坏性：文件仍在盘（真实 shell.trashItem 才会移入回收站）。
    expect(await fs.stat(artifact).then((s) => s.isFile())).toBe(true);
  });

  it('A-2a 指向根外的目录 junction（链接本身即产物，字符串在根内）→ 拒绝；spy 零误收；目标文件完好', async () => {
    const root = makeCaseDir('a2a');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside'); // 在 roots（videoDir/temp）之外
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'external.mp4');
    await fs.writeFile(target, 'foreign-bytes');
    const junction = join(videoDir, 'evil-link');
    await fs.symlink(outsideDir, junction, 'junction');

    // 证据链前提：产物字符串在根内（字符串门放行）——拒绝只能来自链接守卫。
    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(isPathInsideRoots(junction, roots as readonly string[])).toBe(true);

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(junction);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('error'); // 不是 trashed / missing
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]); // spy 零误收：trashItem 从未被调到
    // 拒绝是无操作：链接与目标都完好。
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('foreign-bytes');
    // 显式移除链接本身，目标不受影响。
    await unlinkIfExists(junction);
    await expect(fs.lstat(junction)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(target, 'utf8')).toBe('foreign-bytes');
  });

  it('A-2b 【D-207 修复后严格用例】中间 junction 的根内字符串产物路径被预检整批拒绝：'
    + 'trashItem 零调用、记录保留、目标文件完好、reason 指向真实路径越界',
  async () => {
    const root = makeCaseDir('a2b');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'escape.mp4');
    await fs.writeFile(target, 'outside-bytes');
    const junction = join(videoDir, 'link');
    await fs.symlink(outsideDir, junction, 'junction');
    const artifact = join(junction, 'escape.mp4'); // 产物路径字符串在根内，物理位置在根外

    // 证据链前提：字符串门放行（修复前唯一放行的门）→ 拒绝只能来自 D-207 预检。
    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(isPathInsideRoots(artifact, roots as readonly string[])).toBe(true);

    const h = m5Harness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    try {
      const result = await h.removeWithFiles();
      expect(result['ok']).toBe(false); // 拒绝，不是假装成功（修复前：status:'trashed' 放行）
      expect(result['code']).toBe('FILE_DELETE_FAILED');
      expect(result['failureKind']).toBe('file-cleanup');
      expect(String(result['reason'])).toContain('真实路径');
      expect(String(result['reason'])).toContain('之外'); // 「产物真实路径指向任务输出目录之外（符号链接/联接），已拒绝回收」
      expect(String(result['message'])).toContain('任务记录已保留');
      expect(result['filesTrashed']).toBeUndefined(); // 诚实计数：拒绝结果不含回收计数
      expect(h.received).toEqual([]); // trashItem 零误收（修复前：收到越界路径）
      expect(h.performCalls).toEqual([]); // 不调用 taskDetail.perform('remove') → 记录保留
      expect(h.recordGone()).toBe(false);
      expect(await fs.readFile(target, 'utf8')).toBe('outside-bytes'); // 目标文件完好
    } finally {
      await unlinkIfExists(junction);
    }
  });

  it('A-2c 【D-207 修复后严格用例】悬空中级 junction 的产物路径被预检拒绝（reason 带 ENOENT 真因）'
    + '而不是误报 missing：记录保留、不误入幂等分支',
  async () => {
    const root = makeCaseDir('a2c');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const junction = join(videoDir, 'dangling-link');
    await fs.symlink(join(root, 'no-such-target'), junction, 'junction');
    const artifact = join(junction, 'ghost.mp4'); // 穿透悬空中级 junction 后末段不存在

    const h = m5Harness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    try {
      const result = await h.removeWithFiles();
      expect(result['ok']).toBe(false); // 拒绝（修复前：误入 missing 幂等分支 → 记录被移除）
      expect(result['code']).toBe('FILE_DELETE_FAILED');
      expect(result['failureKind']).toBe('file-cleanup');
      expect(String(result['reason'])).toContain('ENOENT'); // 真实 errno，不是猜测
      expect(String(result['reason'])).toContain('不可判定'); // 悬空符号链接/联接 → 上下文不可判定
      expect(result['filesMissing']).toBeUndefined(); // 不得误报 missing（missing 会让记录在"以为已清理"下被移除）
      expect(String(result['message'])).toContain('任务记录已保留');
      expect(h.received).toEqual([]); // trashItem 零调用
      expect(h.performCalls).toEqual([]); // 记录保留
      expect(h.recordGone()).toBe(false);
      // 拒绝是无操作：外指 reparse point 原样保留（未做任何破坏，也未误删记录）。
      expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    } finally {
      await unlinkIfExists(junction);
    }
  });

  it('A-2d 【D-207 预检判定树】中级 junction 指向根外且外层产物已被外部删除 → 预检仍拒绝'
    + '（父目录真实路径越界），不是 missing',
  async () => {
    const root = makeCaseDir('a2d');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'vanished.mp4');
    await fs.writeFile(target, 'soon-gone');
    const junction = join(videoDir, 'link');
    await fs.symlink(outsideDir, junction, 'junction');
    const artifact = join(junction, 'vanished.mp4');
    await fs.unlink(target); // 外层真实文件已被删除；junction 目标目录仍存在且在根外

    const h = m5Harness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    try {
      const result = await h.removeWithFiles();
      // 产物本身 ENOENT，但其父目录（junction 目标）可解析且真实位置在根外
      // → 归属不可证明 → fail-closed 拒绝，而非 missing 幂等。
      expect(result['ok']).toBe(false);
      expect(result['code']).toBe('FILE_DELETE_FAILED');
      expect(String(result['reason'])).toContain('真实路径');
      expect(String(result['reason'])).toContain('之外');
      expect(result['filesMissing']).toBeUndefined();
      expect(h.received).toEqual([]); // trashItem 零调用
      expect(h.recordGone()).toBe(false); // 记录保留
      expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    } finally {
      await unlinkIfExists(junction);
    }
  });

  it('A-3 指向根外的文件符号链接 → 拒绝（无开发者模式 / 管理员时按能力探测跳过，不静默）', async (ctx) => {
    if (!capabilities.fileSymlink) {
      ctx.skip(true, `A-D206 能力判定：本机不能创建文件符号链接（${capabilities.fileSymlinkReason}）`
        + '——文件符号链接用例按 C 节策略显式跳过，junction 用例不受影响');
    }
    const root = makeCaseDir('a3');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'external.mp4');
    await fs.writeFile(target, 'foreign-bytes');
    const symlink = join(videoDir, 'evil.mp4');
    await fs.symlink(target, symlink, 'file');

    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(isPathInsideRoots(symlink, roots as readonly string[])).toBe(true);

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(symlink);
    expect(outcomes[0]?.status).toBe('error');
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]);
    expect(await fs.readFile(target, 'utf8')).toBe('foreign-bytes'); // 目标完好
    await unlinkIfExists(symlink);
  });

  it('A-4a 悬空 junction → 拒绝而非 missing（明确不误入幂等分支）', async () => {
    const root = makeCaseDir('a4a');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const junction = join(videoDir, 'dangling-j');
    await fs.symlink(join(root, 'no-such-target'), junction, 'junction'); // 目标不存在
    // 守卫能拒它，正因为 lstat（不跟随）仍把它报成符号链接。
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(junction);
    expect(outcomes[0]?.status).toBe('error'); // 不是 missing！
    expect(outcomes[0]?.status).not.toBe('missing');
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]);
    await unlinkIfExists(junction);
  });

  it('A-4b 悬空文件符号链接 → 同样拒绝而非 missing（能力允许时）', async (ctx) => {
    if (!capabilities.fileSymlink) {
      ctx.skip(true, `A-D206 能力判定：本机不能创建文件符号链接（${capabilities.fileSymlinkReason}）——按 C 节策略显式跳过`);
    }
    const root = makeCaseDir('a4b');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'later-deleted.mp4');
    await fs.writeFile(target, 'gone-soon');
    const symlink = join(videoDir, 'vanish.mp4');
    await fs.symlink(target, symlink, 'file');
    await fs.unlink(target); // 制造悬空
    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true); // lstat 不跟随，仍报符号链接

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(symlink);
    expect(outcomes[0]?.status).toBe('error');
    expect(outcomes[0]?.status).not.toBe('missing');
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]);
    await unlinkIfExists(symlink);
  });

  it('A-5 junction 循环 a→b→a → 拒绝', async () => {
    const root = makeCaseDir('a5');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const a = join(videoDir, 'loop-a');
    const b = join(videoDir, 'loop-b');
    await fs.symlink(b, a, 'junction');
    await fs.symlink(a, b, 'junction');

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(a);
    expect(outcomes[0]?.status).toBe('error');
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]);
    await unlinkIfExists(a);
    await unlinkIfExists(b);
  });

  it('A-6 路径大小写不同（记录大写、磁盘小写）→ containment 大小写不敏感放行 + 正常回收', async () => {
    const root = makeCaseDir('a6');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const onDisk = join(videoDir, 'case-episode.mp4');
    await fs.writeFile(onDisk, 'case-bytes');
    const recorded = join(videoDir, 'CASE-EPISODE.MP4'); // 记录用大写，磁盘实际小写
    expect(recorded).not.toBe(onDisk);

    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(isPathInsideRoots(recorded, roots as readonly string[])).toBe(true); // containment 大小写不敏感

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(recorded);
    expect(outcomes[0]).toEqual({ path: recorded, status: 'trashed' }); // lstat 大小写不敏感地找到了文件
    expect(received).toEqual([recorded]); // trashItem 收到的是记录里的原样字符串
  });

  it('A-7a \\?\\ 长路径前缀形态的普通产物 → 与普通路径一致：放行（trashed）', async () => {
    const root = makeCaseDir('a7a');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const onDisk = join(videoDir, 'ext.mp4');
    await fs.writeFile(onDisk, 'ext-bytes');
    const artifact = `\\\\?\\${onDisk}`; // 扩展长度前缀形态（纯反斜杠）

    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(isPathInsideRoots(artifact, roots as readonly string[])).toBe(true); // 前缀被 containment 归一化剥掉

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(artifact);
    expect(outcomes[0]).toEqual({ path: artifact, status: 'trashed' });
    expect(received).toEqual([artifact]);
    expect(await fs.stat(artifact).then((s) => s.isFile())).toBe(true); // \\?\ 形态对真实 fs 同样可达
  });

  it('A-7b \\?\\ 前缀的 junction 产物 → 与普通路径一致：拒绝（链接守卫对扩展前缀形态同样生效）', async () => {
    const root = makeCaseDir('a7b');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'external.mp4');
    await fs.writeFile(target, 'foreign-bytes');
    const junction = join(videoDir, 'ext-link');
    await fs.symlink(outsideDir, junction, 'junction');
    const artifact = `\\\\?\\${junction}`;

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(artifact);
    expect(outcomes[0]?.status).toBe('error');
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]);
    expect(await fs.readFile(target, 'utf8')).toBe('foreign-bytes'); // 目标完好
    await unlinkIfExists(junction);
  });

  it('A-8 能力判定（永远执行）：UNC 管理员共享（\\\\localhost\\<盘符>$…）稳定可达性探测', () => {
    expect(capabilities.probed).toBe(true);
    expect(typeof capabilities.uncStable).toBe('boolean');
    if (!capabilities.uncStable) {
      // 显式登记：不可稳定构造 → 未覆盖边界留给 CI / 真机，不写假用例。
      expect(capabilities.uncReason).not.toBe('');
      console.info(`[A-D206][A-8] UNC 未覆盖边界登记：${capabilities.uncReason}`);
    }
  });

  it('A-8a UNC 根（\\\\localhost\\<盘符>$…）下的真实产物 → trashed（不可稳定构造时 ctx.skip 登记）', async (ctx) => {
    if (!capabilities.uncStable) {
      ctx.skip(true, `A-D206 能力判定：UNC 管理员共享在本机不可稳定构造（${capabilities.uncReason}）`
        + '——按矩阵第 8 项登记为未覆盖边界，留给 CI / 真机');
    }
    const root = makeCaseDir('a8a');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const uncVideoDir = uncFormOf(videoDir);
    expect(uncVideoDir).not.toBeNull();
    // 用例内复测：UNC 形态对刚建好的目录必须真实可达，否则按能力判定跳过。
    const inCase = await stableProbe(uncVideoDir as string);
    if (!inCase.ok) ctx.skip(true, `A-D206 用例内复测：UNC 形态不可达（${inCase.reason}）——不写假用例`);

    await fs.writeFile(join(videoDir, 'unc.mp4'), 'unc-bytes'); // 经盘符形态写入
    const artifact = `${uncVideoDir}\\unc.mp4`;
    const roots = trustedArtifactRoots(requestFor(uncVideoDir as string, join(root, 'temp')).paths);
    expect(roots).not.toBeNull();
    expect(isPathInsideRoots(artifact, roots as readonly string[])).toBe(true);

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(artifact);
    expect(outcomes[0]).toEqual({ path: artifact, status: 'trashed' });
    expect(received).toEqual([artifact]);
  });

  it('A-8b UNC 根下的 junction 产物 → 拒绝（同 A-8a 能力门；SMB 过滤 reparse point 时显式跳过）', async (ctx) => {
    if (!capabilities.uncStable) {
      ctx.skip(true, `A-D206 能力判定：UNC 管理员共享在本机不可稳定构造（${capabilities.uncReason}）——留给 CI / 真机`);
    }
    const root = makeCaseDir('a8b');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    await fs.writeFile(join(outsideDir, 'external.mp4'), 'foreign-bytes');
    const junction = join(videoDir, 'unc-link');
    await fs.symlink(outsideDir, junction, 'junction'); // 经盘符形态创建
    const uncVideoDir = uncFormOf(videoDir);
    expect(uncVideoDir).not.toBeNull();
    const artifact = `${uncVideoDir}\\unc-link`;
    // 用例内复测 UNC 形态对 junction 的 lstat 是否报符号链接（SMB 可能过滤 reparse point）。
    const viaUnc = await fs.lstat(artifact).then(
      (s) => ({ ok: true, symlink: s.isSymbolicLink() }),
      (error) => ({ ok: false, reason: String((error as { code?: string } | null)?.code ?? error) }),
    );
    if (!viaUnc.ok) ctx.skip(true, `A-D206 用例内复测：UNC 形态 lstat 不可达（${viaUnc.reason}）——不写假用例`);
    if (!viaUnc.symlink) ctx.skip(true, 'A-D206 用例内复测：SMB 对 reparse point 的 lstat 未报符号链接（平台形态）——不写假用例');

    const { trashOne, received } = trashWithSpy();
    const outcomes = await trashOne(artifact);
    expect(outcomes[0]?.status).toBe('error');
    expect(reasonText(outcomes[0])).toContain('符号链接/联接无法验证归属');
    expect(received).toEqual([]);
    expect(await fs.readFile(join(outsideDir, 'external.mp4'), 'utf8')).toBe('foreign-bytes');
    await unlinkIfExists(junction);
  });
});

// ===========================================================================
// B · 打开面 — 真实 node-ports fs（D-204 realpath）+ 真实 TaskDetailService
// + spy shell。Junction 用例永远执行；文件符号链接用例按能力探测跳过。
// ===========================================================================
describe.skipIf(!onWindows)('B · 打开面：真实 node-ports fs + 真实 TaskDetailService + spy shell（A-D206 · D-204）', () => {
  it('B-0 能力探测（永远执行）：探测逻辑工作并输出能力状态；junction 无需权限', () => {
    expect(capabilities.probed).toBe(true);
    expect(typeof capabilities.fileSymlink).toBe('boolean');
    expect(capabilities.junction).toBe(true);
    if (!capabilities.fileSymlink) expect(capabilities.fileSymlinkReason).not.toBe('');
    console.info(
      `[A-D206][B] symlink 用例 ${capabilities.fileSymlink ? '执行' : 'skipped（能力不可用）'}；`
      + `realpath 语义参照: ELOOP=循环拒、ENOENT=缺失流程（真实 fs 已在 A 组验证）`,
    );
  });

  it('B-9 目录 junction 指向根外 + 产物在其下 → REFUSED（信息含「符号链接/联接」），shell 零调用', async () => {
    const root = makeCaseDir('b9');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    await fs.writeFile(join(outsideDir, 'real.mp4'), 'outside-bytes');
    const junction = join(videoDir, 'link');
    await fs.symlink(outsideDir, junction, 'junction');
    const artifact = join(junction, 'real.mp4'); // 字符串在根内，真实路径在根外

    const roots = trustedArtifactRoots(requestFor(videoDir, join(root, 'temp')).paths);
    expect(isPathInsideRoots(artifact, roots as readonly string[])).toBe(true); // 字符串门放行 → 拒绝必来自 realpath 重检

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    for (const action of ['open-file', 'open-folder'] as const) {
      const result = await service.perform('t1', action);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('REFUSED');
      expect(result.message).toContain('符号链接/联接'); // D-204 拒绝话术（解析后越界）
      expect(result.message).toContain('已拒绝打开');
    }
    expect(shellCalls).toEqual([]); // shell 零调用
    await unlinkIfExists(junction);
    expect(await fs.readFile(join(outsideDir, 'real.mp4'), 'utf8')).toBe('outside-bytes');
  });

  it('B-10 junction 指向根内 → OK，spy shell 收到原始（未解析）路径', async () => {
    const root = makeCaseDir('b10');
    const videoDir = join(root, 'videos');
    const realStuff = join(videoDir, 'real-stuff'); // 根内的真实子目录
    mkdirSync(realStuff, { recursive: true });
    const realFile = join(realStuff, 'real.mp4');
    await fs.writeFile(realFile, 'inside-bytes');
    const junction = join(videoDir, 'link');
    await fs.symlink(realStuff, junction, 'junction');
    const artifact = join(junction, 'real.mp4');

    // 真实 fs 证据：该路径确实经过 junction 解析（realpath ≠ 原始串）。
    const resolved = await fs.realpath(artifact);
    expect(slash(resolved)).toBe(slash(realFile));

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('OK');
    expect(shellCalls).toEqual([{ op: 'open', path: artifact }]); // 原始（未解析）路径
    await unlinkIfExists(junction);
  });

  it('B-11a 悬空 junction → open-file 走 FILE_MISSING 流程（不当安全拒绝吞掉）', async () => {
    const root = makeCaseDir('b11a');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const junction = join(videoDir, 'ghost-link');
    await fs.symlink(join(root, 'no-such-target'), junction, 'junction');
    const artifact = join(videoDir, 'ghost-link'); // 产物即悬空链接

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FILE_MISSING'); // realpath ENOENT → 缺失流程，不是 REFUSED
    expect(result.message).toContain('产物不存在');
    expect(shellCalls).toEqual([]);
    await unlinkIfExists(junction);
  });

  it('B-11b 悬空 junction → open-folder 走目录回退（fileMissing=true，打开的是父目录）', async () => {
    const root = makeCaseDir('b11b');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const junction = join(videoDir, 'ghost-link');
    await fs.symlink(join(root, 'no-such-target'), junction, 'junction');
    const artifact = join(videoDir, 'ghost-link');

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('OK');
    expect(result.fileMissing).toBe(true); // D-120 回退标记
    // 回退打开的是产物父目录（trusted root 本身），且绝不经悬空链接。
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.op).toBe('open');
    expect(slash(shellCalls[0]?.path ?? '')).toBe(slash(videoDir));
    await unlinkIfExists(junction);
  });

  it('B-11c 悬空文件符号链接 → FILE_MISSING（能力允许时）', async (ctx) => {
    if (!capabilities.fileSymlink) {
      ctx.skip(true, `A-D206 能力判定：本机不能创建文件符号链接（${capabilities.fileSymlinkReason}）——按 C 节策略显式跳过`);
    }
    const root = makeCaseDir('b11c');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const target = join(outsideDir, 'later-deleted.mp4');
    await fs.writeFile(target, 'gone-soon');
    const symlink = join(videoDir, 'ghost.mp4');
    await fs.symlink(target, symlink, 'file');
    await fs.unlink(target); // 制造悬空
    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);

    const { service, shellCalls } = openHarness(recordWith([symlink], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FILE_MISSING');
    expect(result.message).toContain('产物不存在');
    expect(shellCalls).toEqual([]);
    await unlinkIfExists(symlink);
  });

  it('B-12 junction 循环 a→b→a → REFUSED（fail-closed，不是 FILE_MISSING）', async () => {
    const root = makeCaseDir('b12');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const a = join(videoDir, 'loop-a');
    const b = join(videoDir, 'loop-b');
    await fs.symlink(b, a, 'junction');
    await fs.symlink(a, b, 'junction');
    const artifact = a; // 字符串在根内

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED'); // ELOOP → 无法证明路径安全 → fail-closed
    expect(result.code).not.toBe('FILE_MISSING'); // 明确不是缺失流程
    expect(result.message).toContain('无法解析产物真实路径');
    expect(result.message).toContain('无法证明路径安全');
    expect(shellCalls).toEqual([]);
    await unlinkIfExists(a);
    await unlinkIfExists(b);
  });

  it('B-13 大小写变体路径 → OK，shell 收到记录（大写）路径', async () => {
    const root = makeCaseDir('b13');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const onDisk = join(videoDir, 'case-episode.mp4');
    await fs.writeFile(onDisk, 'case-bytes');
    const recorded = join(videoDir, 'CASE-EPISODE.MP4');

    const { service, shellCalls } = openHarness(recordWith([recorded], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('OK'); // realpath 归一化（盘面真实大小写）后仍在根内
    expect(shellCalls).toEqual([{ op: 'open', path: recorded }]); // 用户可见的记录原样路径
  });

  it('B-14 \\?\\ 长路径前缀形态产物 → OK，shell 收到 \\?\\ 原始形态（raw 结果不做改写）', async () => {
    const root = makeCaseDir('b14');
    const videoDir = join(root, 'videos');
    mkdirSync(videoDir, { recursive: true });
    const onDisk = join(videoDir, 'ext-open.mp4');
    await fs.writeFile(onDisk, 'ext-bytes');
    const artifact = `\\\\?\\${onDisk}`;
    // 真实 fs 证据：realpath 把 \\?\ 形态解析为普通形态（containment 归一化可判）。
    expect(slash(await fs.realpath(artifact))).toBe(slash(onDisk));

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('OK');
    expect(shellCalls).toEqual([{ op: 'open', path: artifact }]); // 原始 \\?\ 形态直达 shell
  });

  it('B-15 \\?\\ 前缀的 junction 产物（指向根外）→ REFUSED（realpath 穿透前缀与链接）', async () => {
    const root = makeCaseDir('b15');
    const videoDir = join(root, 'videos');
    const outsideDir = join(root, 'outside');
    mkdirSync(videoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    await fs.writeFile(join(outsideDir, 'real.mp4'), 'outside-bytes');
    const junction = join(videoDir, 'ext-link');
    await fs.symlink(outsideDir, junction, 'junction');
    const artifact = `\\\\?\\${join(junction, 'real.mp4')}`;

    const { service, shellCalls } = openHarness(recordWith([artifact], requestFor(videoDir, join(root, 'temp'))));
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REFUSED');
    expect(result.message).toContain('已拒绝打开'); // 解析到根外 / 无法解析均为此话术
    expect(shellCalls).toEqual([]);
    await unlinkIfExists(junction);
  });
});

// ===========================================================================
// C · 能力探测与跳过策略（不静默跳过）——任意平台执行，验证探测机制本身。
// ===========================================================================
describe('C · 能力探测与跳过策略（不静默跳过）', () => {
  it('C-1 探测已执行、结论完备：跳过只允许来自能力判定，且 reason 必须可追溯', () => {
    expect(capabilities.probed).toBe(true);
    for (const key of ['fileSymlink', 'junction', 'uncStable'] as const) {
      expect(typeof capabilities[key]).toBe('boolean');
    }
    // 无能力必须有显式原因（登记口径），有能力则原因留空。
    if (!capabilities.fileSymlink) expect(capabilities.fileSymlinkReason).not.toBe('');
    if (!capabilities.junction) expect(capabilities.junctionReason).not.toBe('');
    if (!capabilities.uncStable) expect(capabilities.uncReason).not.toBe('');
    // 本套件的跳过面（与实现一致，防止未来引入静默跳过）：
    //   - 文件符号链接用例：A-3 / A-4b / B-11c —— 仅当 fileSymlink=false；
    //   - UNC 用例：A-8a / A-8b —— 仅当 uncStable=false（或用例内复测失败）；
    //   - junction 用例（含 A-2b / A-2c / A-2d）永远执行；
    //   - A-2b / A-2c 不是跳过也不是 it.fails：D-207 修复后已升级为严格拒绝
    //     用例（m5 全链断言），永远执行。
    console.info(
      `[A-D206][C] 跳过面: fileSymlink-gated=[A-3,A-4b,B-11c](${capabilities.fileSymlink ? '执行' : 'skipped'}), `
      + `UNC-gated=[A-8a,A-8b](${capabilities.uncStable ? '执行' : 'skipped'}), `
      + `strict-refusal(D-207)=[A-2b,A-2c,A-2d](永远执行), junction 用例永远执行=${capabilities.junction}`,
    );
    expect(true).toBe(true); // 断言本体即上面的完备性检查
  });
});
