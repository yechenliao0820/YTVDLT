/**
 * B3 / F037 · IShellPort Electron contract (A-4.6-02 / A-M3-12 / D-39).
 *
 * Real Electron `shell` cannot be launched here (`node_modules/electron/dist`
 * has no binary), so the adapter is verified with an INJECTED fake shell. The
 * module itself has no runtime `import 'electron'`, which is part of the
 * contract: `app-host.ts` is the single injection point.
 */
import { describe, it, expect } from 'vitest';
import type { IShellPort } from '@ytvdlt/shared';
import {
  ElectronShellPort, createElectronShellPort, type ElectronShellLike,
} from '../../apps/desktop/src/main/adapters/electron-shell-port.js';

interface ShellCall { operation: 'open' | 'reveal'; path: string }

function fakeShell(openResult = ''): { shell: ElectronShellLike; calls: ShellCall[] } {
  const calls: ShellCall[] = [];
  return {
    calls,
    shell: {
      async openPath(path: string): Promise<string> {
        calls.push({ operation: 'open', path });
        return openResult;
      },
      showItemInFolder(path: string): void {
        calls.push({ operation: 'reveal', path });
      },
    },
  };
}

describe('B3 · ElectronShellPort implements IShellPort', () => {
  it('exposes openPath + showItemInFolder (structural contract)', () => {
    const { shell } = fakeShell();
    const port: IShellPort = createElectronShellPort(shell);
    expect(typeof port.openPath).toBe('function');
    expect(typeof port.showItemInFolder).toBe('function');
    expect(new ElectronShellPort(shell)).toBeInstanceOf(ElectronShellPort);
  });

  it('openPath forwards the exact path and resolves on an empty result', async () => {
    const { shell, calls } = fakeShell();
    const port = createElectronShellPort(shell);
    await expect(port.openPath('C:/out/Title [id].mp4')).resolves.toBeUndefined();
    expect(calls).toEqual([{ operation: 'open', path: 'C:/out/Title [id].mp4' }]);
  });

  it('showItemInFolder forwards the exact path', async () => {
    const { shell, calls } = fakeShell();
    const port = createElectronShellPort(shell);
    await expect(port.showItemInFolder('D:\\media\\clip.mkv')).resolves.toBeUndefined();
    expect(calls).toEqual([{ operation: 'reveal', path: 'D:\\media\\clip.mkv' }]);
  });

  it('openPath rejects when Electron returns an OS error message', async () => {
    const { shell } = fakeShell('The system cannot find the file specified.');
    const port = createElectronShellPort(shell);
    await expect(port.openPath('C:/missing.mp4')).rejects.toThrow(/shell.openPath failed/);
  });

  it('both operations are independent and idempotent at the port boundary', async () => {
    const { shell, calls } = fakeShell();
    const port = createElectronShellPort(shell);
    await port.openPath('C:/a.mp4');
    await port.showItemInFolder('C:/a.mp4');
    await port.openPath('C:/b.mp4');
    expect(calls.map((c) => c.operation)).toEqual(['open', 'reveal', 'open']);
    expect(calls.map((c) => c.path)).toEqual(['C:/a.mp4', 'C:/a.mp4', 'C:/b.mp4']);
  });
});
