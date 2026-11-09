/**
 * In-memory CorePorts for offline L0 tests (F085).
 * Map-backed filesystem, controllable clock, fake process with recorded stdout.
 * This is the only OTHER implementation of `CorePorts` besides node-ports.ts;
 * it lives in tests/, never in packages/core or engine-ytdlp.
 */
import { createHash } from 'node:crypto';
import type {
  CorePorts, FileSystemPort, HashPort, ProcessPort, ClockPort,
  EnvPort, LogSinkPort, SpawnResult, SpawnOptions,
} from '@ytvdlt/shared';

export interface SpawnCall {
  file: string;
  argv: readonly string[];
  opts: SpawnOptions;
}

/** Scripted output for `spawnStreaming` (L0 replays these chunks in order). */
export interface StreamScript {
  chunks: ReadonlyArray<{ stream: 'stdout' | 'stderr'; text: string }>;
  exitCode: number | null;
  stderr?: string;
  /** Result of `kill()`; false simulates a failed termination. */
  killResult?: boolean;
  /** Whether the pid should still be alive after kill(). */
  survivesKill?: boolean;
  /** Files the simulated process "writes" (e.g. the --print-to-file manifest). */
  writeFiles?: Record<string, string>;
}

export interface InMemoryState {
  files: Map<string, string>;
  bytes: Map<string, Uint8Array>;
  logLines: string[];
  spawnCalls: SpawnCall[];
  /** Map from a matcher string (matched against file path) to a canned result. */
  spawnResults: Map<string, SpawnResult>;
  /** Map from a matcher string to a streaming script. */
  streamScripts: Map<string, StreamScript>;
  /** Every spawnStreaming call, in order. */
  streamCalls: SpawnCall[];
  /** Pids currently considered alive. */
  alivePids: Set<number>;
  /** Pids passed to kill(). */
  killedPids: number[];
  killed: number;
  /** Test hook: shell invocations recorded by the fake IShellPort. */
  shellCalls?: Array<{ operation: 'open' | 'reveal'; path: string }>;
  nowIso: string;
  nowEpochMs: number;
  env: {
    packaged: boolean;
    resourcesPath: string;
    appDataDir: string;
    configDir: string;
    logsDir: string;
    runtimeDir: string;
    appVersion: string;
    platform: string;
    osRelease: string;
    vars: Record<string, string | undefined>;
  };
}

export interface InMemoryPorts {
  ports: CorePorts;
  state: InMemoryState;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createInMemoryPorts(overrides: Partial<InMemoryState> = {}): InMemoryPorts {
  const state: InMemoryState = {
    files: new Map(),
    bytes: new Map(),
    logLines: [],
    spawnCalls: [],
    spawnResults: new Map(),
    streamScripts: new Map(),
    streamCalls: [],
    alivePids: new Set(),
    killedPids: [],
    killed: 0,
    nowIso: '2026-11-05T00:00:00.000Z',
    nowEpochMs: 1_762_300_800_000,
    env: {
      packaged: false,
      resourcesPath: 'C:/Program Files/YTVDLT/resources',
      appDataDir: 'C:/Users/test/AppData/Roaming/YTVDLT',
      configDir: 'C:/Users/test/AppData/Roaming/YTVDLT/config',
      logsDir: 'C:/Users/test/AppData/Roaming/YTVDLT/logs',
      runtimeDir: 'C:/runtime',
      appVersion: '0.1.0',
      platform: 'win32',
      osRelease: 'Windows_NT 10.0.22631',
      vars: { PATH: 'C:/Windows/System32' },
    },
    ...overrides,
  };
  if (overrides.files) state.files = overrides.files;
  if (overrides.bytes) state.bytes = overrides.bytes;
  if (overrides.logLines) state.logLines = overrides.logLines;
  if (overrides.spawnCalls) state.spawnCalls = overrides.spawnCalls;
  if (overrides.spawnResults) state.spawnResults = overrides.spawnResults;
  if (overrides.env) state.env = { ...state.env, ...overrides.env };

  const fs: FileSystemPort = {
    async readText(path: string): Promise<string> {
      const value = state.files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    async writeTextAtomic(path: string, text: string): Promise<void> {
      // Simulate tmp + rename: write tmp first, then move.
      state.files.set(`${path}.tmp`, text);
      state.files.set(path, text);
      state.files.delete(`${path}.tmp`);
    },
    async writeBytesAtomic(path: string, data: Uint8Array): Promise<void> {
      state.bytes.set(path, data);
      state.files.set(path, '');
    },
    async exists(path: string): Promise<boolean> {
      return state.files.has(path) || state.bytes.has(path);
    },
    async stat(path: string): Promise<{ sizeBytes: number; isFile: boolean }> {
      const text = state.files.get(path);
      if (text !== undefined) return { sizeBytes: Buffer.byteLength(text, 'utf8'), isFile: true };
      const data = state.bytes.get(path);
      if (data !== undefined) return { sizeBytes: data.length, isFile: true };
      throw new Error(`ENOENT: ${path}`);
    },
    async mkdir(_dir: string): Promise<void> { /* no-op */ },
    async rename(from: string, to: string): Promise<void> {
      // Byte entries win over the empty-string placeholder `writeBytesAtomic`
      // leaves in `files`; otherwise renaming a binary would silently move ''.
      const data = state.bytes.get(from);
      if (data !== undefined) {
        state.bytes.set(to, data);
        state.bytes.delete(from);
        state.files.delete(from);
        state.files.delete(to);
        return;
      }
      const text = state.files.get(from);
      if (text !== undefined) {
        state.files.set(to, text);
        state.files.delete(from);
        state.bytes.delete(to);
      }
    },
    async unlink(path: string): Promise<void> {
      state.files.delete(path);
      state.bytes.delete(path);
    },
    // D-118: mirror the real primitive — an empty-dir-only remove.
    async rmdir(path: string): Promise<void> {
      const prefix = path.replace(/[\\/]+$/, '') + '/';
      const occupied = [...state.files.keys(), ...state.bytes.keys()]
        .some((key) => key.startsWith(prefix));
      if (occupied) throw new Error(`ENOTEMPTY: ${path}`);
    },
    async readdir(dir: string): Promise<string[]> {
      const prefix = dir.replace(/[\\/]+$/, '') + '/';
      const names = new Set<string>();
      for (const key of [...state.files.keys(), ...state.bytes.keys()]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split(/[\\/]/)[0] ?? '');
      }
      return [...names];
    },
    // M5 append-only (D-62): raw bytes for the engine self-updater.
    async readBytes(path: string): Promise<Uint8Array> {
      const bytes = state.bytes.get(path);
      if (bytes !== undefined) return new Uint8Array(bytes);
      const text = state.files.get(path);
      if (text !== undefined) return new TextEncoder().encode(text);
      throw new Error(`ENOENT: ${path}`);
    },
  };

  const hash: HashPort = {
    async sha256File(path: string): Promise<string> {
      const text = state.files.get(path);
      if (text !== undefined) return hashText(text);
      const data = state.bytes.get(path);
      if (data !== undefined) return createHash('sha256').update(data).digest('hex');
      throw new Error(`ENOENT: ${path}`);
    },
    async sha256Bytes(data: Uint8Array): Promise<string> {
      return createHash('sha256').update(data).digest('hex');
    },
  };

  const proc: ProcessPort = {
    async spawn(file: string, argv: readonly string[], opts: SpawnOptions): Promise<SpawnResult> {
      state.spawnCalls.push({ file, argv, opts });
      // Matchers may target the executable OR a distinctive argv flag
      // (e.g. 'ffprobe.exe' vs 'framemd5' on the same ffmpeg binary).
      const haystack = [file, ...argv].join(' ');
      for (const [matcher, result] of state.spawnResults) {
        if (haystack.includes(matcher)) return result;
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    spawnStreaming(
      file: string,
      argv: readonly string[],
      opts: SpawnOptions,
      onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    ) {
      state.streamCalls.push({ file, argv, opts });
      let pid = 4000 + state.streamCalls.length;
      let script: StreamScript | undefined;
      for (const [matcher, candidate] of state.streamScripts) {
        if (file.includes(matcher)) { script = candidate; break; }
      }
      const chunks = script?.chunks ?? [];
      const exitCode = script?.exitCode ?? 0;
      const extraStderr = script?.stderr ?? '';
      const killResult = script?.killResult ?? true;
      const survivesKill = script?.survivesKill ?? false;
      const writeFiles = script?.writeFiles ?? {};
      state.alivePids.add(pid);

      let settle: (value: SpawnResult) => void = () => undefined;
      const done = new Promise<SpawnResult>((resolve) => { settle = resolve; });
      let settled = false;
      let killed = false;
      const finish = (result: SpawnResult): void => {
        if (settled) return;
        settled = true;
        state.alivePids.delete(pid);
        settle(result);
      };

      queueMicrotask(() => {
        if (killed) return;
        for (const chunk of chunks) onChunk(chunk);
        // Simulate side effects of the real process (manifest/cookie writes).
        for (const [path, text] of Object.entries(writeFiles)) state.files.set(path, text);
        finish({
          exitCode,
          stdout: chunks.filter((c) => c.stream === 'stdout').map((c) => c.text).join(''),
          stderr: extraStderr || chunks.filter((c) => c.stream === 'stderr').map((c) => c.text).join(''),
          timedOut: false,
        });
      });

      return {
        pid,
        done,
        async kill(): Promise<boolean> {
          killed = true;
          state.killed += 1;
          state.killedPids.push(pid);
          if (survivesKill) return false;
          finish({ exitCode: null, stdout: '', stderr: extraStderr, timedOut: false });
          return killResult;
        },
      };
    },
    async isAlive(pid: number): Promise<boolean> {
      return state.alivePids.has(pid);
    },
  };

  const clock: ClockPort = {
    nowIso: () => state.nowIso,
    nowEpochMs: () => state.nowEpochMs,
  };

  const env: EnvPort = {
    isPackaged: () => state.env.packaged,
    resourcesPath: () => state.env.resourcesPath,
    appDataDir: () => state.env.appDataDir,
    configDir: () => state.env.configDir,
    logsDir: () => state.env.logsDir,
    runtimeDir: () => state.env.runtimeDir,
    platform: () => state.env.platform,
    osRelease: () => state.env.osRelease,
    appVersion: () => state.env.appVersion,
    get: (name: string) => state.env.vars[name],
  };

  const logSink: LogSinkPort = {
    async appendJsonl(line: string): Promise<void> {
      state.logLines.push(line);
    },
  };

  // M2: recorded shell invocations (A-4.6-02 boundary — argv correctness only).
  const shellCalls: Array<{ operation: 'open' | 'reveal'; path: string }> = [];
  const shell = {
    async openPath(path: string): Promise<void> { shellCalls.push({ operation: 'open', path }); },
    async showItemInFolder(path: string): Promise<void> { shellCalls.push({ operation: 'reveal', path }); },
  };
  state.shellCalls = shellCalls;

  return { ports: { fs, hash, process: proc, clock, env, logSink, shell }, state };
}

/** Helper: SHA-256 of a string, for building fake manifests in tests. */
export function sha256Of(text: string): string {
  return hashText(text);
}
