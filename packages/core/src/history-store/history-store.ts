/**
 * HistoryStore — JSON + atomic write, dedupe by normalized primary path,
 * search/filter, private-mode skip, remove (optionally deleting files).
 * Zero `node:*`; all I/O through `CorePorts`.
 */
import type {
  CorePorts, HistoryEntry, HistoryQuery, HistoryAddResult,
} from '@ytvdlt/shared';
import type { IHistoryStore } from '../ports.js';
import { isMissingFileError } from '../fs-errors.js';
import { applyQuery, dedupeKey, normalizePath } from './query.js';

interface HistoryFile {
  schemaVersion: 1;
  entries: HistoryEntry[];
}

/**
 * external online audit P3: the narrow "cannot make a consumer throw" test for
 * an element loaded out of history.json. `dedupeKey()` dereferences exactly one
 * field — `entry.videoPath`, on which `normalizePath()` calls `.trim()` — and
 * the other loaded-entry consumers (`get`, `remove`, `matchEntry`) do plain
 * property reads that throw only on null/undefined. So a non-null object whose
 * `videoPath` is a string survives those; `null`, primitives and objects
 * without a string `videoPath` are quarantined. `completedAt` must also be a
 * string: `applyQuery`'s newest-first sort calls
 * `b.completedAt.localeCompare(a.completedAt)` on EVERY comparison, so a row
 * missing it crashes `query()` exactly like the videoPath cases crash `add()`.
 * Both checks are the MINIMUM the store's own consumers dereference — still no
 * deeper shape validation (ids, sizes, dates beyond existence): an old row with
 * odd-but-harmless fields must survive a load untouched. Neither check can
 * strand legal data: `completedAt` is a required `string` on HistoryEntry and
 * `buildHistoryEntry` (task-queue/history-entry.ts) always fills it from the
 * clock, so every row this app ever wrote passes.
 */
const isUsableHistoryEntry = (element: unknown): element is HistoryEntry =>
  typeof element === 'object' && element !== null
  && typeof (element as { videoPath?: unknown }).videoPath === 'string'
  && typeof (element as { completedAt?: unknown }).completedAt === 'string';

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
  /** Single-flight gate for the first load (D-227). Null until the first init. */
  private initPromise: Promise<void> | null = null;
  /**
   * D-230 (audit P1): bytes of a history file that EXISTS but could not be
   * parsed. They are copied to `<history>.corrupt-<ts>.json` before the first
   * rewrite, so the damaged original is never silently replaced. `null` means
   * "nothing to preserve" (healthy load, or no file at all).
   */
  private corruptOriginal: string | null = null;

  constructor(deps: HistoryStoreDeps) {
    this.ports = deps.ports;
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/history.json`;
  }

  /**
   * D-227: single-flight initialisation. The OLD code set `loaded = true`
   * BEFORE the first `await`, so a second caller arriving during the load saw
   * "already loaded" and went straight into the write queue with an EMPTY
   * `entries` array — its persist then overwrote the seeded history.json on
   * disk (measured: both seeded rows lost, both new rows kept). Every
   * concurrent caller now awaits the SAME promise, and `loaded` flips only
   * after the read has been committed to `this.entries`, so a mutation can
   * never run against a half-initialised store. A failed load clears the
   * promise so the next caller retries instead of silently operating on an
   * empty history forever.
   */
  async init(): Promise<void> {
    if (this.loaded) return;
    if (this.initPromise === null) {
      this.initPromise = this.load().then(
        () => { this.loaded = true; },
        (error: unknown) => {
          this.initPromise = null; // allow a retry on the next call
          throw error;
        },
      );
    }
    return this.initPromise;
  }

  /**
   * The actual first read. Only ever runs once, inside {@link init}.
   *
   * D-230 (audit P1): a read failure and a parse failure are NOT the same
   * thing and must not share one `catch`.
   *  - **read failure** (EACCES / EBUSY / a transient lock): the file may be
   *    perfectly good, it just could not be opened. Returning an empty array
   *    here made the NEXT `add()` persist `[onlyTheNewRow]` and destroy a
   *    history this process never saw. It now throws: `init()` clears the
   *    cached promise (D-227) so the next call retries, and every mutation
   *    rejects instead of writing against an unknown baseline.
   *  - **parse failure** (the bytes really are not JSON): the store still
   *    starts empty so the app keeps working, but the original bytes are
   *    copied aside before the first rewrite — corrupt is not the same as
   *    worthless, and `add()` must never be the thing that deletes it.
   *
   * D-241 (audit P1): "does the file exist?" is answered by the READ itself,
   * not by a separate `fs.exists()` probe. The old order was
   * `exists()` → `readText()`; the production `exists()` port maps EVERY
   * failure (not just `ENOENT`) to `false`, so a transient stat error on a
   * perfectly good file skipped the read, left `entries` empty, and the next
   * `add()` persisted that empty baseline over the real history. Now only a
   * genuine "no such file" (`isMissingFileError`) is a first run; every other
   * error propagates and blocks the overwrite, exactly like D-230's read
   * failure path.
   *
   * external online audit P3: element-level quarantine. Proving the file holds
   * an ARRAY says nothing about its ELEMENTS; a hand-edited / imported /
   * legacy element a consumer cannot survive (`null`, a bare string, an object
   * without a string `videoPath` or `completedAt`) used to reach `this.entries`
   * verbatim and
   * then detonated at the first touch — `add()`'s dedupe scan, `get()`,
   * `query()`, `remove()` — so every later download surfaced as an Error even
   * though its artifact had already been written to disk. Such elements are
   * dropped here, once, at the single load boundary (see
   * {@link isUsableHistoryEntry} for the deliberately narrow test), and when
   * anything was dropped the WHOLE original file goes through the same D-230
   * preserve-before-overwrite path as unparseable bytes: quarantined rows are
   * never silently destroyed, and the consuming methods need no try/catch of
   * their own.
   */
  private async load(): Promise<void> {
    await this.ports.fs.mkdir(this.ports.env.configDir());
    let raw: string;
    try {
      raw = await this.ports.fs.readText(this.filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.entries = [];
        return;
      }
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const candidate = parsed as Partial<HistoryFile>;
      // Valid JSON with the wrong SHAPE is just as unreadable as broken JSON:
      // `{}`, `{"entries": 5}` or a bare array all mean "we cannot recover the
      // rows", so they take the same preserve-before-overwrite path.
      if (!Array.isArray(candidate.entries)) throw new Error('history structure: entries is not an array');
      // external online audit P3: the array check proves the FILE's shape, not
      // its ELEMENTS'. Quarantine exactly what would make a consumer throw
      // (see isUsableHistoryEntry — deliberately no deeper validation, so
      // legal old rows with harmless oddities survive untouched). Dropping
      // anything routes the WHOLE original file through the same D-230
      // preserve-before-overwrite path as broken JSON below: memory keeps only
      // the clean rows and the raw bytes are never silently discarded. When
      // nothing is dropped this is a plain copy — no backup marker is set.
      const incoming = candidate.entries as readonly unknown[];
      this.entries = incoming.filter(isUsableHistoryEntry);
      if (this.entries.length !== incoming.length) this.corruptOriginal = raw;
    } catch {
      // Corrupt history must not crash the app; start empty, keep the bytes.
      this.entries = [];
      this.corruptOriginal = raw;
    }
  }

  /**
   * D-230: preserve an unparseable history file exactly once, before the first
   * write that would replace it. A failed copy aborts the write (the caller
   * sees the rejection and the disk keeps the original), which is the same
   * fail-closed stance `task-store` takes for a damaged `tasks.json` (D-159).
   */
  private async preserveCorruptOriginal(): Promise<void> {
    const original = this.corruptOriginal;
    if (original === null) return;
    const backup = `${this.filePath}.corrupt-${this.ports.clock.nowEpochMs()}.json`;
    await this.ports.fs.writeTextAtomic(backup, original);
    this.corruptOriginal = null;
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
    // D-230: an unreadable-but-present history is copied aside first; a failed
    // backup therefore blocks the overwrite instead of losing the original.
    await this.preserveCorruptOriginal();
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
   *
   * D-238: removes the history ROW only — never files. The former
   * `deleteFile` option performed a permanent `fs.unlink` (§0.1 violation)
   * on entry paths that carry no containment proof (no request roots →
   * D-203's red line) while `importJson()` accepts paths verbatim. Removed
   * outright before any UI could wire it; file deletion stays exclusively
   * with the `TASK_ACTION withFiles` chain and its full pre-flight doors.
   */
  async remove(id: string): Promise<boolean> {
    await this.init();
    const removed = await this.enqueue(async () => {
      const entry = this.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) return null;
      const next = this.entries.filter((candidate) => candidate.id !== id);
      await this.persist(next); // persist the would-be state first
      this.entries = next;      // commit memory only after the write succeeded
      return entry;
    });
    return removed !== null;
  }

  async exportJson(): Promise<string> {
    await this.init();
    return JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2);
  }

  /**
   * Import with dedupe; reports how many entries were added and how many were
   * rejected as unusable.
   * Same persist-first, commit-after contract as `add()`/`remove()`: the old
   * code pushed straight into `this.entries` before persisting, which on a
   * persist failure left imported rows in memory but not on disk. The queue
   * task now builds the next array, persists it and only then commits.
   *
   * D-277 (external audit P3, 2026-11-22 round): elements are validated with
   * the SAME `isUsableHistoryEntry` predicate the load path uses (D-271)
   * BEFORE they can enter the store. Previously an entry with a `videoPath`
   * but no `completedAt` was imported verbatim and crashed `applyQuery`'s
   * newest-first sort (`b.completedAt.localeCompare` dereferences the field on
   * EVERY comparison), and an element without a string `videoPath` crashed
   * `dedupeKey` itself. Unusable elements are rejected, counted, and never
   * touch the memory or the disk. D-274 had registered this as a P4 ("改它需
   * 另立决策"); that decision is this one.
   */
  async importJson(json: string): Promise<{ added: number; rejected: number }> {
    await this.init();
    const parsed: unknown = JSON.parse(json);
    const candidate = parsed as Partial<HistoryFile>;
    const rawElements: unknown[] = Array.isArray(candidate.entries) ? candidate.entries : [];
    const incoming = rawElements.filter(isUsableHistoryEntry);
    const rejected = rawElements.length - incoming.length;
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
      return { added, rejected };
    });
  }

  /** Test/debug helper: normalized keys currently stored. */
  keys(): string[] {
    return this.entries.map((entry) => normalizePath(entry.videoPath));
  }
}
