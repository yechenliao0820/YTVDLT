/**
 * Task bootstrapping (M4-3 / 原始验收 ②).
 *
 * One call wires "read the snapshot → recover interrupted states → rehydrate the
 * queue". Kept in core (pure orchestration over `ITaskStore` + `TaskQueue`) so
 * the Electron layer only has to construct the two objects.
 */
import type { TaskSnapshot } from '@ytvdlt/shared';
import type { ITaskStore } from '../ports.js';
import type { TaskQueue } from '../task-queue/task-queue.js';

/** States that cannot survive a process restart. */
export const INTERRUPTED_STATES: readonly string[] = ['Running', 'FetchingInfo'];

/** Pure count of tasks that were mid-flight when the snapshot was written. */
export function countInterrupted(snapshot: TaskSnapshot): number {
  return snapshot.tasks.filter((task) => INTERRUPTED_STATES.includes(task.state)).length;
}

export interface RestoreTasksResult {
  /** Tasks rehydrated into the queue. */
  restored: number;
  /** How many of them were `Running` / `FetchingInfo` before recovery. */
  interrupted: number;
  /** Tasks present in the snapshot but already known to the queue. */
  skipped: number;
  /** True when no snapshot file existed (first run). */
  empty: boolean;
}

/**
 * Restore the queue from `store`. Interrupted tasks become `Canceled` while
 * their `lastPercent` / `mediaInfo` / `request` are preserved, so the UI can
 * show prior progress and the user can retry with one click.
 */
export async function restoreTasks(queue: TaskQueue, store: ITaskStore): Promise<RestoreTasksResult> {
  const raw = await store.load();
  const interrupted = countInterrupted(raw);
  const recovered = store.recover(raw);
  const restored = await queue.restore(recovered);
  return {
    restored,
    interrupted,
    skipped: Math.max(0, recovered.tasks.length - restored),
    empty: raw.tasks.length === 0,
  };
}
