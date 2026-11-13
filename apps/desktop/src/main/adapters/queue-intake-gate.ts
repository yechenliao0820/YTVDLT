/**
 * Lazy `QueueIntakeGate` over the real `TaskQueue` (M5-5, C2).
 *
 * The engine is constructed before `createM5Host()` exists, but the queue lives
 * INSIDE the host. Taking a getter instead of the queue itself breaks that
 * assembly cycle without making either object depend on the other.
 *
 * A missing queue is not an error: `check-runtime` and CLI paths have no queue,
 * and an update there simply runs without pausing anything.
 */
import type { QueueIntakeGate } from '@ytvdlt/shared';
import type { ITaskQueue } from '@ytvdlt/core';

export function createQueueIntakeGate(getQueue: () => ITaskQueue | null | undefined): QueueIntakeGate {
  const current = (): ITaskQueue | null => {
    try {
      return getQueue() ?? null;
    } catch {
      // A getter that throws before the host exists must not break an update.
      return null;
    }
  };
  return {
    pause(): void {
      current()?.pauseIntake();
    },
    resume(): void {
      current()?.resumeIntake();
    },
    isPaused(): boolean {
      return current()?.intakePaused === true;
    },
    /**
     * D-171: poll `activeTaskIds` until the queue is empty. Polling (not an
     * event subscription) is deliberate: the gate is a lazy getter over a queue
     * that may not exist yet, and a subscription would have to be re-attached
     * every time the host is rebuilt.
     */
    async waitForIdle(timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        const queue = current();
        if (queue === null) return true;
        if (queue.activeTaskIds.length === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
      }
    },
  };
}
