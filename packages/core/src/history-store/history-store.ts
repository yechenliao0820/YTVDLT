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

  private async persist(): Promise<void> {
    const payload: HistoryFile = { schemaVersion: 1, entries: this.entries };
    await this.ports.fs.writeTextAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  async add(entry: HistoryEntry, opts: { privateMode?: boolean } = {}): Promise<HistoryAddResult> {
    await this.init();
    if (opts.privateMode === true) {
      // Private mode: never persist, but the task still completes normally.
      return { added: false, reason: 'private-mode' };
    }
    const key = dedupeKey(entry);
    const existing = this.entries.find((candidate) => dedupeKey(candidate) === key);
    if (existing !== undefined) {
      return { added: false, reason: 'duplicate', existing };
    }
    this.entries = [...this.entries, entry];
    await this.enqueue(() => this.persist());
    return { added: true, entry };
  }

  async query(q: HistoryQuery): Promise<HistoryEntry[]> {
    await this.init();
    return applyQuery(this.entries, q);
  }

  async get(id: string): Promise<HistoryEntry | null> {
    await this.init();
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  async remove(id: string, opts: { deleteFile?: boolean } = {}): Promise<boolean> {
    await this.init();
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    await this.enqueue(() => this.persist());
    if (opts.deleteFile === true) {
      const targets = [entry.videoPath, entry.audioPath, entry.thumbnailPath, ...entry.subtitlePaths]
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

  /** Import with dedupe; returns the number of newly added entries. */
  async importJson(json: string): Promise<number> {
    await this.init();
    const parsed: unknown = JSON.parse(json);
    const candidate = parsed as Partial<HistoryFile>;
    const incoming = Array.isArray(candidate.entries) ? candidate.entries : [];
    const seen = new Set(this.entries.map((entry) => dedupeKey(entry)));
    let added = 0;
    for (const entry of incoming) {
      const key = dedupeKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      this.entries.push(entry);
      added += 1;
    }
    if (added > 0) await this.enqueue(() => this.persist());
    return added;
  }

  /** Test/debug helper: normalized keys currently stored. */
  keys(): string[] {
    return this.entries.map((entry) => normalizePath(entry.videoPath));
  }
}
