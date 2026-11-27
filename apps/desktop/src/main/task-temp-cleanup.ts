/**
 * D-291 · per-task temp-dir housekeeping (main process).
 *
 * yt-dlp parks `.part` / `.part-FragN.part` / `.ytdl` inside a PER-TASK temp
 * directory (`<work>/<taskId>`, `<configuredTempDir>/<taskId>` or
 * `<outputDir>/.ytvdlt-incomplete/<taskId>` — D-118). Those files are RESUME
 * CREDENTIALS, so nothing here runs while the task record still exists:
 *
 *   - a cancelled or failed task keeps its record and its partials (retry
 *     resumes from byte N; D-209 makes cancel terminal on purpose);
 *   - the record's own removal is the ONLY point where a retry becomes
 *     impossible, and that is where `discardTaskTempDir()` runs;
 *   - at boot an EMPTY managed directory is pure residue (no `.part` to
 *     resume), so it is removed with a non-recursive `rmdir` — the same rule
 *     the engine applies after a successful download (D-118).
 *
 * `isManagedTempDir()` existed since D-118 but had no production caller: the
 * cleanup it was written for was never wired, so `<dataDir>/work` accumulated
 * one directory per abandoned task (a cancelled private-mode task also left a
 * title-named `.part` OUTSIDE the private tree). It is the string gate below —
 * deliberately weak on its own, which is why every filesystem decision is
 * re-checked here:
 *
 *   1. the path must match the managed shape (`…/work/<id>` or
 *      `…/.ytvdlt-incomplete/<id>`);
 *   2. its last segment must be the SANITIZED id of the record being removed
 *      (we built the path from that id at intake);
 *   3. `lstat` must report a real directory — a symlink / junction is skipped;
 *   4. `realpath` must still resolve to a direct child of the same parent
 *      (catches a mid-path junction swapped in after intake);
 *   5. only then is the tree removed, recursively.
 *
 * A failure of ANY step keeps the directory and returns `kept` — cleanup is
 * cosmetic, the record removal already succeeded and must not be undone.
 */
import type { TaskRecord } from '@ytvdlt/shared';
import { isManagedTempDir, sanitizeTaskSegment } from '@ytvdlt/core';

export interface TempDirIo {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<readonly string[]>;
  rmdir(path: string): Promise<void>;
  /** Recursive remove of an app-owned tree. */
  rm(path: string): Promise<void>;
}

export type TempDirOutcome = 'discarded' | 'empty-removed' | 'kept' | 'skipped';

const SEPARATOR = /[\\/]+/;

function stripTrailing(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

/** Last path segment, separator-agnostic (no `node:path`). */
export function lastSegmentOf(path: string): string {
  const normalized = stripTrailing(path);
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** Parent directory, separator-agnostic; `''` when there is none. */
export function parentOf(path: string): string {
  const normalized = stripTrailing(path);
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (index < 0) return '';
  return index === 0 ? normalized.slice(0, 1) : normalized.slice(0, index);
}

/** Windows path comparison is case-insensitive; POSIX is not. */
function sameText(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Remove the per-task temp directory of a record that has just been REMOVED
 * from the queue. `tempDir` is the request's resolved value (may be `''`).
 */
export async function discardTaskTempDir(
  io: TempDirIo,
  tempDir: string | null | undefined,
  taskId: string,
): Promise<TempDirOutcome> {
  if (typeof tempDir !== 'string' || tempDir.trim() === '') return 'skipped';
  const dir = tempDir.trim();
  if (!isManagedTempDir(dir)) return 'skipped';
  const expected = sanitizeTaskSegment(taskId);
  if (expected === '' || !sameText(lastSegmentOf(dir), expected)) return 'skipped';
  let info: { isSymbolicLink(): boolean; isDirectory(): boolean };
  try {
    info = await io.lstat(dir);
  } catch {
    // Already gone (or unreadable) — nothing to clean, never an error.
    return 'kept';
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return 'skipped';
  const parent = parentOf(dir);
  if (parent === '' || parent === dir) return 'skipped';
  try {
    // A reparse point in a MIDDLE component would resolve somewhere else even
    // though `lstat` on the final component reports a plain directory.
    const [resolved, resolvedParent] = await Promise.all([io.realpath(dir), io.realpath(parent)]);
    if (!sameText(parentOf(resolved), resolvedParent)) return 'kept';
    if (!sameText(lastSegmentOf(resolved), expected)) return 'kept';
    await io.rm(resolved);
    return 'discarded';
  } catch {
    return 'kept';
  }
}

/**
 * Remove a managed temp directory that is provably EMPTY (boot-time sweep).
 * `rmdir` is non-recursive, so a directory holding a resumable `.part` is kept
 * by the filesystem itself — the same guarantee D-118 relies on.
 */
export async function removeEmptyTempDir(
  io: Pick<TempDirIo, 'lstat' | 'readdir' | 'rmdir'>,
  dir: string,
): Promise<boolean> {
  if (typeof dir !== 'string' || dir.trim() === '') return false;
  const target = stripTrailing(dir.trim());
  if (!isManagedTempDir(target)) return false;
  try {
    const info = await io.lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const entries = await io.readdir(target);
    if (entries.length > 0) return false;
    await io.rmdir(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot housekeeping: sweep EMPTY managed temp dirs of the restored records,
 * plus the direct children of each app-private work root (orphans from a
 * crashed or deleted run). Non-empty directories are never touched here.
 *
 * `workRoots` covers BOTH roots this app owns: `<dataDir>/work` for ordinary
 * tasks and `<private>/work` for private-mode tasks (D-291 — private records
 * are never persisted, so their directories can only be found by scanning).
 */
export async function sweepEmptyTempDirs(
  io: Pick<TempDirIo, 'lstat' | 'readdir' | 'rmdir'>,
  inputs: { readonly recordTempDirs: readonly string[]; readonly workRoots: readonly string[] },
): Promise<number> {
  const candidates = new Set<string>();
  for (const dir of inputs.recordTempDirs) {
    if (typeof dir === 'string' && dir.trim() !== '' && isManagedTempDir(dir.trim())) {
      candidates.add(stripTrailing(dir.trim()));
    }
  }
  for (const rawRoot of inputs.workRoots) {
    const root = stripTrailing(typeof rawRoot === 'string' ? rawRoot.trim() : '');
    if (root === '') continue;
    try {
      for (const entry of await io.readdir(root)) {
        if (entry === '' || SEPARATOR.test(entry)) continue;
        candidates.add(`${root}/${entry}`);
      }
    } catch {
      // No such work root yet (fresh install) — nothing to sweep.
    }
  }
  let removed = 0;
  for (const dir of candidates) {
    if (await removeEmptyTempDir(io, dir)) removed += 1;
  }
  return removed;
}

/** The request's resolved per-task temp dir, or `''` for legacy records. */
export function tempDirOf(record: Pick<TaskRecord, 'request'> | undefined): string {
  const value = record?.request?.paths?.tempDir;
  return typeof value === 'string' ? value : '';
}
