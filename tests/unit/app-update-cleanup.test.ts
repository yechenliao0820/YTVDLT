import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  cleanupCompletedUpdate, rememberPendingUpdate, type UpdateCleanupFiles,
} from '../../apps/desktop/src/main/app-update-cleanup.js';

const DIR = join('C:', 'updates');
const NAME = 'YTVDLT-Setup-0.3.0.exe';
const HASH = 'a'.repeat(64);

function setup() {
  const data = new Map<string, string>();
  const removed: string[] = [];
  let regular = true;
  let hash = HASH;
  let failRemove = false;
  const files: UpdateCleanupFiles = {
    async read(path) {
      const value = data.get(path);
      if (value === undefined) throw new Error('missing');
      return value;
    },
    async write(path, value) { data.set(path, value); },
    async isRegularFile() { return regular; },
    async hash() { return hash; },
    async remove(path) {
      if (failRemove) throw new Error('locked');
      removed.push(path);
    },
  };
  return {
    files, data, removed,
    setRegular(value: boolean) { regular = value; },
    setHash(value: string) { hash = value; },
    setFailRemove(value: boolean) { failRemove = value; },
  };
}

async function remember(files: UpdateCleanupFiles) {
  await rememberPendingUpdate(files, DIR, '0.2.9', '0.3.0', join(DIR, NAME), HASH);
}

describe('completed app update cleanup', () => {
  it('removes only the recorded installer after the target version starts', async () => {
    const h = setup();
    await remember(h.files);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(true);
    expect(h.removed).toEqual([join(DIR, NAME)]);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    expect(h.removed).toHaveLength(1);
  });

  it('retains the installer when the old or a different version starts', async () => {
    const h = setup();
    await remember(h.files);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.2.9')).toBe(false);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.1')).toBe(false);
    expect(h.removed).toEqual([]);
  });

  /**
   * D-286: the switch in Settings → App update. Default ON (the parameter is
   * absent in every call above); an explicit `false` must keep the package so
   * the user can reinstall or archive it, and must NOT clear the pending
   * marker — re-enabling the switch on a later launch still cleans it up.
   */
  it('keeps the installer and the marker when the user turned cleanup off', async () => {
    const h = setup();
    await remember(h.files);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0', { enabled: false })).toBe(false);
    expect(h.removed).toEqual([]);
    // The marker is untouched, so a later launch with the switch back ON does
    // the cleanup exactly once.
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(true);
    expect(h.removed).toEqual([join(DIR, NAME)]);
  });

  it('retains replaced files and links', async () => {
    const h = setup();
    await remember(h.files);
    h.setHash('b'.repeat(64));
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    h.setHash(HASH);
    h.setRegular(false);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    expect(h.removed).toEqual([]);
  });

  it('rejects corrupt markers and path traversal', async () => {
    const h = setup();
    const marker = join(DIR, 'pending-update-cleanup.json');
    h.data.set(marker, '{');
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    h.data.set(marker, JSON.stringify({ fromVersion: '0.2.9', targetVersion: '0.3.0', fileName: '../YTVDLT-Setup-0.3.0.exe', sha256: HASH }));
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    expect(h.removed).toEqual([]);
  });

  it('ignores missing records and retains a locked installer for retry', async () => {
    const h = setup();
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    await remember(h.files);
    h.setFailRemove(true);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(false);
    h.setFailRemove(false);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.0')).toBe(true);
    expect(h.removed).toEqual([join(DIR, NAME)]);
  });

  it('does not record non-upgrades or unrelated filenames', async () => {
    const h = setup();
    await rememberPendingUpdate(h.files, DIR, '0.3.0', '0.3.0', join(DIR, NAME), HASH);
    await rememberPendingUpdate(h.files, DIR, '0.2.9', '0.3.0', join(DIR, 'video.exe'), HASH);
    expect(h.data.size).toBe(0);
  });
});
