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
 * adapter's bounded abort kill settled. That is LATER than the cancel promise
 * itself resolving, so slot release stays its own evidence — neither evidence
 * replaces the other.
 *
 * D-255 (external audit P2-01): slot draining alone is NOT enough. A queued
 * task (`isPending`) occupies NO slot, yet its cancel() — the D-242 pending
 * branch — performs a snapshot write whose settlement used to be
 * fire-and-forget: the quit could proceed before the persistence landed (the
 * record stays on disk and the task REVIVES after a restart), and a REJECTED
 * cancel was swallowed into a log that claimed success. The wait is therefore
 * BOTH evidences under ONE total budget: ① every cancel promise has settled
 * (each outcome registered in the report) AND ② `activeTaskIds` has drained
 * to empty. Each evidence may release early; the deadline cuts both off — a
 * hung shutdown is worse than an unconfirmed child, and the engine's own
 * cancellation latch already guarantees the run settles as `Canceled` no
 * matter how the process eventually dies.
 *
 * Per-task report semantics (`ShutdownCancelReport.tasks`, one entry per
 * requested id, in target order):
 * - `confirmed`        — cancel() resolved `true`. For a running task the
 *   process tree is confirmed dead (D-142); for a queued task the record was
 *   dropped AND the snapshot write completed. The slot release may still lag
 *   the promise — that is evidence ②'s job.
 * - `kill-unconfirmed` — cancel() resolved `false` (D-142: the tree may still
 *   be alive; the record keeps its slot, so `stillActive` names it).
 * - `persist-failed`   — cancel() REJECTED: in the D-242 shape the queued
 *   record was put back in memory and is still on disk — it will be picked up
 *   again after a restart. `reason` carries the rejection message (errno …).
 * - `unsettled`        — the budget expired before the cancel promise
 *   settled; nothing is claimed about the task.
 *
 * Failure only degrades the report: never thrown, never retried, never
 * blocking the quit (D-247's swallow boundary and 5 s budget stand).
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

/**
 * D-255: how one cancel request ended. The three failure shapes the audit
 * demanded visibility for are `persist-failed` (D-242), `kill-unconfirmed`
 * (D-142) and `unsettled` (budget expiry) — semantics documented in the
 * module header.
 */
export type ShutdownCancelTaskOutcome =
  | 'confirmed'
  | 'kill-unconfirmed'
  | 'persist-failed'
  | 'unsettled';

export interface ShutdownCancelTaskResult {
  readonly taskId: string;
  readonly outcome: ShutdownCancelTaskOutcome;
  /** `persist-failed` only: why the cancel was rejected (D-242 errno text). */
  readonly reason?: string;
}

export interface ShutdownCancelReport {
  /** How many tasks received a cancel request (active + queued). */
  readonly requested: number;
  /** Ids still occupying a slot when the wait ended (empty = all drained). */
  readonly stillActive: readonly string[];
  /** True when every slot drained before the budget expired. */
  readonly drained: boolean;
  /**
   * D-255: one entry per requested id (target order). A task whose cancel
   * promise had not settled at the deadline is reported `unsettled` — the
   * report is a snapshot at return time, later settlements change nothing.
   */
  readonly tasks: readonly ShutdownCancelTaskResult[];
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
 * Normalize one `cancel()` call into a promise channel: a synchronous throw
 * from a broken queue must land in the SAME per-task isolation as a rejection
 * (D-247's per-task isolation) instead of aborting the loop or rejecting the
 * whole shutdown.
 */
function invokeCancel(queue: ShutdownCancellableQueue, id: string): Promise<boolean> {
  try {
    return queue.cancel(id);
  } catch (cause: unknown) {
    return Promise.reject(cause);
  }
}

/**
 * Human-readable reason for a rejected cancel (D-242 writes the errno text).
 * Must never throw — a hostile `message` getter would otherwise reject
 * `allCancelled` and break the never-throw boundary of the shutdown path.
 */
function describeRejection(cause: unknown): string {
  try {
    if (cause instanceof Error) return cause.message;
    return String(cause);
  } catch {
    return 'unknown cancel rejection';
  }
}

/**
 * Cancel everything in flight, then wait — WITHIN ONE total budget — for BOTH
 * pieces of evidence: every cancel promise settled (D-255, includes the D-242
 * snapshot write of queued tasks) AND every slot released (坑 27, the run
 * closure settling after the child's exit). Never throws: a per-task cancel
 * failure (D-242 snapshot write) or a broken queue must not block the quit,
 * it only degrades the report the caller logs.
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
    return { requested: 0, stillActive: [...queue.activeTaskIds], drained: true, tasks: [] };
  }

  // Evidence ① (D-255): one cancel per task, isolated, and now REGISTERED —
  // a rejected cancel (D-242 write failure) or an honest `false` (D-142
  // unconfirmed kill) must not break the others or the quit, but it can no
  // longer vanish: allSettled lands each outcome in `results`.
  const cancels = targets.map((id) => invokeCancel(queue, id));
  const results: Array<ShutdownCancelTaskResult | undefined> = targets.map(() => undefined);
  const allCancelled = Promise.allSettled(cancels).then((outcomes) => {
    for (let index = 0; index < outcomes.length; index += 1) {
      const settled = outcomes[index];
      const id = targets[index];
      if (settled === undefined || id === undefined) continue;
      results[index] = settled.status === 'fulfilled'
        ? (settled.value
          ? { taskId: id, outcome: 'confirmed' }
          : { taskId: id, outcome: 'kill-unconfirmed' })
        : { taskId: id, outcome: 'persist-failed', reason: describeRejection(settled.reason) };
    }
  });

  // Evidence ② (坑 27 discipline): ISSUING a cancel is not proof the child
  // exited. Slot release IS the observable evidence (see the module header).
  // Poll until the slots drain or the budget expires — whichever comes first.
  const deadline = Date.now() + budgetMs;
  const drainWait = (async (): Promise<boolean> => {
    let drained = queue.activeTaskIds.length === 0;
    while (!drained && Date.now() < deadline) {
      await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
      drained = queue.activeTaskIds.length === 0;
    }
    return drained;
  })();

  // ONE budget bounds BOTH evidences (D-255): wait until every cancel promise
  // has settled AND the slots drained — each may release early, the deadline
  // cuts both off. Expiry degrades the report (`unsettled` entries); it never
  // throws, never retries, never blocks the quit (D-247 boundary stands).
  await Promise.race([allCancelled, sleep(Math.max(0, deadline - Date.now()))]);
  const drained = await drainWait;

  return {
    requested: targets.length,
    stillActive: [...queue.activeTaskIds],
    drained,
    tasks: targets.map((id, index): ShutdownCancelTaskResult =>
      results[index] ?? { taskId: id, outcome: 'unsettled' }),
  };
}
