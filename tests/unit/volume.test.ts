/**
 * D-118: volume detection + where partial files may live.
 *
 * The safety property under test is narrow and absolute: a temp directory may
 * only be used when the final move is a rename (same volume), or when the user
 * explicitly asked for that directory. Everything else falls back to a folder
 * inside the output dir — never to a cross-volume copy the user did not choose.
 */
import { describe, it, expect } from 'vitest';
import {
  INCOMPLETE_DIR_NAME, isManagedTempDir, resolveDownloadTempDir,
  sameVolume, sanitizeTaskSegment, volumeKeyOf,
} from '@ytvdlt/core';

describe('D-118 volumeKeyOf', () => {
  it('reduces a Windows path to its drive', () => {
    expect(volumeKeyOf('C:\\Users\\leo\\Videos')).toBe('c:');
    expect(volumeKeyOf('c:/Users/leo')).toBe('c:');
    expect(volumeKeyOf('D:\\')).toBe('d:');
    expect(volumeKeyOf('  E:\\media  ')).toBe('e:');
  });

  it('reduces a UNC path to its share, not its server', () => {
    expect(volumeKeyOf('\\\\nas\\media\\videos\\a.mp4')).toBe('\\\\nas\\media');
    // Two shares on one server are two volumes.
    expect(volumeKeyOf('\\\\nas\\other\\x')).toBe('\\\\nas\\other');
  });

  it('understands extended-length prefixes', () => {
    expect(volumeKeyOf('\\\\?\\C:\\very\\long')).toBe('c:');
    expect(volumeKeyOf('\\\\?\\UNC\\nas\\media\\x')).toBe('\\\\nas\\media');
  });

  it('treats a POSIX absolute path as one root volume', () => {
    expect(volumeKeyOf('/home/leo/videos')).toBe('/');
  });

  it('returns "" (unknown) for relative or empty input — never a guess', () => {
    expect(volumeKeyOf('')).toBe('');
    expect(volumeKeyOf('   ')).toBe('');
    expect(volumeKeyOf('videos/a.mp4')).toBe('');
    expect(volumeKeyOf('\\\\onlyserver')).toBe('');
    // Non-string input must not throw.
    expect(volumeKeyOf(undefined as unknown as string)).toBe('');
  });
});

describe('D-118 sameVolume', () => {
  it('is true only for two KNOWN identical volumes', () => {
    expect(sameVolume('C:\\a', 'c:/b')).toBe(true);
    expect(sameVolume('C:\\a', 'D:\\a')).toBe(false);
    expect(sameVolume('\\\\nas\\media\\a', '\\\\nas\\media\\b')).toBe(true);
    expect(sameVolume('\\\\nas\\media\\a', '\\\\nas\\backup\\b')).toBe(false);
  });

  it('is false when either side is unknown', () => {
    expect(sameVolume('', 'C:\\a')).toBe(false);
    expect(sameVolume('C:\\a', 'relative/dir')).toBe(false);
    expect(sameVolume('relative/a', 'relative/b')).toBe(false);
  });
});

describe('D-118 sanitizeTaskSegment', () => {
  it('keeps the generated id shape intact', () => {
    expect(sanitizeTaskSegment('single-20261109183500-1')).toBe('single-20261109183500-1');
  });

  it('neutralises anything that could escape the folder', () => {
    expect(sanitizeTaskSegment('../evil')).not.toContain('..');
    expect(sanitizeTaskSegment('a/b\\c')).toBe('a_b_c');
    expect(sanitizeTaskSegment('a:b*c?')).toBe('a_b_c_');
    expect(sanitizeTaskSegment('...')).toBe('');
    expect(sanitizeTaskSegment('')).toBe('');
  });

  it('caps the length so a hostile id cannot blow the path budget', () => {
    expect(sanitizeTaskSegment('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

const base = {
  outputDir: 'C:/Users/leo/Videos/YTVDLT',
  configuredTempDir: '',
  internalWorkDir: 'C:/Users/leo/AppData/Roaming/YTVDLT/work',
  taskId: 'single-1',
};

describe('D-118 resolveDownloadTempDir', () => {
  it('uses the app work dir when it is on the same volume as the output', () => {
    expect(resolveDownloadTempDir(base)).toBe('C:/Users/leo/AppData/Roaming/YTVDLT/work/single-1');
  });

  it('falls back INSIDE the output dir when the volumes differ', () => {
    const resolved = resolveDownloadTempDir({ ...base, outputDir: 'D:/Media/YTVDLT' });
    // Same volume by construction → the final move is always a rename.
    expect(resolved).toBe(`D:/Media/YTVDLT/${INCOMPLETE_DIR_NAME}/single-1`);
    expect(volumeKeyOf(resolved ?? '')).toBe('d:');
  });

  it('falls back inside the output dir when the work dir volume is unknown', () => {
    const resolved = resolveDownloadTempDir({
      ...base, internalWorkDir: 'relative/work', outputDir: 'C:/Videos',
    });
    expect(resolved).toBe(`C:/Videos/${INCOMPLETE_DIR_NAME}/single-1`);
  });

  it('honours an explicitly configured temp dir, but still isolates per task', () => {
    const resolved = resolveDownloadTempDir({ ...base, configuredTempDir: 'D:/scratch/' });
    // User decision wins (including its volume); the task folder is not optional.
    expect(resolved).toBe('D:/scratch/single-1');
  });

  it('never produces a path without a task segment', () => {
    expect(resolveDownloadTempDir({ ...base, taskId: '' })).toBeNull();
    expect(resolveDownloadTempDir({ ...base, taskId: '..' })).toBeNull();
  });

  it('returns null when there is no output dir (legacy argv, no -P temp:)', () => {
    expect(resolveDownloadTempDir({ ...base, outputDir: '' })).toBeNull();
    expect(resolveDownloadTempDir({ ...base, outputDir: '   ' })).toBeNull();
  });

  it('keeps spaces and CJK in the output path verbatim', () => {
    const resolved = resolveDownloadTempDir({
      ...base,
      outputDir: 'C:/Users/leo/我的 视频/YTVDLT',
      internalWorkDir: '',
    });
    expect(resolved).toBe(`C:/Users/leo/我的 视频/YTVDLT/${INCOMPLETE_DIR_NAME}/single-1`);
  });

  it('keeps a UNC output dir on its own share', () => {
    const resolved = resolveDownloadTempDir({
      ...base,
      outputDir: '\\\\nas\\media\\YTVDLT',
      internalWorkDir: 'C:\\Users\\leo\\AppData\\YTVDLT\\work',
    });
    expect(resolved).toBe(`\\\\nas\\media\\YTVDLT/${INCOMPLETE_DIR_NAME}/single-1`);
  });

  it('strips a trailing separator from the configured dir instead of doubling it', () => {
    expect(resolveDownloadTempDir({ ...base, configuredTempDir: 'D:/scratch///' }))
      .toBe('D:/scratch/single-1');
  });
});

describe('D-118 isManagedTempDir', () => {
  it('recognises the two directories this module creates', () => {
    expect(isManagedTempDir('C:/Videos/.ytvdlt-incomplete/single-1')).toBe(true);
    expect(isManagedTempDir('C:/AppData/YTVDLT/work/single-1')).toBe(true);
  });

  it('does not claim arbitrary folders', () => {
    expect(isManagedTempDir('C:/Videos')).toBe(false);
    expect(isManagedTempDir('C:/Videos/work')).toBe(false);
    expect(isManagedTempDir('C:/work/single-1/sub')).toBe(false);
    expect(isManagedTempDir('')).toBe(false);
  });
});
