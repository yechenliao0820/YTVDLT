/**
 * D-291 · guarded per-task temp-dir cleanup.
 *
 * The ONLY destructive path added by D-291, so every guard gets its own test:
 * managed shape, id match, symlink refusal, realpath containment, and the
 * empty-only boot sweep that can never eat a resumable `.part`.
 */
import { describe, it, expect } from 'vitest';
import {
  discardTaskTempDir, lastSegmentOf, parentOf, removeEmptyTempDir, sweepEmptyTempDirs,
  type TempDirIo,
} from '../../apps/desktop/src/main/task-temp-cleanup.js';

interface FakeEntry {
  readonly kind: 'dir' | 'link';
  readonly children: string[];
  /** Real location this directory resolves to (defaults to its own path). */
  readonly resolveTo?: string;
}

function fakeIo(entries: Record<string, FakeEntry> = {}) {
  const removed: string[] = [];
  const rmdirCalls: string[] = [];
  const io: TempDirIo = {
    lstat: async (path) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return {
        isSymbolicLink: () => entry.kind === 'link',
        isDirectory: () => entry.kind === 'dir',
      };
    },
    realpath: async (path) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entry.resolveTo ?? path;
    },
    readdir: async (path) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entry.children;
    },
    rmdir: async (path) => { rmdirCalls.push(path); },
    rm: async (path) => { removed.push(path); },
  };
  return { io, removed, rmdirCalls };
}

describe('D-291 · discardTaskTempDir', () => {
  it('removes a managed <work>/<taskId> tree whose id matches', async () => {
    const f = fakeIo({
      'C:/Data/work/t1': { kind: 'dir', children: ['clip.mp4.part'] },
      'C:/Data/work': { kind: 'dir', children: ['t1'] },
    });
    const outcome = await discardTaskTempDir(f.io, 'C:/Data/work/t1', 't1');
    expect(outcome).toBe('discarded');
    expect(f.removed).toEqual(['C:/Data/work/t1']);
  });

  it('accepts the same-volume .ytvdlt-incomplete shape', async () => {
    const f = fakeIo({
      'C:/V/.ytvdlt-incomplete/t2': { kind: 'dir', children: ['.part'] },
      'C:/V/.ytvdlt-incomplete': { kind: 'dir', children: ['t2'] },
    });
    expect(await discardTaskTempDir(f.io, 'C:/V/.ytvdlt-incomplete/t2', 't2')).toBe('discarded');
    expect(f.removed).toEqual(['C:/V/.ytvdlt-incomplete/t2']);
  });

  it('skips a user-configured temp dir (not a managed shape)', async () => {
    const f = fakeIo({ 'C:/Users/leo/Temp/t1': { kind: 'dir', children: [] } });
    expect(await discardTaskTempDir(f.io, 'C:/Users/leo/Temp/t1', 't1')).toBe('skipped');
    expect(f.removed).toEqual([]);
  });

  it('skips when the last segment is not THIS record id', async () => {
    const f = fakeIo({
      'C:/Data/work/t2': { kind: 'dir', children: [] },
      'C:/Data/work': { kind: 'dir', children: ['t2'] },
    });
    expect(await discardTaskTempDir(f.io, 'C:/Data/work/t2', 't1')).toBe('skipped');
    expect(f.removed).toEqual([]);
  });

  it('refuses a symlink / junction standing in for the directory', async () => {
    const f = fakeIo({
      'C:/Data/work/t1': { kind: 'link', children: [] },
      'C:/Data/work': { kind: 'dir', children: ['t1'] },
    });
    expect(await discardTaskTempDir(f.io, 'C:/Data/work/t1', 't1')).toBe('skipped');
    expect(f.removed).toEqual([]);
  });

  it('keeps the tree when realpath resolves somewhere else (mid-path junction)', async () => {
    const f = fakeIo({
      'C:/Data/work/t1': { kind: 'dir', children: [], resolveTo: 'D:/Elsewhere/t1' },
      'C:/Data/work': { kind: 'dir', children: ['t1'] },
    });
    expect(await discardTaskTempDir(f.io, 'C:/Data/work/t1', 't1')).toBe('kept');
    expect(f.removed).toEqual([]);
  });

  it('an already-gone directory is not an error', async () => {
    const f = fakeIo({});
    expect(await discardTaskTempDir(f.io, 'C:/Data/work/t1', 't1')).toBe('kept');
    expect(f.removed).toEqual([]);
  });

  it('empty / null values are skipped without any filesystem call', async () => {
    const f = fakeIo({});
    expect(await discardTaskTempDir(f.io, '', 't1')).toBe('skipped');
    expect(await discardTaskTempDir(f.io, null, 't1')).toBe('skipped');
    expect(await discardTaskTempDir(f.io, 'C:/Data/work/../evil', 't1')).toBe('skipped');
  });
});

describe('D-291 · empty-dir sweep (boot)', () => {
  it('removes an EMPTY managed dir and keeps a dir holding a partial', async () => {
    const f = fakeIo({
      'C:/Data/work/empty1': { kind: 'dir', children: [] },
      'C:/Data/work/resumable': { kind: 'dir', children: ['clip.mp4.part'] },
    });
    expect(await removeEmptyTempDir(f.io, 'C:/Data/work/empty1')).toBe(true);
    expect(await removeEmptyTempDir(f.io, 'C:/Data/work/resumable')).toBe(false);
    expect(f.rmdirCalls).toEqual(['C:/Data/work/empty1']);
  });

  it('never touches non-managed dirs or symlinks', async () => {
    const f = fakeIo({
      'C:/Videos/holiday': { kind: 'dir', children: [] },
      'C:/Data/work/link': { kind: 'link', children: [] },
    });
    expect(await removeEmptyTempDir(f.io, 'C:/Videos/holiday')).toBe(false);
    expect(await removeEmptyTempDir(f.io, 'C:/Data/work/link')).toBe(false);
    expect(f.rmdirCalls).toEqual([]);
  });

  it('sweeps record temp dirs plus the work root children, empties only', async () => {
    const f = fakeIo({
      'C:/Data/work/t1': { kind: 'dir', children: [] },
      'C:/Data/work/orphan': { kind: 'dir', children: [] },
      'C:/Data/work/keep': { kind: 'dir', children: ['.ytdl'] },
      'C:/V/.ytvdlt-incomplete/t2': { kind: 'dir', children: [] },
      'C:/Data/work': { kind: 'dir', children: ['t1', 'orphan', 'keep'] },
      'C:/V/.ytvdlt-incomplete': { kind: 'dir', children: ['t2'] },
      'C:/Private/work/private-orphan': { kind: 'dir', children: [] },
      'C:/Private/work': { kind: 'dir', children: ['private-orphan'] },
    });
    const removed = await sweepEmptyTempDirs(f.io, {
      recordTempDirs: ['C:/V/.ytvdlt-incomplete/t2', ''],
      workRoots: ['C:/Data/work', 'C:/Private/work'],
    });
    expect(removed).toBe(4);
    expect(f.rmdirCalls.sort()).toEqual([
      'C:/Data/work/orphan', 'C:/Data/work/t1',
      'C:/Private/work/private-orphan', 'C:/V/.ytvdlt-incomplete/t2',
    ]);
  });

  it('a missing work root is not an error (fresh install)', async () => {
    const f = fakeIo({});
    expect(await sweepEmptyTempDirs(f.io, { recordTempDirs: [], workRoots: ['C:/Nope/work'] })).toBe(0);
  });
});

describe('D-291 · path helpers', () => {
  it('handles both separators and trailing slashes', () => {
    expect(lastSegmentOf('C:\\Data\\work\\t1\\')).toBe('t1');
    expect(lastSegmentOf('C:/Data/work/t1')).toBe('t1');
    expect(parentOf('C:\\Data\\work\\t1')).toBe('C:\\Data\\work');
    expect(parentOf('C:/t1')).toBe('C:');
  });
});
