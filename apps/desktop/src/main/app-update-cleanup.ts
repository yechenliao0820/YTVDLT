import { lstat, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isNewerVersion } from '@ytvdlt/core';

interface PendingUpdate {
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly fileName: string;
  readonly sha256: string;
}

export interface UpdateCleanupFiles {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  isRegularFile(path: string): Promise<boolean>;
  /**
   * Entry names directly inside `dir` — files AND directories (plain
   * `readdir`): type checking stays with `isRegularFile`, so symlinks and
   * subdirectories can be skipped by the caller instead of trusted here.
   */
  list(dir: string): Promise<readonly string[]>;
  hash(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export function createUpdateCleanupFiles(hash: (path: string) => Promise<string>): UpdateCleanupFiles {
  return {
    read: (path) => readFile(path, 'utf8'),
    write: async (path, data) => { await writeFile(path, data, 'utf8'); },
    isRegularFile: async (path) => (await lstat(path)).isFile(),
    // Sorted so sweep reports (and the logs built from them) are deterministic
    // regardless of the filesystem's directory order.
    list: async (dir) => (await readdir(dir)).sort(),
    hash,
    remove: async (path) => { await unlink(path); },
  };
}

/**
 * D-289: the REAL installer names this project ships under.
 *
 * The old pattern was `/^YTVDLT-Setup-[…]\.exe$/i` — it matched the 0.2.x
 * asset naming (`YTVDLT-Setup-0.2.1.exe`) and silently rejected everything
 * from 0.3.x on (`YTVDLT.Setup.0.3.3.exe`): `safeFileName()` only strips
 * Windows-illegal characters, so the dots survive on disk. `validPending()`
 * therefore returned false, `rememberPendingUpdate()` returned before writing
 * the marker, and `cleanupCompletedUpdate()` never had anything to read. The
 * mechanism (and the D-286 switch on top of it) was dead in production; the
 * unit tests hid it by using a hyphenated fixture name.
 *
 * Accepts every shape that can actually reach the updates directory:
 *   YTVDLT.Setup.0.3.3.exe   (GitHub asset name, dots)
 *   YTVDLT Setup 0.3.3.exe   (local build name, spaces)
 *   YTVDLT-Setup-0.2.1.exe   (legacy asset name, hyphens)
 *   YTVDLT-Setup.exe         (safeFileName fallback)
 * The prefix is fixed and the tail excludes `/` and `\`, so a crafted
 * `fileName` can never escape `<dataDir>/updates` through `join()`.
 *
 * The tail is captured (group 1) so `sweepLegacyInstallers()` can parse the
 * `X.Y.Z` version out of the SAME whitelist — match semantics are unchanged.
 */
const INSTALLER_FILE_NAME = /^YTVDLT[ .-]Setup(?:[ .-]([A-Za-z0-9._-]+))?\.exe$/i;

function validPending(value: unknown): value is PendingUpdate {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item['fromVersion'] === 'string'
    && typeof item['targetVersion'] === 'string'
    && typeof item['fileName'] === 'string'
    && INSTALLER_FILE_NAME.test(item['fileName'])
    && typeof item['sha256'] === 'string'
    && /^[a-f0-9]{64}$/.test(item['sha256']);
}

/**
 * Write the cleanup marker. Returns `false` when nothing was recorded, so the
 * caller can log it: an invalid file name used to be a SILENT no-op, which is
 * exactly how D-289 stayed invisible for months.
 */
export async function rememberPendingUpdate(
  files: UpdateCleanupFiles, updatesDir: string, fromVersion: string,
  targetVersion: string, installerPath: string, sha256: string,
): Promise<boolean> {
  const pending = { fromVersion, targetVersion, fileName: basename(installerPath), sha256: sha256.toLowerCase() };
  // Not an upgrade (same / older target): nothing to clean up later, and that
  // is not an error.
  if (!isNewerVersion(targetVersion, fromVersion)) return false;
  if (!validPending(pending)) return false;
  await files.write(join(updatesDir, 'pending-update-cleanup.json'), JSON.stringify(pending));
  return true;
}

export async function cleanupCompletedUpdate(
  files: UpdateCleanupFiles, updatesDir: string, currentVersion: string,
  options: { readonly enabled?: boolean } = {},
): Promise<boolean> {
  // D-286: the user can keep the installed package (Settings → App update).
  // Default ON: `enabled` is only false when the config says so explicitly.
  if (options.enabled === false) return false;
  try {
    const pending: unknown = JSON.parse(await files.read(join(updatesDir, 'pending-update-cleanup.json')));
    if (!validPending(pending) || pending.targetVersion !== currentVersion
      || !isNewerVersion(currentVersion, pending.fromVersion)) return false;
    const target = join(updatesDir, pending.fileName);
    if (!(await files.isRegularFile(target)) || (await files.hash(target)).toLowerCase() !== pending.sha256) return false;
    await files.remove(target);
    await files.write(join(updatesDir, 'pending-update-cleanup.json'), '{}').catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exactly `X.Y.Z` (three numeric segments) at the START of a string, optional
 * `v`, optional suffix behind a non-word separator: `0.3.3`, `v0.3.3`,
 * `0.3.3-x64` parse; `0.3` (two segments), `0.3.3.1` (four), `0.3.3beta`
 * (glued), `abc` do not. Deliberately NOT `parseVersionSegments()` from core:
 * that one is prefix-anchored with a variable segment count, while the sweep
 * needs a strict three-segment read of a tail that may carry extra tokens.
 */
const VERSION_HEAD = /^v?(\d+)\.(\d+)\.(\d+)(?![\w.])/i;

function parseVersionTriple(raw: string): readonly [number, number, number] | null {
  const match = VERSION_HEAD.exec(String(raw ?? '').trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface LegacySweepReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Legacy sweep · startup one-shot for the PRE-marker era orphans (D-286).
 *
 * `cleanupCompletedUpdate()` can only delete the ONE installer the pending
 * marker names — but the marker mechanism never wrote anything before the
 * D-289 whitelist fix, so every user who came up through 0.3.0–0.3.3 carries
 * ~216 MiB of dead installers per version that nothing would ever clean. This
 * sweep is the counterpart for that stock. Responsibility boundary with the
 * marker cleanup, which runs alongside it on the SAME switch:
 *   - marker cleanup = precise, SHA-256-verified removal of the one installer
 *     the running version was just upgraded from (that file's version EQUALS
 *     the running version);
 *   - legacy sweep   = version-based bulk pass over historical orphans — only
 *     whitelisted names STRICTLY OLDER than the running version go, so it can
 *     never double-handle the file the marker flow owns.
 *
 * Guards, all of which must hold before a file is removed:
 *   - the name comes from `list(updatesDir)` joined onto `updatesDir` — no
 *     external path can enter;
 *   - the whitelist above matches, and its captured tail parses as `X.Y.Z`
 *     (dot/space/hyphen legacy namings all land here); unparsable → kept;
 *   - the file version is STRICTLY OLDER than the running version (equal and
 *     newer are kept — the running version's own package belongs to the
 *     marker flow, a future one to the next launch);
 *   - `isRegularFile` (symlinks/junctions/directories are kept);
 *   - the `advanced.autoCleanUpdateInstaller` switch (off → not even a read).
 *
 * Every whitelist hit lands in exactly ONE bucket, so `removed.length +
 * kept.length + failed.length` always equals the number of whitelist hits in
 * the directory. Anything the whitelist rejects — markers, `.replaced-*` /
 * `.rejected-*` / `.download` / `.part` siblings, subdirectories, foreign
 * files — is not counted and not touched. One failing `remove` is reported
 * and the sweep continues; a failed `list` or an unparsable running version
 * makes the whole sweep a no-op (fail closed).
 */
export async function sweepLegacyInstallers(
  files: UpdateCleanupFiles, updatesDir: string, currentVersion: string,
  options: { readonly enabled?: boolean } = {},
): Promise<LegacySweepReport> {
  const report: { removed: string[]; kept: string[]; failed: string[] } = { removed: [], kept: [], failed: [] };
  // D-286: same switch as the marker cleanup — off means not even a readdir.
  if (options.enabled === false) return report;
  // Fail closed: without a parsable running version the "strictly older" test
  // is meaningless, so the sweep deletes nothing at all.
  const current = parseVersionTriple(currentVersion);
  if (current === null) return report;
  let names: readonly string[];
  try {
    names = await files.list(updatesDir);
  } catch {
    // A missing/unreadable updates directory is a normal state, not an error.
    return report;
  }
  for (const name of names) {
    // `name` is a readdir entry joined onto `updatesDir` — nothing external.
    const match = INSTALLER_FILE_NAME.exec(name);
    if (match === null) continue; // markers, isolated/staged siblings, foreign files: zero touch
    try {
      // Guard failures (unparsable name version, symlink/junction/directory,
      // a stat that raced away) keep the file: only a verified-older REGULAR
      // file may go, and the comparison is `isNewerVersion(current, file)` —
      // core's segment-wise numeric rule, identical to a strict-less triple
      // compare now that both sides are validated `X.Y.Z` triples.
      const version = match[1] === undefined ? null : parseVersionTriple(match[1]);
      const older = version !== null && isNewerVersion(current.join('.'), version.join('.'));
      if (!older || !(await files.isRegularFile(join(updatesDir, name)))) {
        report.kept.push(name);
        continue;
      }
    } catch {
      report.kept.push(name);
      continue;
    }
    try {
      await files.remove(join(updatesDir, name));
      report.removed.push(name);
    } catch {
      // One locked file must not abort the sweep — keep going, report partial.
      report.failed.push(name);
    }
  }
  return report;
}
