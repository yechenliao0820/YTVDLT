/**
 * Electron `shell` implementation of `IShellPort` (M3-F024 / A-4.6-02 / D-39).
 *
 * This module deliberately has NO runtime `import 'electron'`: the real
 * `shell` object is injected by `app-host.ts` (the only electron entry point).
 * That keeps the port unit-testable with a fake shell in this offline M3
 * environment, where `node_modules/electron/dist` has no binary.
 */
import type { IShellPort } from '@ytvdlt/shared';

/** Structural subset of Electron's `shell` used here (no electron typings needed). */
export interface ElectronShellLike {
  /** Resolves to '' on success, or an OS error message on failure. */
  openPath(path: string): Promise<string>;
  showItemInFolder(fullPath: string): void;
}

export class ElectronShellPort implements IShellPort {
  private readonly shell: ElectronShellLike;

  constructor(shell: ElectronShellLike) {
    this.shell = shell;
  }

  async openPath(path: string): Promise<void> {
    const error = await this.shell.openPath(path);
    if (typeof error === 'string' && error.length > 0) {
      throw new Error(`[ytvdlt] shell.openPath failed: ${error}`);
    }
  }

  async showItemInFolder(path: string): Promise<void> {
    this.shell.showItemInFolder(path);
  }
}

/** Factory used by `app-host.ts`; keeps dependency injection explicit. */
export function createElectronShellPort(shell: ElectronShellLike): IShellPort {
  return new ElectronShellPort(shell);
}
