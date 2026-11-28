import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  cleanupCompletedUpdate, rememberPendingUpdate, sweepLegacyInstallers, type UpdateCleanupFiles,
} from '../../apps/desktop/src/main/app-update-cleanup.js';

const DIR = join('C:', 'updates');
const NAME = 'YTVDLT-Setup-0.3.0.exe';
const HASH = 'a'.repeat(64);

function setup() {
  const data = new Map<string, string>();
  const removed: string[] = [];
  const listing = new Map<string, readonly string[]>();
  const notRegular = new Set<string>();
  const failRemoveFor = new Set<string>();
  let regular = true;
  let hash = HASH;
  let failRemove = false;
  let failList = false;
  let listCalls = 0;
  const files: UpdateCleanupFiles = {
    async read(path) {
      const value = data.get(path);
      if (value === undefined) throw new Error('missing');
      return value;
    },
    async write(path, value) { data.set(path, value); },
    async isRegularFile(path) { return regular && !notRegular.has(path); },
    async list(dir) {
      listCalls += 1;
      if (failList) throw new Error('io');
      const names = listing.get(dir);
      if (names === undefined) throw new Error('missing dir');
      return [...names];
    },
    async hash() { return hash; },
    async remove(path) {
      if (failRemove || failRemoveFor.has(path)) throw new Error('locked');
      removed.push(path);
    },
  };
  return {
    files, data, removed, listing, notRegular, failRemoveFor,
    setRegular(value: boolean) { regular = value; },
    setHash(value: string) { hash = value; },
    setFailRemove(value: boolean) { failRemove = value; },
    setFailList(value: boolean) { failList = value; },
    listCalls: () => listCalls,
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

/**
 * D-286 follow-up · the legacy sweep. The pending-marker flow can only delete
 * the ONE installer it names — and the marker mechanism never wrote anything
 * before the D-289 whitelist fix (0.3.0–0.3.3 were a total blank window), so
 * those users still carry ~216 MiB of dead installers per version in
 * `<updatesDir>` that nothing would ever clean. The sweep removes whitelisted
 * installers STRICTLY OLDER than the running version at startup.
 */
describe('legacy installer sweep', () => {
  const CURRENT = '0.4.0';

  function listing(names: readonly string[]) {
    const h = setup();
    h.listing.set(DIR, names);
    return h;
  }

  it('removes dot/space/hyphen legacy names for versions older than the running one', async () => {
    const h = listing(['YTVDLT.Setup.0.3.0.exe', 'YTVDLT Setup 0.3.2.exe', 'YTVDLT-Setup-0.3.3.exe']);
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report.removed).toEqual(['YTVDLT.Setup.0.3.0.exe', 'YTVDLT Setup 0.3.2.exe', 'YTVDLT-Setup-0.3.3.exe']);
    expect(report.kept).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(h.removed).toEqual([
      join(DIR, 'YTVDLT.Setup.0.3.0.exe'),
      join(DIR, 'YTVDLT Setup 0.3.2.exe'),
      join(DIR, 'YTVDLT-Setup-0.3.3.exe'),
    ]);
  });

  it('keeps installers at or newer than the running version', async () => {
    const h = listing(['YTVDLT.Setup.0.4.0.exe', 'YTVDLT.Setup.0.5.0.exe', 'YTVDLT-Setup-9.9.9.exe']);
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual(['YTVDLT.Setup.0.4.0.exe', 'YTVDLT.Setup.0.5.0.exe', 'YTVDLT-Setup-9.9.9.exe']);
    expect(h.removed).toEqual([]);
  });

  it('no-ops entirely (not even a readdir) when the running version is unparsable', async () => {
    const h = listing(['YTVDLT.Setup.0.3.0.exe']);
    for (const bad of ['abc', '0.4', '']) {
      const report = await sweepLegacyInstallers(h.files, DIR, bad);
      expect(report).toEqual({ removed: [], kept: [], failed: [] });
    }
    expect(h.listCalls()).toBe(0);
    expect(h.removed).toEqual([]);
  });

  it('keeps whitelist hits whose tail carries no parsable X.Y.Z instead of guessing', async () => {
    // All three DO match the whitelist (the tail is optional and free-form):
    // 'foo' is no version at all, '0.3' only two segments, and the bare
    // `YTVDLT-Setup.exe` has no tail — each is counted as kept, never removed.
    const h = listing(['YTVDLT.Setup.foo.exe', 'YTVDLT.Setup.0.3.exe', 'YTVDLT-Setup.exe']);
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.kept).toEqual(['YTVDLT.Setup.foo.exe', 'YTVDLT.Setup.0.3.exe', 'YTVDLT-Setup.exe']);
    expect(h.removed).toEqual([]);
  });

  it('never touches markers, isolated copies, staged downloads or foreign entries', async () => {
    const h = listing([
      'pending-update-cleanup.json',
      'YTVDLT.Setup.0.3.0.exe.replaced-1730000000000',
      'YTVDLT.Setup.0.3.0.exe.rejected-1730000000000',
      'YTVDLT.Setup.0.4.0.exe.ab12cd34.download',
      'YTVDLT.Setup.0.4.0.exe.part',
      'notes.txt',
      'old-installers',
    ]);
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report).toEqual({ removed: [], kept: [], failed: [] });
    expect(h.removed).toEqual([]);
  });

  it('partitions every whitelisted hit exactly once', async () => {
    const h = listing([
      'YTVDLT.Setup.0.3.0.exe',
      'YTVDLT Setup 0.3.2.exe',
      'YTVDLT.Setup.0.4.0.exe',
      'YTVDLT.Setup.0.3.exe',
      'pending-update-cleanup.json',
      'YTVDLT.Setup.0.3.0.exe.rejected-1',
    ]);
    h.failRemoveFor.add(join(DIR, 'YTVDLT Setup 0.3.2.exe'));
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report.removed).toEqual(['YTVDLT.Setup.0.3.0.exe']);
    expect(report.failed).toEqual(['YTVDLT Setup 0.3.2.exe']);
    expect(report.kept).toEqual(['YTVDLT.Setup.0.4.0.exe', 'YTVDLT.Setup.0.3.exe']);
    // 4 whitelist hits = 1 removed + 1 failed + 2 kept; the marker and the
    // .rejected- sibling are not whitelisted and stay uncounted.
    expect(report.removed.length + report.kept.length + report.failed.length).toBe(4);
  });

  it('keeps sweeping when one installer is locked and reports it', async () => {
    const h = listing(['YTVDLT.Setup.0.3.0.exe', 'YTVDLT Setup 0.3.2.exe', 'YTVDLT-Setup-0.3.3.exe']);
    h.failRemoveFor.add(join(DIR, 'YTVDLT Setup 0.3.2.exe'));
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report.removed).toEqual(['YTVDLT.Setup.0.3.0.exe', 'YTVDLT-Setup-0.3.3.exe']);
    expect(report.failed).toEqual(['YTVDLT Setup 0.3.2.exe']);
    expect(h.removed).toEqual([join(DIR, 'YTVDLT.Setup.0.3.0.exe'), join(DIR, 'YTVDLT-Setup-0.3.3.exe')]);
  });

  it('keeps directories and symlinks even when name and version both match', async () => {
    const h = listing(['YTVDLT.Setup.0.3.0.exe']);
    // lstat says "not a regular file" — a directory, symlink or junction.
    h.notRegular.add(join(DIR, 'YTVDLT.Setup.0.3.0.exe'));
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual(['YTVDLT.Setup.0.3.0.exe']);
    expect(h.removed).toEqual([]);
  });

  it('does nothing when the D-286 switch is off (not even a readdir)', async () => {
    const h = listing(['YTVDLT.Setup.0.3.0.exe']);
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT, { enabled: false });
    expect(report).toEqual({ removed: [], kept: [], failed: [] });
    expect(h.listCalls()).toBe(0);
    expect(h.removed).toEqual([]);
  });

  it('survives an unreadable updates directory without throwing', async () => {
    const h = setup();
    h.setFailList(true);
    const report = await sweepLegacyInstallers(h.files, DIR, CURRENT);
    expect(report).toEqual({ removed: [], kept: [], failed: [] });
    expect(h.removed).toEqual([]);
  });
});
