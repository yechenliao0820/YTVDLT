/**
 * Streaming process adapter — the ONLY place that kills process TREES.
 *
 * Windows cancellation MUST use `taskkill.exe /PID <pid> /T /F` (absolute path,
 * argv[], shell:false). `child.kill()` only terminates the parent; yt-dlp spawns
 * ffmpeg, which would be left orphaned and violate acceptance ③.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { ProcessPort, SpawnOptions, SpawnResult, StreamingSpawn } from '@ytvdlt/shared';
import { STREAM_TAIL_MAX_BYTES, STREAM_TAIL_TRUNCATED_MARKER } from '@ytvdlt/shared';

/** Absolute path of taskkill.exe (never rely on PATH). */
export function taskkillPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'taskkill.exe');
}

/**
 * D-144 — bounded diagnostic tail for one output stream of a streaming spawn.
 *
 * The download path streams megabytes of progress by design, so the old
 * `stdout += text; stderr += text` accumulators made the main process grow
 * without bound on verbose / long-batch runs. The realtime parser is NOT
 * bounded (`onChunk` keeps receiving every chunk, untouched); only the
 * DIAGNOSTIC copy kept for `SpawnResult` is bounded: when appending a chunk
 * would push `bytes` past the ceiling, whole code points are dropped from the
 * HEAD until the budget holds — error diagnosis reads the ending lines — and
 * `truncated` latches so the assembled value carries
 * STREAM_TAIL_TRUNCATED_MARKER exactly once, in front, and can never be
 * mistaken for a complete log.
 *
 * Byte counting uses `Buffer.byteLength` on the already-decoded chunk string:
 * `String.length` counts UTF-16 code units and understates CJK by 3x, the
 * exact trap D-133 documented (手册坑 23). `setEncoding('utf8')` guarantees a
 * multi-byte sequence is never split across chunks, so per-chunk byte lengths
 * add up exactly.
 *
 * PERFORMANCE CONTRACT (why the retained content is a deque, not one string):
 * every append must cost O(chunk), never O(retained). The first D-144 draft
 * re-sliced a 1 MiB string on every overflowing chunk, which under a flood
 * starved the event loop for seconds — measured: a `wait(400)` timer fired at
 * 2552 ms, and the resulting late kill let a probe child survive past its own
 * 1.5 s sentinel (probe-output-limit 9a). The kill path shares this loop, so
 * the tail bookkeeping must stay cheap. Hence: whole chunks are dropped by
 * index bump (O(1)), only the ONE boundary chunk is byte-walked and re-sliced
 * (O(chunk)), and the retained text is materialized once, at assembly.
 */
interface StreamTail {
  /** Retained chunks in order; everything before `headIndex` is dropped. */
  parts: string[];
  headIndex: number;
  /** Exact UTF-8 bytes of the retained text (parts[headIndex..]). */
  bytes: number;
  truncated: boolean;
}

/**
 * Walk `text`'s head in UTF-8 bytes until `budget` bytes are covered. A
 * surrogate pair moves as one 4-byte unit, so the cut lands on a code-point
 * boundary and the retained text stays well-formed. Returns the code-unit
 * index to slice at and the exact number of bytes that walk covered.
 */
const utf8HeadCut = (
  text: string,
  budget: number,
): { index: number; bytes: number } => {
  let index = 0;
  let bytes = 0;
  while (bytes < budget && index < text.length) {
    const code = text.charCodeAt(index);
    let unitBytes: number;
    let units = 1;
    if (code < 0x80) unitBytes = 1;
    else if (code < 0x800) unitBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { unitBytes = 4; units = 2; }
      else unitBytes = 3;
    } else {
      unitBytes = 3;
    }
    bytes += unitBytes;
    index += units;
  }
  return { index, bytes };
};

/** Exported for the D-144 unit tests (see `appendToStreamTail`). */
export const newStreamTail = (): StreamTail => ({ parts: [], headIndex: 0, bytes: 0, truncated: false });

/** The retained tail text, materialized (one join; O(retained), call-site only). */
export const streamTailText = (tail: StreamTail): string =>
  tail.headIndex === 0 ? tail.parts.join('') : tail.parts.slice(tail.headIndex).join('');

/**
 * Exported for the D-144 unit tests (same pattern as `createBoundedOutput`):
 * the byte-exactness cases are pure and run without a child process.
 */
export const appendToStreamTail = (tail: StreamTail, chunk: string, limit: number): void => {
  if (chunk.length === 0) return;
  const chunkBytes = Buffer.byteLength(chunk);
  tail.parts.push(chunk);
  tail.bytes += chunkBytes;
  if (tail.bytes <= limit) return;
  tail.truncated = true;
  // Drop whole head parts while that alone covers the overflow (O(1) each),
  // then cut inside the ONE boundary part for the remainder. Never scans or
  // re-slices the whole retained text — see the performance contract above.
  let drop = tail.bytes - limit;
  while (drop > 0 && tail.headIndex < tail.parts.length) {
    const head = tail.parts[tail.headIndex] as string;
    const headBytes = Buffer.byteLength(head);
    if (headBytes <= drop) {
      drop -= headBytes;
      tail.bytes -= headBytes;
      tail.headIndex += 1;
    } else {
      const cut = utf8HeadCut(head, drop);
      tail.parts[tail.headIndex] = head.slice(cut.index);
      tail.bytes -= cut.bytes;
      drop = 0;
    }
  }
  // The dropped prefix is garbage; keep the deque from growing without bound
  // without ever copying retained bytes (references only, and only when the
  // dropped prefix has outgrown the retained part).
  if (tail.headIndex > 64 && tail.headIndex * 2 > tail.parts.length) {
    tail.parts = tail.parts.slice(tail.headIndex);
    tail.headIndex = 0;
  }
};

/** Final value for `SpawnResult`: the marker (once, in front) + retained tail. */
export const assembleStreamTail = (tail: StreamTail): string =>
  tail.truncated ? `${STREAM_TAIL_TRUNCATED_MARKER}\n${streamTailText(tail)}` : streamTailText(tail);

export interface StreamingProcessPortOptions {
  /** Override for tests; defaults to process.execPath-adjacent taskkill. */
  taskkill?: string;
}

export function createStreamingProcessPort(options: StreamingProcessPortOptions = {}): {
  spawnStreaming: ProcessPort['spawnStreaming'];
  isAlive: ProcessPort['isAlive'];
  /**
   * D-133 (TASK-02): exposed so the bounded `spawn()` path can terminate a
   * process TREE on output overflow. `child.kill()` is not enough — a yt-dlp
   * onefile bootloader survives it (§9 坑 21) — so both the timeout and the
   * overflow paths must funnel through this one implementation.
   */
  killTree: (pid: number | null, child: ChildProcess) => Promise<boolean>;
} {
  const taskkillExe = options.taskkill ?? taskkillPath();

  const isAlive: ProcessPort['isAlive'] = async (pid: number): Promise<boolean> => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      // Signal 0 performs an existence check without delivering a signal.
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but we cannot signal it → still alive.
      return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  };

  // D-142: after the child's `exit` event has fired, `exitCode`/`signalCode`
  // are set and Windows may ALREADY have reassigned the pid to an unrelated
  // process — `process.kill(pid, 0)` cannot tell them apart, so trusting
  // `isAlive(pid)` alone could taskkill an innocent tree or report a cancel
  // failure for a tree that is long dead. The child object we own is the
  // authoritative exit evidence for the process we spawned.
  const childConfirmedExited = (child: ChildProcess): boolean =>
    child.exitCode !== null || child.signalCode !== null;

  const killTree = async (pid: number | null, child: ChildProcess): Promise<boolean> => {
    if (pid === null) {
      try { child.kill(); } catch { /* already gone */ }
      return true;
    }
    // Already exited: taskkill would return non-zero; treat as success (idempotent).
    if (childConfirmedExited(child)) return true;
    if (!(await isAlive(pid))) return true;

    const result = await new Promise<SpawnResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value: SpawnResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const killer = spawn(taskkillExe, ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
        });
        killer.stdout?.setEncoding('utf8');
        killer.stderr?.setEncoding('utf8');
        killer.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        killer.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        killer.on('error', (error: Error) => finish({
          exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false,
        }));
        killer.on('close', (code: number | null) => finish({
          exitCode: code, stdout, stderr, timedOut: false,
        }));
      } catch (error) {
        finish({
          exitCode: null, stdout, stderr: String(error), timedOut: false,
        });
      }
    });

    if (childConfirmedExited(child) || !(await isAlive(pid))) return true;
    // Retry once; taskkill may report 128 for a parent that already died.
    await new Promise<void>((resolve) => {
      const retry = spawn(taskkillExe, ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      retry.on('error', () => resolve());
      retry.on('close', () => resolve());
    });
    // The exit event may have landed while the retries ran; it outranks the
    // pid probe (which a reused pid would fail).
    if (childConfirmedExited(child)) return true;
    const stillAlive = await isAlive(pid);
    if (stillAlive) {
      // Last resort: SIGKILL the direct child so we never leak it.
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    void result;
    if (childConfirmedExited(child)) return true;
    return !(await isAlive(pid));
  };

  const spawnStreaming: ProcessPort['spawnStreaming'] = (
    file: string,
    argv: readonly string[],
    opts: SpawnOptions,
    onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
  ): StreamingSpawn => {
    let child: ChildProcess;
    let pid: number | null = null;
    let spawnError: string | null = null;

    try {
      child = spawn(file, [...argv], {
        shell: false,
        windowsHide: true,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        env: { ...process.env, ...(opts.env ?? {}) },
      });
      pid = child.pid ?? null;
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      return {
        pid: null,
        done: Promise.resolve({ exitCode: null, stdout: '', stderr: spawnError, timedOut: false }),
        kill: async () => true,
      };
    }

    // D-144: bounded diagnostic tails (see the comment on StreamTail above).
    // `onChunk` stays byte-for-byte unchanged — progress parsing must see the
    // full, unbounded stream.
    const stdoutTail = newStreamTail();
    const stderrTail = newStreamTail();
    let timedOut = false;
    let killRequested = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      appendToStreamTail(stdoutTail, text, STREAM_TAIL_MAX_BYTES);
      onChunk({ stream: 'stdout', text });
    });
    child.stderr?.on('data', (text: string) => {
      appendToStreamTail(stderrTail, text, STREAM_TAIL_MAX_BYTES);
      onChunk({ stream: 'stderr', text });
    });

    const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      void killTree(pid, child);
    }, opts.timeoutMs);

    const done = new Promise<SpawnResult>((resolve) => {
      let settled = false;
      const finish = (value: SpawnResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      child.on('error', (error: Error) => finish({
        exitCode: null, stdout: assembleStreamTail(stdoutTail),
        stderr: `${assembleStreamTail(stderrTail)}${error.message}`, timedOut,
      }));
      child.on('close', (code: number | null) => finish({
        exitCode: killRequested ? null : code,
        stdout: assembleStreamTail(stdoutTail),
        stderr: assembleStreamTail(stderrTail),
        timedOut,
      }));
    });

    const kill = async (): Promise<boolean> => {
      killRequested = true;
      const ok = await killTree(pid, child);
      return ok;
    };

    return { pid, done, kill };
  };

  return { spawnStreaming, isAlive, killTree };
}
