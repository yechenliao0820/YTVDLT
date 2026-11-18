/**
 * ConfigStore — 分域 + schemaVersion + 迁移 + 原子写(tmp+rename) + 损坏回退默认并 WARNING.
 *
 * All I/O goes through injected `CorePorts`; this file has NO `node:*` import
 * and NO `process` usage. Concurrency of `set()` is serialized by an internal
 * promise queue. Corrupt files are backed up (never deleted) before falling
 * back to defaults.
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
        await this.persist(); // genuine first run: the file does not exist
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
      await this.persist();
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

  private async persist(): Promise<void> {
    this.state.updatedAt = this.ports.clock.nowIso();
    this.state.schemaVersion = CONFIG_SCHEMA_VERSION;
    await this.ports.fs.writeTextAtomic(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  get<T>(domain: ConfigDomainName, key: string): T {
    const bucket = this.state.domains[domain] ?? {};
    return bucket[key] as T;
  }

  async set<T>(domain: ConfigDomainName, key: string, value: T): Promise<void> {
    await this.load();
    return this.enqueue(async () => {
      const current = this.state.domains[domain] ?? {};
      this.state.domains[domain] = { ...current, [key]: value };
      await this.persist();
    });
  }

  getDomain(domain: ConfigDomainName): Readonly<Record<string, unknown>> {
    return clone(this.state.domains[domain] ?? {});
  }

  async setDomain(domain: ConfigDomainName, patch: Record<string, unknown>): Promise<void> {
    await this.load();
    return this.enqueue(async () => {
      const current = this.state.domains[domain] ?? {};
      this.state.domains[domain] = { ...current, ...patch };
      await this.persist();
    });
  }

  /** M4 implements de-duplication; M1 returns a schema-versioned snapshot. */
  async export(): Promise<string> {
    await this.load();
    return JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, config: clone(this.state) });
  }

  /** M4 implements de-duplication; M1 validates the snapshot then persists it. */
  async import(json: string): Promise<void> {
    await this.load();
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid import payload');
    const wrapper = parsed as Record<string, unknown>;
    const candidate: unknown = wrapper['config'] ?? parsed;
    if (!isValidConfigFile(candidate)) throw new Error('invalid config snapshot');
    if (isDowngrade(candidate.schemaVersion)) throw new Error('cannot import newer schema');
    return this.enqueue(async () => {
      this.state = clone(applyMigrations(candidate, this.migrations));
      await this.persist();
    });
  }
}
