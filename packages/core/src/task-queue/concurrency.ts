/**
 * The concurrency rule, split out of `task-queue.ts` (task-6 refactor).
 *
 * Every symbol below was moved VERBATIM from `task-queue.ts` — behaviour is
 * byte-identical. The module exists so the slot-limit rule lives in its own
 * unit instead of inside the queue class file; `TaskQueue` remains the only
 * owner of the actual slot state (`limit`, pending/running).
 *
 * Old import paths keep working: `task-queue.ts` re-exports all three symbols
 * (`export { ... } from './concurrency.js'`), and the `@ytvdlt/core` barrel
 * now also exposes them via `task-queue/index.js`.
 */

/** Hard ceiling: more slots than this only thrashes the network + disk. */
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 3;

/** Pure clamp used by the queue AND by the config layer (single rule). */
export function normalizeConcurrency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(numeric)));
}
