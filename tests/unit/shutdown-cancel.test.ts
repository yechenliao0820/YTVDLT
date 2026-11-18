/**
 * D-247 · quit-time cancellation of in-flight downloads (shutdown-cancel).
 *
 * The audit claim: 「退出」 / Alt+F4 ended the process without touching running
 * downloads, leaving `yt-dlp` orphans (bandwidth + `.part` writes + restart
 * state mismatch). The fix wires the EXISTING cancel chain (TaskQueue.cancel()
 * -> engine handle -> killTree with bounded exit-evidence wait, D-142/D-156,
 * 坑 21/坑 27) into the quit path, with a TOTAL budget after which the quit
 * proceeds and the caller logs a WARNING.
 *
 * The fake queue here mirrors the real contract (坑 37/41 discipline: fakes
 * must reproduce the real dispatch semantics, not just "call it"): a slot is
 * released only when the run's closure has settled, which is exactly the
 * evidence `activeTaskIds` draining to empty stands for. The budget tests run
 * on a FAKE CLOCK (vi.useFakeTimers) — no real 5 s waits, no timing flakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SHUTDOWN_CANCEL_BUDGET_MS,
  cancelRunningTasksForShutdown, shutdownCancelTargets,
  type ShutdownCancellableQueue,
} from '../../apps/desktop/src/main/shutdown-cancel.js';

interface FakeQueue {
  queue: ShutdownCancellableQueue;
  /** Mutate to simulate runs settling / new slots. */
  active: string[];
  pending: string[];
  /** Every cancel() invocation, in order. */
  cancelCalls: string[];
  /** Per-task cancel behaviour; default = confirm immediately (no drain). */
  cancelImpls: Map<string, () => Promise<boolean>>;
}

function fakeQueue(initial: { active?: string[]; pending?: string[] } = {}): FakeQueue {
  const fq: FakeQueue = {
    active: [...(initial.active ?? [])],
    pending: [...(initial.pending ?? [])],
    cancelCalls: [],
    cancelImpls: new Map(),
    queue: null as unknown as ShutdownCancellableQueue,
  };
  fq.queue = {
    get activeTaskIds(): readonly string[] { return [...fq.active]; },
    isPending: (id: string) => fq.pending.includes(id),
    list: () => [...fq.active, ...fq.pending].map((id) => ({ id })),
    cancel: async (id: string): Promise<boolean> => {
      fq.cancelCalls.push(id);
      const impl = fq.cancelImpls.get(id);
      return impl ? await impl() : true;
    },
  };
  return fq;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('D-247 · shutdownCancelTargets', () => {
  it('collects running AND queued ids, deduplicated, and ignores settled records', () => {
    const fq = fakeQueue({ active: ['a', 'b'], pending: ['b', 'p'] });
    expect(shutdownCancelTargets(fq.queue)).toEqual(['a', 'b', 'p']);
  });

  it('a restored Idle/ReadyWithInfo record (no slot, not queued) is NOT a target', () => {
    // restore() deliberately leaves such records out of the FIFO (D-209) —
    // cancel() would reject the transition and there is no child behind them.
    const fq = fakeQueue();
    fq.queue.list = () => [{ id: 'restored-idle' }];
    expect(shutdownCancelTargets(fq.queue)).toEqual([]);
  });

  it('an empty queue yields no targets', () => {
    expect(shutdownCancelTargets(fakeQueue().queue)).toEqual([]);
  });
});

describe('D-247 · cancelRunningTasksForShutdown', () => {
  it('(a) with a running download: cancel is requested and the wait ends on the drain evidence', async () => {
    const fq = fakeQueue({ active: ['dl'], pending: ['queued'] });
    // The kill is confirmed only AFTER the run settles: the slot drains 250 ms
    // into the wait (fake clock — no real waiting).
    fq.cancelImpls.set('dl', async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
      fq.active = [];
      return true;
    });

    const pendingReport = cancelRunningTasksForShutdown(fq.queue);
    // The cancels fire BEFORE any waiting happens.
    await vi.advanceTimersByTimeAsync(0);
    expect(fq.cancelCalls).toEqual(['dl', 'queued']);

    let settled = false;
    void pendingReport.then(() => { settled = true; });
    // One poll later the slot is still occupied (child not yet confirmed dead)
    // — the helper must still be waiting, not pretending the quit is safe.
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    // The kill confirms and the slot drains: the wait resolves with evidence.
    await vi.advanceTimersByTimeAsync(300);
    const report = await pendingReport;
    expect(settled).toBe(true);
    expect(report).toEqual({ requested: 2, stillActive: [], drained: true });
  });

  it('(b) killTree stuck (slot never drains): the budget expires and the quit is released with the WARNING evidence', async () => {
    const fq = fakeQueue({ active: ['stuck'] });
    // D-142 shape: the taskkill answer never arrives, the record keeps its
    // slot forever. The cancel itself resolves (honestly) false.
    fq.cancelImpls.set('stuck', async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 60_000); });
      return false;
    });

    const pendingReport = cancelRunningTasksForShutdown(fq.queue);
    await vi.advanceTimersByTimeAsync(0);
    expect(fq.cancelCalls).toEqual(['stuck']);

    let settled = false;
    void pendingReport.then(() => { settled = true; });
    // Well inside the budget: still waiting, still holding the slot.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_CANCEL_BUDGET_MS - 500);
    expect(settled).toBe(false);
    // Budget expiry — not a second earlier, not a second later — releases the
    // quit with the unconfirmed ids for the WARNING log.
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await pendingReport;
    expect(settled).toBe(true);
    expect(report.drained).toBe(false);
    expect(report.requested).toBe(1);
    expect(report.stillActive).toEqual(['stuck']);
  });

  it('(c) no in-flight tasks: no cancel call, immediate return, behaviour unchanged', async () => {
    const fq = fakeQueue();
    const report = await cancelRunningTasksForShutdown(fq.queue);
    expect(fq.cancelCalls).toEqual([]);
    expect(report).toEqual({ requested: 0, stillActive: [], drained: true });
    // Resolved without advancing any timer: the quit path gains no delay.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queued-only tasks are dropped from the FIFO without any wait', async () => {
    const fq = fakeQueue({ pending: ['p1', 'p2'] });
    const report = await cancelRunningTasksForShutdown(fq.queue);
    expect(fq.cancelCalls).toEqual(['p1', 'p2']);
    expect(report).toEqual({ requested: 2, stillActive: [], drained: true });
  });

  it('a per-task cancel rejection (D-242 snapshot write) never breaks the shutdown', async () => {
    const fq = fakeQueue({ active: ['boom', 'healthy'] });
    // D-242 shape: the cancel could not persist the snapshot and REJECTS.
    // The fire-and-forget isolation must swallow it (vitest fails the whole
    // run on any unhandled rejection, so this test staying green IS the
    // no-unhandled-rejection assertion).
    fq.cancelImpls.set('boom', async () => {
      throw new Error('任务取消未能写入队列快照（ENOSPC），任务仍在队列中');
    });
    fq.cancelImpls.set('healthy', async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      fq.active = [];
      return true;
    });
    const pendingReport = cancelRunningTasksForShutdown(fq.queue);
    // Fake clock: drive the healthy task's settle timer and the poll loop.
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await pendingReport;
    expect(fq.cancelCalls).toEqual(['boom', 'healthy']);
    expect(report.drained).toBe(true);
    expect(report.requested).toBe(2);
  });
});
