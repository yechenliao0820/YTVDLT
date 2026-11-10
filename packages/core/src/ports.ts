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

export interface ITaskStore {
  load(): Promise<TaskSnapshot>;
  save(snapshot: TaskSnapshot): Promise<void>;
  recover(raw: TaskSnapshot): TaskSnapshot;
}

export interface ITaskQueue {
  enqueue(record: TaskRecord): Promise<void>;
  /** Enqueue N independent tasks (playlist batch, M4-4). */
  enqueueBatch(records: readonly TaskRecord[]): Promise<readonly string[]>;
  cancel(taskId: string): Promise<boolean>;
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
