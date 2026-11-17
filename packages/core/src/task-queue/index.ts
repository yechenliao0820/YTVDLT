export * from './state-machine.js';
// Task-6 split: the pure clusters moved out of `task-queue.ts`. The named
// export below keeps the ORIGINAL barrel surface intact (same symbols, same
// shapes); the `export *` lines only add the new module paths.
export * from './concurrency.js';
export * from './snapshot-projection.js';
export * from './history-entry.js';
export * from './app-error.js';
export * from './private-cleanup.js';
export {
  TaskQueue, normalizeConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY,
  type TaskQueueDeps,
} from './task-queue.js';
