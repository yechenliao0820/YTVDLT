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

/**
 * D-248 · single flight and bounded concurrency.
 *
 * A `stat` on a disconnected network drive hangs for the OS timeout. The queue
 * polls `TASK_LIST` every 0.4 s / 1.2 s and action handlers fire extra forced
 * refreshes, so per-call fresh batches used to stack one full batch of pending
 * stats on top of the last, without bound. The port now runs at most ONE batch
 * round at a time, with at most 4 stat calls pending inside it.
 */
function hangingFixture(initial: Record<string, StatOutcome> = {}) {
  const table: Record<string, StatOutcome> = { ...initial };
  let clock = 1_000;
  let calls = 0;
  let pending = 0;
  let peak = 0;
  const hung: Array<{ path: string; release: (value: StatOutcome) => void }> = [];
  const fallback = (path: string): StatOutcome => (path.includes('.') ? { kind: 'file' } : { kind: 'dir' });
  const probe = createLocalFileStatusProbe({
    stat: (path: string) => {
      calls += 1;
      pending += 1;
      peak = Math.max(peak, pending);
      return new Promise<StatOutcome>((resolve) => {
        hung.push({ path, release: (value) => { pending -= 1; resolve(value); } });
      });
    },
    now: () => clock,
    cacheTtlMs: 1000,
    // D-248 tests drive the release themselves; D-291's deadline is off here.
    statTimeoutMs: 0,
  });
  return {
    probe: (tasks: readonly { id: string; state: string; artifacts: readonly string[] }[], force?: boolean) =>
      probe.probe(tasks, force),
    probeTask: (task: { id: string; state: string; artifacts: readonly string[] }) => probe.probeTask(task),
    table,
    setTable: (path: string, outcome: StatOutcome) => { table[path] = outcome; },
    statCalls: () => calls,
    inFlight: () => pending,
    peakInFlight: () => peak,
    /** Resolves every hung stat with the CURRENT table value for its path. */
    releaseAll: () => {
      for (const hang of hung.splice(0)) hang.release(table[hang.path] ?? fallback(hang.path));
    },
    tick: (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); }),
    advance: (ms: number) => { clock += ms; },
  };
}

describe('D-248 · single flight and bounded concurrency', () => {
  it('overlapping probes share ONE round while the stats hang', async () => {
    const f = hangingFixture();
    const tasks = [completed('t1'), completed('t2')];
    const first = f.probe(tasks);
    const second = f.probe(tasks); // overlaps the still-running first round
    await f.tick();
    // One round: 2 workers × 1 file stat each. A second independent round
    // would have started 2 more stat calls on top of the hung ones.
    expect(f.statCalls()).toBe(2);
    expect(f.inFlight()).toBe(2);
    f.releaseAll(); // file stats land, the dir stats are issued next
    await f.tick();
    expect(f.statCalls()).toBe(4);
    f.releaseAll(); // dir stats land, the round completes
    const [roundOne, roundTwo] = await Promise.all([first, second]);
    expect(roundTwo).toBe(roundOne); // the second caller got the SAME round result
    expect(f.statCalls()).toBe(4); // 8 would mean two independent rounds
  });

  it('keeps at most 4 stat calls pending inside one round', async () => {
    const f = hangingFixture();
    const tasks = Array.from({ length: 12 }, (_, index) =>
      completed(`t${index}`, [`C:/Videos/v${index}.mp4`]));
    const running = f.probe(tasks);
    await f.tick();
    expect(f.inFlight()).toBe(4); // pool saturated exactly — not 12 × 2 = 24
    // 12 tasks × 2 sequential stats = 24 stats, released in waves of 4.
    for (let wave = 0; wave < 6; wave += 1) {
      expect(f.inFlight()).toBe(4);
      f.releaseAll();
      await f.tick();
    }
    const result = await running;
    expect(Object.keys(result)).toHaveLength(12);
    expect(f.statCalls()).toBe(24);
    expect(f.peakInFlight()).toBe(4);
  });

  it('a forced probe waits out the running round, then re-stats and overwrites the cache', async () => {
    const f = hangingFixture({
      'C:/Videos/clip.mp4': { kind: 'file' },
      'C:/Videos': { kind: 'dir' },
    });
    const tasks = [completed('t1')];
    const first = f.probe(tasks); // hangs on the batch file stat
    const forced = f.probe(tasks, true); // must NOT be answered by the running round
    await f.tick();
    expect(f.statCalls()).toBe(1); // the forced call started NO second batch early
    let forcedDone = false;
    forced.then(() => { forcedDone = true; });
    f.releaseAll(); // round 1 file stat lands, dir stat issued
    await f.tick();
    expect(f.statCalls()).toBe(2);
    f.releaseAll(); // round 1 completes; the queued forced round starts
    await f.tick();
    expect(f.statCalls()).toBe(3);
    expect(forcedDone).toBe(false); // never answered by the earlier round
    f.setTable('C:/Videos/clip.mp4', { kind: 'error', code: 'ENOENT' });
    f.releaseAll(); // forced file stat lands (ENOENT), dir stat issued
    await f.tick();
    expect(f.statCalls()).toBe(4);
    expect(forcedDone).toBe(false);
    f.releaseAll(); // forced dir stat lands, forced round completes
    const fresh = await forced;
    expect(fresh['t1']).toEqual({ status: 'missing', dirStatus: 'present' });
    // The forced round OVERWROTE the cache: a plain probe now reports the new
    // state without a single additional stat call.
    const cached = await f.probe(tasks);
    expect(cached['t1']).toEqual({ status: 'missing', dirStatus: 'present' });
    expect(f.statCalls()).toBe(4);
  });

  it('probeTask does not queue behind a hanging round', async () => {
    const f = hangingFixture({ 'C:/Videos/clip.mp4': { kind: 'file' }, 'C:/Videos': { kind: 'dir' } });
    const round = f.probe([completed('t1')]); // the batch stat hangs
    await f.tick();
    const before = f.statCalls();
    const observed = f.probeTask(completed('t1')); // must stat right away
    await f.tick();
    expect(f.statCalls()).toBe(before + 2); // both pair stats issued immediately
    f.releaseAll(); // lands the hung batch stat AND the whole probeTask pair
    await f.tick();
    expect(await observed).toEqual({ status: 'present', dirStatus: 'present' });
    f.releaseAll(); // lands the batch dir stat, round completes
    await round;
    expect(f.statCalls()).toBe(4); // 2 (batch) + 2 (probeTask), never re-batched
  });
});

/**
 * D-291 · a single stat is deadline-bound, and a dead path is quarantined.
 *
 * `TASK_LIST` awaits the batch probe: without a deadline one artifact on a
 * disconnected share held the queue page in its loading state for the OS SMB
 * timeout. The deadline keeps the answer bounded; the quarantine keeps the next
 * poll round from feeding the thread pool a fresh batch of hung syscalls.
 */
function deadShareFixture(options: { readonly hangForever?: boolean } = {}) {
  let clock = 1_000;
  let calls = 0;
  const hangForever = options.hangForever !== false;
  const probe = createLocalFileStatusProbe({
    stat: (path: string) => {
      calls += 1;
      // A dead share never answers; a healthy path answers immediately.
      if (hangForever && path.startsWith('//nas')) return new Promise<StatOutcome>(() => {});
      return Promise.resolve<StatOutcome>(path.includes('.') ? { kind: 'file' } : { kind: 'dir' });
    },
    now: () => clock,
    cacheTtlMs: 1000,
    statTimeoutMs: 25,
    hungRetryMs: 60_000,
  });
  return {
    probe: (tasks: readonly { id: string; state: string; artifacts: readonly string[] }[], force?: boolean) =>
      probe.probe(tasks, force),
    probeTask: (task: { id: string; state: string; artifacts: readonly string[] }) => probe.probeTask(task),
    statCalls: () => calls,
    advance: (ms: number) => { clock += ms; },
  };
}

const remote = (id: string) => completed(id, ['//nas/share/clip.mp4']);

describe('D-291 · per-stat deadline + quarantine', () => {
  it('answers within the deadline with `unavailable` instead of hanging on the OS timeout', async () => {
    const f = deadShareFixture();
    const started = Date.now();
    const result = await f.probe([remote('t1')]);
    expect(result['t1']).toEqual({ status: 'unavailable', dirStatus: 'unavailable' });
    // 25 ms budget per stat × 2 sequential stats — far below the 5 s test
    // timeout and below any real SMB timeout.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.statCalls()).toBe(2);
  });

  it('does not re-stat a hung path in the next non-forced round (quarantine)', async () => {
    const f = deadShareFixture();
    await f.probe([remote('t1')]);
    expect(f.statCalls()).toBe(2);
    f.advance(1001); // cache TTL expired: without quarantine this would stat again
    const result = await f.probe([remote('t1')]);
    expect(result['t1']).toEqual({ status: 'unavailable', dirStatus: 'unavailable' });
    expect(f.statCalls()).toBe(2); // zero new hung syscalls
  });

  it('a forced refresh (user action) ignores the quarantine and stats for real', async () => {
    const f = deadShareFixture();
    await f.probe([remote('t1')]);
    await f.probe([remote('t1')]);
    expect(f.statCalls()).toBe(2);
    await f.probe([remote('t1')], true);
    expect(f.statCalls()).toBe(4); // forced round issued both stats again
  });

  it('probeTask (open file/folder) ignores the quarantine too', async () => {
    const f = deadShareFixture();
    await f.probe([remote('t1')]);
    await f.probeTask(remote('t1'));
    expect(f.statCalls()).toBe(4);
  });

  it('a healthy local path is unaffected by the deadline', async () => {
    const f = deadShareFixture();
    const local = completed('t2', ['C:/Videos/clip.mp4']);
    expect((await f.probe([local]))['t2']).toEqual({ status: 'present', dirStatus: 'present' });
  });
});
