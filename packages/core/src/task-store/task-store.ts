/**
 * TaskStore — queue snapshot persistence + crash recovery.
 * Recovery rule: `Running` / `FetchingInfo` become `Canceled` (they cannot still
 * be running after a restart) while `lastPercent` is preserved for the UI.
 *
 * D-159: a damaged snapshot must never be replaced by an empty one without a
 * recoverable byte-for-byte copy. `load()` now classifies the failure, backs up
 * the original before any filtered/empty snapshot can be persisted, and blocks
 * every later `save()` when the original could not be read or copied.
 */
import type { CorePorts, TaskSnapshot, TaskRecord } from '@ytvdlt/shared';
import type { ITaskStore, TaskLoadDiagnostic } from '../ports.js';

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

/** The five `DownloadRequest` domains; a broken one makes the request unusable. */
const REQUEST_DOMAINS: readonly string[] = ['format', 'subtitle', 'paths', 'network', 'advanced'];
const NUMERIC_PROGRESS_KEYS: readonly string[] = [
  'lastDownloadedBytes', 'lastTotalBytes', 'lastSpeedBps', 'lastEtaSec',
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asLoose = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/**
 * D-161 · structural guard + NON-DESTRUCTIVE repair of the nested fields that
 * D-151 deliberately left shallow. Three outcomes, in order:
 *
 *   1. an unusable KEY field (`id` / `url` / `state`, or a non-array
 *      `artifacts`) → `null`: isolate the whole record, exactly as D-151 did;
 *   2. a usable record with broken NESTED fields → a shallow copy with those
 *      fields replaced by safe defaults, counted in `repaired`. Dropping the
 *      whole record for one bad subtitle link would lose the user's task;
 *   3. a fully valid record → the ORIGINAL object reference, unchanged
 *      (D-151's "合法快照行为零变化" contract).
 *
 * `queue.restore()` writes the repaired snapshot back, so `load()` backs up
 * the damaged original first — the same D-159 invariant as isolation. No
 * schema library: core stays dependency-free, and every consumer still
 * null-checks the optional objects.
 */
function sanitizeRecord(
  candidate: unknown,
  nowIso: string,
): { record: TaskRecord | null; repaired: number } {
  if (!isObjectRecord(candidate)) return { record: null, repaired: 0 };
  const raw = candidate as unknown as TaskRecord;
  if (typeof raw.id !== 'string' || raw.id === '') return { record: null, repaired: 0 };
  if (typeof raw.url !== 'string') return { record: null, repaired: 0 };
  if (typeof raw.state !== 'string' || !TASK_STATES.has(raw.state)) return { record: null, repaired: 0 };
  if (raw.artifacts !== undefined && !Array.isArray(raw.artifacts)) return { record: null, repaired: 0 };

  let record: TaskRecord = raw;
  let repaired = 0;
  /** Copy on the FIRST repair only, so a healthy record keeps its identity. */
  const fix = (apply: (target: TaskRecord) => void): void => {
    if (record === raw) record = { ...raw };
    apply(record);
    repaired += 1;
  };

  if (raw.kind !== 'video' && raw.kind !== 'audio') fix((r) => { r.kind = 'video'; });
  if (typeof raw.createdAt !== 'string') fix((r) => { r.createdAt = nowIso; });
  if (typeof raw.updatedAt !== 'string') fix((r) => { r.updatedAt = nowIso; });
  if (raw.lastPercent !== null && typeof raw.lastPercent !== 'number') {
    fix((r) => { r.lastPercent = null; });
  }
  for (const key of NUMERIC_PROGRESS_KEYS) {
    const value = asLoose(raw)[key];
    if (value !== undefined && value !== null && typeof value !== 'number') {
      fix((r) => { asLoose(r)[key] = null; });
    }
  }
  if (typeof raw.privateMode !== 'boolean') fix((r) => { r.privateMode = false; });
  if (typeof raw.postprocessed !== 'boolean') fix((r) => { r.postprocessed = false; });

  // `artifacts` entries must all be non-empty absolute path strings.
  if (Array.isArray(raw.artifacts)) {
    const cleaned = raw.artifacts.filter((item): item is string => typeof item === 'string' && item !== '');
    if (cleaned.length !== raw.artifacts.length) {
      const dropped = raw.artifacts.length - cleaned.length;
      fix((r) => { r.artifacts = cleaned; });
      repaired += dropped - 1;
    }
  }

  // `mediaInfo`: shape + the fields the UI / restart path read directly.
  if (raw.mediaInfo !== null && raw.mediaInfo !== undefined) {
    const media = raw.mediaInfo;
    if (!isObjectRecord(media)) {
      fix((r) => { r.mediaInfo = null; });
    } else {
      const patch: Record<string, unknown> = {};
      if (typeof media['id'] !== 'string') patch['id'] = raw.id;
      if (typeof media['title'] !== 'string') patch['title'] = raw.id;
      if (!Array.isArray(media['formats'])) patch['formats'] = [];
      const count = Object.keys(patch).length;
      if (count > 0) {
        fix((r) => { r.mediaInfo = { ...media, ...patch } as unknown as TaskRecord['mediaInfo']; });
        repaired += count - 1;
      }
    }
  }

  // `request`: all five domains must be objects, or nothing may be reused.
  if (raw.request !== null && raw.request !== undefined) {
    const request = raw.request;
    if (!isObjectRecord(request) || REQUEST_DOMAINS.some((domain) => !isObjectRecord(request[domain]))) {
      fix((r) => { r.request = null; });
    }
  }

  // `error`: AppError needs a usable code + message for the UI / report builder.
  if (raw.error !== null && raw.error !== undefined) {
    const error = raw.error;
    if (!isObjectRecord(error)
      || typeof error['code'] !== 'string' || typeof error['message'] !== 'string') {
      fix((r) => { r.error = null; });
    }
  }

  // `subtitleFiles`: a wrong type / bad element must not reach the detail page
  // or the recycle-bin cleanup (D-131).
  if (raw.subtitleFiles !== undefined && !Array.isArray(raw.subtitleFiles)) {
    fix((r) => { r.subtitleFiles = []; });
  } else if (Array.isArray(raw.subtitleFiles)) {
    const cleaned = raw.subtitleFiles.filter((item) => isObjectRecord(item));
    if (cleaned.length !== raw.subtitleFiles.length) {
      const dropped = raw.subtitleFiles.length - cleaned.length;
      fix((r) => {
        r.subtitleFiles = cleaned as unknown as NonNullable<TaskRecord['subtitleFiles']>;
      });
      repaired += dropped - 1;
    }
  }

  return { record, repaired };
}

/** Isolate unusable records, repair nested fields, count both. */
function isolateValidRecords(
  entries: readonly unknown[],
  nowIso: string,
): { records: TaskRecord[]; skipped: number; repaired: number } {
  const records: TaskRecord[] = [];
  let skipped = 0;
  let repaired = 0;
  for (const entry of entries) {
    const outcome = sanitizeRecord(entry, nowIso);
    if (outcome.record === null) {
      skipped += 1;
      continue;
    }
    records.push(outcome.record);
    repaired += outcome.repaired;
  }
  return { records, skipped, repaired };
}

/** D-159: the two healthy outcomes share one diagnostic shape. */
function healthyDiagnostic(status: 'missing' | 'ok'): TaskLoadDiagnostic {
  return { status, skippedRecords: 0, backupPath: null, writeBlocked: false, error: null };
}

/**
 * D-159: only a genuine "file does not exist" is a first run. The in-memory
 * test port throws a plain `Error('ENOENT: <path>')` while the production port
 * throws a Node `ErrnoException` with `code`; both must be recognised, and
 * everything else (`EACCES`, `EIO`, `EBUSY`, lock errors…) is a read failure.
 */
function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^ENOENT\b/.test(message);
}

/** D-159: bounded, content-free cause for the JSONL warning payload. */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export class TaskStore implements ITaskStore {
  private readonly ports: CorePorts;
  private readonly filePath: string;
  /** Records isolated by the most recent `load()` (diagnostics only). */
  private lastLoadSkipped = 0;
  /** D-161: nested fields repaired by the most recent `load()` (diagnostics only). */
  private lastLoadRepaired = 0;
  /** D-159: health of the most recent `load()`, consumed by `restoreTasks()`. */
  private diagnostic: TaskLoadDiagnostic = healthyDiagnostic('missing');
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

  /**
   * D-159: five outcomes, no longer one silent empty snapshot.
   *
   *   missing          → first run; nothing on disk to protect, writes allowed
   *   ok               → parsed with 0 isolated records; writes allowed
   *   corrupt          → JSON / top-level shape broken; back up the raw file first
   *   invalid-records  → parsed but N records isolated; back up BEFORE the
   *                      filtered snapshot is written back (D-151 filtered
   *                      without a copy, losing the bad records forever)
   *   read-error       → no readable original; block ALL later writes
   *
   * A degraded outcome always emits one WARNING through the existing
   * `CorePorts.logSink` (lands in `logs/app-*.jsonl` in production) carrying
   * the status, isolated-record count, backup path and write-block decision.
   * The payload never contains snapshot content or URLs.
   */
  async load(): Promise<TaskSnapshot> {
    this.lastLoadSkipped = 0;
    this.lastLoadRepaired = 0;
    this.diagnostic = healthyDiagnostic('missing');

    let text: string;
    try {
      text = await this.ports.fs.readText(this.filePath);
    } catch (error) {
      if (isMissingFileError(error)) return this.emptySnapshot();
      // No bytes to copy and no reason to trust the disk. Refusing every later
      // save() is what stops `queue.restore() → persistSnapshot()` from
      // replacing the only remaining copy of the user's task history.
      await this.setDegraded({
        status: 'read-error',
        skippedRecords: 0,
        backupPath: null,
        writeBlocked: true,
        error: errorMessage(error),
      });
      return this.emptySnapshot();
    }

    let entries: unknown[];
    let savedAt: string;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('snapshot root is not an object');
      }
      const candidate = parsed as Partial<TaskSnapshot>;
      if (!Array.isArray(candidate.tasks)) throw new Error('tasks is not an array');
      entries = candidate.tasks as unknown[];
      savedAt = typeof candidate.savedAt === 'string' ? candidate.savedAt : this.ports.clock.nowIso();
    } catch (error) {
      const backupPath = await this.backupOriginal(text);
      await this.setDegraded({
        status: 'corrupt',
        skippedRecords: 0,
        backupPath,
        writeBlocked: backupPath === null,
        error: errorMessage(error),
      });
      return this.emptySnapshot();
    }

    const { records, skipped, repaired } = isolateValidRecords(entries, this.ports.clock.nowIso());
    this.lastLoadSkipped = skipped;
    this.lastLoadRepaired = repaired;
    if (skipped > 0 || repaired > 0) {
      // D-161: a REPAIR also changes what is about to be written back. Back up
      // the exact original bytes first, using the same D-159 invariant as an
      // isolated record — otherwise the bad nested fields are lost for good.
      const backupPath = await this.backupOriginal(text);
      await this.setDegraded({
        status: skipped > 0 ? 'invalid-records' : 'repaired-fields',
        skippedRecords: skipped,
        ...(repaired > 0 ? { repairedFields: repaired } : {}),
        backupPath,
        writeBlocked: backupPath === null,
        error: skipped > 0
          ? `${skipped} record(s) failed the structural guard${repaired > 0 ? `; ${repaired} nested field(s) repaired` : ''}`
          : `${repaired} nested field(s) repaired`,
      });
    } else {
      this.diagnostic = healthyDiagnostic('ok');
    }
    return { schemaVersion: 1, savedAt, tasks: records };
  }

  /** Empty snapshot returned for every degenerate load outcome. */
  private emptySnapshot(): TaskSnapshot {
    return { schemaVersion: 1, savedAt: this.ports.clock.nowIso(), tasks: [] };
  }

  /**
   * D-159: byte-for-byte copy of the damaged original at
   * `tasks.corrupt-<UTC stamp>.json` next to `tasks.json`. `readText()` already
   * decoded with UTF-8 (invalid bytes became U+FFFD), so the copy is taken from
   * `readBytes()` instead — a truncated / non-UTF-8 file stays recoverable
   * exactly as written. Text write is a second-line fallback for a port that
   * cannot supply raw bytes. A failed copy returns `null`, which blocks writes.
   *
   * The original is NEVER moved, renamed or deleted: with an atomic replace,
   * leaving it in place until a verified copy exists is the only safe order.
   */
  private async backupOriginal(rawText: string): Promise<string | null> {
    let path: string;
    try {
      path = await this.nextBackupPath();
    } catch {
      return null;
    }
    try {
      const bytes = await this.ports.fs.readBytes(this.filePath);
      await this.ports.fs.writeBytesAtomic(path, bytes);
      return path;
    } catch {
      try {
        await this.ports.fs.writeTextAtomic(path, rawText);
        return path;
      } catch {
        return null;
      }
    }
  }

  /**
   * D-159: `nowEpochMs()` is injected (deterministic in tests), the stamp is
   * Windows-filename-safe, and a collision adds `-2`, `-3`, … so two loads in
   * the same millisecond never overwrite each other's backup.
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
    throw new Error('cannot allocate a unique snapshot backup name');
  }

  /** D-159: one WARNING per degraded load; a dead log sink must not break the boot. */
  private async setDegraded(diagnostic: TaskLoadDiagnostic): Promise<void> {
    this.diagnostic = diagnostic;
    try {
      await this.ports.logSink.appendJsonl(JSON.stringify({
        ts: this.ports.clock.nowIso(),
        level: 'WARNING',
        scope: 'task-store',
        event: 'snapshot.load.degraded',
        payload: {
          status: diagnostic.status,
          skippedRecords: diagnostic.skippedRecords,
          backupPath: diagnostic.backupPath,
          writeBlocked: diagnostic.writeBlocked,
          ...(diagnostic.repairedFields === undefined
            ? {} : { repairedFields: diagnostic.repairedFields }),
          error: diagnostic.error,
        },
      }));
    } catch { /* a dead log sink must not break the boot either */ }
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
   *
   * D-159: while `load()` reports an unreadable / unbacked-up original, every
   * write is refused. `TaskQueue.persistSnapshot()` already catches rejected
   * saves, so the download path stays alive and logs a WARNING instead.
   */
  async save(snapshot: TaskSnapshot): Promise<void> {
    if (this.diagnostic.writeBlocked) {
      const error = new Error('SNAPSHOT_WRITE_BLOCKED: refusing to overwrite an unreadable or unbacked-up snapshot');
      this.lastSaveFailure = error;
      throw error;
    }
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
   * snapshot on disk was damaged but the rest of it still loaded. D-159 also
   * surfaces this number through `lastLoadDiagnostic` / the boot restore report.
   */
  get lastLoadSkippedCount(): number {
    return this.lastLoadSkipped;
  }

  /** D-159: full health of the most recent `load()`, read by `restoreTasks()`. */
  get lastLoadDiagnostic(): TaskLoadDiagnostic {
    return this.diagnostic;
  }

  /**
   * D-161: how many nested fields the most recent `load()` repaired. Zero for
   * a healthy snapshot; a non-zero value always comes with a byte-for-byte
   * backup and a WARNING (the repaired shape gets written back on restore).
   */
  get lastLoadRepairedCount(): number {
    return this.lastLoadRepaired;
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
      const { records } = isolateValidRecords(entries, this.ports.clock.nowIso());
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
