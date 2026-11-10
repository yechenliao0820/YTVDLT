/**
 * D-120 · local artifact state probe (pure logic, no filesystem).
 *
 * The critical property: a transient OS error must NEVER be reported as
 * "the user deleted the file". Only ENOENT / ENOTDIR are "missing".
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStat, createLocalFileStatusProbe, isUsablePath, parentDirOf,
  type StatOutcome,
} from '../../apps/desktop/src/main/local-file-status.js';

describe('D-120 · errno classification', () => {
  it('only ENOENT / ENOTDIR mean gone', () => {
    expect(classifyStat({ kind: 'error', code: 'ENOENT' }, true)).toBe('missing');
    expect(classifyStat({ kind: 'error', code: 'ENOTDIR' }, true)).toBe('missing');
  });

  it('permission, locked file, unavailable volume and unknown errno stay distinct', () => {
    for (const code of ['EACCES', 'EPERM']) {
      expect(classifyStat({ kind: 'error', code }, true)).toBe('inaccessible');
    }
    for (const code of ['EBUSY', 'EIO', 'ENODEV', 'ENETDOWN', 'ETIMEDOUT', 'UNKNOWN', undefined]) {
      expect(classifyStat({ kind: 'error', code }, true)).toBe('unavailable');
    }
  });

  it('a present file / directory wins; a wrong kind is an invalid record', () => {
    expect(classifyStat({ kind: 'file' }, true)).toBe('present');
    expect(classifyStat({ kind: 'dir' }, false)).toBe('present');
    expect(classifyStat({ kind: 'dir' }, true)).toBe('invalid');
    expect(classifyStat({ kind: 'other' }, false)).toBe('invalid');
  });
});

describe('D-120 · path validation and parent directory', () => {
  it('accepts Windows drive, UNC and POSIX roots; rejects broken records', () => {
    expect(isUsablePath('C:/Videos/clip.mp4')).toBe(true);
    expect(isUsablePath('D:\\Videos\\clip.mp4')).toBe(true);
    expect(isUsablePath('//nas/share/clip.mp4')).toBe(true);
    expect(isUsablePath('/home/leo/clip.mp4')).toBe(true);
    expect(isUsablePath('')).toBe(false);
    expect(isUsablePath('   ')).toBe(false);
    expect(isUsablePath('clip.mp4')).toBe(false);
    expect(isUsablePath('C:/a\u0000b.mp4')).toBe(false);
    expect(isUsablePath(42)).toBe(false);
  });

  it('derives the containing directory without node:path', () => {
    expect(parentDirOf('C:/Videos/clip.mp4')).toBe('C:/Videos');
    expect(parentDirOf('C:\\Videos\\clip.mp4')).toBe('C:/Videos');
    expect(parentDirOf('//nas/share/clip.mp4')).toBe('//nas/share');
    expect(parentDirOf('/clip.mp4')).toBe('/');
    expect(parentDirOf('clip.mp4')).toBe('');
  });
});

function probeFixture(initial: Record<string, StatOutcome>) {
  const table: Record<string, StatOutcome> = { ...initial };
  let calls = 0;
  let clock = 1_000;
  const probe = createLocalFileStatusProbe({
    stat: async (path) => {
      calls += 1;
      return table[path] ?? { kind: 'error', code: 'ENOENT' };
    },
    now: () => clock,
    cacheTtlMs: 1000,
  });
  return {
    probe: (tasks: readonly { id: string; state: string; artifacts: readonly string[] }[], force?: boolean) =>
      probe.probe(tasks, force),
    probeTask: (task: { id: string; state: string; artifacts: readonly string[] }) => probe.probeTask(task),
    forget: (id: string) => probe.forget(id),
    table,
    statCalls: () => calls,
    advance: (ms: number) => { clock += ms; },
  };
}

const completed = (id: string, artifacts: readonly string[] = ['C:/Videos/clip.mp4']) =>
  ({ id, state: 'Completed', artifacts });

const presentPair: Record<string, StatOutcome> = {
  'C:/Videos/clip.mp4': { kind: 'file' },
  'C:/Videos': { kind: 'dir' },
};

describe('D-120 · on-demand probe, cache and recovery', () => {
  it('reports present for an existing file and its directory', async () => {
    const f = probeFixture(presentPair);
    const result = await f.probe([completed('t1')]);
    expect(result['t1']).toEqual({ status: 'present', dirStatus: 'present' });
    // One stat for the file, one for the directory — never a directory scan.
    expect(f.statCalls()).toBe(2);
  });

  it('never stats a running task, and never invents a state for one', async () => {
    const f = probeFixture(presentPair);
    const result = await f.probe([
      { id: 'run', state: 'Running', artifacts: ['C:/Videos/clip.mp4'] },
      { id: 't1', state: 'Completed', artifacts: ['C:/Videos/clip.mp4'] },
    ]);
    expect(Object.keys(result)).toEqual(['t1']);
    expect(f.statCalls()).toBe(2);
  });

  it('distinguishes a deleted file from an unreadable one', async () => {
    const gone = probeFixture({ 'C:/Videos/clip.mp4': { kind: 'error', code: 'ENOENT' }, 'C:/Videos': { kind: 'dir' } });
    expect((await gone.probe([completed('t1')]))['t1']?.status).toBe('missing');
    const locked = probeFixture({ 'C:/Videos/clip.mp4': { kind: 'error', code: 'EACCES' }, 'C:/Videos': { kind: 'dir' } });
    expect((await locked.probe([completed('t1')]))['t1']?.status).toBe('inaccessible');
    const unavailable = probeFixture({ 'C:/Videos/clip.mp4': { kind: 'error', code: 'EIO' }, 'C:/Videos': { kind: 'dir' } });
    expect((await unavailable.probe([completed('t1')]))['t1']?.status).toBe('unavailable');
  });

  it('keeps the directory state separately (folder still exists after the file was deleted)', async () => {
    const f = probeFixture({ 'C:/Videos/clip.mp4': { kind: 'error', code: 'ENOENT' }, 'C:/Videos': { kind: 'dir' } });
    expect((await f.probe([completed('t1')]))['t1']).toEqual({ status: 'missing', dirStatus: 'present' });
    const bothGone = probeFixture({ 'C:/Videos/clip.mp4': { kind: 'error', code: 'ENOENT' }, 'C:/Videos': { kind: 'error', code: 'ENOENT' } });
    expect((await bothGone.probe([completed('t1')]))['t1']).toEqual({ status: 'missing', dirStatus: 'missing' });
  });

  it('marks a record with no usable path as invalid, not missing', async () => {
    const f = probeFixture(presentPair);
    const result = await f.probe([completed('t1', [])]);
    expect(result['t1']).toEqual({ status: 'invalid', dirStatus: 'invalid' });
    expect(f.statCalls()).toBe(0);
  });

  it('reuses a short-lived cache, but not a stale one', async () => {
    const f = probeFixture(presentPair);
    await f.probe([completed('t1')]);
    expect(f.statCalls()).toBe(2);
    f.table['C:/Videos/clip.mp4'] = { kind: 'error', code: 'ENOENT' };
    // Within the TTL the cached observation is used — no per-render fs work.
    await f.probe([completed('t1')]);
    expect(f.statCalls()).toBe(2);
    expect((await f.probe([completed('t1')]))['t1']?.status).toBe('present');
    // ...but the cache expires, so an external deletion is eventually visible.
    f.advance(1001);
    expect((await f.probe([completed('t1')]))['t1']?.status).toBe('missing');
    expect(f.statCalls()).toBe(4);
  });

  it('force=true re-stats immediately (page load / re-entry)', async () => {
    const f = probeFixture(presentPair);
    await f.probe([completed('t1')]);
    f.table['C:/Videos/clip.mp4'] = { kind: 'error', code: 'ENOENT' };
    const result = await f.probe([completed('t1')], true);
    expect(result['t1']?.status).toBe('missing');
    expect(f.statCalls()).toBe(4);
  });

  it('a file restored at the same path returns to present on the next check', async () => {
    const f = probeFixture({ 'C:/Videos/clip.mp4': { kind: 'error', code: 'ENOENT' }, 'C:/Videos': { kind: 'dir' } });
    expect((await f.probe([completed('t1')]))['t1']?.status).toBe('missing');
    f.table['C:/Videos/clip.mp4'] = { kind: 'file' };
    expect((await f.probe([completed('t1')], true))['t1']?.status).toBe('present');
  });

  it('probeTask always re-stats; forget drops the cached entry', async () => {
    const f = probeFixture(presentPair);
    await f.probe([completed('t1')]);
    f.table['C:/Videos/clip.mp4'] = { kind: 'error', code: 'ENOENT' };
    expect((await f.probeTask(completed('t1'))).status).toBe('missing');
    expect(f.statCalls()).toBe(4);
    f.forget('t1');
    await f.probe([completed('t1')]);
    expect(f.statCalls()).toBe(6);
  });
});
