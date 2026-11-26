import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
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
  hash(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export function createUpdateCleanupFiles(hash: (path: string) => Promise<string>): UpdateCleanupFiles {
  return {
    read: (path) => readFile(path, 'utf8'),
    write: async (path, data) => { await writeFile(path, data, 'utf8'); },
    isRegularFile: async (path) => (await lstat(path)).isFile(),
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
 */
const INSTALLER_FILE_NAME = /^YTVDLT[ .-]Setup(?:[ .-][A-Za-z0-9._-]+)?\.exe$/i;

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
