/**
 * TXT import · pure parser against the REAL engine URL whitelist.
 *
 * `assertHttpUrl` is the exact validator `argv-builder-download.ts` calls
 * before building argv, so these cases exercise the production contract, not
 * a test-only lookalike. No network, no filesystem, no Electron.
 */
import { describe, it, expect } from 'vitest';
import { assertHttpUrl } from '@ytvdlt/engine-ytdlp';
import {
  parseTxtUrlList, looksLikePlaylistUrl, TXT_IMPORT_LIMITS,
  type TxtImportParseResult,
} from '@ytvdlt/core';

const validateUrl = (raw: string): void => assertHttpUrl(raw);
const parse = (text: string): TxtImportParseResult => parseTxtUrlList({ text, validateUrl });

const V = (n: number): string => `https://www.youtube.com/watch?v=video${String(n).padStart(3, '0')}`;

describe('TXT import · normal import', () => {
  it('reads four URLs into four distinct entries (LF)', () => {
    const result = parse([V(1), V(2), V(3), V(4)].join('\n'));
    expect(result.code).toBe('OK');
    expect(result.urls).toEqual([V(1), V(2), V(3), V(4)]);
    expect(result.totalLines).toBe(4);
    expect(result.validCount).toBe(4);
    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => item.status === 'valid')).toBe(true);
  });

  it('ignores blank lines and leading/trailing whitespace', () => {
    const text = `  ${V(1)}  \n\n   \n\t${V(2)}\t\n  ${V(3)}  \n`;
    const result = parse(text);
    expect(result.urls).toEqual([V(1), V(2), V(3)]);
    expect(result.totalLines).toBe(5);
    expect(result.blankCount).toBe(2);
    expect(result.validCount).toBe(3);
    expect(result.invalidCount).toBe(0);
  });

  it('strips exactly one leading UTF-8 BOM', () => {
    const result = parse(`\uFEFF${V(1)}\n${V(2)}`);
    expect(result.urls[0]).toBe(V(1));
    expect(result.validCount).toBe(2);
  });

  it.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
    ['CR', '\r'],
    ['mixed', '\r\n'],
  ])('handles %s line endings', (_label, sep) => {
    const lines = [V(1), '', `  ${V(2)} `, V(3)];
    const result = parse(lines.join(sep) + sep);
    expect(result.urls).toEqual([V(1), V(2), V(3)]);
    expect(result.totalLines).toBe(4);
    expect(result.blankCount).toBe(1);
  });

  it('a trailing newline is a terminator, not an extra line', () => {
    const result = parse(`${V(1)}\n`);
    expect(result.totalLines).toBe(1);
    expect(result.blankCount).toBe(0);
  });

  it('accepts any http(s) host — site support is the engine\'s decision, not a regex', () => {
    const result = parse('https://some-unknown-site.invalid/a/b?x=1\nhttp://127.0.0.1:8080/v');
    expect(result.validCount).toBe(2);
    expect(result.urls).toHaveLength(2);
  });
});

describe('TXT import · invalid input', () => {
  it('reports an empty file and an all-blank file the same way', () => {
    expect(parse('').code).toBe('EMPTY_FILE');
    const blank = parse('\n  \n\r\n\t\n');
    expect(blank.code).toBe('EMPTY_FILE');
    expect(blank.totalLines).toBe(4);
    expect(blank.blankCount).toBe(4);
  });

  it.each([
    ['not a URL', 'hello world'],
    ['file scheme', 'file:///C:/video.mp4'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['windows path', 'C:\\Videos\\a.mp4'],
    ['embedded credentials', 'https://user:pass@example.org/v'],
    ['control character', 'https://example.org/v\u0001'],
    ['shell metacharacters', 'https://example.org/v && del /q C:\\'],
  ])('marks %s invalid without executing or shell-interpolating it', (_label, line) => {
    const result = parse(`${V(1)}\n${line}`);
    expect(result.invalidCount).toBe(1);
    expect(result.validCount).toBe(1);
    expect(result.urls).toEqual([V(1)]);
    expect(result.items[1]?.status).toBe('invalid');
  });

  it('reports no valid URL while still shipping the real counts and list', () => {
    const result = parse('nope\nalso nope\n\n');
    expect(result.code).toBe('NO_VALID_URL');
    expect(result.totalLines).toBe(3);
    expect(result.invalidCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.urls).toEqual([]);
  });

  it('rejects a line longer than the per-line cap', () => {
    const result = parse(`${V(1)}\n${'a'.repeat(TXT_IMPORT_LIMITS.maxLineLength + 1)}`);
    expect(result.invalidCount).toBe(1);
    expect(result.items[1]?.status).toBe('too-long');
    expect(result.items[1]?.text.length).toBeLessThanOrEqual(TXT_IMPORT_LIMITS.maxRenderedLength + 1);
    expect(result.validCount).toBe(1);
  });

  it('refuses a file with too many lines but reports the true line count', () => {
    const lines = Array.from({ length: TXT_IMPORT_LIMITS.maxLines + 1 }, (_, i) => V(i));
    const result = parse(lines.join('\n'));
    expect(result.code).toBe('TOO_MANY_LINES');
    expect(result.totalLines).toBe(TXT_IMPORT_LIMITS.maxLines + 1);
    expect(result.urls).toEqual([]);
  });

  it('refuses more than maxUrls while still showing the full preview', () => {
    const lines = Array.from({ length: TXT_IMPORT_LIMITS.maxUrls + 1 }, (_, i) => V(i));
    const result = parse(lines.join('\n'));
    expect(result.code).toBe('TOO_MANY_URLS');
    expect(result.validCount).toBe(TXT_IMPORT_LIMITS.maxUrls + 1);
    expect(result.items).toHaveLength(TXT_IMPORT_LIMITS.maxUrls + 1);
    expect(result.urls).toHaveLength(TXT_IMPORT_LIMITS.maxUrls + 1);
  });
});

describe('TXT import · duplicates and playlists', () => {
  it('keeps the first occurrence and counts the rest as duplicates', () => {
    const result = parse(`${V(1)}\n${V(2)}\n  ${V(1)}  \n${V(1)}\n${V(3)}`);
    expect(result.urls).toEqual([V(1), V(2), V(3)]);
    expect(result.duplicateCount).toBe(2);
    expect(result.items[2]?.status).toBe('duplicate');
    expect(result.items[3]?.status).toBe('duplicate');
  });

  it('does not merge two differently signed URLs', () => {
    const a = 'https://example.org/v?token=aaa';
    const b = 'https://example.org/v?token=bbb';
    expect(parse(`${a}\n${b}`).urls).toEqual([a, b]);
  });

  it.each([
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=abc&list=PL123',
    'https://www.youtube.com/@someone/videos',
    'https://www.youtube.com/channel/UC123/videos',
    'https://soundcloud.com/user/sets/mixtape',
  ])('flags %s as a playlist and leaves it out of the batch', (url) => {
    expect(looksLikePlaylistUrl(url)).toBe(true);
    const result = parse(`${V(1)}\n${url}`);
    expect(result.playlistCount).toBe(1);
    expect(result.validCount).toBe(1);
    expect(result.urls).toEqual([V(1)]);
    expect(result.items[1]?.status).toBe('playlist');
  });

  it('does not mistake an ordinary watch link for a playlist', () => {
    expect(looksLikePlaylistUrl(V(1))).toBe(false);
    expect(parse(V(1)).playlistCount).toBe(0);
  });
});

describe('TXT import · honest mixed counts', () => {
  it('reports 30 lines / 28 valid / 2 invalid exactly', () => {
    const lines: string[] = [];
    for (let i = 0; i < 28; i += 1) lines.push(V(i));
    lines.push('not-a-url', 'file:///C:/a.mp4');
    const result = parse(lines.join('\n'));
    expect(result.totalLines).toBe(30);
    expect(result.validCount).toBe(28);
    expect(result.invalidCount).toBe(2);
    expect(result.code).toBe('OK');
    expect(result.urls).toHaveLength(28);
  });

  it('keeps file order and 1-based line numbers across blanks and rejects', () => {
    const result = parse(`\n${V(1)}\nbroken\n\n${V(2)}`);
    expect(result.items.map((item) => item.line)).toEqual([2, 3, 5]);
    expect(result.items.map((item) => item.status)).toEqual(['valid', 'invalid', 'valid']);
  });
});
