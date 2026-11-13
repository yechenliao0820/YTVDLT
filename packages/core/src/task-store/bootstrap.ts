/**
 * Task bootstrapping (M4-3 / 原始验收 ②).
 *
 * One call wires "read the snapshot → recover interrupted states → rehydrate the
 * queue". Kept in core (pure orchestration over `ITaskStore` + `TaskQueue`) so
 * the Electron layer only has to construct the two objects.
 *
 * D-159: the restore report now carries the health of the snapshot load, so a
 * damaged file, isolated records, a backup path and a write-block decision are
 * visible to the boot caller instead of being silently discarded.
 */
import type { TaskSnapshot } from '@ytvdlt/shared';
import type { ITaskStore, TaskLoadDiagnostic } from '../ports.js';
import type { TaskQueue } from '../task-queue/task-queue.js';

/** States that cannot survive a process restart. */
export const INTERRUPTED_STATES: readonly string[] = ['Running', 'FetchingInfo'];

/**
 * D-159: a legacy / hand-built store has no diagnostic contract. Report that
 * honestly rather than claiming the snapshot was verified healthy.
 */
const UNKNOWN_LOAD: TaskLoadDiagnostic = {
  status: 'unknown',
  skippedRecords: 0,
  backupPath: null,
  writeBlocked: false,
  error: null,
};

/**
 * Pure count of tasks that were mid-flight when the snapshot was written.
 * Defence in depth: an entry that is not a traversable record (or has no known
 * string state) can never have been interrupted, so it is skipped instead of
 * throwing — `load()` normally guarantees valid records, but this function is
 * exported and may receive hand-built snapshots.
 */
export function countInterrupted(snapshot: TaskSnapshot): number {
  let count = 0;
  for (const task of snapshot.tasks) {
    if (typeof task?.state === 'string' && INTERRUPTED_STATES.includes(task.state)) count += 1;
  }
  return count;
}

export interface RestoreTasksResult {
  /** Tasks rehydrated into the queue. */
  restored: number;
  /** How many of them were `Running` / `FetchingInfo` before recovery. */
  interrupted: number;
  /** Tasks present in the snapshot but already known to the queue. */
  skipped: number;
  /**
   * True when the loaded snapshot contained no usable tasks. NOTE: a corrupt
   * or unreadable file also loads zero tasks — consult `load.status` before
   * treating `empty: true` as "first run".
   */
  empty: boolean;
  /**
   * D-159: health of the snapshot load that fed this boot. Carries the number
   * of isolated records (previously only available on `TaskStore`, never in the
   * production boot report), the byte-for-byte backup path and whether later
   * writes were refused to protect the original.
   */
  load: TaskLoadDiagnostic;
}

/**
 * Restore the queue from `store`. Interrupted tasks become `Canceled` while
 * their `lastPercent` / `mediaInfo` / `request` are preserved, so the UI can
 * show prior progress and the user can retry with one click.
 *
 * D-159: `queue.restore()` persists unconditionally, so the protection lives in
 * `TaskStore` (backup before filtering + `save()` guard), NOT in a condition
 * here — that also covers every later `persistSnapshot()` from enqueue/progress.
 */
export async function restoreTasks(queue: TaskQueue, store: ITaskStore): Promise<RestoreTasksResult> {
  const raw = await store.load();
  const load = store.lastLoadDiagnostic ?? UNKNOWN_LOAD;
  const interrupted = countInterrupted(raw);
  const recovered = store.recover(raw);
  const restored = await queue.restore(recovered);
  return {
    restored,
    interrupted,
    skipped: Math.max(0, recovered.tasks.length - restored),
    empty: raw.tasks.length === 0,
    load,
  };
}
