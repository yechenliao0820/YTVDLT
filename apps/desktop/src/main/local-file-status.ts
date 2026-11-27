/**
 * D-120 — local artifact state probe (main-process only, pure logic).
 *
 * The renderer must never touch the filesystem. This module classifies the
 * recorded artifact path of a COMPLETED task into one stable bucket, using an
 * injected `stat` so it stays L0-testable and has no `node:*` / `electron`
 * import. The real `stat` lives in `adapters/local-file-status-port.ts`.
 *
 * Five rules that must not be relaxed:
 *  1. Only `ENOENT` / `ENOTDIR` mean "gone". Permission, locked files, an
 *     unavailable volume and unknown errno are NOT "deleted" — misreporting
 *     a transient error as a missing file is how a user loses their history.
 *  2. Only completed tasks are probed in batch; running tasks are skipped
 *     entirely (no filesystem work, no invented state).
 *  3. Results are cached briefly. `probeTask()` always re-stats (user-triggered
 *     open actions), and `forget()` drops the cache after a record is removed.
 *  4. D-248: batch probing is SINGLE-FLIGHT and CONCURRENCY-BOUNDED. `TASK_LIST`
 *     is a poll channel (0.4 s / 1.2 s cadence) that overlaps with
 *     action-triggered `refreshFileStatus` calls and page reloads; a stat on a
 *     disconnected network drive hangs for the OS timeout, so the old
 *     start-a-fresh-batch-per-call behaviour piled one full batch of stats per
 *     call on top of the last, without bound. At most ONE batch round is ever
 *     in flight (non-forced callers share it), a forced caller waits it out and
 *     then runs its own fresh round, and a round keeps at most
 *     `MAX_PROBE_WORKERS` stat calls pending.
 *  5. D-291: a single stat is DEADLINE-BOUND. Bounding the batch is not enough —
 *     `TASK_LIST` awaits the probe, so one artifact on a dead share kept the
 *     queue page loading for the whole SMB timeout. A stat that misses
 *     `statTimeoutMs` is reported as `unavailable` and the path is quarantined
 *     for `hungRetryMs`, so the poll loop stops feeding the thread pool new
 *     hung syscalls. A user-triggered probe (open file/folder) ignores the
 *     quarantine and stats for real.
 */
import type { TaskRecord } from '@ytvdlt/shared';
import { primaryMediaArtifact } from '@ytvdlt/core';

export type LocalFileStatus =
  | 'present'
  | 'missing'
  | 'inaccessible'
  | 'unavailable'
  | 'invalid';

export interface LocalFileState {
  readonly status: LocalFileStatus;
  /** State of the containing directory — drives the "open folder" branch. */
  readonly dirStatus: LocalFileStatus;
}

/** Narrow slice the probe needs; `TaskRecord` satisfies it structurally. */
export interface FileStateInput {
  readonly id: string;
  readonly state: string;
  readonly artifacts: readonly string[];
}

/** What an injected `stat` returns. `code` is the real OS errno on failure. */
export interface StatOutcome {
  readonly kind: 'file' | 'dir' | 'other' | 'error';
  readonly code?: string;
}

export interface LocalFileStatusPort {
  /**
   * Batch probe. Non-completed tasks are absent from the result.
   * D-248: single-flight — a non-forced call joins the round already running
   * (one shared result); a forced call never reuses it: it waits for the
   * running round to end, then re-stats everything in a fresh round.
   */
  probe(tasks: readonly FileStateInput[], force?: boolean): Promise<Record<string, LocalFileState>>;
  /** Always re-stats: used immediately before open-file / open-folder. */
  probeTask(task: FileStateInput): Promise<LocalFileState>;
  /** Invalidate after a record (or its files) disappears. */
  forget(taskId: string): void;
}

export interface LocalFileStatusOptions {
  readonly stat: (path: string) => Promise<StatOutcome>;
  readonly now?: () => number;
  /** Short TTL only. A long cache would keep showing a deleted file as present. */
  readonly cacheTtlMs?: number;
  /**
   * D-291: per-stat ceiling. `TASK_LIST` awaits the batch probe, so one
   * artifact on a disconnected network share used to hold the WHOLE queue page
   * in its loading state until the OS SMB timeout (tens of seconds). A stat
   * that does not answer within this budget is reported as `unavailable`
   * (honest: "cannot prove the file is gone") and the path is quarantined.
   */
  readonly statTimeoutMs?: number;
  /**
   * D-291: how long a timed-out path is skipped WITHOUT issuing another stat.
   * Re-probing a dead share on every poll is what turned one hung syscall into
   * a permanent stall (each round queues up to `MAX_PROBE_WORKERS` new hung
   * stats). A forced refresh (user action) always re-stats.
   */
  readonly hungRetryMs?: number;
}

/** `ENOENT` means gone; everything else is an honest, distinct failure. */
export function classifyStat(outcome: StatOutcome, wantFile: boolean): LocalFileStatus {
  if (outcome.kind === 'error') {
    switch (outcome.code) {
      case 'ENOENT':
      case 'ENOTDIR':
        return 'missing';
      case 'EACCES':
      case 'EPERM':
        return 'inaccessible';
      // EBUSY (locked), EIO, ENODEV / ENETDOWN (volume or network gone),
      // ETIMEDOUT, EAGAIN, UNKNOWN: cannot prove the file was deleted.
      default:
        return 'unavailable';
    }
  }
  if (wantFile ? outcome.kind !== 'file' : outcome.kind !== 'dir') return 'invalid';
  return 'present';
}

/**
 * Windows + UNC + POSIX roots. A relative, empty or NUL-bearing stored value is
 * a broken record — NOT evidence that the user deleted the video.
 */
export function isUsablePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.trim() === '' || value.includes('\u0000')) return false;
  const normalized = value.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') || normalized.startsWith('/');
}

/** Pure string parent — `core` and this module must not import `node:path`. */
export function parentDirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '';
  return index === 0 ? '/' : normalized.slice(0, index);
}

const INVALID_STATE: LocalFileState = { status: 'invalid', dirStatus: 'invalid' };

/** D-248: a batch round keeps at most this many stat calls pending. */
const MAX_PROBE_WORKERS = 4;

/** The derived directory of a bare root does not exist — there is no parent. */
const NO_PARENT: StatOutcome = { kind: 'error', code: 'ENOENT' };

/** D-291: a stat that missed its deadline is reported as this bounded outcome. */
const TIMED_OUT: StatOutcome = { kind: 'error', code: 'ETIMEDOUT' };

export function createLocalFileStatusProbe(options: LocalFileStatusOptions): LocalFileStatusPort {
  const now = options.now ?? ((): number => Date.now());
  const ttl = options.cacheTtlMs ?? 1500;
  // D-291: 1200 ms is long enough for a healthy local/NAS stat and short enough
  // that the queue page never feels frozen; a dead share answers far later.
  const statTimeoutMs = options.statTimeoutMs ?? 1200;
  const hungRetryMs = options.hungRetryMs ?? 5 * 60 * 1000;
  /** path -> epoch ms until which a non-forced round must not re-stat it. */
  const hungUntil = new Map<string, number>();
  const MAX_HUNG_ENTRIES = 256;
  const cache = new Map<string, { readonly key: string; readonly value: LocalFileState; readonly at: number }>();

  /**
   * D-291: bound a single `stat` by a deadline. The underlying `fs.stat` keeps
   * its libuv thread until the OS answers — that part is unavoidable from JS —
   * but the caller must not wait for it, and the quarantine below stops the
   * poll loop from feeding the pool a new hung syscall every round.
   */
  async function withinDeadline(path: string): Promise<StatOutcome> {
    let pending: Promise<StatOutcome>;
    try {
      pending = options.stat(path);
    } catch {
      return { kind: 'error', code: 'UNKNOWN' };
    }
    if (statTimeoutMs <= 0) return pending;
    return new Promise<StatOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(TIMED_OUT);
      }, statTimeoutMs);
      // A hung stat must never keep the process alive after `before-quit`.
      (timer as unknown as { unref?: () => void }).unref?.();
      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'error', code: 'UNKNOWN' });
        },
      );
    });
  }

  function rememberHung(path: string): void {
    hungUntil.set(path, now() + hungRetryMs);
    if (hungUntil.size <= MAX_HUNG_ENTRIES) return;
    // Insertion order is the eviction order; an expired entry always goes first.
    for (const [key, expiry] of hungUntil) {
      if (hungUntil.size <= MAX_HUNG_ENTRIES) break;
      if (expiry <= now() || hungUntil.size > MAX_HUNG_ENTRIES) hungUntil.delete(key);
    }
  }

  /**
   * `allowQuarantine` is false for user-triggered probes (open-file/folder): a
   * reconnected share must answer on the next click, not five minutes later.
   */
  async function statBounded(path: string, allowQuarantine: boolean): Promise<StatOutcome> {
    if (allowQuarantine) {
      const until = hungUntil.get(path);
      if (until !== undefined) {
        if (until > now()) return TIMED_OUT;
        hungUntil.delete(path);
      }
    }
    const outcome = await withinDeadline(path);
    if (outcome.kind === 'error' && outcome.code === 'ETIMEDOUT') rememberHung(path);
    return outcome;
  }

  const keyOf = (task: FileStateInput): string => `${task.state}|${task.artifacts.join('|')}`;

  /**
   * Stage 4: probe the MEDIA file. `artifacts[0]` is a thumbnail or a subtitle
   * on plenty of manifests, and reporting a task as "file deleted" because a
   * `.jpg` is gone would be a lie.
   */
  function splitArtifact(task: FileStateInput): { readonly primary: string; readonly dir: string } | null {
    const primary = primaryMediaArtifact(task.artifacts) ?? task.artifacts[0];
    if (!isUsablePath(primary)) return null;
    return { primary, dir: parentDirOf(primary) };
  }

  function stateOf(
    pair: { readonly dir: string },
    fileStat: StatOutcome,
    dirStat: StatOutcome,
  ): LocalFileState {
    return {
      status: classifyStat(fileStat, true),
      dirStatus: pair.dir === '' ? 'invalid' : classifyStat(dirStat, false),
    };
  }

  /** User-action path: the pair runs concurrently for promptness. */
  async function measure(task: FileStateInput): Promise<LocalFileState> {
    const pair = splitArtifact(task);
    if (pair === null) return INVALID_STATE;
    const [fileStat, dirStat] = await Promise.all([
      statBounded(pair.primary, false),
      pair.dir === '' ? Promise.resolve<StatOutcome>(NO_PARENT) : statBounded(pair.dir, false),
    ]);
    return stateOf(pair, fileStat, dirStat);
  }

  /**
   * Batch path: the [file, dir] pair runs back-to-back. A pool over concurrent
   * pairs would leave `2 × workers` stats pending at once, so the sequential
   * pair pins the whole round's pending-stat peak at exactly the pool size.
   */
  async function measureSequentially(task: FileStateInput, allowQuarantine: boolean): Promise<LocalFileState> {
    const pair = splitArtifact(task);
    if (pair === null) return INVALID_STATE;
    const fileStat = await statBounded(pair.primary, allowQuarantine);
    const dirStat = pair.dir === '' ? NO_PARENT : await statBounded(pair.dir, allowQuarantine);
    return stateOf(pair, fileStat, dirStat);
  }

  function remember(task: FileStateInput, value: LocalFileState): LocalFileState {
    cache.set(task.id, { key: keyOf(task), value, at: now() });
    return value;
  }

  async function probeTask(task: FileStateInput): Promise<LocalFileState> {
    // Not pooled on purpose: an open action must never queue behind a slow
    // (e.g. disconnected network drive) batch round. One click adds one stat
    // pair — user-triggered work cannot pile up.
    return remember(task, await measure(task));
  }

  // ---- D-248: single flight -------------------------------------------------
  // The in-flight round's promise, registered SYNCHRONOUSLY when a round starts
  // and cleared in its `finally`. Overlapping TASK_LIST calls (the poll loop,
  // action-triggered `refreshFileStatus`, a page reload stacking a new first
  // load on top of a still-hanging round) must never start a second batch of
  // stats while one round is still out: on a disconnected network drive every
  // stat hangs for the OS timeout and the old fresh-batch-per-call behaviour
  // accumulated one unbounded batch per overlapping call.
  let round: Promise<Record<string, LocalFileState>> | null = null;

  function startRound(tasks: readonly FileStateInput[], force: boolean): Promise<Record<string, LocalFileState>> {
    const promise = executeRound(tasks, force).finally(() => {
      if (round === promise) round = null;
    });
    round = promise;
    return promise;
  }

  /** One bounded batch: cache-served entries plus a 4-worker stat pool. */
  async function executeRound(tasks: readonly FileStateInput[], force: boolean): Promise<Record<string, LocalFileState>> {
    const result: Record<string, LocalFileState> = {};
    const work: FileStateInput[] = [];
    for (const task of tasks) {
      // Never stat a task that is still downloading: it has no final artifact.
      if (task.state !== 'Completed') continue;
      const key = keyOf(task);
      const hit = cache.get(task.id);
      if (!force && hit !== undefined && hit.key === key && now() - hit.at < ttl) {
        result[task.id] = hit.value;
        continue;
      }
      work.push(task);
    }
    let cursor = 0;
    const failures: unknown[] = [];
    const worker = async (): Promise<void> => {
      while (failures.length === 0) {
        const task = work[cursor];
        if (task === undefined) return;
        cursor += 1;
        try {
          result[task.id] = remember(task, await measureSequentially(task, !force));
        } catch (error) {
          // One failed stat must not turn sibling workers into unhandled
          // rejections; the round still reports the FIRST failure.
          failures.push(error);
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let index = 0; index < Math.min(MAX_PROBE_WORKERS, work.length); index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    if (failures.length > 0) throw failures[0];
    return result;
  }

  async function probe(tasks: readonly FileStateInput[], force = false): Promise<Record<string, LocalFileState>> {
    for (;;) {
      const running = round;
      if (running === null) return startRound(tasks, force);
      // Overlapping non-forced callers share the running round's result. Ids
      // that entered the queue after it started get their observation on the
      // next poll — the renderer treats an absent fileStatus as "unknown".
      if (!force) return running;
      // A forced refresh is never answered by a round that predates it (that
      // round may serve cached values and misses newly recorded paths): wait
      // for it to end, then run a fresh forced round below.
      try {
        await running;
      } catch {
        // The blocking round failed; this caller runs its own round, so a
        // failure it reports is its own, not a borrowed one.
      }
    }
  }

  return {
    probe,
    probeTask,
    forget(taskId: string): void { cache.delete(taskId); },
  };
}

/** Convenience adapter so callers can pass real `TaskRecord`s unchanged. */
export function toFileStateInput(record: TaskRecord): FileStateInput {
  return { id: record.id, state: record.state, artifacts: record.artifacts };
}
