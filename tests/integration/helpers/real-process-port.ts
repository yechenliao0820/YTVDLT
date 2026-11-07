/**
 * A REAL ProcessPort for the M1 L2 offline case — the only place in tests that
 * actually spawns a bundled binary. Still obeys the spawn 铁律:
 * absolute file + argv[] + shell:false + windowsHide:true.
 * Binds only 127.0.0.1 via the mock server; NO external network.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { ProcessPort, SpawnOptions, SpawnResult, StreamingSpawn } from '@ytvdlt/shared';

export interface RecordedSpawn {
  file: string;
  argv: readonly string[];
  opts: SpawnOptions;
}

export interface RealProcessPort {
  process: ProcessPort;
  calls: RecordedSpawn[];
}

/** Absolute path of taskkill.exe (never rely on PATH). */
function taskkillPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'taskkill.exe');
}

export function createRealProcessPort(): RealProcessPort {
  const calls: RecordedSpawn[] = [];
  const process: ProcessPort = {
    spawn(file: string, argv: readonly string[], opts: SpawnOptions): Promise<SpawnResult> {
      calls.push({ file, argv, opts });
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (result: SpawnResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(file, [...argv], {
            shell: false,
            windowsHide: true,
            cwd: opts.cwd,
            env: { ...globalThis.process.env, ...(opts.env ?? {}) },
          });
        } catch (error) {
          finish({
            exitCode: null, stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            timedOut: false,
          });
          return;
        }
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
          timedOut = true;
          child.kill();
          finish({ exitCode: null, stdout, stderr, timedOut: true });
        }, opts.timeoutMs);
        child.on('error', (error: Error) => {
          if (timer) clearTimeout(timer);
          finish({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
        });
        child.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer);
          finish({ exitCode: code, stdout, stderr, timedOut });
        });
      });
    },
    spawnStreaming(
      file: string,
      argv: readonly string[],
      opts: SpawnOptions,
      onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    ): StreamingSpawn {
      calls.push({ file, argv, opts });
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(file, [...argv], {
          shell: false,
          windowsHide: true,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          env: { ...globalThis.process.env, ...(opts.env ?? {}) },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          pid: null,
          done: Promise.resolve({ exitCode: null, stdout: '', stderr: message, timedOut: false }),
          kill: async () => true,
        };
      }

      const pid = child.pid ?? null;
      let stdout = '';
      let stderr = '';
      let killRequested = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        stdout += text;
        onChunk({ stream: 'stdout', text });
      });
      child.stderr.on('data', (text: string) => {
        stderr += text;
        onChunk({ stream: 'stderr', text });
      });

      const done = new Promise<SpawnResult>((resolve) => {
        let settled = false;
        const finish = (value: SpawnResult): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.on('error', (error: Error) => finish({
          exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false,
        }));
        child.on('close', (code: number | null) => finish({
          exitCode: killRequested ? null : code, stdout, stderr, timedOut: false,
        }));
      });

      const alive = async (): Promise<boolean> => {
        if (pid === null) return false;
        try { globalThis.process.kill(pid, 0); return true; } catch {
          return false;
        }
      };

      const kill = async (): Promise<boolean> => {
        killRequested = true;
        if (pid === null || !(await alive())) return true;
        await new Promise<void>((resolve) => {
          const killer = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.on('error', () => resolve());
          killer.on('close', () => resolve());
        });
        // Give Windows a moment to reap the tree before the liveness probe.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!(await alive())) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return !(await alive());
      };

      return { pid, done, kill };
    },
    async isAlive(pid: number): Promise<boolean> {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        globalThis.process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as { code?: string })?.code === 'EPERM';
      }
    },
  };
  return { process, calls };
}
