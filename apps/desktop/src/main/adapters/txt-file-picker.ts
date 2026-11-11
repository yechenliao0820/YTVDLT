/**
 * Native TXT picker + bounded read (TXT batch import).
 *
 * This is the ONLY place the feature touches the filesystem, and it lives in
 * the main process: the renderer sends no path and receives no file handle,
 * only a preview DTO. A picked file is never executed, never interpolated into
 * a command string and never passed to a shell — its lines only ever become
 * one argv element each in the existing download engine.
 *
 * Byte-level decisions live in `txt-import-file.ts` (pure, unit-tested); this
 * adapter only owns the Electron dialog, `stat()` and `readFile()`.
 */
import { dialog } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { TXT_IMPORT_LIMITS } from '@ytvdlt/core';
import type { TxtImportFilePort, TxtImportFileResult } from '../txt-import-service.js';
import { decodeTxtFile } from '../txt-import-file.js';

const TITLE = '选择 TXT 清单 / Choose a TXT list';

function failure(code: string, fileName: string): TxtImportFileResult {
  return { canceled: false, fileName, text: '', code };
}

export function createTxtFilePicker(): TxtImportFilePort {
  return {
    async pick(): Promise<TxtImportFileResult> {
      const chosen = await dialog.showOpenDialog({
        title: TITLE,
        filters: [{ name: 'TXT (*.txt)', extensions: ['txt'] }],
        properties: ['openFile'],
      });
      if (chosen.canceled || chosen.filePaths.length === 0) {
        return { canceled: true, fileName: '', text: '', code: '' };
      }
      const filePath = chosen.filePaths[0] ?? '';
      const fileName = basename(filePath);
      if (extname(filePath).toLowerCase() !== '.txt') {
        return failure('NOT_TXT', fileName);
      }
      let info;
      try {
        info = await stat(filePath);
      } catch {
        return failure('FILE_NOT_FOUND', fileName);
      }
      if (!info.isFile()) return failure('FILE_NOT_FOUND', fileName);
      if (info.size > TXT_IMPORT_LIMITS.maxFileBytes) {
        return failure('FILE_TOO_LARGE', fileName);
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(filePath);
      } catch {
        return failure('FILE_NOT_FOUND', fileName);
      }
      // `decodeTxtFile` re-checks the size AFTER the read (a file can grow
      // between stat() and readFile()) and enforces strict UTF-8.
      return decodeTxtFile(buffer, filePath);
    },
  };
}
