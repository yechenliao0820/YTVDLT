/**
 * D-120 · the real adapter's idempotent cleanup contract.
 *
 * `shell.trashItem` is injected; the assertions here are about which paths
 * are EVER handed to it. A missing or unreadable file must never reach it.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTrashError, createTrashFilesPort, reasonOf,
} from '../../apps/desktop/src/main/adapters/local-file-status-port.js';
import type { StatOutcome } from '../../apps/desktop/src/main/local-file-status.js';
import type { TrashFileOutcome, TrashFilesPort } from '../../apps/desktop/src/main/m5-channels.js';

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
