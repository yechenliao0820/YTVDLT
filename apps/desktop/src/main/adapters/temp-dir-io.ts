/**
 * D-291 · the real `node:fs` implementation of `TempDirIo`.
 *
 * Lives in `main/adapters` for the same reason as every other adapter: the
 * decision logic (`task-temp-cleanup.ts`) stays unit-testable with fakes, and
 * this file is the only place the cleanup touches the disk.
 *
 * `rm` is recursive on purpose — the caller has already proven the target is a
 * managed per-task temp directory whose record was removed. Node's `rm` walks
 * with `lstat`, so a symlink / junction inside the tree is unlinked, never
 * followed.
 */
import { promises as fs } from 'node:fs';
import type { TempDirIo } from '../task-temp-cleanup.js';

export function createTempDirIo(): TempDirIo {
  return {
    lstat: (path) => fs.lstat(path),
    realpath: (path) => fs.realpath(path),
    readdir: (path) => fs.readdir(path),
    rmdir: (path) => fs.rmdir(path),
    rm: (path) => fs.rm(path, { recursive: true, force: true }),
  };
}
