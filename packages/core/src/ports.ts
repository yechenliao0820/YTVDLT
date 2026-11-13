/**
 * @ytvdlt/core public contracts (ARCHITECTURE §3.6) and port composition.
 * Pure types: no `node:*`, no `electron`, no I/O.
 */
import type {
  CorePorts, AppError, ErrorContext, RuntimeCheckReport, RuntimeManifest,
  FileSystemPort, HashPort, ProcessPort, ClockPort, EnvPort, LogSinkPort,
  SpawnOptions, SpawnResult,
} from '@ytvdlt/shared';

export type {
  CorePorts, AppError, ErrorContext, RuntimeCheckReport, RuntimeManifest,
  FileSystemPort, HashPort, ProcessPort, ClockPort, EnvPort, LogSinkPort,
  SpawnOptions, SpawnResult,
} from '@ytvdlt/shared';

export type ConfigDomainName =
  | 'general'
  | 'format'
  | 'subtitle'
  | 'paths'
  | 'network'
  | 'advanced'
  | 'saved_links';

/** ConfigStore public API (implemented by `config-store/config-store.ts`). */
export interface IConfigStore {
  readonly schemaVersion: number;
  get<T>(domain: ConfigDomainName, key: string): T;
  set<T>(domain: ConfigDomainName, key: string, value: T): Promise<void>;
  getDomain(domain: ConfigDomainName): Readonly<Record<string, unknown>>;
  setDomain(domain: ConfigDomainName, patch: Record<string, unknown>): Promise<void>;
  /** M4 implements de-duplication & schema versioning; M1 returns a snapshot. */
  export(): Promise<string>;
  import(json: string): Promise<void>;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

export interface LogEvent {
  level: LogLevel;
  scope: string;
  event: string;
  payload?: Record<string, unknown>;
}

/** Logger public API (implemented by `logger/logger.ts`). */
export interface ILogger {
  log(e: LogEvent): Promise<void>;
  info(scope: string, event: string, payload?: Record<string, unknown>): Promise<void>;
  warn(scope: string, event: string, payload?: Record<string, unknown>): Promise<void>;
  error(scope: string, event: string, payload?: Record<string, unknown>): Promise<void>;
  /** argv is ALWAYS redacted before it is written (A-4.4-30 decision point). */
  logArgv(scope: string, argv: readonly string[]): Promise<void>;
  /** M1 placeholder: writes a versioned crash report file and returns its path. */
  writeCrashReport(err: unknown, context: Record<string, unknown>): Promise<string>;
  /** M1 placeholder: exports accumulated JSONL lines. */
  exportLogs(): Promise<string>;
}

/** ErrorMapper public API (implemented by `error-mapper/error-mapper.ts`). */
export interface IErrorMapper {
  /** Ordered rule table, FIRST match wins → mutually exclusive classes (A-4.5-05). */
  map(stderr: string, ctx: ErrorContext): AppError;
  /** Proactive construction (e.g. INVALID_URL pre-check). */
  fromCode(code: AppError['code'], ctx: ErrorContext): AppError;
}

/** RuntimeResolver public API (implemented by `runtime-resolver/runtime-resolver.ts`). */
export interface IRuntimeResolver {
  check(): Promise<RuntimeCheckReport>;
}

/** Factory signature shared by check-runtime.mjs and the Electron assembly layer. */
export type CheckRuntime = (
  ports: CorePorts,
  manifestOrPath: string | RuntimeManifest,
) => Promise<RuntimeCheckReport>;

// ---------------------------------------------------------------------------
// M2 additions (append-only)
// ---------------------------------------------------------------------------
import type {
  VerificationReport, ExpectedArtifactManifest, HistoryEntry, HistoryQuery,
  HistoryAddResult, TaskRecord, TaskSnapshot, TaskEvent, DownloadKind, MediaInfo,
  SubtitleDomain,
} from '@ytvdlt/shared';

export type { ExpectedArtifactManifest } from '@ytvdlt/shared';

/** Cancel handle held in memory by TaskQueue (structurally = shared CancelHandle). */
export interface ICancelHandle {
  cancel(): Promise<boolean>;
  readonly pid: number | null;
}

export interface VerifierInput {
  taskId: string;
  artifacts: string[];
  /** Expected metadata from probe (may be null). */
  expected: MediaInfo | null;
  /** Whether post-processing happened (decides C2 vs C8). */
  postprocessed: boolean;
  /** L2 expectation manifest (optional). */
  expectedManifest?: ExpectedArtifactManifest | null;
  /** History entry for C11 (optional). */
  historyEntry?: HistoryEntry | null;
  /** Video vs audio task (C6 has opposite expectations). */
  kind?: DownloadKind;
  /**
   * Stage 4 (append-only): the subtitle domain of the request. Read ONLY by the
   * advisory attachment probes (embedded-stream check). It cannot fail a task.
   */
  subtitleRequest?: SubtitleDomain | null;
}

export interface IArtifactVerifier {
  verify(input: VerifierInput): Promise<VerificationReport>;
}

export interface IHistoryStore {
  init(): Promise<void>;
  add(entry: HistoryEntry, opts?: { privateMode?: boolean }): Promise<HistoryAddResult>;
  query(q: HistoryQuery): Promise<HistoryEntry[]>;
  get(id: string): Promise<HistoryEntry | null>;
  remove(id: string, opts?: { deleteFile?: boolean }): Promise<boolean>;
  exportJson(): Promise<string>;
  importJson(json: string): Promise<number>;
}

/**
 * D-159 · why the last `load()` did NOT return a fully trusted snapshot.
 *
 * `missing` / `ok` are healthy; the other three are degraded. `unknown` is
 * reserved for a store that predates this contract (or a hand-built mock) and
 * therefore cannot report on itself — it must never be reported as `ok`.
 */
export type TaskLoadStatus =
  | 'missing'
  | 'ok'
  | 'invalid-records'
  | 'repaired-fields'
  | 'corrupt'
  | 'read-error'
  | 'unknown';

/** D-159 · structured boot-time snapshot health, carried by `RestoreTasksResult`. */
export interface TaskLoadDiagnostic {
  readonly status: TaskLoadStatus;
  /** Records isolated by the structural guard (bad entries silently dropped before D-159). */
  readonly skippedRecords: number;
  /** Byte-for-byte copy of the damaged original; `null` when no copy could be made. */
  readonly backupPath: string | null;
  /**
   * True when `save()` refuses to write: the original is still on disk and was
   * neither readable nor safely backed up. A boot that returns an empty snapshot
   * must then be unable to overwrite the only remaining copy of the user's data.
   */
  readonly writeBlocked: boolean;
  /**
   * D-161: nested fields normalised to safe defaults (bad `artifacts` entries,
   * `kind`, `mediaInfo`, `request`, `error`, …). Present only when > 0; the
   * original damaged bytes are backed up before the repaired snapshot is
   * written back, exactly like an isolated record.
   */
  readonly repairedFields?: number;
  /** Short cause; never contains snapshot content or URLs. */
  readonly error: string | null;
}

export interface ITaskStore {
  load(): Promise<TaskSnapshot>;
  save(snapshot: TaskSnapshot): Promise<void>;
  recover(raw: TaskSnapshot): TaskSnapshot;
  /** D-159 (optional for legacy / mock stores): health of the most recent `load()`. */
  readonly lastLoadDiagnostic?: TaskLoadDiagnostic;
}

export interface ITaskQueue {
  enqueue(record: TaskRecord): Promise<void>;
  /** Enqueue N independent tasks (playlist batch, M4-4). */
  enqueueBatch(records: readonly TaskRecord[]): Promise<readonly string[]>;
  /**
   * D-142: `false` means the process was NOT confirmed terminated — either the
   * tree kill failed or the task is mid-probe with no handle yet. The record
   * keeps its non-terminal state and its slot; the cancel may be retried at
   * any time. `true` means the tree is confirmed dead (or the task was still
   * queued and was dropped).
   */
  cancel(taskId: string): Promise<boolean>;
  /**
   * Re-queue a settled task. Refuses (throws) while the task still occupies a
   * slot (D-142): a second run for the same id would double-write the temp
   * dir, manifest and output file.
   */
  restart(taskId: string): Promise<void>;
  get(taskId: string): TaskRecord | undefined;
  list(): readonly TaskRecord[];
  onEvent(listener: (e: TaskEvent) => void): () => void;
  // M4-2 additions (append-only): bounded concurrency + slot introspection.
  /** Current slot limit (1..8). */
  readonly concurrency: number;
  /** Ids occupying a slot right now. */
  readonly activeTaskIds: readonly string[];
  /** Tasks waiting for a free slot. */
  readonly pendingCount: number;
  /** Change the slot limit; raising it starts parked tasks immediately. */
  setConcurrency(value: number): number;
  /** Remove a non-running task (M4-6 detail "delete"). */
  remove(taskId: string): Promise<boolean>;
  // M5-5 additions (append-only): self-update intake switch (D-62).
  /**
   * True while intake is paused. Running tasks are unaffected; `enqueue()` may
   * still park new records, they simply do not start.
   */
  readonly intakePaused: boolean;
  /** Stop pulling new work out of the FIFO. Never cancels anything. */
  pauseIntake(): void;
  /** Clear the flag and immediately refill free slots (FIFO order preserved). */
  resumeIntake(): void;
}
