/**
 * Pure-type dependency-injection ports (hexagonal / ports-and-adapters).
 *
 * ZERO implementations and ZERO `node:*` / `electron` imports live here.
 * Implementations exist only in:
 *   - apps/desktop/src/main/adapters/node-ports.ts  (production + check-runtime CLI)
 *   - tests/unit/helpers/in-memory-ports.ts         (offline L0 tests)
 * This is the foundation that keeps `packages/core` and `engine-ytdlp`
 * free of filesystem / process / OS side effects and 100% offline-testable.
 */

export interface FileSystemPort {
  readText(path: string): Promise<string>;
  /** Atomic write: same-dir `<path>.tmp` -> fsync -> rename; never overwrite in place. */
  writeTextAtomic(path: string, text: string): Promise<void>;
  writeBytesAtomic(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ sizeBytes: number; isFile: boolean }>;
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  /**
   * M5 append-only (D-62): raw bytes, used by the engine self-updater to
   * back up `yt-dlp.exe` before replacing it. `readText` cannot carry a
   * 30 MB binary — UTF-8 decoding would corrupt it.
   */
  readBytes(path: string): Promise<Uint8Array>;
}

export interface HashPort {
  sha256File(path: string): Promise<string>;
  sha256Bytes(data: Uint8Array): Promise<string>;
}

export interface SpawnOptions {
  /** Locked at the type level: NEVER `true`. */
  shell: false;
  /** Locked at the type level: never flash a console window on Windows. */
  windowsHide: true;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** M2: streaming child handle (pid + settle + process-tree kill). */
export interface StreamingSpawn {
  /** OS process id; may be null when spawn failed. */
  readonly pid: number | null;
  /** Resolves when the process exits (same shape as SpawnResult). */
  readonly done: Promise<SpawnResult>;
  /** Terminate the process TREE (Windows: taskkill /T /F). Idempotent. */
  kill(): Promise<boolean>;
}

export interface ProcessPort {
  /** M1: absolute `file` + `argv[]` + shell:false + windowsHide:true (§4.3 spawn 铁律). */
  spawn(file: string, argv: readonly string[], opts: SpawnOptions): Promise<SpawnResult>;
  /**
   * M2 (append-only): streaming spawn with pid + kill. Used by `download()`.
   * `spawn` above is unchanged, so all M1 callers keep working.
   */
  spawnStreaming(
    file: string,
    argv: readonly string[],
    opts: SpawnOptions,
    onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
  ): StreamingSpawn;
  /** M2 (append-only): post-cancel liveness assertion. */
  isAlive(pid: number): Promise<boolean>;
}

/**
 * M2: open / reveal an artifact (A-4.6-02).
 * M2 adapter uses `explorer.exe` argv[]; M3 hands this to Electron `shell`.
 */
export interface IShellPort {
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
}

export interface ClockPort {
  nowIso(): string;
  nowEpochMs(): number;
}

export interface EnvPort {
  isPackaged(): boolean;
  resourcesPath(): string;
  appDataDir(): string;
  configDir(): string;
  logsDir(): string;
  /** Already resolved absolute runtime directory (dev or packaged). */
  runtimeDir(): string;
  platform(): string;
  osRelease(): string;
  appVersion(): string;
  get(name: string): string | undefined;
}

export interface LogSinkPort {
  appendJsonl(line: string): Promise<void>;
}

/** Injected into every Core component's constructor. */
/**
 * M5 append-only (D-67): the only network surface in the whole system.
 *
 * Deliberately two methods and no streaming: component updates are small files
 * fetched whole, verified by SHA-256, then written atomically. Anything more
 * elaborate (resume, ranges, proxies) belongs in the update source, not here.
 */
export interface HttpPort {
  getText(url: string, opts?: { timeoutMs?: number }): Promise<string>;
  getBytes(url: string, opts?: { timeoutMs?: number }): Promise<Uint8Array>;
}

export interface CorePorts {
  fs: FileSystemPort;
  hash: HashPort;
  process: ProcessPort;
  clock: ClockPort;
  env: EnvPort;
  logSink: LogSinkPort;
  /** M2 optional: open/reveal artifacts (A-4.6-02). M1 components ignore it. */
  shell?: IShellPort;
  /** M5 optional (D-67): absent means "this build cannot fetch updates". */
  http?: HttpPort;
}
