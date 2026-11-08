/**
 * Native folder picker + "open in Explorer" for the download root (0.2.1, D-98).
 *
 * This is an adapter, not logic: the decision of WHAT to do with the picked path
 * (validate, persist, fall back to the default) lives in `m5-channels.ts`.
 *
 * Two details worth keeping:
 *   - `createDirectory` lets the user create a new folder from the dialog, which
 *     is what people actually do for "downloads/YouTube";
 *   - a picked folder is probed for writability BEFORE it is saved. Saving a
 *     read-only path is the classic way to make every later download fail with
 *     `PERMISSION_DENIED` and a confusing error code.
 */
import { dialog, shell } from 'electron';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PathKind, PathPickerPort } from '../m5-channels.js';

const TITLES: Readonly<Record<PathKind, string>> = {
  video: '选择视频下载文件夹 / Choose video folder',
  audio: '选择音频下载文件夹 / Choose audio folder',
};

export function createPathPicker(): PathPickerPort {
  return {
    async pick(kind: PathKind, startAt: string): Promise<{ path: string | null; error: string | null }> {
      const result = await dialog.showOpenDialog({
        title: TITLES[kind],
        ...(startAt === '' ? {} : { defaultPath: startAt }),
        properties: ['openDirectory', 'createDirectory'],
      });
      const dir = result.canceled ? null : (result.filePaths[0] ?? null);
      if (dir === null) return { path: null, error: null };
      try {
        await mkdir(dir, { recursive: true });
        const probe = join(dir, `.ytvdlt-write-${process.pid}.tmp`);
        await writeFile(probe, 'ok', 'utf8');
        await unlink(probe);
      } catch {
        return { path: null, error: `该文件夹不可写：${dir}` };
      }
      return { path: dir, error: null };
    },

    async open(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
      const message = await shell.openPath(path);
      if (typeof message === 'string' && message !== '') throw new Error(message);
    },
  };
}
