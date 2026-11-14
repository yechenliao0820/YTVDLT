/**
 * D-182 · artifact containment — the pure path gate.
 *
 * Covers: `..` traversal in every separator spelling, case games, UNC and
 * `\\?\` prefixes, the segment boundary (sibling names), the documented
 * fail-open on empty roots, and the must-NOT-reject list (copy suffix,
 * subtitles, chapters, extractor/playlist subdirs, per-task temp roots).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizedForContainment, artifactRootsOf, isPathInsideRoots, splitArtifactsByRoots,
} from '@ytvdlt/core';

const ROOTS = ['C:/Videos', 'C:/Music'];

describe('D-182 normalizedForContainment', () => {
  it('normalizes separators, case and trailing slashes', () => {
    expect(normalizedForContainment('C:\\Videos\\A.MP4')).toBe('c:/videos/a.mp4');
    expect(normalizedForContainment('c:/Videos/A.MP4/')).toBe('c:/videos/a.mp4');
    expect(normalizedForContainment('C:\\\\Videos\\\\a.mp4')).toBe('c:/videos/a.mp4');
  });

  it('unwraps the extended-length prefixes like volumeKeyOf', () => {
    expect(normalizedForContainment('\\\\?\\C:\\Videos\\a.mp4')).toBe('c:/videos/a.mp4');
    expect(normalizedForContainment('\\\\?\\UNC\\srv\\share\\a.mp4')).toBe('//srv/share/a.mp4');
    expect(normalizedForContainment('\\\\srv\\share\\a.mp4')).toBe('//srv/share/a.mp4');
  });

  it('rejects unusable input: empty, NUL, whitespace-only, non-string', () => {
    expect(normalizedForContainment('')).toBeNull();
    expect(normalizedForContainment('   ')).toBeNull();
    expect(normalizedForContainment('C:\\a\u0000b.mp4')).toBeNull();
    expect(normalizedForContainment(undefined)).toBeNull();
    expect(normalizedForContainment(42 as never)).toBeNull();
  });

  it('rejects `.` and `..` segments but keeps dotted file names', () => {
    expect(normalizedForContainment('C:/Videos/../evil.mp4')).toBeNull();
    expect(normalizedForContainment('C:/Videos/./a.mp4')).toBeNull();
    expect(normalizedForContainment('..')).toBeNull();
    // A literal file name may legally contain dots; URL decoding never happens.
    expect(normalizedForContainment('C:/Videos/..hidden.mp4')).toBe('c:/videos/..hidden.mp4');
    expect(normalizedForContainment('C:/Videos/a%2e%2eb.mp4')).toBe('c:/videos/a%2e%2eb.mp4');
  });
});

describe('D-182 artifactRootsOf', () => {
  it('collects the request output roots in stable order, dropping empties', () => {
    expect(artifactRootsOf({ videoDir: 'C:/V', audioDir: 'C:/A', tempDir: 'C:/V/.ytvdlt-incomplete/t1' }))
      .toEqual(['c:/v', 'c:/a', 'c:/v/.ytvdlt-incomplete/t1']);
  });

  it('de-duplicates identical roots (videoDir === audioDir is common)', () => {
    expect(artifactRootsOf({ videoDir: 'C:\\V', audioDir: 'c:/v/', tempDir: '' }))
      .toEqual(['c:/v']);
  });

  it('a root with a traversal segment is dropped, not propagated', () => {
    expect(artifactRootsOf({ videoDir: 'C:/V/../evil', audioDir: 'C:/A', tempDir: '' }))
      .toEqual(['c:/a']);
  });

  it('no input at all → no roots (cannot judge)', () => {
    expect(artifactRootsOf(null)).toEqual([]);
    expect(artifactRootsOf({})).toEqual([]);
  });
});

describe('D-182 isPathInsideRoots · rejection side', () => {
  it('rejects another drive / another root', () => {
    expect(isPathInsideRoots('D:/Videos/a.mp4', ROOTS)).toBe(false);
    expect(isPathInsideRoots('C:/MusicOther/a.mp4', ROOTS)).toBe(false);
  });

  it('rejects the root directory itself', () => {
    expect(isPathInsideRoots('C:/Videos', ROOTS)).toBe(false);
  });

  it('rejects `..` traversal in every spelling (backslash, mixed, UNC)', () => {
    expect(isPathInsideRoots('C:/Videos/../Windows/evil.mp4', ROOTS)).toBe(false);
    expect(isPathInsideRoots('C:\\Videos\\..\\Windows\\evil.mp4', ROOTS)).toBe(false);
    expect(isPathInsideRoots('C:/Videos/sub/..\\..\\evil.mp4', ROOTS)).toBe(false);
    expect(isPathInsideRoots('\\\\srv\\share\\..\\..\\evil.mp4', ['\\\\srv\\share'])).toBe(false);
    // Case games do not smuggle a traversal past the gate.
    expect(isPathInsideRoots('C:/VIDEOS/..\\windows/evil.mp4', ROOTS)).toBe(false);
  });

  it('the segment boundary holds: C:/VideosEvil is not inside C:/Videos', () => {
    expect(isPathInsideRoots('C:/VideosEvil/a.mp4', ROOTS)).toBe(false);
    expect(isPathInsideRoots('C:/Videos (.bak)/a.mp4', ['C:/Videos'])).toBe(false);
  });

  it('rejects unusable paths outright', () => {
    expect(isPathInsideRoots('', ROOTS)).toBe(false);
    expect(isPathInsideRoots('C:/a\u0000.mp4', ROOTS)).toBe(false);
  });
});

describe('D-182 isPathInsideRoots · acceptance side (no false positives)', () => {
  it('accepts media in the root and in extractor/playlist subdirectories', () => {
    expect(isPathInsideRoots('C:/Videos/Title [id].mp4', ROOTS)).toBe(true);
    expect(isPathInsideRoots('C:\\Videos\\YouTube\\Title [id].mp4', ROOTS)).toBe(true);
    expect(isPathInsideRoots('C:/Music/Title [id].mp3', ROOTS)).toBe(true);
  });

  it('accepts the D-101 copy suffix and same-directory subtitles', () => {
    expect(isPathInsideRoots('C:/Videos/Title [id]_(1).mp4', ROOTS)).toBe(true);
    expect(isPathInsideRoots('C:/Videos/Title [id] (2).mp4', ROOTS)).toBe(true);
    expect(isPathInsideRoots('C:/Videos/Title [id].en.srt', ROOTS)).toBe(true);
    expect(isPathInsideRoots('C:/Videos/Title [id].jpg', ROOTS)).toBe(true);
    expect(isPathInsideRoots('C:/Videos/chapters/01 Intro.mp4', ROOTS)).toBe(true);
  });

  it('accepts the per-task temp roots (work dir, user temp, cross-volume)', () => {
    const roots = artifactRootsOf({
      videoDir: 'C:/V', audioDir: 'C:/A',
      tempDir: 'C:/V/.ytvdlt-incomplete/t1',
    });
    expect(isPathInsideRoots('C:/V/.ytvdlt-incomplete/t1/f.zip', roots)).toBe(true);
    const workRoots = artifactRootsOf({ videoDir: 'C:/V', audioDir: 'C:/A', tempDir: 'C:/data/work/t1' });
    expect(isPathInsideRoots('C:/data/work/t1/f.zip', workRoots)).toBe(true);
    const userRoots = artifactRootsOf({ videoDir: 'C:/V', audioDir: 'C:/A', tempDir: 'D:/temp/t1' });
    expect(isPathInsideRoots('D:/temp/t1/f.zip', userRoots)).toBe(true);
  });

  it('accepts `\\?\\`-prefixed spellings of an inside path (case/sep games)', () => {
    expect(isPathInsideRoots('\\\\?\\C:\\VIDEOS\\a.mp4', ROOTS)).toBe(true);
    expect(isPathInsideRoots('c:/videos/SUB/A.MP4', ['c:\\videos'])).toBe(true);
  });

  it('accepts UNC artifacts against a UNC root', () => {
    const roots = ['\\\\srv\\share\\Videos'];
    expect(isPathInsideRoots('\\\\srv\\share\\Videos\\a.mp4', roots)).toBe(true);
    expect(isPathInsideRoots('\\\\?\\UNC\\srv\\share\\Videos\\a.mp4', roots)).toBe(true);
    expect(isPathInsideRoots('\\\\srv\\share2\\Videos\\a.mp4', roots)).toBe(false);
  });

  it('handles the POSIX root: absolute non-UNC paths inside, siblings not', () => {
    expect(isPathInsideRoots('/home/user/a.mp4', ['/'])).toBe(true);
    expect(isPathInsideRoots('//srv/share/a.mp4', ['/'])).toBe(false);
    expect(isPathInsideRoots('/home/user/a.mp4', ['/home'])).toBe(true);
    expect(isPathInsideRoots('/homeevil/a.mp4', ['/home'])).toBe(false);
  });

  it('empty roots fail OPEN (cannot judge) — documented rule', () => {
    expect(isPathInsideRoots('C:/anything/at/all.mp4', [])).toBe(true);
  });
});

describe('D-182 splitArtifactsByRoots', () => {
  it('splits order-preservingly and reports both halves', () => {
    const { kept, rejected } = splitArtifactsByRoots(
      [
        'C:/Videos/a.mp4',
        'C:/Windows/evil.mp4',
        'C:/Videos/b.en.srt',
        '..\\evil',
        'D:/elsewhere/c.mp4',
      ],
      ROOTS,
    );
    expect(kept).toEqual(['C:/Videos/a.mp4', 'C:/Videos/b.en.srt']);
    expect(rejected).toEqual(['C:/Windows/evil.mp4', '..\\evil', 'D:/elsewhere/c.mp4']);
  });

  it('never throws on null/empty input', () => {
    expect(splitArtifactsByRoots(null, ROOTS)).toEqual({ kept: [], rejected: [] });
    expect(splitArtifactsByRoots([], ROOTS)).toEqual({ kept: [], rejected: [] });
  });

  it('empty roots keep everything (fail open)', () => {
    expect(splitArtifactsByRoots(['C:/x/a.mp4'], [])).toEqual({ kept: ['C:/x/a.mp4'], rejected: [] });
  });
});
