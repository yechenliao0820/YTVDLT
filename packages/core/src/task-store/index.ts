export { TaskStore, type TaskStoreDeps } from './task-store.js';
// M4-3 (append-only): boot-time recovery orchestration.
export {
  restoreTasks, countInterrupted, INTERRUPTED_STATES,
  type RestoreTasksResult,
} from './bootstrap.js';
