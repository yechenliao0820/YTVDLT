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

/**
 * D-289 · the marker had been frozen on the 0.2.x asset naming
 * (`YTVDLT-Setup-0.2.1.exe`). Everything shipped since 0.3.0 is
 * `YTVDLT.Setup.X.Y.Z.exe` (GitHub normalises spaces to dots) and
 * `safeFileName()` does NOT rewrite dots — so `validPending()` rejected the
 * real name, `rememberPendingUpdate()` returned before writing, and the whole
 * cleanup (including the D-286 switch) never ran in production. The old test
 * used a hyphenated fixture, which is exactly why it stayed green.
 */
describe('D-289 · the cleanup marker accepts the installer names we actually ship', () => {
  const REAL = 'YTVDLT.Setup.0.3.3.exe';

  it('records and cleans up the GitHub dot-name asset', async () => {
    const h = setup();
    expect(await rememberPendingUpdate(h.files, DIR, '0.3.2', '0.3.3', join(DIR, REAL), HASH)).toBe(true);
    expect(h.data.has(join(DIR, 'pending-update-cleanup.json'))).toBe(true);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.3')).toBe(true);
    expect(h.removed).toEqual([join(DIR, REAL)]);
  });

  it('accepts the space-form local build name too', async () => {
    const h = setup();
    const local = 'YTVDLT Setup 0.3.3.exe';
    expect(await rememberPendingUpdate(h.files, DIR, '0.3.2', '0.3.3', join(DIR, local), HASH)).toBe(true);
    expect(await cleanupCompletedUpdate(h.files, DIR, '0.3.3')).toBe(true);
    expect(h.removed).toEqual([join(DIR, local)]);
  });

  it('refuses names that are not ours and writes no marker', async () => {
    const h = setup();
    for (const bad of ['setup.exe', 'YTVDLT.Setup.0.3.3.exe.bak', '..\\evil.exe', 'YTVDLTXSetup0.3.3.exe']) {
      expect(await rememberPendingUpdate(h.files, DIR, '0.3.2', '0.3.3', join(DIR, bad), HASH)).toBe(false);
    }
    expect(h.data.has(join(DIR, 'pending-update-cleanup.json'))).toBe(false);
  });

  it('does not record a non-upgrade', async () => {
    const h = setup();
    expect(await rememberPendingUpdate(h.files, DIR, '0.3.3', '0.3.3', join(DIR, REAL), HASH)).toBe(false);
  });
});
