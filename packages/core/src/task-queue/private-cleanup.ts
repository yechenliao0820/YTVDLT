/**
 * D-232 · which records a private-mode close may purge.
 *
 * The queue toolbar's 「无痕下载」 switch is a promise about the DOWNLOADS the
 * user made while it was on, not about records from before it was flipped. The
 * old close hook walked `queue.list()` and removed every non-running row, so
 * turning private mode on for one video erased the ordinary downloads the user
 * still wanted — an irreversible deletion of data that was never private.
 *
 * Two rules, deliberately independent of the current switch position:
 *  1. only `record.privateMode === true` is a cleanup target. The flag is
 *     captured at enqueue time and survives restarts (it is part of the
 *     snapshot), so the decision belongs to the record, not to whatever the
 *     toggle says hours later;
 *  2. a record that still occupies a slot (`Running` / `FetchingInfo`) is
 *     skipped — `TaskQueue.remove()` refuses it anyway, and killing a live
 *     download to tidy a list is not what "close the window" means. Its own
 *     `run().finally` will persist the finished state; the NEXT close removes
 *     it.
 *
 * D-240 (audit P1) closed the leak this rule used to have: skipping a running
 * record kept it OUT of this pass but still IN `tasks.json`, so a crash / kill
 * during the download restored a `Canceled` private row on the next launch.
 * Private rows are now excluded from every snapshot at the write boundary
 * (`persistableRecords`) and dropped by `restore()`, so "skipped here" no
 * longer means "still on disk". This purge is therefore only the in-memory
 * tidy-up; privacy no longer depends on it running at all.
 *
 * Pure and dependency-free on purpose: no `node:*`, no queue import (the
 * minimal port shape below keeps this testable and keeps `task-queue.ts` the
 * only state owner). The caller supplies the covers' `forget` callback because
 * the thumbnail cache lives in the desktop layer.
 *
 * D-252 closes the cache-layer gap of the same promise: `forget()` only drops
 * the in-memory reference, so the cover FILE and its `index.json` entry used to
 * wait for a prune pass — which is gated by the `autoCleanThumbnailCache`
 * SPACE-hygiene switch and by future `ensure()` traffic. Privacy is a
 * correctness promise, not space hygiene, so a close must also decide WHICH
 * covers may be recycled now. `coverNamesOwnedOnlyBy()` is that decision as a
 * pure set rule (a cover goes only when EVERY index-recorded task id belongs
 * to the purge — a cover shared with any other task, or never attributed at
 * all, is left to the existing prune rules). The desktop adapter turns the
 * returned names into guarded recycle-bin deletes.
 */
import type { TaskRecord, TaskState } from '@ytvdlt/shared';

/** The minimum a cover-index entry must expose for the ownership decision. */
export interface PrivateCoverEntry {
  /** Task ids recorded in the thumbnail cache index; empty = never attributed. */
  readonly taskIds: readonly string[];
}

/**
 * D-252 · which cache cover names a private-mode close may recycle.
 *
 * A name qualifies only when the index attributes it to at least one task and
 * EVERY attributed id is in `ownerIds` (the ids that were just purged). This
 * keeps the exact reference-counting semantics of the prune pass: a cover
 * shared with any task outside the purge — live, settled, or an unknown id
 * from an older session — survives, and untracked files (`taskIds: []`) stay
 * with the age/budget rules that own them.
 *
 * external online audit P2 · the optional `liveIds` narrows that rule to what
 * privacy actually needs. A task id recorded in the index but ABSENT from
 * `liveIds` (the queue's `list()`) is stale bookkeeping: the record was
 * already removed and nothing ever cleans historical ids out of the index, so
 * no card can ever use the cover again — such an id must not block the
 * recycle forever. With `liveIds` a name therefore qualifies when the purge
 * owns part of it (the cover really belongs to a just-removed task) and every
 * remaining reference is either purged or no longer live; a LIVE reference
 * outside the purge still keeps the cover (its card needs it). Omitting
 * `liveIds` keeps the exact D-252 exclusivity semantics above (the existing
 * pins and the old call shape are unchanged).
 */
export function coverNamesOwnedOnlyBy<E extends PrivateCoverEntry>(
  entries: Readonly<Record<string, E>>,
  ownerIds: ReadonlySet<string>,
  liveIds?: ReadonlySet<string>,
): string[] {
  const names: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.taskIds.length === 0) continue;
    if (liveIds === undefined) {
      if (!entry.taskIds.every((id) => ownerIds.has(id))) continue;
    } else {
      // The purge must own part of the cover, and every other reference must
      // be purged too or no longer live (stale bookkeeping does not block).
      if (!entry.taskIds.some((id) => ownerIds.has(id))) continue;
      if (!entry.taskIds.every((id) => ownerIds.has(id) || !liveIds.has(id))) continue;
    }
    names.push(name);
  }
  return names;
}

/** The minimum a purge needs from a queue — structurally satisfied by TaskQueue. */
export interface PrivateCleanupQueue {
  list(): readonly TaskRecord[];
  remove(taskId: string): Promise<boolean>;
}

/** States that still hold a slot; `TaskQueue.remove()` refuses these. */
const SLOT_HOLDING: readonly TaskState[] = ['Running', 'FetchingInfo'];

/** True when this record must disappear when a private-mode session closes. */
export function shouldPurgeOnPrivateClose(
  record: Pick<TaskRecord, 'privateMode' | 'state'>,
): boolean {
  if (record.privateMode !== true) return false;
  return !SLOT_HOLDING.includes(record.state);
}

export interface PrivatePurgeReport {
  /** Ids actually removed from the queue. */
  readonly removed: readonly string[];
  /** Private ids left alone because they are still running. */
  readonly keptRunning: readonly string[];
}

/**
 * Remove every settled private record. Files are never touched — the media the
 * user downloaded belongs to them (D-88's "cleanup never touches the
 * filesystem" rule is unchanged); only the queue row and its snapshot entry go.
 *
 * A `remove()` rejection propagates: the snapshot write failed, so the row is
 * still on disk and pretending otherwise would hide a failed privacy cleanup.
 */
export async function purgePrivateRecords(
  queue: PrivateCleanupQueue,
  forgetCover?: (taskId: string) => void,
): Promise<PrivatePurgeReport> {
  const removed: string[] = [];
  const keptRunning: string[] = [];
  for (const record of queue.list()) {
    if (record.privateMode !== true) continue;
    if (!shouldPurgeOnPrivateClose(record)) {
      keptRunning.push(record.id);
      continue;
    }
    if (await queue.remove(record.id)) {
      removed.push(record.id);
      forgetCover?.(record.id);
    }
  }
  return { removed, keptRunning };
}
