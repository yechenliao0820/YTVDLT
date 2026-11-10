/**
 * D-120 — real filesystem adapters for the two main-process jobs that must
 * distinguish "gone" from "cannot be deleted".
 *
 * This file belongs in `apps/desktop/src/main/adapters`: it is the ONLY place
 * that touches `node:fs` for these features. Everything above it (channel
 * layer, core, renderer) receives ports and stays offline-testable.
 *
 * `shell.trashItem` is injected, not imported, so the adapter has no `electron`
 * dependency and its error classification can be unit tested with fakes.
 */
import { promises as fs } from 'node:fs';
import type { TrashFileOutcome, TrashFilesPort } from '../m5-channels.js';
import {
  createLocalFileStatusProbe, type LocalFileStatusPort, type StatOutcome,
} from '../local-file-status.js';

/** `stat` never throws: the errno is data, not a crash. */
export async function nodeStat(path: string): Promise<StatOutcome> {
  try {
    const info = await fs.stat(path);
    if (info.isDirectory()) return { kind: 'dir' };
    if (info.isFile()) return { kind: 'file' };
    return { kind: 'other' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { kind: 'error', code: typeof code === 'string' ? code : 'UNKNOWN' };
  }
}

export function createLocalFileStatusPort(): LocalFileStatusPort {
  return createLocalFileStatusProbe({ stat: nodeStat });
}

/**
 * Electron's `shell.trashItem` can reject with an OS error whose `code` is
 * absent. Only an explicit not-found errno / Windows shell code counts as
 * "already gone"; permission, sharing-violation and unknown errors stay errors.
 */
export function classifyTrashError(error: unknown): 'missing' | 'error' {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const text = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (/\bENOENT\b/.test(text) || /\bERROR_FILE_NOT_FOUND\b/.test(text)) return 'missing';
  return 'error';
}

export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? `${code}: ${text}` : text;
}

/**
 * Idempotent local-file cleanup:
 *  - exists        -> move to the Recycle Bin (`trashed`)
 *  - ENOENT        -> already cleaned (`missing`); NOT a failure
 *  - stat/trash error other than not-found -> `error` + the real reason
 *
 * No path is ever unlinked. Deletions stay inside the OS recycle bin, and the
 * caller decides whether a record may be dropped — never this adapter.
 */
export function createTrashFilesPort(
  trashItem: (path: string) => Promise<void>,
  stat: (path: string) => Promise<StatOutcome> = nodeStat,
): TrashFilesPort {
  return {
    async trash(paths: readonly string[]): Promise<readonly TrashFileOutcome[]> {
      const outcomes: TrashFileOutcome[] = [];
      for (const path of paths) {
        const probe = await stat(path);
        if (probe.kind === 'error') {
          if (probe.code === 'ENOENT' || probe.code === 'ENOTDIR') {
            outcomes.push({ path, status: 'missing' });
          } else {
            outcomes.push({ path, status: 'error', reason: `无法访问本地文件（${probe.code ?? 'UNKNOWN'}）` });
          }
          continue;
        }
        if (probe.kind !== 'file') {
          outcomes.push({ path, status: 'error', reason: '记录的产物路径不是文件' });
          continue;
        }
        try {
          await trashItem(path);
          outcomes.push({ path, status: 'trashed' });
        } catch (error) {
          const kind = classifyTrashError(error);
          outcomes.push(kind === 'missing'
            ? { path, status: 'missing' }
            : { path, status: 'error', reason: reasonOf(error) });
        }
      }
      return outcomes;
    },
  };
}
