/**
 * D-120 — local artifact state probe (main-process only, pure logic).
 *
 * The renderer must never touch the filesystem. This module classifies the
 * recorded artifact path of a COMPLETED task into one stable bucket, using an
 * injected `stat` so it stays L0-testable and has no `node:*` / `electron`
 * import. The real `stat` lives in `adapters/local-file-status-port.ts`.
 *
 * Three rules that must not be relaxed:
 *  1. Only `ENOENT` / `ENOTDIR` mean "gone". Permission, locked files, an
 *     unavailable volume and unknown errno are NOT "deleted" — misreporting
 *     a transient error as a missing file is how a user loses their history.
 *  2. Only completed tasks are probed in batch; running tasks are skipped
 *     entirely (no filesystem work, no invented state).
 *  3. Results are cached briefly. `probeTask()` always re-stats (user-triggered
 *     open actions), and `forget()` drops the cache after a record is removed.
 */
import type { TaskRecord } from '@ytvdlt/shared';

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
  /** Batch probe. Non-completed tasks are absent from the result. */
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

export function createLocalFileStatusProbe(options: LocalFileStatusOptions): LocalFileStatusPort {
  const now = options.now ?? ((): number => Date.now());
  const ttl = options.cacheTtlMs ?? 1500;
  const cache = new Map<string, { readonly key: string; readonly value: LocalFileState; readonly at: number }>();

  const keyOf = (task: FileStateInput): string => `${task.state}|${task.artifacts.join('|')}`;

  async function measure(task: FileStateInput): Promise<LocalFileState> {
    const primary = task.artifacts[0];
    if (!isUsablePath(primary)) return INVALID_STATE;
    const dir = parentDirOf(primary);
    const [fileStat, dirStat] = await Promise.all([
      options.stat(primary),
      dir === '' ? Promise.resolve<StatOutcome>({ kind: 'error', code: 'ENOENT' }) : options.stat(dir),
    ]);
    return {
      status: classifyStat(fileStat, true),
      dirStatus: dir === '' ? 'invalid' : classifyStat(dirStat, false),
    };
  }

  async function probeTask(task: FileStateInput): Promise<LocalFileState> {
    const value = await measure(task);
    cache.set(task.id, { key: keyOf(task), value, at: now() });
    return value;
  }

  async function probe(tasks: readonly FileStateInput[], force = false): Promise<Record<string, LocalFileState>> {
    const result: Record<string, LocalFileState> = {};
    const pending: Promise<void>[] = [];
    for (const task of tasks) {
      // Never stat a task that is still downloading: it has no final artifact.
      if (task.state !== 'Completed') continue;
      const key = keyOf(task);
      const hit = cache.get(task.id);
      if (!force && hit !== undefined && hit.key === key && now() - hit.at < ttl) {
        result[task.id] = hit.value;
        continue;
      }
      pending.push(probeTask(task).then((value) => { result[task.id] = value; }));
    }
    await Promise.all(pending);
    return result;
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
