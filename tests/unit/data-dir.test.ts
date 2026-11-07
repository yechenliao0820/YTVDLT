/**
 * M5-4 · portable data-directory probe (§6.2-⑧).
 *
 * The decision is made by writing a probe file, not by asking `app.getPath`,
 * so these cases pin the four ways it can go:
 *   writable exe dir → portable; unwritable → %APPDATA%; cleanup failure still
 *   portable; dev build → historical location.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNodeProbePort, resolveDataDir, type DataDirOptions, type ProbePort,
} from '../../apps/desktop/src/main/data-dir.js';

interface FakeProbe extends ProbePort {
  readonly writes: string[];
  readonly removals: string[];
}

function fakeProbe(behaviour: { failWrite?: boolean; failUnlink?: boolean } = {}): FakeProbe {
  const writes: string[] = [];
  const removals: string[] = [];
  return {
    writes,
    removals,
    async writeTextAtomic(path: string) {
      if (behaviour.failWrite === true) throw new Error('EACCES: permission denied');
      writes.push(path);
    },
    async unlink(path: string) {
      if (behaviour.failUnlink === true) throw new Error('EBUSY');
      removals.push(path);
    },
    async exists(path: string) {
      return writes.includes(path) && !removals.includes(path);
    },
  };
}

const packaged = (overrides: Partial<DataDirOptions> = {}): DataDirOptions => ({
  exeDir: 'C:/Program Files/YTVDLT',
  fallbackDir: 'C:/Users/leo/AppData/Roaming/YTVDLT',
  isPackaged: true,
  ...overrides,
});

describe('data dir · packaged decisions', () => {
  it('uses the exe directory when the write probe succeeds (portable install)', async () => {
    const probe = fakeProbe();
    const result = await resolveDataDir(packaged(), probe);
    expect(result.mode).toBe('portable');
    expect(result.writable).toBe(true);
    expect(result.dataDir).toBe('C:/Program Files/YTVDLT');
    expect(result.configDir).toBe(join('C:/Program Files/YTVDLT', 'config'));
    expect(result.logsDir).toBe(join('C:/Program Files/YTVDLT', 'logs'));
    expect(result.reason).toContain('便携');
  });

  it('leaves no probe file behind on the success path', async () => {
    const probe = fakeProbe();
    await resolveDataDir(packaged({ exeDir: 'C:/YTVDLT' }), probe);
    expect(probe.writes).toEqual([join('C:/YTVDLT', '.ytvdlt-write-probe')]);
    expect(probe.removals).toEqual(probe.writes);
  });

  it('falls back to %APPDATA% when the exe directory is read-only', async () => {
    const probe = fakeProbe({ failWrite: true });
    const result = await resolveDataDir(packaged(), probe);
    expect(result.mode).toBe('appdata');
    expect(result.writable).toBe(false);
    expect(result.dataDir).toBe('C:/Users/leo/AppData/Roaming/YTVDLT');
    expect(result.reason).toContain('EACCES');
    expect(probe.removals).toEqual([]);
  });

  it('stays portable when only the cleanup unlink fails', async () => {
    const probe = fakeProbe({ failUnlink: true });
    const result = await resolveDataDir(packaged({ exeDir: 'C:/YTVDLT' }), probe);
    expect(result.mode).toBe('portable');
    expect(result.dataDir).toBe('C:/YTVDLT');
  });

  it('honours a custom probe file name so a portable build can be identified', async () => {
    const probe = fakeProbe();
    await resolveDataDir(packaged({ exeDir: 'D:/apps', probeFileName: '.portable-check' }), probe);
    expect(probe.writes).toEqual([join('D:/apps', '.portable-check')]);
  });
});

describe('data dir · development builds', () => {
  it('keeps the historical %APPDATA% location and never probes the cwd', async () => {
    const probe = fakeProbe();
    const result = await resolveDataDir(packaged({ isPackaged: false, exeDir: 'C:/repo' }), probe);
    expect(result.mode).toBe('development');
    expect(result.dataDir).toBe('C:/Users/leo/AppData/Roaming/YTVDLT');
    expect(probe.writes).toEqual([]);
  });
});

describe('data dir · real probe adapter', () => {
  it('writes then deletes a real file in a temp directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-probe-'));
    const probe = createNodeProbePort();
    const target = join(dir, '.ytvdlt-write-probe');
    await probe.writeTextAtomic(target, 'ok');
    expect(await probe.exists(target)).toBe(true);
    await probe.unlink(target);
    expect(await probe.exists(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
