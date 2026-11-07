/**
 * Data-directory resolution for the packaged app (M5-4 / §6.2-⑧).
 *
 * `app.getPath('appData')` always points at `%APPDATA%`, which is wrong for the
 * portable build: a portable exe must keep its config next to itself. The exe
 * directory is only usable if it is writable — a machine-wide install under
 * `C:\Program Files` is not — so the decision is made by ACTUALLY writing a
 * probe file and deleting it again.
 *
 * `process.cwd()` is never consulted: it is inherited from whoever launched the
 * exe (Explorer, a shortcut, the installer) and says nothing about the app.
 *
 * Ports are injected, so the whole decision is L0-testable without touching a
 * real disk layout.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface ProbePort {
  writeTextAtomic(path: string, text: string): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface DataDirOptions {
  /** Directory that holds the executable (portable candidate). */
  exeDir: string;
  /** `%APPDATA%\YTVDLT` — always writable for the current user. */
  fallbackDir: string;
  isPackaged: boolean;
  /** Test seam; defaults to `.ytvdlt-write-probe`. */
  probeFileName?: string;
}

export type DataDirMode = 'portable' | 'appdata' | 'development';

export interface DataDirResolution {
  readonly dataDir: string;
  readonly configDir: string;
  readonly logsDir: string;
  readonly mode: DataDirMode;
  /** True when the chosen directory accepted the write probe. */
  readonly writable: boolean;
  /** Human-readable justification, logged and shown in the About box. */
  readonly reason: string;
}

/** Real filesystem probe — main process only. */
export function createNodeProbePort(): ProbePort {
  return {
    async writeTextAtomic(path: string, text: string): Promise<void> {
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
    async unlink(path: string): Promise<void> {
      await fs.rm(path, { force: true });
    },
    async exists(path: string): Promise<boolean> {
      try {
        await fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function resolution(dataDir: string, mode: DataDirMode, writable: boolean, reason: string): DataDirResolution {
  return {
    dataDir,
    configDir: join(dataDir, 'config'),
    logsDir: join(dataDir, 'logs'),
    mode,
    writable,
    reason,
  };
}

/**
 * Decide where config/logs live.
 *
 * Dev builds keep the historical `%APPDATA%\YTVDLT` location so existing
 * developer profiles are not migrated. Packaged builds prefer the exe
 * directory (portable) and fall back to `%APPDATA%` when the probe fails.
 */
export async function resolveDataDir(
  options: DataDirOptions,
  probe: ProbePort,
): Promise<DataDirResolution> {
  if (!options.isPackaged) {
    return resolution(options.fallbackDir, 'development', true, 'dev build: %APPDATA%\\YTVDLT');
  }

  const probePath = join(options.exeDir, options.probeFileName ?? '.ytvdlt-write-probe');
  try {
    await probe.writeTextAtomic(probePath, 'ok');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return resolution(
      options.fallbackDir,
      'appdata',
      false,
      `exe 目录不可写（${detail}）→ %APPDATA%\\YTVDLT`,
    );
  }

  // Cleanup failure must not demote a writable install; a leftover probe file
  // is harmless and the next launch overwrites it.
  try {
    await probe.unlink(probePath);
  } catch {
    /* ignore */
  }

  return resolution(options.exeDir, 'portable', true, 'exe 目录可写 → 便携模式（配置与 exe 同目录）');
}
