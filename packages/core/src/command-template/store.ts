/**
 * CommandTemplateStore — CRUD for user command templates (M4-5).
 *
 * Every write re-validates the argv array through `validateTemplateArgs()`; a
 * stored template can therefore never contain a denied option, even if the file
 * was edited by hand (load() drops invalid entries and records the reason).
 */
import type { CorePorts } from '@ytvdlt/shared';
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
  /** Entries dropped at load time, with the reason (surfaced to the UI). */
  readonly rejectedAtLoad: Array<{ id: string; reason: string }> = [];

  constructor(deps: CommandTemplateStoreDeps) {
    this.ports = deps.ports;
    this.filePath = deps.filePath ?? `${deps.ports.env.configDir()}/command-templates.json`;
  }

  get path(): string {
    return this.filePath;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.ports.fs.mkdir(this.ports.env.configDir());
    if (!(await this.ports.fs.exists(this.filePath))) {
      this.templates = [];
      return;
    }
    try {
      const parsed = JSON.parse(await this.ports.fs.readText(this.filePath)) as Partial<TemplateFile>;
      const list = Array.isArray(parsed.templates) ? parsed.templates : [];
      this.templates = [];
      for (const candidate of list) {
        const checked = this.normalize(candidate);
        if (checked.ok) this.templates.push(checked.template);
        else this.rejectedAtLoad.push({ id: String(candidate?.id ?? '?'), reason: checked.reason });
      }
    } catch {
      this.templates = [];
    }
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
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ports.fs.writeTextAtomic(this.filePath, body);
    });
    return this.writeQueue;
  }
}
