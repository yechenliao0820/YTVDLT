/**
 * TXT import · REAL byte-level file decoding (no Electron dialog needed).
 *
 * The native dialog itself needs a GUI, but every safety decision about the
 * bytes is a pure function — extension, 1 MiB cap, strict UTF-8 — and is
 * exercised here with real Buffers. Several cases then run the decoded text
 * through the real parser to prove the whole offline pipeline.
 */
import { describe, it, expect } from 'vitest';
import { parseTxtUrlList, TXT_IMPORT_LIMITS } from '@ytvdlt/core';
import { assertHttpUrl } from '@ytvdlt/engine-ytdlp';
import { decodeTxtFile } from '../../apps/desktop/src/main/txt-import-file.js';

const V = (n: number): string => `https://www.youtube.com/watch?v=video${String(n).padStart(3, '0')}`;
const PATH = 'C:/Users/leolee/Desktop/links.txt';

const parse = (text: string) => parseTxtUrlList({ text, validateUrl: assertHttpUrl });

describe('TXT import · bounded file decoding', () => {
  it('decodes a UTF-8 BOM + CRLF file and hands the text to the real parser', () => {
    const bytes = Buffer.from(`\uFEFF${V(1)}\r\n${V(2)}\r\n`, 'utf8');
    const file = decodeTxtFile(bytes, PATH);
    expect(file).toMatchObject({ canceled: false, fileName: 'links.txt', code: '' });
    expect(file.text.charCodeAt(0)).toBe(0xfeff);
    const result = parse(file.text);
    expect(result.urls).toEqual([V(1), V(2)]);
    expect(result.totalLines).toBe(2);
  });

  it('refuses a file larger than maxFileBytes', () => {
    const bytes = Buffer.alloc(TXT_IMPORT_LIMITS.maxFileBytes + 1, 0x20);
    expect(decodeTxtFile(bytes, PATH).code).toBe('FILE_TOO_LARGE');
  });

  it('accepts a file exactly at the size cap', () => {
    const bytes = Buffer.alloc(TXT_IMPORT_LIMITS.maxFileBytes, 0x20);
    expect(decodeTxtFile(bytes, PATH).code).toBe('');
    expect(parse(decodeTxtFile(bytes, PATH).text).code).toBe('EMPTY_FILE');
  });

  it('rejects malformed UTF-8 bytes instead of silently replacing them', () => {
    const bytes = Buffer.from([0x68, 0xff, 0xfe, 0x41]);
    expect(decodeTxtFile(bytes, PATH).code).toBe('ENCODING_ERROR');
    expect(decodeTxtFile(bytes, PATH).text).toBe('');
  });

  it('refuses a non-.txt extension regardless of its content', () => {
    const bytes = Buffer.from(V(1), 'utf8');
    expect(decodeTxtFile(bytes, 'C:/Users/leolee/Desktop/virus.exe').code).toBe('NOT_TXT');
  });

  it('accepts an upper-case .TXT extension', () => {
    const file = decodeTxtFile(Buffer.from(V(1), 'utf8'), 'C:/Users/leolee/Desktop/LINKS.TXT');
    expect(file.code).toBe('');
    expect(file.fileName).toBe('LINKS.TXT');
  });

  it('an empty file decodes to an empty text and parses as EMPTY_FILE', () => {
    const file = decodeTxtFile(Buffer.alloc(0), PATH);
    expect(file.code).toBe('');
    expect(file.text).toBe('');
    expect(parse(file.text).code).toBe('EMPTY_FILE');
  });

  it('end to end: a real 30-line file reports 28 valid / 2 invalid', () => {
    const lines = Array.from({ length: 28 }, (_v, i) => V(i));
    lines.push('not-a-url', 'file:///C:/a.mp4');
    const file = decodeTxtFile(Buffer.from(lines.join('\r\n'), 'utf8'), PATH);
    const result = parse(file.text);
    expect(result.code).toBe('OK');
    expect(result.totalLines).toBe(30);
    expect(result.validCount).toBe(28);
    expect(result.invalidCount).toBe(2);
  });

  it('end to end: a real over-limit file is refused with the true count', () => {
    const lines = Array.from({ length: TXT_IMPORT_LIMITS.maxUrls + 1 }, (_v, i) => V(i));
    const file = decodeTxtFile(Buffer.from(lines.join('\n'), 'utf8'), PATH);
    const result = parse(file.text);
    expect(result.code).toBe('TOO_MANY_URLS');
    expect(result.validCount).toBe(TXT_IMPORT_LIMITS.maxUrls + 1);
    expect(result.items).toHaveLength(TXT_IMPORT_LIMITS.maxUrls + 1);
  });
});
