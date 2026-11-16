/**
 * HistoryStore — JSON + atomic write, dedupe by normalized primary path,
 * search/filter, private-mode skip, remove (optionally deleting files).
 * Zero `node:*`; all I/O through `CorePorts`.
 */
import type {
  CorePorts, HistoryEntry, HistoryQuery, HistoryAddResult,
} from '@ytvdlt/shared';
import type { IHistoryStore } from '../ports.js';
import { applyQuery, dedupeKey, normalizePath } from './query.js';

interface HistoryFile {
  schemaVersion: 1;
  entries: HistoryEntry[];
}

export interface HistoryStoreDeps {
  ports: CorePorts;
  /** Defaults to `<configDir>/history.json`. */
  filePath?: string;
}

export class HistoryStore implements IHistoryStore {
  private readonly ports: CorePorts;
  private readonly filePath: string;
  private entries: HistoryEntry[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(deps: HistoryStoreDeps) {
    this.ports = deps.ports;
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/history.json`;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.ports.fs.mkdir(this.ports.env.configDir());
    if (!(await this.ports.fs.exists(this.filePath))) {
      this.entries = [];
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await this.ports.fs.readText(this.filePath));
      const candidate = parsed as Partial<HistoryFile>;
      this.entries = Array.isArray(candidate.entries) ? candidate.entries : [];
    } catch {
      // Corrupt history must not crash the app; start empty (data is regenerable).
      this.entries = [];
    }
  }

  /**
   * Serialize the given (would-be) state. Callers pass the NEXT entries array,
   * never `this.entries` directly: the whole point of the persist-first,
   * commit-after contract below is that the state on disk is decided BEFORE
   * memory moves. `writeTextAtomic` stays the atomic primitive — a failed
   * write leaves no half-written file behind, so a rejection here means the
   * disk still holds exactly the previous state.
   */
  private async persist(entries: HistoryEntry[]): Promise<void> {
    const payload: HistoryFile = { schemaVersion: 1, entries };
    await this.ports.fs.writeTextAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    // The chain keeps `Promise<void>` on purpose: a rejected task must never
    // poison later queue tasks. The caller-facing promise is `next`, which
    // still rejects with the task's own error.
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Persist-first, commit-after (audit follow-up to D-218): the entire
   * read → dedupe-check → build-next → persist → commit sequence runs INSIDE
   * the write-queue task. The write queue is strictly serial, so a queue task
   * is the only writer of `this.entries` while it runs — the sequence is
   * effectively atomic. When `persist()` rejects, NOTHING has been committed:
   * memory still holds the old entries and the disk still holds the previous
   * state (atomic write), so there is no residue in memory, no memory/disk
   * divergence, and every later queue task serializes the clean state.
   *
   * Deliberately NO "restore the old array" rollback on failure: the old
   * commit-early pattern was what created residue in the first place, and a
   * restore-style rollback would risk clobbering records another queue task
   * appended meanwhile. Here a failure simply leaves both sides untouched.
   *
   * `query()` / `get()` read `this.entries` and therefore always observe the
   * last COMMITTED state (never a write that may still fail).
   */
  async add(entry: HistoryEntry, opts: { privateMode?: boolean } = {}): Promise<HistoryAddResult> {
    await this.init();
    if (opts.privateMode === true) {
      // Private mode: never persist, but the task still completes normally.
      return { added: false, reason: 'private-mode' };
    }
    return this.enqueue(async () => {
      const key = dedupeKey(entry);
      const existing = this.entries.find((candidate) => dedupeKey(candidate) === key);
      if (existing !== undefined) return { added: false, reason: 'duplicate', existing };
      const next = [...this.entries, entry];
      await this.persist(next); // persist the would-be state first
      this.entries = next;      // commit memory only after the write succeeded
      return { added: true, entry };
    });
  }

  async query(q: HistoryQuery): Promise<HistoryEntry[]> {
    await this.init();
    return applyQuery(this.entries, q);
  }

  async get(id: string): Promise<HistoryEntry | null> {
    await this.init();
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  /**
   * Same persist-first, commit-after contract as `add()` (see there for the
   * full rationale): the removal is persisted as the would-be state and only
   * committed to memory after the atomic write succeeded. A persist failure
   * leaves the entry in memory AND on disk (no divergence, no compensation
   * needed) and the returned error surfaces to the caller unchanged.
   */
  async remove(id: string, opts: { deleteFile?: boolean } = {}): Promise<boolean> {
    await this.init();
    const removed = await this.enqueue(async () => {
      const entry = this.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) return null;
      const next = this.entries.filter((candidate) => candidate.id !== id);
      await this.persist(next); // persist the would-be state first
      this.entries = next;      // commit memory only after the write succeeded
      return entry;
    });
    if (removed === null) return false;
    if (opts.deleteFile === true) {
      const targets = [removed.videoPath, removed.audioPath, removed.thumbnailPath, ...removed.subtitlePaths]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      for (const target of targets) {
        try { await this.ports.fs.unlink(target); } catch { /* missing file is fine */ }
      }
    }
    return true;
  }

  async exportJson(): Promise<string> {
    await this.init();
    return JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2);
  }

  /**
   * Import with dedupe; returns the number of newly added entries.
   * Same persist-first, commit-after contract as `add()`/`remove()`: the old
   * code pushed straight into `this.entries` before persisting, which on a
   * persist failure left imported rows in memory but not on disk. The queue
   * task now builds the next array, persists it and only then commits.
   */
  async importJson(json: string): Promise<number> {
    await this.init();
    const parsed: unknown = JSON.parse(json);
    const candidate = parsed as Partial<HistoryFile>;
    const incoming = Array.isArray(candidate.entries) ? candidate.entries : [];
    return this.enqueue(async () => {
      const seen = new Set(this.entries.map((entry) => dedupeKey(entry)));
      const next = [...this.entries];
      let added = 0;
      for (const entry of incoming) {
        const key = dedupeKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(entry);
        added += 1;
      }
      if (added > 0) {
        await this.persist(next); // persist the would-be state first
        this.entries = next;      // commit memory only after the write succeeded
      }
      return added;
    });
  }

  /** Test/debug helper: normalized keys currently stored. */
  keys(): string[] {
    return this.entries.map((entry) => normalizePath(entry.videoPath));
  }
}
