/**
 * shutdown-cancel — quit-time cancellation of in-flight downloads (D-247).
 *
 * The audit claim this module closes: the app menu 「退出」 and the whole real
 * quit path used to end the process WITHOUT touching running downloads, so the
 * `yt-dlp` children became orphans — still consuming bandwidth, still writing
 * `.part` files, and leaving task state inconsistent after a restart. The
 * cancel capability itself already existed end-to-end (D-142/D-156/D-162/D-200:
 * `TaskQueue.cancel()` -> engine handle -> `killTree()` with a bounded wait for
 * EXIT EVIDENCE — 手册坑 27); the quit path simply never called it.
 *
 * What "the child exited" means HERE, without reaching into `TaskQueue`
 * internals (task-queue.ts is read-only for this fix): a slot is released only
 * when the run's own closure has settled — for a download that happens after
 * the engine observed the child's close / exit evidence, for a probe after the
 * adapter's bounded abort kill settled. So the observable evidence this module
 * waits for is `activeTaskIds` draining to empty, under a TOTAL budget. When
 * the budget expires (D-142 kill genuinely failed, taskkill.exe stuck, …) the
 * caller proceeds with the quit and logs a WARNING — a hung shutdown is worse
 * than an unconfirmed child, and the engine's own cancellation latch already
 * guarantees the run settles as `Canceled` no matter how the process
 * eventually dies.
 *
 * Cancellation semantics follow the existing contracts, nothing new is
 * invented: queued-but-not-started tasks are dropped from the FIFO
 * (`cancel()` pending branch, D-242 may throw on a failed snapshot write —
 * caught per task so a broken disk cannot block quitting), running tasks land
 * in `Canceled` (D-200 / D-209) and after a restart they are retried BY HAND
 * (D-209: startup never auto-resumes).
 *
 * This file stays free of `electron` / `node:*` imports so the unit tests can
 * drive it with fakes and a fake clock (same seam rationale as bootstrap.ts).
 */

/**
 * The slice of `ITaskQueue` / `TaskQueue` the shutdown path needs. Structural
 * on purpose: unit tests inject a fake queue without importing core.
 */
export interface ShutdownCancellableQueue {
  /** Ids currently occupying a slot (probe or transfer in flight). */
  readonly activeTaskIds: readonly string[];
  /** True while the record is parked in the FIFO and has not started. */
  isPending(taskId: string): boolean;
  list(): readonly { readonly id: string }[];
  /**
   * Existing public cancel API (D-142 contract): `true` = the process tree is
   * confirmed dead (or a queued task was dropped); `false` = unconfirmed.
   * May REJECT when the snapshot write fails (D-242) — caught per task here.
   */
  cancel(taskId: string): Promise<boolean>;
}

export interface ShutdownCancelReport {
  /** How many tasks received a cancel request (active + queued). */
  readonly requested: number;
  /** Ids still occupying a slot when the wait ended (empty = all drained). */
  readonly stillActive: readonly string[];
  /** True when every slot drained before the budget expired. */
  readonly drained: boolean;
}

/**
 * Total shutdown budget. 5 s mirrors the bounded-wait sums the adapter already
 * uses (TERMINATION_GRACE_MS / OVERFLOW_SETTLE_GRACE_MS): enough for
 * `taskkill /T /F` to answer on a healthy machine, short enough that "退出"
 * never feels stuck. Expiry is reported, never thrown.
 */
export const SHUTDOWN_CANCEL_BUDGET_MS = 5_000;

/** How often the drain evidence is re-read while waiting. */
const POLL_INTERVAL_MS = 100;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Every task that should be cancelled at quit: ids occupying a slot RIGHT NOW
 * (probe or download in flight) plus queued-but-not-started ids. Restored
 * `Idle` / `ReadyWithInfo` records that were never started this session are
 * neither — `cancel()` would reject them as illegal transitions, and there is
 * no child process behind them to wait for.
 */
export function shutdownCancelTargets(queue: ShutdownCancellableQueue): string[] {
  const ids = new Set<string>(queue.activeTaskIds);
  for (const record of queue.list()) {
    if (queue.isPending(record.id)) ids.add(record.id);
  }
  return [...ids];
}

/**
 * Cancel everything in flight, then wait — WITHIN the budget — for the queue
 * to release every slot. Never throws: a per-task cancel failure (D-242
 * snapshot write) or a broken queue must not block the quit, it only degrades
 * the report the caller logs.
 */
export async function cancelRunningTasksForShutdown(
  queue: ShutdownCancellableQueue,
  options: {
    /** Total wait budget; default {@link SHUTDOWN_CANCEL_BUDGET_MS}. */
    readonly budgetMs?: number;
    /** Evidence re-read interval; default 100 ms (tests shrink this). */
    readonly pollMs?: number;
    /** Injectable wait so a fake clock can drive the poll loop. */
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ShutdownCancelReport> {
  const budgetMs = options.budgetMs ?? SHUTDOWN_CANCEL_BUDGET_MS;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;

  const targets = shutdownCancelTargets(queue);
  if (targets.length === 0) {
    return { requested: 0, stillActive: [...queue.activeTaskIds], drained: true };
  }

  // One cancel per task, isolated: a rejected cancel (D-242 write failure) or
  // an honest `false` (D-142 unconfirmed kill) must not break the others or
  // the quit. The promises are deliberately not awaited individually — the
  // drain evidence below is the thing the budget actually bounds.
  for (const id of targets) {
    void queue.cancel(id).catch(() => false);
  }

  // 坑 27 discipline: ISSUING a cancel is not proof the child exited. Slot
  // release IS the observable evidence (see the module header). Poll until the
  // slots drain or the budget expires — whichever comes first.
  const deadline = Date.now() + budgetMs;
  let drained = queue.activeTaskIds.length === 0;
  while (!drained && Date.now() < deadline) {
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    drained = queue.activeTaskIds.length === 0;
  }
  return {
    requested: targets.length,
    stillActive: [...queue.activeTaskIds],
    drained,
  };
}
