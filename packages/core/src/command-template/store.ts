/**
 * CommandTemplateStore — CRUD for user command templates (M4-5).
 *
 * Every write re-validates the argv array through `validateTemplateArgs()`; a
 * stored template can therefore never contain a denied option, even if the file
 * was edited by hand (load() drops invalid entries and records the reason).
 */
import type { CorePorts } from '@ytvdlt/shared';
import { isMissingFileError } from '../fs-errors.js';
import { validateTemplateArgs, customCommandRejected } from './validate.js';

export interface CommandTemplate {
  readonly id: string;
  readonly name: string;
  readonly args: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TemplateFile {
  schemaVersion: 1;
  templates: CommandTemplate[];
}

export interface CommandTemplateStoreDeps {
  ports: CorePorts;
  /** Defaults to `<configDir>/command-templates.json`. */
  filePath?: string;
}

export interface CommandTemplateInput {
  readonly name: string;
  readonly args: readonly string[];
}

const MAX_NAME_LENGTH = 80;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class CommandTemplateStore {
  private readonly ports: CorePorts;
  private readonly filePath: string;
  private templates: CommandTemplate[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Single-flight gate for the first load (mirrors HistoryStore, D-227). */
  private initPromise: Promise<void> | null = null;
  /** Entries dropped at load time, with the reason (surfaced to the UI). */
  readonly rejectedAtLoad: Array<{ id: string; reason: string }> = [];

  constructor(deps: CommandTemplateStoreDeps) {
    this.ports = deps.ports;
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/command-templates.json`;
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Single-flight initialisation. The OLD code set `loaded = true` BEFORE the
   * first `await`, so a second caller arriving during the load saw "already
   * loaded" and ran against an EMPTY `templates` array — its `create()` then
   * persisted that empty baseline over the file the first load was still
   * reading (the exact failure mode D-227 fixed for `HistoryStore`). Every
   * concurrent caller now awaits the SAME promise, `loaded` flips only after
   * the read has been committed to `this.templates`, and a failed load clears
   * the cached promise so the next call retries instead of silently operating
   * on an empty list forever.
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
   * D-241 classification (same rule as `TaskStore` / `HistoryStore`): "does the
   * file exist?" is answered by the READ itself, not by a separate
   * `fs.exists()` probe — the production `exists()` port maps EVERY failure to
   * `false`, which would turn a transient read error into a "first run" and let
   * the next write replace the real file with an empty list. Only a genuine
   * ENOENT / ENOTDIR is a first run; every other read error propagates (and
   * `init()` clears the cached promise so mutations retry instead of writing on
   * an unknown baseline).
   *
   * Corrupt JSON (D-159 stance, best-effort variant): the store still starts
   * empty so the app keeps working, but the original bytes are copied aside
   * FIRST to `command-templates.corrupt-<UTC stamp>[-N].json`, so the next
   * persist cannot silently destroy the only copy. A failed backup does NOT
   * block the fallback (templates are user preferences, not history) — the
   * deliberate difference from the fail-closed `tasks.json` handling.
   */
  private async load(): Promise<void> {
    await this.ports.fs.mkdir(this.ports.env.configDir());
    let raw: string;
    try {
      raw = await this.ports.fs.readText(this.filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.templates = [];
        return;
      }
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const file = parsed as Partial<TemplateFile>;
      // Valid JSON with the wrong SHAPE (`{}`, `{"templates": 5}`) is just as
      // unreadable as broken JSON: take the same preserve-before-overwrite path.
      if (!Array.isArray(file.templates)) throw new Error('templates is not an array');
      const list = file.templates;
      this.templates = [];
      for (const candidate of list) {
        const checked = this.normalize(candidate);
        if (checked.ok) this.templates.push(checked.template);
        else this.rejectedAtLoad.push({ id: String(candidate?.id ?? '?'), reason: checked.reason });
      }
    } catch {
      // Corrupt templates file must not crash the app; start empty, keep the bytes.
      await this.backupOriginal(raw);
      this.templates = [];
    }
  }

  /**
   * Byte-for-byte best-effort copy of a damaged templates file next to the
   * original (see {@link load}). `readText()` already decoded with UTF-8
   * (invalid bytes became U+FFFD), so the copy is taken from `readBytes()`
   * instead — a truncated / non-UTF-8 file stays recoverable exactly as
   * written. Text write is the second-line fallback for a port that cannot
   * supply raw bytes. NEVER throws: a failed backup must not make the store
   * unusable. The original is never moved, renamed or deleted — the next
   * persist may replace it only AFTER a copy has been attempted.
   */
  private async backupOriginal(rawText: string): Promise<void> {
    let backupPath: string;
    try {
      backupPath = await this.nextBackupPath();
    } catch {
      return;
    }
    try {
      const bytes = await this.ports.fs.readBytes(this.filePath);
      await this.ports.fs.writeBytesAtomic(backupPath, bytes);
    } catch {
      try {
        await this.ports.fs.writeTextAtomic(backupPath, rawText);
      } catch { /* best-effort: nothing more this store can do */ }
    }
  }

  /**
   * `nowEpochMs()` is injected (deterministic in tests), the stamp is
   * Windows-filename-safe, and a collision adds `-2`, `-3`, … so two corrupt
   * loads in the same millisecond never overwrite each other's backup.
   */
  private async nextBackupPath(): Promise<string> {
    const slash = Math.max(this.filePath.lastIndexOf('/'), this.filePath.lastIndexOf('\\'));
    const dir = slash >= 0 ? this.filePath.slice(0, slash) : '';
    const base = slash >= 0 ? this.filePath.slice(slash + 1) : this.filePath;
    const stem = base.replace(/\.json$/i, '');
    const stamp = new Date(this.ports.clock.nowEpochMs()).toISOString().replace(/[:.]/g, '-');
    for (let i = 0; i < 100; i += 1) {
      const suffix = i === 0 ? '' : `-${i + 1}`;
      const candidate = `${dir}/${stem}.corrupt-${stamp}${suffix}.json`;
      if (!(await this.ports.fs.exists(candidate))) return candidate;
    }
    throw new Error('cannot allocate a unique command-template backup name');
  }

  list(): readonly CommandTemplate[] {
    return this.templates.map((template) => ({ ...template, args: [...template.args] }));
  }

  get(id: string): CommandTemplate | undefined {
    const found = this.templates.find((template) => template.id === id);
    return found === undefined ? undefined : { ...found, args: [...found.args] };
  }

  async create(input: CommandTemplateInput): Promise<CommandTemplate> {
    await this.init();
    const name = this.validateName(input.name);
    const args = this.validateArgs(input.args);
    const now = this.ports.clock.nowIso();
    const id = this.nextId();
    const template: CommandTemplate = {
      id, name, args: [...args], createdAt: now, updatedAt: now,
    };
    this.templates.push(template);
    await this.persist();
    return { ...template, args: [...template.args] };
  }

  async update(id: string, patch: Partial<CommandTemplateInput>): Promise<CommandTemplate> {
    await this.init();
    const index = this.templates.findIndex((template) => template.id === id);
    if (index === -1) throw new Error(`unknown command template: ${id}`);
    const current = this.templates[index] as CommandTemplate;
    const name = patch.name === undefined ? current.name : this.validateName(patch.name);
    const args = patch.args === undefined ? current.args : this.validateArgs(patch.args);
    const next: CommandTemplate = {
      ...current, name, args: [...args], updatedAt: this.ports.clock.nowIso(),
    };
    this.templates[index] = next;
    await this.persist();
    return { ...next, args: [...next.args] };
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    const before = this.templates.length;
    this.templates = this.templates.filter((template) => template.id !== id);
    if (this.templates.length === before) return false;
    await this.persist();
    return true;
  }

  private validateName(raw: unknown): string {
    if (typeof raw !== 'string') throw customCommandRejected('template name must be a string');
    const name = raw.trim();
    if (name.length === 0) throw customCommandRejected('template name is empty');
    if (name.length > MAX_NAME_LENGTH) throw customCommandRejected('template name too long');
    if (CONTROL_RE.test(name)) throw customCommandRejected('template name has control characters');
    return name;
  }

  private validateArgs(raw: unknown): readonly string[] {
    const result = validateTemplateArgs(raw as readonly unknown[]);
    if (!result.ok) throw customCommandRejected(result.reason);
    return [...(raw as readonly string[])];
  }

  private normalize(raw: unknown): { ok: true; template: CommandTemplate } | { ok: false; reason: string } {
    if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
    const candidate = raw as Partial<CommandTemplate>;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) return { ok: false, reason: 'missing id' };
    if (typeof candidate.name !== 'string') return { ok: false, reason: 'missing name' };
    const args = validateTemplateArgs(candidate.args as readonly unknown[]);
    if (!args.ok) return { ok: false, reason: args.reason };
    const now = this.ports.clock.nowIso();
    return {
      ok: true,
      template: {
        id: candidate.id,
        name: candidate.name,
        args: [...(candidate.args as readonly string[])],
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : now,
        updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : now,
      },
    };
  }

  private nextId(): string {
    const base = this.ports.clock.nowEpochMs();
    let sequence = this.templates.length + 1;
    let id = `tpl-${base}-${sequence}`;
    while (this.templates.some((template) => template.id === id)) {
      sequence += 1;
      id = `tpl-${base}-${sequence}`;
    }
    return id;
  }

  private persist(): Promise<void> {
    const body = `${JSON.stringify({
      schemaVersion: 1,
      templates: this.templates,
    } satisfies TemplateFile, null, 2)}\n`;
    const run = this.writeQueue.then(async () => {
      await this.ports.fs.writeTextAtomic(this.filePath, body);
    });
    // The chain itself must never stay rejected (house pattern: HistoryStore
    // enqueue / TaskStore save). The OLD code chained every later write onto
    // the raw promise, so ONE failed write poisoned the queue and every
    // subsequent persist rejected with the stale error until restart.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}
