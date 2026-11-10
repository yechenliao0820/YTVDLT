/**
 * D-120 · the real adapter's idempotent cleanup contract.
 *
 * `shell.trashItem` is injected; the assertions here are about which paths
 * are EVER handed to it. A missing or unreadable file must never reach it.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTrashError, createTrashFilesPort, reasonOf,
} from '../../apps/desktop/src/main/adapters/local-file-status-port.js';
import type { StatOutcome } from '../../apps/desktop/src/main/local-file-status.js';
import type { TrashFileOutcome, TrashFilesPort } from '../../apps/desktop/src/main/m5-channels.js';

const FILE = 'C:/Videos/clip.mp4';

function fixture(stat: Record<string, StatOutcome>, trashError?: unknown) {
  const trashed: string[] = [];
  const port = createTrashFilesPort(
    async (path) => {
      if (trashError !== undefined) throw trashError;
      trashed.push(path);
    },
    async (path) => stat[path] ?? { kind: 'error', code: 'ENOENT' },
  );
  return { port, trashed };
}

async function outcomes(port: TrashFilesPort, paths: readonly string[]): Promise<readonly TrashFileOutcome[]> {
  return (await port.trash(paths)).filter((entry): entry is TrashFileOutcome => typeof entry !== 'string');
}

describe('D-120 · classifying the OS error', () => {
  it('recognises a not-found errno, a not-found message and the Windows shell code', () => {
    expect(classifyTrashError(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe('missing');
    expect(classifyTrashError(Object.assign(new Error('gone'), { code: 'ENOTDIR' }))).toBe('missing');
    expect(classifyTrashError(new Error('ENOENT: no such file or directory'))).toBe('missing');
    expect(classifyTrashError(new Error('ERROR_FILE_NOT_FOUND'))).toBe('missing');
  });

  it('does NOT turn permission / sharing / unknown errors into "missing"', () => {
    for (const error of [
      Object.assign(new Error('denied'), { code: 'EACCES' }),
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
      Object.assign(new Error('io'), { code: 'EIO' }),
      new Error('some unexpected failure'),
    ]) {
      expect(classifyTrashError(error)).toBe('error');
    }
    expect(reasonOf(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toContain('EBUSY');
  });
});

describe('D-120 · idempotent recycle-bin adapter', () => {
  it('existing file -> one trashItem call, status trashed', async () => {
    const f = fixture({ [FILE]: { kind: 'file' } });
    expect(await outcomes(f.port, [FILE])).toEqual([{ path: FILE, status: 'trashed' }]);
    expect(f.trashed).toEqual([FILE]);
  });

  it('ENOENT -> already clean, NO deletion attempted', async () => {
    const f = fixture({ [FILE]: { kind: 'error', code: 'ENOENT' } });
    expect(await outcomes(f.port, [FILE])).toEqual([{ path: FILE, status: 'missing' }]);
    expect(f.trashed).toEqual([]);
  });

  it('EACCES / EBUSY from stat -> real error with the real reason, record kept', async () => {
    for (const code of ['EACCES', 'EBUSY']) {
      const f = fixture({ [FILE]: { kind: 'error', code } });
      const result = await outcomes(f.port, [FILE]);
      expect(result[0]?.status).toBe('error');
      expect(result[0]?.reason).toContain(code);
      expect(f.trashed).toEqual([]);
    }
  });

  it('a directory or special file recorded as an artifact is rejected', async () => {
    const f = fixture({ [FILE]: { kind: 'dir' } });
    expect((await outcomes(f.port, [FILE]))[0]?.status).toBe('error');
    expect(f.trashed).toEqual([]);
  });

  it('trashItem failing with EBUSY is an error, not a silent success', async () => {
    const f = fixture({ [FILE]: { kind: 'file' } }, Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const result = await outcomes(f.port, [FILE]);
    expect(result[0]?.status).toBe('error');
    expect(result[0]?.reason).toContain('EBUSY');
  });

  it('file disappearing between stat and trashItem is still idempotent', async () => {
    const f = fixture({ [FILE]: { kind: 'file' } }, Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await outcomes(f.port, [FILE])).toEqual([{ path: FILE, status: 'missing' }]);
  });

  it('a mixed batch reports each path separately', async () => {
    const OTHER = 'C:/Videos/clip.vtt';
    const f = fixture({
      [FILE]: { kind: 'file' },
      [OTHER]: { kind: 'error', code: 'ENOENT' },
    });
    const result = await outcomes(f.port, [FILE, OTHER]);
    expect(result.map((entry) => entry.status)).toEqual(['trashed', 'missing']);
    expect(f.trashed).toEqual([FILE]);
  });
});
