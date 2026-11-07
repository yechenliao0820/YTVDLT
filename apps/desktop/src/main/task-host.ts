/**
 * TaskHost — boot-time assembly of the M4 task queue (M4-3).
 *
 * Responsibilities, in order:
 *   1. read `general.concurrency` from ConfigStore (default 3, clamped 1..8);
 *   2. build `TaskStore` (`<configDir>/tasks.json`, atomic write);
 *   3. build the concurrent `TaskQueue`;
 *   4. restore the previous session's tasks (interrupted → `Canceled`).
 *
 * No `electron` import here on purpose: the host is L0-testable with injected
 * ports and never opens a window.
 */
import type { CorePorts, DownloadEngine } from '@ytvdlt/shared';
import {
  ConfigStore, HistoryStore, TaskQueue, TaskStore, normalizeConcurrency, restoreTasks,
  type IArtifactVerifier, type IHistoryStore,
} from '@ytvdlt/core';

export interface TaskHostOptions {
  ports: CorePorts;
  engine: DownloadEngine;
  verifier: IArtifactVerifier;
  /** Absolute path of the bundled node.exe (EJS runtime). */
  jsRuntimePath: string;
  /** Defaults to `<configDir>/tasks.json`. */
  snapshotPath?: string;
  /** Defaults to `<configDir>/config.json`. */
  configPath?: string;
  /** Test/CLI override; when absent `general.concurrency` wins. */
  concurrency?: number;
  history?: IHistoryStore;
}

export interface TaskHost {
  config: ConfigStore;
  store: TaskStore;
  queue: TaskQueue;
  history: IHistoryStore;
  /** Effective slot limit after clamping. */
  concurrency: number;
  /** What the boot recovery did (restored / interrupted / skipped / empty). */
  restore: Awaited<ReturnType<typeof restoreTasks>>;
}

export async function createTaskHost(options: TaskHostOptions): Promise<TaskHost> {
  const { ports } = options;
  const config = new ConfigStore({
    ports,
    ...(options.configPath === undefined ? {} : { filePath: options.configPath }),
  });
  await config.load();

  const configured = options.concurrency ?? config.get<number>('general', 'concurrency');
  const concurrency = normalizeConcurrency(configured);

  const store = new TaskStore({
    ports,
    ...(options.snapshotPath === undefined ? {} : { filePath: options.snapshotPath }),
  });
  const history = options.history ?? new HistoryStore({ ports });
  const queue = new TaskQueue({
    ports,
    engine: options.engine,
    verifier: options.verifier,
    history,
    taskStore: store,
    jsRuntimePath: options.jsRuntimePath,
    concurrency,
  });

  const restore = await restoreTasks(queue, store);
  return { config, store, queue, history, concurrency, restore };
}
