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

function validPending(value: unknown): value is PendingUpdate {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item['fromVersion'] === 'string'
    && typeof item['targetVersion'] === 'string'
    && typeof item['fileName'] === 'string'
    && /^YTVDLT-Setup-[a-zA-Z0-9._-]+\.exe$/i.test(item['fileName'])
    && typeof item['sha256'] === 'string'
    && /^[a-f0-9]{64}$/.test(item['sha256']);
}

export async function rememberPendingUpdate(
  files: UpdateCleanupFiles, updatesDir: string, fromVersion: string,
  targetVersion: string, installerPath: string, sha256: string,
): Promise<void> {
  const pending = { fromVersion, targetVersion, fileName: basename(installerPath), sha256: sha256.toLowerCase() };
  if (!validPending(pending) || !isNewerVersion(targetVersion, fromVersion)) return;
  await files.write(join(updatesDir, 'pending-update-cleanup.json'), JSON.stringify(pending));
}

export async function cleanupCompletedUpdate(
  files: UpdateCleanupFiles, updatesDir: string, currentVersion: string,
): Promise<boolean> {
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
