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

/** Absolute path of taskkill.exe (never rely on PATH). */
export function taskkillPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'taskkill.exe');
}

export interface StreamingProcessPortOptions {
  /** Override for tests; defaults to process.execPath-adjacent taskkill. */
  taskkill?: string;
}

export function createStreamingProcessPort(options: StreamingProcessPortOptions = {}): {
  spawnStreaming: ProcessPort['spawnStreaming'];
  isAlive: ProcessPort['isAlive'];
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

  const killTree = async (pid: number | null, child: ChildProcess): Promise<boolean> => {
    if (pid === null) {
      try { child.kill(); } catch { /* already gone */ }
      return true;
    }
    // Already exited: taskkill would return non-zero; treat as success (idempotent).
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

    if (!(await isAlive(pid))) return true;
    // Retry once; taskkill may report 128 for a parent that already died.
    await new Promise<void>((resolve) => {
      const retry = spawn(taskkillExe, ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      retry.on('error', () => resolve());
      retry.on('close', () => resolve());
    });
    const stillAlive = await isAlive(pid);
    if (stillAlive) {
      // Last resort: SIGKILL the direct child so we never leak it.
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    void result;
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

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killRequested = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      stdout += text;
      onChunk({ stream: 'stdout', text });
    });
    child.stderr?.on('data', (text: string) => {
      stderr += text;
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
        exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut,
      }));
      child.on('close', (code: number | null) => finish({
        exitCode: killRequested ? null : code, stdout, stderr, timedOut,
      }));
    });

    const kill = async (): Promise<boolean> => {
      killRequested = true;
      const ok = await killTree(pid, child);
      return ok;
    };

    return { pid, done, kill };
  };

  return { spawnStreaming, isAlive };
}
