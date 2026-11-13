/**
 * TaskStore — queue snapshot persistence + crash recovery.
 * Recovery rule: `Running` / `FetchingInfo` become `Canceled` (they cannot still
 * be running after a restart) while `lastPercent` is preserved for the UI.
 */
import type { CorePorts, TaskSnapshot, TaskRecord } from '@ytvdlt/shared';
import type { ITaskStore } from '../ports.js';

export interface TaskStoreDeps {
  ports: CorePorts;
  /** Defaults to `<configDir>/tasks.json`. */
  filePath?: string;
}

const RECOVER_TO_CANCELED: ReadonlySet<string> = new Set(['Running', 'FetchingInfo']);

/**
 * Every `TaskState` literal, mirroring `packages/shared/src/task.ts` (7 states).
 * A persisted record whose `state` is not one of these is unreadable garbage:
 * recovery and the UI cannot give it a meaning, so the record is isolated.
 */
const TASK_STATES: ReadonlySet<string> = new Set([
  'Idle', 'FetchingInfo', 'ReadyWithInfo', 'Running', 'Completed', 'Error', 'Canceled',
]);

/**
 * Structural guard for one persisted record (no schema library — core stays
 * dependency-free). Returns the record unchanged when traversing it is safe
 * (`recover` / `countInterrupted` / `queue.restore` read `state` and `id`,
 * spread the rest, and spread `artifacts`), or `null` to isolate it.
 * Deliberately shallow: `mediaInfo` / `request` / `error` pass through as-is —
 * every consumer null-checks them, so a wrong shape degrades display instead
 * of crashing the boot.
 */
function asTraversableRecord(candidate: unknown): TaskRecord | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
  const record = candidate as TaskRecord;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.url !== 'string') return null;
  if (typeof record.state !== 'string' || !TASK_STATES.has(record.state)) return null;
  if (record.artifacts !== undefined && !Array.isArray(record.artifacts)) return null;
  return record;
}

/** Isolate-and-skip: keep every traversable record, count the dropped ones. */
function isolateValidRecords(entries: readonly unknown[]): { records: TaskRecord[]; skipped: number } {
  const records: TaskRecord[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const record = asTraversableRecord(entry);
    if (record === null) {
      skipped += 1;
      continue;
    }
    records.push(record);
  }
  return { records, skipped };
}

export class TaskStore implements ITaskStore {
  private readonly ports: CorePorts;
  private readonly filePath: string;
  /** Records isolated by the most recent `load()` (diagnostics only). */
  private lastLoadSkipped = 0;
  /**
   * T2: internal write queue. `save()` chains onto it so concurrent callers
   * are written to disk strictly in call order — never interleaved, never
   * dropped. The chain itself never rejects (a failed save would otherwise
   * poison every later one); the per-call promise keeps the historical
   * contract (reject on failure). Same house pattern as ConfigStore.
   */
  private writeQueue: Promise<void> = Promise.resolve();
  /** Failure of the most recent `save()` attempt (diagnostics only). */
  private lastSaveFailure: Error | null = null;

  constructor(deps: TaskStoreDeps) {
    this.ports = deps.ports;
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/tasks.json`;
  }

  async load(): Promise<TaskSnapshot> {
    this.lastLoadSkipped = 0;
    try {
      const text = await this.ports.fs.readText(this.filePath);
      const parsed: unknown = JSON.parse(text);
      const candidate = parsed as Partial<TaskSnapshot>;
      if (!Array.isArray(candidate.tasks)) throw new Error('tasks is not an array');
      // Every throw site above precedes this loop, so the fallback below can
      // never observe a half-counted `lastLoadSkipped`.
      const { records, skipped } = isolateValidRecords(candidate.tasks);
      this.lastLoadSkipped = skipped;
      return {
        schemaVersion: 1,
        savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : this.ports.clock.nowIso(),
        tasks: records,
      };
    } catch {
      return { schemaVersion: 1, savedAt: this.ports.clock.nowIso(), tasks: [] };
    }
  }

  /**
   * Queue one snapshot write. The external promise contract is UNCHANGED: the
   * promise resolves only after this call's own snapshot has been fully
   * written, and rejects when the write fails. What changed is the internal
   * ordering: N concurrent calls are executed one at a time, strictly in call
   * order, so two tasks finishing at once can no longer interleave their
   * `mkdir`/`writeTextAtomic` steps and let an older snapshot win the rename.
   * The snapshot is stringified at CALL time, so what lands on disk is exactly
   * what the caller handed over, even if the object is mutated afterwards.
   */
  async save(snapshot: TaskSnapshot): Promise<void> {
    let text: string;
    try {
      text = `${JSON.stringify(snapshot, null, 2)}\n`;
    } catch (error) {
      // A stringify failure is also a failed save attempt — record it like one.
      this.lastSaveFailure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    const run = this.writeQueue.then(() => this.writeSnapshot(text));
    // The chain continues even after a rejection (house pattern, ConfigStore).
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** One serialized write; records the outcome for `lastSaveError`. */
  private async writeSnapshot(text: string): Promise<void> {
    try {
      await this.ports.fs.mkdir(this.ports.env.configDir());
      await this.ports.fs.writeTextAtomic(this.filePath, text);
      this.lastSaveFailure = null;
    } catch (error) {
      this.lastSaveFailure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /** Load + recover in one call (the boot path used by `restoreTasks`). */
  async loadRecovered(): Promise<TaskSnapshot> {
    return this.recover(await this.load());
  }

  /** Path of the snapshot file (exposed for diagnostics / error reports). */
  get snapshotPath(): string {
    return this.filePath;
  }

  /**
   * How many records the most recent `load()` isolated (dropped) because they
   * failed the structural guard — e.g. `null` entries or an unknown `state`.
   * Read-only diagnostics for error reports / logs; a non-zero value means the
   * snapshot on disk was damaged but the rest of it still loaded.
   */
  get lastLoadSkippedCount(): number {
    return this.lastLoadSkipped;
  }

  /**
   * T2: the error of the most recent `save()` attempt, or `null` when that
   * attempt succeeded (or no save has happened yet). Read-only diagnostics in
   * the same spirit as `lastLoadSkippedCount` — callers who swallow a rejected
   * `save()` (TaskQueue.persistSnapshot must, to keep "保存失败不炸下载") can
   * still surface WHY persistence failed without a second IPC surface.
   */
  get lastSaveError(): Error | null {
    return this.lastSaveFailure;
  }

  /**
   * Pure recovery: interrupted states become `Canceled`, progress preserved.
   * Defence in depth: records that fail the structural guard are filtered out
   * instead of throwing, so a hand-built (or future store-provided) snapshot
   * with garbage entries can never crash the boot even if it bypassed `load()`.
   */
  recover(raw: TaskSnapshot): TaskSnapshot {
    const entries: unknown = (raw as { tasks?: unknown } | null)?.tasks;
    let tasks: TaskRecord[] = [];
    if (Array.isArray(entries)) {
      const { records } = isolateValidRecords(entries);
      tasks = records.map((record) => (
        RECOVER_TO_CANCELED.has(record.state)
          ? {
            ...record,
            state: 'Canceled',
            updatedAt: this.ports.clock.nowIso(),
            // lastPercent is intentionally preserved so the UI can show prior progress.
          }
          : record
      ));
    }
    return { schemaVersion: 1, savedAt: this.ports.clock.nowIso(), tasks };
  }
}
