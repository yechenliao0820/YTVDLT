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
  /**
   * D-118: remove an EMPTY directory. Deliberately not recursive — a non-empty
   * directory must fail here. Used only to retire a per-task temp folder after
   * yt-dlp moved every finished file out of it; any leftover byte keeps the
   * folder alive, because a leftover is either resumable data or evidence.
   */
  rmdir(path: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  /**
   * M5 append-only (D-62): raw bytes, used by the engine self-updater to
   * back up `yt-dlp.exe` before replacing it. `readText` cannot carry a
   * 30 MB binary — UTF-8 decoding would corrupt it.
   */
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * D-204 (append-only, OPTIONAL): resolve `path` through every symlink /
   * NTFS junction to its FINAL real location. This is the symlink/junction
   * guard point for "open file / open folder" (D-204): a manifest path that
   * only LOOKS inside the trusted roots on the string level may actually
   * point anywhere, so the caller re-runs containment on the resolved path
   * before handing it to the shell.
   *
   * OPTIONAL for compatibility: the production adapter
   * (apps/desktop/src/main/adapters/node-ports.ts) ALWAYS provides it; its
   * absence exists only in legacy test fakes, where the gate degrades to the
   * string-level containment check (security strength drops accordingly).
   *
   * Windows notes: `realpath` resolves junctions/symlinks to their final
   * TARGET (a junction pointing at a FILE is treated as broken by the OS
   * itself — stat/realpath both fail with ENOENT, so nothing can be opened
   * through it). Depending on the Node/libuv version the result may be the
   * plain absolute path or the extended-length form (`\\?\C:\...`,
   * `\\?\UNC\srv\share\...`) for UNC targets; the containment normalization
   * unwraps both prefixes, so the raw result can be fed straight into
   * containment checks. Fails with ENOENT/ENOTDIR when the path does not
   * exist.
   */
  realpath?(path: string): Promise<string>;
}

export interface HashPort {
  sha256File(path: string): Promise<string>;
  sha256Bytes(data: Uint8Array): Promise<string>;
}

/**
 * T5 (append-only): the minimal abort surface `SpawnOptions.signal` needs.
 *
 * STRUCTURAL ON PURPOSE: this package compiles with `types: []` (no DOM lib,
 * no `@types/node`), so the DOM `AbortSignal` type does not exist here. Every
 * real producer — `new AbortController().signal` in the Electron main process
 * — satisfies this shape, so callers pass their signal without a cast and
 * without `shared` growing an `electron` / `node:*` dependency (§2 layering).
 *
 * `addEventListener` keeps the listener untyped (`() => void`) and `type` a
 * plain `string` so the DOM/Node overloads remain assignable in both
 * directions; the adapter only ever listens for `'abort'`.
 */
export interface SpawnAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SpawnOptions {
  /** Locked at the type level: NEVER `true`. */
  shell: false;
  /** Locked at the type level: never flash a console window on Windows. */
  windowsHide: true;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /**
   * D-133 (TASK-02, append-only): hard ceiling on collected stdout, in BYTES
   * (not characters — a CJK playlist title is 3 bytes per glyph).
   *
   * Absent/0 means "unbounded", which is what a normal download keeps: a long
   * transfer legitimately streams megabytes of progress and killing it would
   * be a regression. It is set for BOUNDED metadata jobs only — the playlist
   * JSON probe — where the output is proportional to the item count and an
   * unbounded `+=` on a huge playlist is what grows the main process without
   * limit.
   */
  maxStdoutBytes?: number;
  /** D-133: independent ceiling for collected stderr, in bytes. */
  maxStderrBytes?: number;
  /**
   * T5 (append-only): cooperative cancellation for BOUNDED jobs (the URL
   * pre-check). When the signal fires, the adapter aborts the wait, kills the
   * whole process TREE through the same `killTree()` path as the timeout
   * (a bare `child.kill()` cannot stop a yt-dlp onefile bootloader) and
   * settles the promise only on real exit evidence — `close` / `error`, or
   * the bounded tree-kill answer — never on "kill was issued".
   *
   * Absent means "uncancellable", which is what every pre-existing caller
   * keeps: normal downloads and metadata probes never pass one.
   */
  signal?: SpawnAbortSignal;
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
 *
 * D-137: the options are additive. `maxBytes` makes the body bounded even when
 * Content-Length lies or is absent; `urlPolicy` is re-applied to every redirect
 * hop, not just the initial URL. Both default to a safe-but-compatible floor so
 * existing callers keep their behaviour while new ones can opt into a stricter
 * policy (covers use `isPublicHttpsUrl`, the updater uses its GitHub allowlist).
 */
export interface HttpFetchOptions {
  readonly timeoutMs?: number;
  /** Hard ceiling on the response body in bytes; a breach aborts the stream. */
  readonly maxBytes?: number;
  /** Per-hop predicate. Absent = accept any http(s) URL; the chain stays bounded. */
  readonly urlPolicy?: (rawUrl: string) => boolean;
  /**
   * D-161 (append-only): with an explicit `urlPolicy` the port normally also
   * requires every resolved address to be public (DNS-rebinding guard). Set
   * this to `true` ONLY for an operator-configured INTRANET feed, whose
   * loopback / RFC1918 addresses are the whole point. The URL policy still
   * applies to the initial URL and every redirect hop, the redirect chain is
   * still capped, and the socket is still pinned — only the public-only
   * address classification is skipped. Default `false` keeps every existing
   * caller (official GitHub feed, thumbnail cache) exactly as strict as before.
   */
  readonly allowPrivateAddresses?: boolean;
}

export interface HttpPort {
  getText(url: string, opts?: HttpFetchOptions): Promise<string>;
  getBytes(url: string, opts?: HttpFetchOptions): Promise<Uint8Array>;
}

/**
 * D-166: the "start with Windows" switch.
 *
 * Deliberately boolean-only: the registry path, the value name and the quoted
 * command line are decided by the Windows adapter (`planAutostart`), not by the
 * renderer and not by the channel layer. `read()` exists so the settings toggle
 * can show the REAL state instead of trusting `config.json`.
 */
export interface ISystemStartupPort {
  apply(enabled: boolean): Promise<{ ok: boolean; reason?: string }>;
  read(): Promise<boolean>;
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
  /** D-166 optional: absent means "this platform cannot register a startup entry". */
  systemStartup?: ISystemStartupPort;
}
