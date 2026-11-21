/**
 * ConfigStore — 分域 + schemaVersion + 迁移 + 原子写(tmp+rename) + 损坏回退默认并 WARNING.
 *
 * All I/O goes through injected `CorePorts`; this file has NO `node:*` import
 * and NO `process` usage. Concurrency of `set()` is serialized by an internal
 * promise queue. Every write path (`set` / `setDomain` / `import`) is
 * persist-first, commit-after (D-222 house pattern, as D-242 task-store /
 * D-256 command-template): a failed `writeTextAtomic` leaves `this.state`
 * exactly what the getters reported and the disk exactly its previous
 * content — the error propagates, nothing half-commits. Corrupt files are
 * backed up (never deleted) before falling back to defaults.
 *
 * D-246: existence is answered by the READ (`ENOENT`/`ENOTDIR` = first run,
 * any other read error blocks the load and every write path) — an
 * `fs.exists()` pre-probe is never used to decide "no config yet", because
 * the production port maps every probe error to `false` and a transient
 * EACCES/EBUSY would then persist defaults over the real file.
 */
import type { CorePorts } from '@ytvdlt/shared';
import type { IConfigStore, ConfigDomainName, LogEvent } from '../ports.js';
import { isMissingFileError } from '../fs-errors.js';
import {
  CONFIG_SCHEMA_VERSION, createDefaultConfig, isValidConfigFile, type ConfigFile,
} from './defaults.js';
import { applyMigrations, isDowngrade, type Migration } from './migrations.js';

export interface ConfigStoreDeps {
  ports: CorePorts;
  migrations?: readonly Migration[];
  /** Overridable for tests; defaults to `<configDir>/config.json`. */
  filePath?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class ConfigStore implements IConfigStore {
  readonly schemaVersion: number = CONFIG_SCHEMA_VERSION;
  private readonly ports: CorePorts;
  private readonly migrations: readonly Migration[];
  private readonly filePath: string;
  private state: ConfigFile;
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;
  /**
   * D-201: memoized first-load attempt. `load()` used to set `loaded` BEFORE
   * any await, so of two concurrent callers the second returned immediately and
   * read the constructor defaults (a following `set()` could even persist them
   * over the real file). Concurrent callers now share one attempt.
   *
   * D-246: a FAILED attempt no longer counts as "loaded". The promise is
   * cleared on rejection (same retry contract as `HistoryStore.init()`,
   * D-227/D-241), so the next `load()` retries instead of running forever on
   * the constructor defaults — where the first `set()` would have persisted
   * those defaults over the real (merely unreadable) config file.
   */
  private loadPromise: Promise<void> | null = null;

  constructor(deps: ConfigStoreDeps) {
    this.ports = deps.ports;
    this.migrations = deps.migrations ?? [];
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/config.json`;
    this.state = createDefaultConfig(deps.ports.clock.nowIso());
  }

  /** Read (or initialize) the config file. Idempotent and safe to call twice. */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise === null) {
      // D-201: concurrent callers share the SAME attempt instead of reading
      // defaults mid-load. D-246: only a SUCCESSFUL attempt sets `loaded`;
      // a failed one clears the memo so the next `load()` retries (the
      // HistoryStore D-227 contract) — every caller of the failed attempt
      // still shares that one rejection.
      this.loadPromise = this.performLoad().then(
        () => { this.loaded = true; },
        (error: unknown) => {
          this.loadPromise = null; // allow a retry on the next call
          throw error;
        },
      );
    }
    await this.loadPromise;
  }

  /**
   * The single real load attempt; concurrent `load()` callers share it.
   *
   * D-246 (external online audit): "does the config file exist?" is answered
   * by the READ itself, never by an `fs.exists()` probe. The old order was
   * `exists()` → `readText()`, and the production `exists()` port maps EVERY
   * error to `false` (`try { stat } catch { return false }`), so one
   * transient stat failure — antivirus lock, busy disk, flaky network drive —
   * looked exactly like a first run and `persist()` wrote the defaults over
   * the real file (download dirs, proxy, cookies path, language: all gone).
   * It also removed the probe's TOCTOU window. Now:
   *  - `ENOENT` / `ENOTDIR` (via `isMissingFileError`, the shared D-241
   *    classifier in `core/src/fs-errors.ts`) is the only "first run" —
   *    defaults are persisted;
   *  - every other read error propagates: NO rename, NO default fallback,
   *    NO write. `load()` rejects, the memo is cleared and retried on the
   *    next call, and every write path (`set` / `setDomain` / `import`, all
   *    of which `await load()` first) rejects with it — the in-memory
   *    defaults may still be DISPLAYED, but nothing can reach the disk and
   *    overwrite the user's config while it is merely unreadable.
   *
   * Real JSON / structure damage still goes through `handleCorrupt`
   * (backup + defaults), unchanged.
   */
  private async performLoad(): Promise<void> {
    await this.ports.fs.mkdir(this.ports.env.configDir());
    let text: string;
    try {
      text = await this.ports.fs.readText(this.filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        // Load path: `this.state` already holds the intended value (the
        // constructor defaults), so it serves as its own candidate — the
        // candidate/commit split below only exists for the write paths,
        // where a failed write must not leave memory ahead of the disk.
        // The D-246 semantics of this branch are unchanged.
        await this.persist(this.state); // genuine first run: the file does not exist
        return;
      }
      throw error; // D-246: a read failure is never "no config"
    }
    let needsWriteBack = false;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isValidConfigFile(parsed)) throw new Error('config structure validation failed');
      if (isDowngrade(parsed.schemaVersion)) {
        throw new Error(`config schemaVersion ${parsed.schemaVersion} > ${CONFIG_SCHEMA_VERSION} (downgrade)`);
      }
      const migrated = applyMigrations(parsed, this.migrations);
      this.state = clone(migrated);
      needsWriteBack = migrated.schemaVersion !== parsed.schemaVersion;
    } catch (error) {
      await this.handleCorrupt(error);
      return;
    }
    // D-246: the migration write-back is a PLAIN IO step, not corruption —
    // only JSON/structure failures above may rename the file away. A transient
    // write failure here propagates as a load failure (retryable, file
    // untouched, write paths blocked by the rejected load) instead of being
    // mis-classified as "corrupt" and resetting a VALID config to defaults.
    if (needsWriteBack) {
      await this.persist(this.state); // load path: memory already holds the migrated state
    }
  }

  /** Corrupt / unrecognised config: back it up, warn, fall back to defaults. */
  private async handleCorrupt(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const backup = `${this.ports.env.configDir()}/config.corrupt-${this.ports.clock.nowEpochMs()}.json`;
    try {
      // D-246: no `exists()` pre-probe (same reason as `performLoad`). The
      // rename IS the existence test: `ENOENT` / `ENOTDIR` means there is no
      // file to back up (it vanished between read and rename); every other
      // failure stays best-effort and must not block the corrupt fallback
      // path — the file is unparseable garbage at this point, and the app
      // must keep working on defaults.
      await this.ports.fs.rename(this.filePath, backup);
    } catch {
      // Best-effort backup; never let it crash the fallback path.
    }
    const warning: LogEvent = {
      level: 'WARNING',
      scope: 'config',
      event: 'config.corrupt',
      payload: { reason, backupPath: backup, fallback: 'defaults' },
    };
    await this.emit(warning);
    this.state = createDefaultConfig(this.ports.clock.nowIso());
  }

  private async emit(event: LogEvent): Promise<void> {
    const line = JSON.stringify({
      ts: this.ports.clock.nowIso(),
      level: event.level,
      scope: event.scope,
      event: event.event,
      ...(event.payload === undefined ? {} : { payload: event.payload }),
    });
    await this.ports.logSink.appendJsonl(line);
  }

  /** Serialize all writes so two concurrent `set()` calls cannot interleave. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Serialize the given (would-be) state and write it atomically (D-222
   * pattern — the same persist-first, commit-after house pattern as D-242
   * task-store / D-256 command-template). Callers pass a CANDIDATE built on
   * the last committed state, never `this.state` itself (the load path above
   * is the one exception: memory there already holds the intended value
   * before any write). The `updatedAt` / `schemaVersion` stamps land on the
   * candidate too — the old zero-argument `persist()` stamped `this.state`
   * BEFORE the write, so even the timestamps half-committed on a failed
   * write. A rejected `writeTextAtomic` (atomic primitive — no half-written
   * file) leaves the disk exactly at its previous state; whether memory
   * follows is decided by the caller, and the write paths commit only after
   * this resolves.
   */
  private async persist(candidate: ConfigFile): Promise<void> {
    candidate.updatedAt = this.ports.clock.nowIso();
    candidate.schemaVersion = CONFIG_SCHEMA_VERSION;
    await this.ports.fs.writeTextAtomic(this.filePath, `${JSON.stringify(candidate, null, 2)}\n`);
  }

  get<T>(domain: ConfigDomainName, key: string): T {
    const bucket = this.state.domains[domain] ?? {};
    return bucket[key] as T;
  }

  /**
   * D-265 (external online audit P1): persist-first, commit-after (D-222 house
   * pattern, same as D-242 task-store / D-256 command-template). The change
   * is built on a CLONE of the last committed state, written to disk first,
   * and only a successful write commits it to `this.state`. The old order
   * (mutate memory, then persist) half-committed on a failed write: the main
   * process kept the new value while the UI rolled its toggle back on the
   * rejection, so the next enqueue built the download on the memory value
   * (`readDefaults()` reads `general.privateMode` — the user sees the private
   * switch OFF while files land in the private directory, or the reverse),
   * and the next successful `persist()` flushed the failed value to disk
   * after all. Now a write failure leaves `this.state` exactly what
   * `get()` / `getDomain()` reported before the call and the disk exactly
   * its previous content; the error surfaces to the caller unchanged —
   * nothing is swallowed, nothing falls back to defaults.
   */
  async set<T>(domain: ConfigDomainName, key: string, value: T): Promise<void> {
    await this.load();
    return this.enqueue(async () => {
      const candidate = clone(this.state);
      const current = candidate.domains[domain] ?? {};
      candidate.domains[domain] = { ...current, [key]: value };
      await this.persist(candidate); // persist the would-be state first (D-222)
      this.state = candidate;        // commit memory only after the write succeeded
    });
  }

  getDomain(domain: ConfigDomainName): Readonly<Record<string, unknown>> {
    return clone(this.state.domains[domain] ?? {});
  }

  /** Same persist-first, commit-after contract as {@link set}: the whole
   * candidate construction → persist → commit sequence runs inside the queue
   * task on top of the last committed state, so a failed write leaves memory
   * and disk on the previous state and the patch is never leaked into a
   * later successful write. */
  async setDomain(domain: ConfigDomainName, patch: Record<string, unknown>): Promise<void> {
    await this.load();
    return this.enqueue(async () => {
      const candidate = clone(this.state);
      const current = candidate.domains[domain] ?? {};
      candidate.domains[domain] = { ...current, ...patch };
      await this.persist(candidate); // persist the would-be state first (D-222)
      this.state = candidate;        // commit memory only after the write succeeded
    });
  }

  /** M4 implements de-duplication; M1 returns a schema-versioned snapshot. */
  async export(): Promise<string> {
    await this.load();
    return JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, config: clone(this.state) });
  }

  /** M4 implements de-duplication; M1 validates the snapshot then persists it.
   *
   * Same persist-first, commit-after contract as {@link set}: the validation
   * (JSON.parse / structure / downgrade) runs before the queue and already
   * had zero side effects; a WRITE failure inside the queue task now also
   * leaves `this.state` and the disk untouched — the imported snapshot is
   * not half-committed into memory and cannot leak into a later write. */
  async import(json: string): Promise<void> {
    await this.load();
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid import payload');
    const wrapper = parsed as Record<string, unknown>;
    const candidate: unknown = wrapper['config'] ?? parsed;
    if (!isValidConfigFile(candidate)) throw new Error('invalid config snapshot');
    if (isDowngrade(candidate.schemaVersion)) throw new Error('cannot import newer schema');
    return this.enqueue(async () => {
      const next = clone(applyMigrations(candidate, this.migrations));
      await this.persist(next); // persist the would-be state first (D-222)
      this.state = next;        // commit memory only after the write succeeded
    });
  }
}
