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

export class TaskStore implements ITaskStore {
  private readonly ports: CorePorts;
  private readonly filePath: string;

  constructor(deps: TaskStoreDeps) {
    this.ports = deps.ports;
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/tasks.json`;
  }

  async load(): Promise<TaskSnapshot> {
    try {
      const text = await this.ports.fs.readText(this.filePath);
      const parsed: unknown = JSON.parse(text);
      const candidate = parsed as Partial<TaskSnapshot>;
      if (!Array.isArray(candidate.tasks)) throw new Error('tasks is not an array');
      return {
        schemaVersion: 1,
        savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : this.ports.clock.nowIso(),
        tasks: candidate.tasks,
      };
    } catch {
      return { schemaVersion: 1, savedAt: this.ports.clock.nowIso(), tasks: [] };
    }
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    await this.ports.fs.mkdir(this.ports.env.configDir());
    await this.ports.fs.writeTextAtomic(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  /** Load + recover in one call (the boot path used by `restoreTasks`). */
  async loadRecovered(): Promise<TaskSnapshot> {
    return this.recover(await this.load());
  }

  /** Path of the snapshot file (exposed for diagnostics / error reports). */
  get snapshotPath(): string {
    return this.filePath;
  }

  /** Pure recovery: interrupted states become `Canceled`, progress preserved. */
  recover(raw: TaskSnapshot): TaskSnapshot {
    const tasks: TaskRecord[] = raw.tasks.map((record) => (
      RECOVER_TO_CANCELED.has(record.state)
        ? {
          ...record,
          state: 'Canceled',
          updatedAt: this.ports.clock.nowIso(),
          // lastPercent is intentionally preserved so the UI can show prior progress.
        }
        : record
    ));
    return { schemaVersion: 1, savedAt: this.ports.clock.nowIso(), tasks };
  }
}
