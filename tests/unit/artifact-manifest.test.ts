/**
 * A-M2-04 · artifact manifest parsing (`%(filepath)q` quoted, multi-line,
 * chapters, blank lines, relative-path rejection, de-duplication).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseArtifactManifest, parseArtifactManifestDetailed, stripOneQuoteLayer,
  isAbsoluteArtifactPath, artifactManifestPath, resolveArtifactManifestDir,
} from '@ytvdlt/engine-ytdlp';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

describe('A-M2-04 stripOneQuoteLayer', () => {
  it('removes exactly one layer of matching outer quotes', () => {
    expect(stripOneQuoteLayer('"C:\\a\\b.mp4"')).toBe('C:\\a\\b.mp4');
    expect(stripOneQuoteLayer("'C:\\a\\b.mp4'")).toBe('C:\\a\\b.mp4');
  });

  it('leaves mismatched / unquoted / single-char values untouched', () => {
    expect(stripOneQuoteLayer('"C:\\a.mp4\'')).toBe('"C:\\a.mp4\'');
    expect(stripOneQuoteLayer('C:\\a.mp4')).toBe('C:\\a.mp4');
    expect(stripOneQuoteLayer('"')).toBe('"');
    expect(stripOneQuoteLayer('')).toBe('');
  });

  it('strips only ONE layer (nested quotes stay)', () => {
    expect(stripOneQuoteLayer('""x""')).toBe('"x"');
  });
});

describe('A-M2-04 isAbsoluteArtifactPath', () => {
  it('accepts drive, UNC and POSIX absolute paths', () => {
    expect(isAbsoluteArtifactPath('C:\\a.mp4')).toBe(true);
    expect(isAbsoluteArtifactPath('C:/a.mp4')).toBe(true);
    expect(isAbsoluteArtifactPath('\\\\server\\share\\a.mp4')).toBe(true);
    expect(isAbsoluteArtifactPath('/mnt/a.mp4')).toBe(true);
  });

  it('rejects relative paths and bare filenames', () => {
    expect(isAbsoluteArtifactPath('relative\\a.mp4')).toBe(false);
    expect(isAbsoluteArtifactPath('./a.mp4')).toBe(false);
    expect(isAbsoluteArtifactPath('a.mp4')).toBe(false);
  });
});

describe('A-M2-04 parseArtifactManifest', () => {
  it('parses the recorded fixture: quoted + unquoted + chapters, deduped', () => {
    const text = fixture('artifacts-quoted.txt');
    const paths = parseArtifactManifest(text);
    expect(paths).toEqual([
      'C:\\Users\\x\\Downloads\\YTVDLT\\Title [id].mp4',
      'C:\\Users\\x\\Downloads\\YTVDLT\\Title [id].en.srt',
      'C:\\Users\\x\\Downloads\\YTVDLT\\Title [id].jpg',
      'C:\\Users\\x\\Downloads\\YTVDLT\\chapters\\01 Intro.mp4',
      'C:\\Users\\x\\Downloads\\YTVDLT\\chapters\\02 Main.mp4',
    ]);
  });

  it('drops the relative line and the .part line with explicit reasons', () => {
    const { dropped } = parseArtifactManifestDetailed(fixture('artifacts-quoted.txt'));
    expect(dropped).toEqual([
      { line: 'relative\\path.mp4', reason: 'not-absolute' },
      { line: 'C:\\Users\\x\\Downloads\\YTVDLT\\Title [id].mp4.part', reason: 'transient-file' },
    ]);
  });

  it('de-duplicates repeated paths (case/separator insensitive)', () => {
    const text = [
      'C:\\a\\b.mp4',
      'c:/A/B.mp4',
      'C:\\a\\b.mp4',
    ].join('\n');
    expect(parseArtifactManifest(text)).toEqual(['C:\\a\\b.mp4']);
  });

  it('handles blank lines, CRLF and a trailing newline', () => {
    expect(parseArtifactManifest('\r\n"C:\\a.mp4"\r\n\r\n')).toEqual(['C:\\a.mp4']);
  });

  it('returns [] for empty / non-string input (never throws)', () => {
    expect(parseArtifactManifest('')).toEqual([]);
    expect(parseArtifactManifest('   \n\n')).toEqual([]);
    expect(parseArtifactManifest(undefined as never)).toEqual([]);
  });

  it('rejects .ytdl / .temp and quote-only lines', () => {
    const { paths, dropped } = parseArtifactManifestDetailed(
      ['C:\\a.mp4.ytdl', 'C:\\a.mp4.temp', '""'].join('\n'),
    );
    expect(paths).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual([
      'transient-file', 'transient-file', 'empty-after-unquote',
    ]);
  });
});

describe('A-M2-04 artifactManifestPath', () => {
  it('is unique per task and rooted at tempDir', () => {
    expect(artifactManifestPath('C:/temp', 't1')).toBe('C:/temp/ytvdlt-artifacts-t1.txt');
    expect(artifactManifestPath('C:\\temp\\', 't2')).toBe('C:\\temp/ytvdlt-artifacts-t2.txt');
    expect(artifactManifestPath('C:/temp', 't1')).not.toBe(artifactManifestPath('C:/temp', 't2'));
  });
});

describe('D-68 · empty tempDir must never point at the drive root', () => {
  it('prefers an explicit tempDir and otherwise falls back to the output dir', () => {
    expect(resolveArtifactManifestDir('C:/T', 'C:/V', 'C:/A', false)).toBe('C:/T');
    expect(resolveArtifactManifestDir('', 'C:/V', 'C:/A', false)).toBe('C:/V');
    expect(resolveArtifactManifestDir('   ', 'C:/V', 'C:/A', false)).toBe('C:/V');
    expect(resolveArtifactManifestDir(null, 'C:/V', 'C:/A', true)).toBe('C:/A');
  });

  it('produces a usable path for the shipped default configuration', () => {
    expect(artifactManifestPath('', 't1')).toBe('ytvdlt-artifacts-t1.txt');
    expect(artifactManifestPath(resolveArtifactManifestDir('', 'C:/V', 'C:/A', false), 't1'))
      .toBe('C:/V/ytvdlt-artifacts-t1.txt');
  });
});
