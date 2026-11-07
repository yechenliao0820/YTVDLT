/**
 * Shell adapter (A-4.6-02 boundary).
 * Uses `explorer.exe` with an argv[] — never a shell string.
 * M3 replaces this with Electron `shell.openPath` / `shell.showItemInFolder`.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { IShellPort } from '@ytvdlt/shared';
import { buildExplorerArgv, type ShellOperation } from '@ytvdlt/core';

/** Absolute path of explorer.exe (never rely on PATH). */
export function explorerPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  return join(systemRoot, 'explorer.exe');
}

export interface ShellPortOptions {
  explorer?: string;
  /** Test hook: record the argv instead of launching anything. */
  onInvoke?: (operation: ShellOperation, argv: readonly string[]) => void;
}

export function createShellPort(options: ShellPortOptions = {}): IShellPort {
  const explorerExe = options.explorer ?? explorerPath();

  const run = (operation: ShellOperation, targetPath: string): Promise<void> => {
    const argv = buildExplorerArgv(operation, targetPath);
    options.onInvoke?.(operation, argv);
    return new Promise<void>((resolve, reject) => {
      try {
        // explorer.exe exits non-zero even on success, so we resolve on 'spawn'
        // and never wait for close / judge the exit code.
        const child = spawn(explorerExe, argv, {
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: 'ignore',
        });
        child.once('spawn', () => resolve());
        child.once('error', (error: Error) => reject(error));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    openPath: (path: string) => run('open', path),
    showItemInFolder: (path: string) => run('reveal', path),
  };
}
