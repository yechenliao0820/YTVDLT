/**
 * A-4.6-02 (M2 boundary) · IShellPort argv correctness + recorded invocation.
 * Only the ARGUMENTS are asserted here; actually launching the user's default
 * player requires Electron `shell` and is verified in M3 (see DECISIONS D-25).
 */
import { describe, it, expect } from 'vitest';
import { buildExplorerArgv } from '@ytvdlt/core';
import { createShellPort, explorerPath } from '../../apps/desktop/src/main/adapters/shell-port.js';

describe('A-4.6-02 buildExplorerArgv', () => {
  it('open → [path]; reveal → [/select,path] (single argument)', () => {
    expect(buildExplorerArgv('open', 'C://out//a.mp4')).toEqual(['C://out//a.mp4']);
    expect(buildExplorerArgv('reveal', 'C://out//a.mp4')).toEqual(['/select,C://out//a.mp4']);
  });

  it('keeps the path as ONE argv element (no shell quoting/joining)', () => {
    const argv = buildExplorerArgv('reveal', 'C://out dir\\a b.mp4');
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain('a b.mp4');
  });

  it('explorerPath is absolute under SystemRoot', () => {
    expect(explorerPath()).toMatch(/^[A-Za-z]:[\\/].*explorer\.exe$/i);
  });
});

describe('A-4.6-02 IShellPort · records the exact invocation', () => {
  it('openPath/showItemInFolder forward the correct operation + path', async () => {
    const calls: Array<{ operation: string; argv: readonly string[] }> = [];
    const shell = createShellPort({
      // Never launch a real window in tests.
      explorer: process.execPath,
      onInvoke: (operation, argv) => calls.push({ operation, argv }),
    });
    await shell.openPath('C://out//a.mp4');
    await shell.showItemInFolder('C://out//a.mp4');
    expect(calls).toEqual([
      { operation: 'open', argv: ['C://out//a.mp4'] },
      { operation: 'reveal', argv: ['/select,C://out//a.mp4'] },
    ]);
  });
});
