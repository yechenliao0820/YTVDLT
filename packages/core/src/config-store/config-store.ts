/**
 * ConfigStore — 分域 + schemaVersion + 迁移 + 原子写(tmp+rename) + 损坏回退默认并 WARNING.
 *
 * All I/O goes through injected `CorePorts`; this file has NO `node:*` import
 * and NO `process` usage. Concurrency of `set()` is serialized by an internal
 * promise queue. Corrupt files are backed up (never deleted) before falling
 * back to defaults.
 */
import type { CorePorts } from '@ytvdlt/shared';
import type { IConfigStore, ConfigDomainName, LogEvent } from '../ports.js';
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
   * over the real file). Concurrent callers now share one attempt; `loaded`
   * settles only after the whole attempt finished — failure included, so a
   * later `load()` stays a no-op exactly like the pre-D-201 failure semantics.
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
      // D-201: `loaded` is NOT set here — only after the attempt settles, so a
      // caller arriving mid-load shares the promise instead of reading defaults.
      this.loadPromise = this.performLoad().finally(() => {
        this.loaded = true;
      });
    }
    await this.loadPromise;
  }

  /** The single real load attempt; concurrent `load()` callers share it. */
  private async performLoad(): Promise<void> {
    await this.ports.fs.mkdir(this.ports.env.configDir());
    const exists = await this.ports.fs.exists(this.filePath);
    if (!exists) {
      await this.persist();
      return;
    }
    try {
      const text = await this.ports.fs.readText(this.filePath);
      const parsed: unknown = JSON.parse(text);
      if (!isValidConfigFile(parsed)) throw new Error('config structure validation failed');
      if (isDowngrade(parsed.schemaVersion)) {
        throw new Error(`config schemaVersion ${parsed.schemaVersion} > ${CONFIG_SCHEMA_VERSION} (downgrade)`);
      }
      const migrated = applyMigrations(parsed, this.migrations);
      this.state = clone(migrated);
      if (migrated.schemaVersion !== parsed.schemaVersion) {
        await this.persist();
      }
    } catch (error) {
      await this.handleCorrupt(error);
    }
  }

  /** Corrupt / unrecognised config: back it up, warn, fall back to defaults. */
  private async handleCorrupt(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const backup = `${this.ports.env.configDir()}/config.corrupt-${this.ports.clock.nowEpochMs()}.json`;
    try {
      if (await this.ports.fs.exists(this.filePath)) {
        await this.ports.fs.rename(this.filePath, backup);
      }
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
