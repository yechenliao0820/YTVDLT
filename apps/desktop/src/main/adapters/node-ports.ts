/**
 * createNodePorts() — the ONLY file in the whole repository allowed to import
 * `node:fs/promises`, `node:crypto`, `node:child_process`, `node:os`, `node:path`.
 *
 * All Core components are pure TS and receive these ports via constructor
 * injection. Both production (Electron main) and `scripts/check-runtime.mjs`
 * assemble the SAME adapter, so self-check logic is never duplicated.
 *
 * spawn 铁律: absolute `file` + `argv[]` + `shell: false` + `windowsHide: true`.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CorePorts, FileSystemPort, HashPort, ProcessPort, ClockPort,
  EnvPort, LogSinkPort, SpawnResult, SpawnOptions, IShellPort, HttpPort, HttpFetchOptions,
} from '@ytvdlt/shared';
import { TERMINATION_UNCONFIRMED_MARKER } from '@ytvdlt/shared';
import { createStreamingProcessPort } from './process-streaming.js';
import { createBoundedOutput, OUTPUT_LIMIT_MARKER, type BoundedOutput } from './output-limiter.js';
import {
  allowAnyHttpUrl, fetchFollowingRedirects, isPublicResolvedAddress, type RedirectPolicy,
} from './http-policy.js';
import { createShellPort } from './shell-port.js';

/**
 * R1-07 — how long an overflowed child gets to die before the promise settles
 * without it.
 *
 * WHY A SECOND DEADLINE EXISTS: the overflow kill goes through `taskkill /T`,
 * which is an external process and can genuinely fail (the child already
 * exited, access denied, a PID recycled in the gap). `killTree()`'s rejection is
 * swallowed — correctly, there is nothing better to do — but then the only
 * thing that could settle the promise was the caller's `timeoutMs`. Every
 * current caller passes one; the next one might not, and the cost of that
 * mistake is a hung pre-check with no error at all.
 *
 * 5 s is deliberately longer than the ~2 s a Windows tree-kill takes in the
 * measured runs and shorter than every bounded caller's own timeout (20 s
 * pre-check, 30 s catalog list), so in practice this timer never fires first —
 * it is a floor, not the normal path. Asserted by a unit test so the bound
 * cannot silently grow past a caller's timeout.
 */
export const OVERFLOW_SETTLE_GRACE_MS = 5_000;

export interface NodePortsOptions {
  packaged: boolean;
  resourcesPath: string;
  /** Absolute runtime root, already resolved by resolveRuntimeDir(). */
  runtimeDir: string;
  appDataDir: string;
  configDir: string;
  logsDir: string;
  appVersion: string;
  platform?: string;
  osRelease?: string;
  getEnv?: (name: string) => string | undefined;
  /** Test hook: capture shell invocations instead of launching explorer. */
  onShellInvoke?: (operation: 'open' | 'reveal', argv: readonly string[]) => void;
  /**
   * M3 B3 (append-only, F057): app-host injects the Electron `IShellPort`.
   * When absent, the M2 `explorer.exe` adapter remains the non-Electron
   * fallback (shell-port.ts is intentionally unchanged).
   */
  shell?: IShellPort;
}

/**
 * D-145: bounded retry for the final "replace target" step of the atomic
 * writes. On Windows an antivirus scanner / search indexer / a lingering
 * viewer routinely holds the TARGET file open for tens of milliseconds, which
 * makes the replace-rename fail with EPERM / EBUSY / EACCES. Such locks clear
 * on their own, so a few short retries turn a spurious save failure into a
 * success. The bound (at most ~ATOMIC_REPLACE_MAX_RETRIES *
 * ATOMIC_REPLACE_RETRY_DELAY_MS of extra waiting) keeps a genuinely stuck
 * lock from hanging a config save forever.
 */
export const ATOMIC_REPLACE_MAX_RETRIES = 3;
export const ATOMIC_REPLACE_RETRY_DELAY_MS = 50;

/** D-145: true for the transient "target momentarily locked" errno set. */
function isTransientReplaceLockError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function replaceRetryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * D-145: replace `target` with `tmp` in ONE step — a plain rename.
 *
 * WHY IT IS ATOMIC: on Windows libuv implements `fs.rename` with
 * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which swaps an existing target in
 * a single kernel call; on POSIX it is rename(2), atomic by definition. The
 * target therefore never points at a missing or truncated file, even if the
 * process dies mid-write.
 *
 * WHY THE TARGET IS NO LONGER `rm`'ED FIRST: the old sequence
 * (`rm target` → `rename tmp target`) had a window between the two calls in
 * which the ONLY good copy of the file (config.json, history, task store...)
 * did not exist. A crash in that window — or a rename failure — destroyed it,
 * which is exactly what an "atomic write" must never do. Nothing here touches
 * `target` before the rename succeeds.
 *
 * On failure the tmp file is cleaned up (best effort, so cleanup cannot mask
 * the real error) and the ORIGINAL rename error is rethrown: the caller keeps
 * the previous good contents on disk.
 */
async function renameReplaceExisting(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (error) {
      // Only the Windows lock-churn errno set is transient (see D-145 above);
      // anything else (e.g. ENOENT on the tmp file) is a real bug — no retry.
      if (!isTransientReplaceLockError(error) || attempt >= ATOMIC_REPLACE_MAX_RETRIES) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      await replaceRetryDelay(ATOMIC_REPLACE_RETRY_DELAY_MS);
    }
  }
}

function fileSystemPort(): FileSystemPort {
  return {
    async readText(path: string): Promise<string> {
      return fs.readFile(path, 'utf8');
    },
    async writeTextAtomic(path: string, text: string): Promise<void> {
      await fs.mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // D-145: atomic replace — the target is never deleted first.
      await renameReplaceExisting(tmp, path);
    },
    async writeBytesAtomic(path: string, data: Uint8Array): Promise<void> {
      await fs.mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // D-145: atomic replace — the target is never deleted first.
      await renameReplaceExisting(tmp, path);
    },
    async exists(path: string): Promise<boolean> {
      try {
        await fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async stat(path: string): Promise<{ sizeBytes: number; isFile: boolean }> {
      const info = await fs.stat(path);
      return { sizeBytes: info.size, isFile: info.isFile() };
    },
    async mkdir(dir: string): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
    },
    // D-118: NON-recursive on purpose. `fs.rm(..., {recursive:true})` would
    // delete resumable `.part` bytes if a caller ever got the path wrong; an
    // empty-dir-only primitive fails loudly instead.
    async rmdir(path: string): Promise<void> {
      await fs.rmdir(path);
    },
    // D-145: a plain rename. libuv's MoveFileExW(MOVEFILE_REPLACE_EXISTING)
    // on Windows / rename(2) on POSIX replaces an existing target atomically,
    // so callers that swap a file in place (engine self-update backup/swap,
    // D-62; ConfigStore corrupt-file backup; crash-guard rotation) never
    // observe a missing target. The old rm-then-rename had a crash window in
    // which `to` did not exist.
    async rename(from: string, to: string): Promise<void> {
      await fs.rename(from, to);
    },
    async unlink(path: string): Promise<void> {
      await fs.rm(path, { force: true });
    },
    async readdir(dir: string): Promise<string[]> {
      return fs.readdir(dir);
    },
    // M5 append-only (D-62): bytes for the engine self-updater's backup step.
    async readBytes(path: string): Promise<Uint8Array> {
      const buffer = await fs.readFile(path);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
}

function hashPort(): HashPort {
  return {
    async sha256File(path: string): Promise<string> {
      const hash = createHash('sha256');
      const stream = (await import('node:fs')).createReadStream(path);
      for await (const chunk of stream) hash.update(chunk as Buffer);
      return hash.digest('hex');
    },
    async sha256Bytes(data: Uint8Array): Promise<string> {
      return createHash('sha256').update(data).digest('hex');
    },
  };
}

function processPort(): ProcessPort {
  const streaming = createStreamingProcessPort();

  /**
   * D-133 (TASK-02): bounded `spawn()`.
   *
   * Counts BYTES, not characters — a CJK playlist title costs 3 UTF-8 bytes per
   * glyph, so a limit expressed in JS string length is off by up to 3x exactly
   * for the users this app ships to.
   *
   * Unbounded is the DEFAULT and is byte-identical to the legacy path: the
   * playlist probe passes ceilings, a metadata probe and every other caller
   * leave them unset. A normal download never reaches here at all (it uses
   * `spawnStreaming`), so no transfer can be killed by this.
   *
   * The overflow kill and the timeout kill both go through `killTree()` — a
   * bare `child.kill()` does not stop a yt-dlp onefile bootloader (§9 坑 21),
   * which is what the old timeout path used.
   */
  const spawn: ProcessPort['spawn'] = (file, argv, opts) => {
    const bounded = opts.maxStdoutBytes !== undefined || opts.maxStderrBytes !== undefined;
    const outLimit: BoundedOutput | null = bounded ? createBoundedOutput(opts.maxStdoutBytes) : null;
    const errLimit: BoundedOutput | null = bounded ? createBoundedOutput(opts.maxStderrBytes) : null;

    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(file, [...argv], {
          shell: false,
          windowsHide: true,
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
        });
      } catch (error) {
        resolve({
          exitCode: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let overflowed = false;
      /** D-137: a `close`/`error` event is the only PROOF that the tree exited. */
      let exitObserved = false;
      /** null = not attempted / still in flight; false = the tree kill failed. */
      let killConfirmed: boolean | null = null;

      // The collector owns the accepted prefix once it exists; the plain string
      // is authoritative only on the unbounded path.
      const currentStdout = (): string => (outLimit === null ? stdout : outLimit.text());
      const currentStderr = (): string => (errLimit === null ? stderr : errLimit.text());
      const overflowNote = (): string => (overflowed ? `\n${OUTPUT_LIMIT_MARKER}` : '');
      /**
       * D-137 (F-03): stamped only when we must settle WITHOUT having seen the
       * child exit and the tree kill was not confirmed. It says "a process tree
       * MAY still be alive"; it never turns the result into a success — the
       * `exitCode: null` above keeps every success path closed.
       *
       * Deliberately a neutral fixed string, like OUTPUT_LIMIT_MARKER: no word
       * from the error-mapper keyword table, so it cannot be mislabelled as a
       * network/permission failure.
       */
      const terminationNote = (): string => (
        (overflowed || timedOut) && !exitObserved && killConfirmed !== true
          ? `\n${TERMINATION_UNCONFIRMED_MARKER}` : ''
      );

      let timer: NodeJS.Timeout | null = null;
      /** R1-07: the overflow deadline, kept separate from the caller's timeout. */
      let settleTimer: NodeJS.Timeout | null = null;
      const finish = (result: SpawnResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
        // A settled result must never leave listeners behind (TASK-02 C:
        // "不能因为增加输出限制而引入新的进程泄漏或者监听器泄漏").
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        resolve(result);
      };

      /**
       * D-137 (F-03): issue a tree kill and WAIT — with a bound — for its answer.
       * `killTree()` already checks liveness, retries once and falls back to a
       * direct SIGKILL, but its own `taskkill` spawn has no deadline. Racing it
       * against OVERFLOW_SETTLE_GRACE_MS keeps a stuck killer from hanging the
       * pre-check forever while still returning an honest boolean.
       */
      const terminate = (): Promise<boolean> => {
        let raceTimer: NodeJS.Timeout | null = null;
        const bounded = new Promise<boolean>((resolve) => {
          raceTimer = setTimeout(() => resolve(false), OVERFLOW_SETTLE_GRACE_MS);
        });
        const attempt = streaming.killTree(child.pid ?? null, child).catch(() => false);
        return Promise.race([attempt, bounded]).then((ok) => {
          if (raceTimer !== null) clearTimeout(raceTimer);
          // If the child already emitted `close`, we SAW it exit — that is at
          // least as strong as the killer's own liveness poll.
          killConfirmed = exitObserved ? true : ok;
          return killConfirmed;
        });
      };

      /** Kill the TREE on overflow; the flag decides how `close` is reported. */
      const killOnOverflow = (): void => {
        if (overflowed) return;
        overflowed = true;
        void terminate();
        // R1-07: the kill is best-effort — `taskkill` can fail (already gone, an
        // access-denied zombie, a PID recycled between the spawn and the kill),
        // and when it does the `close` event may never arrive. Without this
        // second deadline the promise would hang forever whenever the caller did
        // not pass `timeoutMs` (the metadata probes do pass one; a future caller
        // would be the bug). Settling here is honest: the result already says
        // `exitCode: null` + the overflow marker, so no caller can mistake it
        // for a clean run with a short answer.
        settleTimer = setTimeout(() => {
          settleTimer = null;
          finish({
            exitCode: null, stdout: currentStdout(),
            stderr: `${currentStderr()}${overflowNote()}${terminationNote()}`,
            timedOut,
          });
        }, OVERFLOW_SETTLE_GRACE_MS);
      };

      const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        const limit = stream === 'stdout' ? outLimit : errLimit;
        if (limit === null) {
          // Unbounded: exact legacy accumulation, no per-chunk work.
          if (stream === 'stdout') stdout += buffer.toString('utf8');
          else stderr += buffer.toString('utf8');
          return;
        }
        if (limit.push(buffer) === 'exceeded') killOnOverflow();
      };

      child.stdout?.on('data', onData('stdout'));
      child.stderr?.on('data', onData('stderr'));

      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          // D-137: wait for the bounded tree-kill answer instead of resolving
          // the instant the kill is issued. A `close` event may already have
          // settled the promise (finish() is idempotent); otherwise this is the
          // honest report of whether the child actually stopped.
          void terminate().then(() => finish({
            exitCode: null, stdout: currentStdout(),
            stderr: `${currentStderr()}${terminationNote()}`, timedOut: true,
          }));
        }, opts.timeoutMs);
      }

      child.on('error', (error: Error) => {
        exitObserved = true;
        finish({
          exitCode: null,
          stdout: currentStdout(),
          stderr: `${currentStderr()}${overflowed ? '' : error.message}${overflowNote()}`,
          timedOut,
        });
      });
      child.on('close', (code: number | null) => {
        exitObserved = true;
        finish({
          // An overflow OR timeout kill is NOT a clean exit: report a null code
          // so the caller errors out instead of `JSON.parse`-ing a truncated
          // blob. D-137: the timeout path now waits for the tree kill, so
          // `close` can legitimately arrive first with taskkill's exit code (1);
          // without `timedOut` here that code would masquerade as a real run.
          exitCode: (overflowed || timedOut) ? null : code,
          stdout: currentStdout(),
          stderr: `${currentStderr()}${overflowNote()}`,
          timedOut,
        });
      });
    });
  };

  return {
    spawn,
    // M2 append-only: streaming spawn (pid + process-tree kill) and liveness.
    spawnStreaming: streaming.spawnStreaming,
    isAlive: streaming.isAlive,
  };
}

/**
 * M5 (D-67): the app's only outbound network call, routed through
 * `fetchFollowingRedirects`. D-143 moved the transport from global `fetch` to
 * `node:http`/`node:https` so every connection is pinned to policy-verified
 * DNS answers (see the header of `http-policy.ts`).
 *
 * D-137 (F-02): `arrayBuffer()` used to read the WHOLE body before any size
 * check — a hostile or simply endless cover-image stream could grow the main
 * process without bound, and the timeout was cleared as soon as headers arrived,
 * so a slow trickle was unbounded in TIME as well. The body is now read through
 * a byte-counted stream under ONE deadline that covers headers + every chunk.
 *
 * `maxBytes` defaults are generous on purpose: `getBytes` also serves the
 * bundled-engine binary (~tens of MiB). Callers with a tighter budget (the
 * thumbnail cache) pass their own `maxBytes` and `urlPolicy`.
 */
const DEFAULT_TEXT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BINARY_MAX_BYTES = 64 * 1024 * 1024;

function httpPort(): HttpPort {
  const readBounded = async (
    url: string,
    opts: HttpFetchOptions | undefined,
    defaults: { readonly maxBytes: number; readonly timeoutMs: number },
  ): Promise<Uint8Array> => {
    const maxBytes = opts?.maxBytes ?? defaults.maxBytes;
    const controller = new AbortController();
    // ONE deadline for the whole operation. It is cleared in `finally`, i.e.
    // only after the last byte (or an error) — never at the response headers.
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? defaults.timeoutMs);
    try {
      const policy: RedirectPolicy = opts?.urlPolicy === undefined
        ? allowAnyHttpUrl
        // D-143: any caller-supplied URL policy now also validates RESOLVED
        // addresses and pins the socket to them. The two production callers are
        // the thumbnail cache (`isPublicHttpsUrl`) and the updater
        // (`isTrustedReleaseHost`); both need "no private/loopback IP behind a
        // checked hostname". The permissive no-policy default stays unvalidated
        // so local 127.0.0.1 traffic keeps working.
        : { allow: opts.urlPolicy, allowResolvedAddress: isPublicResolvedAddress };
      const response = await fetchFollowingRedirects(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'YTVDLT' },
      }, policy);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

      // A declared length is a cheap early rejection, but it is NOT trusted:
      // the stream counter below is what actually enforces the ceiling.
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`response too large: ${declared} bytes`);
      }
      if (response.body === null) return new Uint8Array(0);

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw new Error(`response exceeded ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* stream already closed */ }
      }
      controller.signal.throwIfAborted();
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return joined;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async getText(url: string, opts?: HttpFetchOptions): Promise<string> {
      const bytes = await readBounded(url, opts, {
        maxBytes: DEFAULT_TEXT_MAX_BYTES, timeoutMs: 20_000,
      });
      return new TextDecoder().decode(bytes);
    },
    async getBytes(url: string, opts?: HttpFetchOptions): Promise<Uint8Array> {
      return readBounded(url, opts, {
        maxBytes: DEFAULT_BINARY_MAX_BYTES, timeoutMs: 120_000,
      });
    },
  };
}

function clockPort(): ClockPort {
  return {
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
  };
}

function envPort(options: NodePortsOptions): EnvPort {
  const get = options.getEnv ?? ((name: string) => process.env[name]);
  return {
    isPackaged: () => options.packaged,
    resourcesPath: () => options.resourcesPath,
    appDataDir: () => options.appDataDir,
    configDir: () => options.configDir,
    logsDir: () => options.logsDir,
    runtimeDir: () => options.runtimeDir,
    platform: () => options.platform ?? 'win32',
    osRelease: () => options.osRelease ?? release(),
    appVersion: () => options.appVersion,
    get,
  };
}

function logSinkPort(options: NodePortsOptions): LogSinkPort {
  return {
    async appendJsonl(line: string): Promise<void> {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const path = join(options.logsDir, `app-${date}.jsonl`);
      await fs.mkdir(options.logsDir, { recursive: true });
      await fs.appendFile(path, `${line}\n`, 'utf8');
    },
  };
}

/** Assemble the full CorePorts used by both Electron main and check-runtime.mjs. */
export function createNodePorts(options: NodePortsOptions): CorePorts {
  return {
    fs: fileSystemPort(),
    hash: hashPort(),
    process: processPort(),
    clock: clockPort(),
    env: envPort(options),
    logSink: logSinkPort(options),
    // M2 append-only: artifact open/reveal (A-4.6-02).
    // M3 B3: an injected Electron shell port wins; explorer.exe stays the
    // non-Electron fallback (D-39 / F057).
    http: httpPort(),
    shell: options.shell ?? createShellPort(
      options.onShellInvoke === undefined ? {} : { onInvoke: options.onShellInvoke },
    ),
  };
}
