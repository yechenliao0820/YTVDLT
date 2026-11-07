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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CorePorts, FileSystemPort, HashPort, ProcessPort, ClockPort,
  EnvPort, LogSinkPort, SpawnResult, SpawnOptions, IShellPort, HttpPort,
} from '@ytvdlt/shared';
import { createStreamingProcessPort } from './process-streaming.js';
import { createShellPort } from './shell-port.js';

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
      await fs.rm(path, { force: true });
      await fs.rename(tmp, path);
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
      await fs.rm(path, { force: true });
      await fs.rename(tmp, path);
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
    async rename(from: string, to: string): Promise<void> {
      await fs.rm(to, { force: true });
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
  return {
    spawn(file: string, argv: readonly string[], opts: SpawnOptions): Promise<SpawnResult> {
      return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(file, [...argv], {
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
        const finish = (result: SpawnResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });

        const timer = opts.timeoutMs === undefined
          ? null
          : setTimeout(() => {
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
    // M2 append-only: streaming spawn (pid + process-tree kill) and liveness.
    spawnStreaming: streaming.spawnStreaming,
    isAlive: streaming.isAlive,
  };
}

/** M5 (D-67): global `fetch`, the only outbound network call in the app. */
function httpPort(): HttpPort {
  const read = async (url: string, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async getText(url: string, opts?: { timeoutMs?: number }): Promise<string> {
      const response = await read(url, opts?.timeoutMs ?? 20_000);
      return response.text();
    },
    async getBytes(url: string, opts?: { timeoutMs?: number }): Promise<Uint8Array> {
      const response = await read(url, opts?.timeoutMs ?? 120_000);
      return new Uint8Array(await response.arrayBuffer());
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
