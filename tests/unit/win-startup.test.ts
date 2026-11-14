/**
 * D-166 (+ its follow-up) · the Windows autostart adapter.
 *
 * Every test runs against an injected `runReg` double, so no real registry
 * value is ever touched. What is pinned:
 *   - reg.exe is driven by argv arrays (the `shell: false` story);
 *   - `reg delete` on an already-absent value is the desired end state, other
 *     nonzero exits are failures;
 *   - `read()` reports the REAL entry state and THROWS on a query that failed,
 *     so the settings toggle can fall back to the config mirror instead of
 *     silently showing "off" for an unknown state.
 */
import { describe, it, expect } from 'vitest';
import { planAutostart } from '@ytvdlt/core';
import {
  createWinStartup, parseRegQueryValue, planToRegArgs,
} from '../../apps/desktop/src/main/adapters/win-startup.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_LINE = '    YTVDLT    REG_SZ    "C:\\Program Files\\YTVDLT\\YTVDLT.exe" --autostart';
const ABSENT_STDERR = 'ERROR: The system was unable to find the specified registry key or value.';

type RegResult = { code: number; stdout: string; stderr: string };

function winAdapter(runReg: (args: readonly string[]) => Promise<RegResult>) {
  return createWinStartup({ exePath: 'C:\\Program Files\\YTVDLT\\YTVDLT.exe', platform: 'win32', runReg });
}

describe('win-startup · reg query output parsing (pure)', () => {
  it('reads the value line of a reg query dump', () => {
    expect(parseRegQueryValue(VALUE_LINE, 'YTVDLT'))
      .toBe('"C:\\Program Files\\YTVDLT\\YTVDLT.exe" --autostart');
  });

  it('ignores other value names, the key header and empty output', () => {
    const stdout = [RUN_KEY, '    OtherApp    REG_SZ    C:\\other.exe', VALUE_LINE].join('\n');
    expect(parseRegQueryValue(stdout, 'YTVDLT')).toContain('--autostart');
    expect(parseRegQueryValue(stdout, 'Missing')).toBeNull();
    expect(parseRegQueryValue('', 'YTVDLT')).toBeNull();
  });
});

describe('win-startup · plan → reg argv (pure)', () => {
  it('builds the add argv for a set plan', () => {
    const plan = planAutostart({ enabled: true, platform: 'win32', exePath: 'C:/Program Files/YTVDLT/YTVDLT.exe' });
    expect(planToRegArgs(plan)).toEqual([
      'add', RUN_KEY, '/v', 'YTVDLT', '/t', 'REG_SZ',
      '/d', '"C:/Program Files/YTVDLT/YTVDLT.exe" --autostart', '/f',
    ]);
  });

  it('builds the delete argv for a remove plan and nothing for unsupported ones', () => {
    const plan = planAutostart({ enabled: false, platform: 'win32', exePath: 'C:/x.exe' });
    expect(planToRegArgs(plan)).toEqual(['delete', RUN_KEY, '/v', 'YTVDLT', '/f']);
    expect(planToRegArgs(planAutostart({ enabled: true, platform: 'darwin', exePath: '/x' }))).toEqual([]);
  });
});

describe('win-startup · apply()', () => {
  it('spawns reg add for the enabled state', async () => {
    const calls: string[][] = [];
    const port = winAdapter(async (args) => {
      calls.push([...args]);
      return { code: 0, stdout: '', stderr: '' };
    });
    await expect(port.apply(true)).resolves.toEqual({ ok: true });
    expect(calls[0]?.[0]).toBe('add');
    expect(calls[0]?.[1]).toBe(RUN_KEY);
  });

  it('treats deleting an already-absent value as success, other exits as failure', async () => {
    const absent = winAdapter(async () => ({ code: 1, stdout: '', stderr: ABSENT_STDERR }));
    await expect(absent.apply(false)).resolves.toEqual({ ok: true });
    const broken = winAdapter(async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' }));
    await expect(broken.apply(false)).resolves.toMatchObject({ ok: false });
  });

  it('never spawns reg on unsupported platforms', async () => {
    let calls = 0;
    const port = createWinStartup({
      exePath: '/x', platform: 'darwin',
      runReg: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    await expect(port.apply(true)).resolves.toEqual({ ok: false, reason: 'unsupported-platform' });
    expect(calls).toBe(0);
  });
});

describe('win-startup · read() shows the real entry state', () => {
  it('reads true when the value exists, false when a successful query does not list it', async () => {
    const present = winAdapter(async () => ({ code: 0, stdout: VALUE_LINE, stderr: '' }));
    await expect(present.read()).resolves.toBe(true);
    const othersOnly = winAdapter(async () => ({
      code: 0, stdout: `    OtherApp    REG_SZ    C:\\other.exe`, stderr: '',
    }));
    await expect(othersOnly.read()).resolves.toBe(false);
  });

  it('reads false when the Run key or value is confirmed absent', async () => {
    const absent = winAdapter(async () => ({ code: 1, stdout: '', stderr: ABSENT_STDERR }));
    await expect(absent.read()).resolves.toBe(false);
  });

  it('throws on a genuinely failed query instead of lying "off"', async () => {
    const broken = winAdapter(async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' }));
    await expect(broken.read()).rejects.toThrow(/reg exited 1/);
    const spawnless = winAdapter(async () => { throw new Error('spawn failed'); });
    await expect(spawnless.read()).rejects.toThrow(/spawn failed/);
  });

  it('throws on unsupported platforms so the caller can fall back', async () => {
    const port = createWinStartup({
      exePath: '/x', platform: 'darwin',
      runReg: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    await expect(port.read()).rejects.toThrow(/unsupported platform/);
  });
});
