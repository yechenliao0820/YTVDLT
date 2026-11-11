/**
 * Bounded TXT decoding — pure, NO `electron` import (so it is unit-testable).
 *
 * The Electron adapter (`adapters/txt-file-picker.ts`) owns the native dialog,
 * `stat()` and `readFile()`; this module owns every decision about the bytes:
 * extension, size, strict UTF-8 and the returned text. Nothing here executes
 * file content or builds a command string.
 */
import { basename, extname } from 'node:path';
import { TXT_IMPORT_LIMITS } from '@ytvdlt/core';
import type { TxtImportFileResult } from './txt-import-service.js';

function failure(code: string, fileName: string): TxtImportFileResult {
  return { canceled: false, fileName, text: '', code };
}

/**
 * Decode a file the native picker already read into memory.
 *
 * `filePath` is used ONLY for the display name and the extension check; no
 * path is ever handed to the renderer as a capability, and no path from the
 * renderer can reach this function.
 */
export function decodeTxtFile(buffer: Buffer, filePath: string): TxtImportFileResult {
  const fileName = basename(filePath);
  if (extname(filePath).toLowerCase() !== '.txt') {
    return failure('NOT_TXT', fileName);
  }
  if (buffer.byteLength > TXT_IMPORT_LIMITS.maxFileBytes) {
    return failure('FILE_TOO_LARGE', fileName);
  }
  const text = buffer.toString('utf8');
  // `toString` replaces malformed sequences with U+FFFD. Re-encoding would
  // then differ from the original bytes, which is a strict UTF-8 test without
  // an extra dependency. A UTF-8 BOM survives the round trip and is stripped
  // by the pure parser (which also handles CRLF / LF / CR).
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    return failure('ENCODING_ERROR', fileName);
  }
  return { canceled: false, fileName, text, code: '' };
}
