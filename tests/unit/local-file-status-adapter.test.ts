/**
 * D-120 · the real adapter's idempotent cleanup contract.
 *
 * `shell.trashItem` is injected; the assertions here are about which paths
 * are EVER handed to it. A missing or unreadable file must never reach it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyTrashError, createTrashFilesPort, preflightTrashPaths, reasonOf,
} from '../../apps/desktop/src/main/adapters/local-file-status-port.js';
import type { StatOutcome } from '../../apps/desktop/src/main/local-file-status.js';
import type { TrashFileOutcome, TrashFilesPort } from '../../apps/desktop/src/main/m5-channels.js';

// ---------------------------------------------------------------------------
// D-203 的条目级 lstat 守卫在 `createTrashFilesPort` 里直接用真实 `fs.lstat`
// （不在构造注入面上）。这里放一个 passthrough mock：注册过的路径返回假件
// （`isSymbolicLink` 可控），其余路径全部透传真实 lstat —— 既有用例的磁盘行为
// 逐字节不变，而「条目级悬空 junction（lstat 报符号链接）」可以被假件显式钉住。
// ---------------------------------------------------------------------------
const lstatState = vi.hoisted(() => ({
  overrides: new Map<string, { isSymbolicLink(): boolean }>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = Object.create(actual.promises) as typeof actual.promises;
  promises.lstat = (async (path: string) => {
    const override = lstatState.overrides.get(path);
    if (override !== undefined) return override;
    return actual.promises.lstat(path);
  }) as unknown as typeof actual.promises.lstat;
  return { ...actual, promises };
});

const FILE = 'C:/Videos/clip.mp4';

function fixture(stat: Record<string, StatOutcome>, trashError?: unknown) {
  const trashed: string[] = [];
  const port = createTrashFilesPort(
    async (path) => {
      if (trashError !== undefined) throw trashError;
      trashed.push(path);
    },
    async (path) => stat[path] ?? { kind: 'error', code: 'ENOENT' },
  );
  return { port, trashed };
}

async function outcomes(port: TrashFilesPort, paths: readonly string[]): Promise<readonly TrashFileOutcome[]> {
  return (await port.trash(paths)).filter((entry): entry is TrashFileOutcome => typeof entry !== 'string');
}

/** Same, with the D-207 backstop roots passed to the executor call. */
async function outcomesInRoots(
  port: TrashFilesPort, paths: readonly string[], roots: readonly string[],
): Promise<readonly TrashFileOutcome[]> {
  return (await port.trash(paths, roots))
    .filter((entry): entry is TrashFileOutcome => typeof entry !== 'string');
}

describe('D-120 · classifying the OS error', () => {
  it('recognises a not-found errno, a not-found message and the Windows shell code', () => {
    expect(classifyTrashError(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe('missing');
    expect(classifyTrashError(Object.assign(new Error('gone'), { code: 'ENOTDIR' }))).toBe('missing');
    expect(classifyTrashError(new Error('ENOENT: no such file or directory'))).toBe('missing');
    expect(classifyTrashError(new Error('ERROR_FILE_NOT_FOUND'))).toBe('missing');
  });

  it('does NOT turn permission / sharing / unknown errors into "missing"', () => {
    for (const error of [
      Object.assign(new Error('denied'), { code: 'EACCES' }),
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
      Object.assign(new Error('io'), { code: 'EIO' }),
      new Error('some unexpected failure'),
    ]) {
      expect(classifyTrashError(error)).toBe('error');
    }
    expect(reasonOf(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toContain('EBUSY');
  });
});

describe('D-120 · idempotent recycle-bin adapter', () => {
  it('existing file -> one trashItem call, status trashed', async () => {
    const f = fixture({ [FILE]: { kind: 'file' } });
    expect(await outcomes(f.port, [FILE])).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
  });

  it('ENOENT -> already clean, NO deletion attempted', async () => {
    const f = fixture({ [FILE]: { kind: 'error', code: 'ENOENT' } });
    expect(await outcomes(f.port, [FILE])).toEqual([{ path: FILE, status: 'missing' }]);
    expect(f.trashed).toEqual([]);
  });

  it('EACCES / EBUSY from stat -> real error with the real reason, record kept', async () => {
    for (const code of ['EACCES', 'EBUSY']) {
      const f = fixture({ [FILE]: { kind: 'error', code } });
      const result = await outcomes(f.port, [FILE]);
      expect(result[0]?.status).toBe('error');
      expect(result[0]?.reason).toContain(code);
      expect(f.trashed).toEqual([]);
    }
  });

  it('a directory or special file recorded as an artifact is rejected', async () => {
    const f = fixture({ [FILE]: { kind: 'dir' } });
    expect((await outcomes(f.port, [FILE]))[0]?.status).toBe('error');
    expect(f.trashed).toEqual([]);
  });

  it('trashItem failing with EBUSY is an error, not a silent success', async () => {
    const f = fixture({ [FILE]: { kind: 'file' } }, Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const result = await outcomes(f.port, [FILE]);
    expect(result[0]?.status).toBe('error');
    expect(result[0]?.reason).toContain('EBUSY');
  });

  it('file disappearing between stat and trashItem is still idempotent', async () => {
    const f = fixture({ [FILE]: { kind: 'file' } }, Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await outcomes(f.port, [FILE])).toEqual([{ path: FILE, status: 'missing' }]);
  });

  it('a mixed batch reports each path separately', async () => {
    const OTHER = 'C:/Videos/clip.vtt';
    const f = fixture({
      [FILE]: { kind: 'file' },
      [OTHER]: { kind: 'error', code: 'ENOENT' },
    });
    const result = await outcomes(f.port, [FILE, OTHER]);
    expect(result.map((entry) => entry.status)).toEqual(['trashed', 'missing']);
    expect(f.trashed).toEqual([FILE]);
  });
});

// -----------------------------------------------------------------------------
// D-207 backstop · the executor-side realpath re-validation (TOCTOU 2nd line)
// -----------------------------------------------------------------------------
// The pre-flight (D-207) and `trash()` are two separate calls; a local attacker
// with write access to an output directory can swap a recorded path (or a
// middle component) for a junction IN BETWEEN. The race is simulated with
// fakes: lstat/stat both report a plain file, but by the time the executor's
// injected `realpath` runs (immediately before `trashItem`) the path resolves
// OUTSIDE the roots — exactly what `shell.trashItem` would then follow.
describe('D-207 backstop · trash() 的执行器 realpath 复检（回收前第二道防线）', () => {
  const ROOTS = ['C:/Videos'];

  /** Fake primitives: stat table + injected realpath (map / unconditional throw). */
  function fixtureWithRealpath(
    stat: Record<string, StatOutcome>,
    realpathMap: Record<string, string> | null,
    realpathError?: unknown,
  ) {
    const trashed: string[] = [];
    const port = createTrashFilesPort(
      async (path) => { trashed.push(path); },
      async (path) => stat[path] ?? { kind: 'error', code: 'ENOENT' },
      async (path) => {
        if (realpathError !== undefined) throw realpathError;
        return realpathMap?.[path] ?? path;
      },
    );
    return { port, trashed };
  }

  it('用例 1 · 竞态拦截：stat 报告普通文件，realpath 却解析到 roots 之外（模拟预检后被换成 junction）→ error（回收前复检），trashItem 零调用', async () => {
    const f = fixtureWithRealpath(
      { [FILE]: { kind: 'file' } },
      { [FILE]: 'C:/Users/evil/clip.mp4' },
    );
    const result = await outcomesInRoots(f.port, [FILE], ROOTS);
    expect(result).toEqual([
      { path: FILE, status: 'error', reason: '产物真实路径指向任务输出目录之外（回收前复检）' },
    ]);
    expect(f.trashed).toEqual([]);
  });

  it('用例 2 · realpath 抛 ENOENT/ENOTDIR（stat 探测后、回收前被外部删除）→ 维持既有 missing 幂等语义，单条结果不双报', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const f = fixtureWithRealpath(
        { [FILE]: { kind: 'file' } },
        null,
        Object.assign(new Error('gone'), { code }),
      );
      const result = await outcomesInRoots(f.port, [FILE], ROOTS);
      expect(result).toEqual([{ path: FILE, status: 'missing' }]);
      expect(f.trashed).toEqual([]);
    }
  });

  it('用例 3 · realpath 抛其它错误（EACCES）→ fail-closed error（reason 带真实 errno），trashItem 未被调用', async () => {
    const f = fixtureWithRealpath(
      { [FILE]: { kind: 'file' } },
      null,
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    const result = await outcomesInRoots(f.port, [FILE], ROOTS);
    expect(result[0]?.status).toBe('error');
    expect(result[0]?.reason).toContain('EACCES');
    expect(f.trashed).toEqual([]);
  });

  it('用例 4 · 传入 roots 且 realpath 解析仍在根内 → 正常 trashed（复检不误伤合法回收）', async () => {
    const f = fixtureWithRealpath({ [FILE]: { kind: 'file' } }, {});
    const result = await outcomesInRoots(f.port, [FILE], ROOTS);
    expect(result).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
  });

  it('用例 5 · canonical roots（D-208 同一判定）：根是短名形态、realpath 以长名别名解析 → 仍放行（不误拒合法文件）', async () => {
    const SHORT_ROOT = 'C:/VIDEOS~1';
    const f = fixtureWithRealpath(
      { [FILE]: { kind: 'file' } },
      { [SHORT_ROOT]: 'C:/Videos', [FILE]: 'C:/Videos/clip.mp4' },
    );
    const result = await outcomesInRoots(f.port, [FILE], [SHORT_ROOT]);
    expect(result).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
  });

  it('用例 6 · 混合批次：根内条目正常回收、根外条目逐条拒绝（执行器复检是逐条最后防线）', async () => {
    const OTHER = 'C:/Videos/clip.vtt';
    const f = fixtureWithRealpath(
      { [FILE]: { kind: 'file' }, [OTHER]: { kind: 'file' } },
      { [FILE]: 'C:/Users/evil/clip.mp4' },
    );
    const result = await outcomesInRoots(f.port, [FILE, OTHER], ROOTS);
    expect(result.map((entry) => entry.status)).toEqual(['error', 'trashed']);
    expect(f.trashed).toEqual([OTHER]);
  });

  it('用例 7 · 不传 roots（undefined）：realpath 根本不被调用，行为与旧契约逐字节一致', async () => {
    const trashed: string[] = [];
    const port = createTrashFilesPort(
      async (path) => { trashed.push(path); },
      async (): Promise<StatOutcome> => ({ kind: 'file' }),
      async () => { throw new Error('realpath must NOT be called without roots'); },
    );
    expect(await outcomes(port, [FILE])).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(trashed).toEqual([FILE]);
  });

  it('用例 8 · roots 为空数组（不可证明归属的退化输入）→ fail-closed 拒绝（不落到 fails-open 的 containment 上）', async () => {
    const f = fixtureWithRealpath({ [FILE]: { kind: 'file' } }, {});
    const result = await outcomesInRoots(f.port, [FILE], []);
    expect(result[0]?.status).toBe('error');
    expect(f.trashed).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// D-221 复核审计修复 · 预检确认的可信根绑定到执行阶段（trusted-root binding）
// -----------------------------------------------------------------------------
// D-221 的执行器复检在执行时「现算」canonical 根：若输出根本身在预检后、执行前
// 被替换（例如目录被换成指向别处的 junction），现算根会基于「新身份」重新判
// 「根内」——信任基线漂移。修复后：预检 ok 裁决携带它实际裁决用的
// `verificationRoots`；调用方原样传回 `trash()` 第三参；执行器先逐个复核绑定根
// 的 realpath 是否仍解析到预检记录的身份（不一致 / 悬空 ENOENT/ENOTDIR / 其它
// errno 一律整批拒绝、trashItem 零调用），逐条复检改按绑定根判定。残余窗口的
// 口径不变：realpath→trashItem 间隙是登记在案的既有残余风险，根绑定解决的是
// 信任基线漂移，不改变该间隙的存在。
describe('回收前可信根绑定 · trash() 按预检确认的根验证（D-221 复核审计修复）', () => {
  const ROOT = 'C:/Videos';

  afterEach(() => {
    lstatState.overrides.clear();
  });

  /** 绑定根 fixture：stat 表 + 可控 realpath（逐路径映射 / 逐路径抛错）+ 调用记录。 */
  function boundFixture(
    stat: Record<string, StatOutcome>,
    realpathMap: Record<string, string> | null,
    realpathErrorFor?: Record<string, unknown>,
  ) {
    const trashed: string[] = [];
    const realpathCalls: string[] = [];
    const port = createTrashFilesPort(
      async (path) => { trashed.push(path); },
      async (path) => stat[path] ?? { kind: 'error', code: 'ENOENT' },
      async (path) => {
        realpathCalls.push(path);
        const thrown = realpathErrorFor?.[path];
        if (thrown !== undefined) throw thrown;
        return realpathMap?.[path] ?? path;
      },
    );
    return { port, trashed, realpathCalls };
  }

  async function boundOutcomes(
    port: TrashFilesPort,
    paths: readonly string[],
    roots: readonly string[],
    bound: readonly string[] | undefined,
  ): Promise<readonly TrashFileOutcome[]> {
    return (await port.trash(paths, roots, bound))
      .filter((entry): entry is TrashFileOutcome => typeof entry !== 'string');
  }

  it('用例 1 · 预检 ok 裁决携带 verificationRoots（含 D-208 canonical 别名）；refused 裁决不带', async () => {
    const ok = await preflightTrashPaths([FILE], {
      roots: [ROOT],
      realpath: async (path) => path,
      lstat: async () => ({ isSymbolicLink: () => false }),
    });
    expect(ok).toEqual({ kind: 'ok', missingPaths: [], verificationRoots: [ROOT] });

    // D-208 形态对：短名字符串根 + realpath 长名别名，两者都随裁决记录在案。
    const aliases = await preflightTrashPaths([FILE], {
      roots: ['C:/VIDEOS~1'],
      realpath: async (path) => (path === 'C:/VIDEOS~1' ? 'C:/Videos' : path),
      lstat: async () => ({ isSymbolicLink: () => false }),
    });
    expect(aliases).toEqual({
      kind: 'ok', missingPaths: [], verificationRoots: ['C:/VIDEOS~1', 'C:/Videos'],
    });

    const refused = await preflightTrashPaths([FILE], {
      roots: [ROOT],
      realpath: async () => 'C:/Users/evil/clip.mp4',
      lstat: async () => ({ isSymbolicLink: () => false }),
    });
    expect(refused.kind).toBe('refused');
    expect((refused as { verificationRoots?: unknown }).verificationRoots).toBeUndefined();
  });

  it('用例 2 · 根替换：预检记录的根执行时 realpath 解析到别处（换了身份，如被换成 junction）→ 整批 error、trashItem 零调用、不逐条复检', async () => {
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      { [ROOT]: 'D:/Elsewhere', [FILE]: 'D:/Elsewhere/clip.mp4' },
    );
    const result = await boundOutcomes(f.port, [FILE], [ROOT], [ROOT]);
    expect(result).toEqual([
      { path: FILE, status: 'error', reason: '回收前复检发现输出根目录身份已变化，已拒绝移入回收站' },
    ]);
    expect(f.trashed).toEqual([]);
    // 只复核了绑定根本身：既没有现算根，也没有顺着新身份继续逐条 realpath。
    expect(f.realpathCalls).toEqual([ROOT]);
  });

  it('用例 3 · 根替换的整批性：两条目全部 error（每条同因），一次 trashItem 都不调', async () => {
    const OTHER = 'C:/Videos/clip.vtt';
    const f = boundFixture(
      { [FILE]: { kind: 'file' }, [OTHER]: { kind: 'file' } },
      { [ROOT]: 'D:/Elsewhere' },
    );
    const result = await boundOutcomes(f.port, [FILE, OTHER], [ROOT], [ROOT]);
    expect(result).toEqual([
      { path: FILE, status: 'error', reason: '回收前复检发现输出根目录身份已变化，已拒绝移入回收站' },
      { path: OTHER, status: 'error', reason: '回收前复检发现输出根目录身份已变化，已拒绝移入回收站' },
    ]);
    expect(f.trashed).toEqual([]);
  });

  it('用例 4 · 根悬空：预检确认过的根执行时 realpath 抛 ENOENT/ENOTDIR → 整批拒绝（D-203：根不可判定一律拒绝），trashItem 零调用', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      // 绑定列表带长名别名（预检确认过该根的 realpath 身份）：执行时短名根与
      // 长名别名都无法解析 → 复检发现「记录的别名不再可推导」→ 按真实 errno 拒绝。
      const f = boundFixture(
        { [FILE]: { kind: 'file' } },
        null,
        {
          'C:/VIDEOS~1': Object.assign(new Error('gone'), { code }),
          'C:/Videos': Object.assign(new Error('gone'), { code }),
        },
      );
      const result = await boundOutcomes(f.port, [FILE], ['C:/VIDEOS~1'], ['C:/VIDEOS~1', 'C:/Videos']);
      expect(result[0]?.status).toBe('error');
      expect(result[0]?.reason).toContain('输出根目录');
      expect(f.trashed).toEqual([]);
    }
  });

  it('用例 5 · 预检确认过的根 realpath 抛其它错误（EACCES）→ 整批 fail-closed 拒绝（reason 带真实 errno），trashItem 零调用', async () => {
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      null,
      {
        'C:/VIDEOS~1': Object.assign(new Error('denied'), { code: 'EACCES' }),
        'C:/Videos': Object.assign(new Error('denied'), { code: 'EACCES' }),
      },
    );
    const result = await boundOutcomes(f.port, [FILE], ['C:/VIDEOS~1'], ['C:/VIDEOS~1', 'C:/Videos']);
    expect(result[0]?.status).toBe('error');
    expect(result[0]?.reason).toContain('EACCES');
    expect(f.trashed).toEqual([]);
  });

  it('用例 6 · 绑定根身份一致（realpath 报等价的反斜杠形态）→ 正常回收：身份比对按 containment 归一化，不逐字节比字符串', async () => {
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      { [ROOT]: 'C:\\Videos', [FILE]: 'C:/Videos/clip.mp4' },
    );
    const result = await boundOutcomes(f.port, [FILE], [ROOT], [ROOT]);
    expect(result).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
  });

  it('用例 7 · 绑定根为 D-208 形态对（短名字符串根 + 长名别名）：每个绑定根都仍解析进记录集合 → 不误拒；roots 参数不再被现算', async () => {
    const bound = ['C:/VIDEOS~1', 'C:/Videos'];
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      { 'C:/VIDEOS~1': 'C:\\Videos', 'C:/Videos': 'C:\\Videos', [FILE]: 'C:/Videos/clip.mp4' },
    );
    const result = await boundOutcomes(f.port, [FILE], ['C:/VIDEOS~1'], bound);
    expect(result).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
    // 绑定路径：realpath 落在字符串根（重推导基线）与条目上 —— 记录的别名经
    // 重推导自动复现，无需单独诊断调用。
    expect(f.realpathCalls).toEqual(['C:/VIDEOS~1', FILE]);
  });

  it('用例 8 · 中间目录替换：绑定根身份未变，但条目 realpath 把 <root>/link/file 解析到根外 → 单条 error（回收前复检），trashItem 零调用', async () => {
    const LINKED = 'C:/Videos/link/clip.mp4';
    const f = boundFixture(
      { [LINKED]: { kind: 'file' } },
      { [ROOT]: 'C:\\Videos', [LINKED]: 'C:/Users/evil/clip.mp4' },
    );
    const result = await boundOutcomes(f.port, [LINKED], [ROOT], [ROOT]);
    expect(result).toEqual([
      { path: LINKED, status: 'error', reason: '产物真实路径指向任务输出目录之外（回收前复检）' },
    ]);
    expect(f.trashed).toEqual([]);
  });

  it('用例 9 · 绑定根下逐条复检仍逐条：根内条目 trashed、根外条目 error', async () => {
    const OTHER = 'C:/Videos/clip.vtt';
    const f = boundFixture(
      { [FILE]: { kind: 'file' }, [OTHER]: { kind: 'file' } },
      { [ROOT]: 'C:\\Videos', [FILE]: 'C:/Users/evil/clip.mp4' },
    );
    const result = await boundOutcomes(f.port, [FILE, OTHER], [ROOT], [ROOT]);
    expect(result.map((entry) => entry.status)).toEqual(['error', 'trashed']);
    expect(f.trashed).toEqual([OTHER]);
  });

  it('用例 10 · 条目级悬空 junction：lstat 报符号链接 → 既有 error 拒绝（D-203 守卫先于逐条 realpath），trashItem 零调用', async () => {
    lstatState.overrides.set(FILE, { isSymbolicLink: () => true });
    const f = boundFixture({ [FILE]: { kind: 'file' } }, { [ROOT]: 'C:\\Videos' });
    const result = await boundOutcomes(f.port, [FILE], [ROOT], [ROOT]);
    expect(result).toEqual([
      { path: FILE, status: 'error', reason: '符号链接/联接无法验证归属，已拒绝移入回收站' },
    ]);
    expect(f.trashed).toEqual([]);
    expect(f.realpathCalls).toEqual([ROOT]);
  });

  it('用例 11 · 条目级悬空 junction（lstat 不报链接、stat 报在盘）：条目 realpath ENOENT → 既有 missing 幂等语义', async () => {
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      null,
      { [FILE]: Object.assign(new Error('gone'), { code: 'ENOENT' }) },
    );
    const result = await boundOutcomes(f.port, [FILE], [ROOT], [ROOT]);
    expect(result).toEqual([{ path: FILE, status: 'missing' }]);
    expect(f.trashed).toEqual([]);
    expect(f.realpathCalls).toEqual([ROOT, FILE]);
  });

  it('用例 12 · 未传第三参（undefined）：与 D-221 现状一致 —— 现算 canonical 根（realpath 落在 roots 上）+ 逐条复检，绑定复核不发生', async () => {
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      { [ROOT]: 'C:\\Videos', [FILE]: 'C:/Videos/clip.mp4' },
    );
    const result = await boundOutcomes(f.port, [FILE], [ROOT], undefined);
    expect(result).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
    // 现算路径：realpath 先落在根上（canonical 化），再落在条目上。
    expect(f.realpathCalls).toEqual([ROOT, FILE]);
  });

  it('用例 13 · 绑定根为空数组：根复核无事可做，逐条复检按既有空 roots fail-closed 拒绝', async () => {
    const f = boundFixture({ [FILE]: { kind: 'file' } }, {});
    const result = await boundOutcomes(f.port, [FILE], [], []);
    expect(result).toEqual([
      { path: FILE, status: 'error', reason: '无法验证产物文件归属（回收前复检缺少可用的输出根目录），已拒绝移入回收站' },
    ]);
    expect(f.trashed).toEqual([]);
    expect(f.realpathCalls).toEqual([]);
  });

  it('用例 14 · 比较用的字符串根（预检时就不存在、无 realpath 别名）执行时仍 ENOENT → 不拒绝（未确认的根没有身份可绑定），条目按绑定根判定', async () => {
    // 真实场景：request 的 tempDir 在预检时还没建盘（canonical 列表里只有字符串
    // 形态、无别名），回收只涉及 videoDir 下的产物 —— 该根的 ENOENT 与预检一致，
    // 不是漂移；用例 4 里「有别名（确认过）却 ENOENT」才拒绝。
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      { [ROOT]: 'C:\\Videos' },
      { 'C:/Missing': Object.assign(new Error('gone'), { code: 'ENOENT' }) },
    );
    const result = await boundOutcomes(f.port, [FILE], [ROOT, 'C:/Missing'], [ROOT, 'C:/Missing']);
    expect(result).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
  });

  it('用例 15 · 预检时不存在的字符串根执行时突然可解析（出现预检未记录的新身份）→ 整批拒绝（信任基线移动，fail-closed）', async () => {
    const f = boundFixture(
      { [FILE]: { kind: 'file' } },
      { [ROOT]: 'C:\\Videos', 'C:/Missing': 'D:/Appeared' },
    );
    const result = await boundOutcomes(f.port, [FILE], [ROOT, 'C:/Missing'], [ROOT, 'C:/Missing']);
    expect(result).toEqual([
      { path: FILE, status: 'error', reason: '回收前复检发现输出根目录身份已变化，已拒绝移入回收站' },
    ]);
    expect(f.trashed).toEqual([]);
  });
});
