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
  };
}
