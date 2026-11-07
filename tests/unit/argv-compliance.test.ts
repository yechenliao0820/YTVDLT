/**
 * B3 / F034 · PRD-M3 §7 forbidden options are rejected one-by-one, and no
 * option outside ALLOWED_DOWNLOAD_OPTIONS can appear in a download argv.
 */
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_DOWNLOAD_OPTIONS, M3_FORBIDDEN_OPTIONS, assertNoForbiddenOptions,
} from '@ytvdlt/engine-ytdlp';

const FORBIDDEN: readonly string[] = [
  '--cookies-from-browser',
  '--geo-bypass',
  '--geo-bypass-country',
  '--geo-bypass-ip-block',
  '--no-check-certificates',
  '--prefer-insecure',
  '--exec',
  '--config-locations',
];

describe('B3 · forbidden option list is complete', () => {
  it('declares all 8 PRD §7 options + po_token', () => {
    for (const token of FORBIDDEN) expect(M3_FORBIDDEN_OPTIONS).toContain(token);
    expect(M3_FORBIDDEN_OPTIONS).toContain('po_token');
  });

  it('ALLOWED_DOWNLOAD_OPTIONS carries every M2 frozen option and the M3 segments', () => {
    for (const option of [
      '--no-playlist', '-f', '-S', '-x', '--audio-format', '--audio-multistreams',
      '--write-subs', '--sub-langs', '--write-auto-subs', '--embed-subs', '--convert-subs',
      '-P', '-o', '-r', '--proxy', '--cookies', '--add-header', '--concurrent-fragments',
      '--no-mtime', '--download-archive', '--progress-template', '--progress-delta',
      '--print-to-file', '--',
      '--embed-metadata', '--embed-thumbnail', '--extractor-args', '--remux-video',
      '--merge-output-format', '--embed-chapters', '--write-thumbnail', '--convert-thumbnails',
      '--restrict-filenames', '-4', '--downloader', '--downloader-args',
      '--sponsorblock-remove', '--download-sections', '--split-chapters',
      '--replace-in-metadata', '--verbose', '--ppa',
    ]) expect(ALLOWED_DOWNLOAD_OPTIONS).toContain(option);
  });
});

describe('B3 · every forbidden token is rejected when injected into argv', () => {
  for (const token of FORBIDDEN) {
    it(`rejects ${token}`, () => {
      expect(() => assertNoForbiddenOptions(['--no-playlist', token, '--', 'https://example.org/v']))
        .toThrow(/forbidden option rejected/);
    });
  }

  it('rejects --opt=value forms', () => {
    expect(() => assertNoForbiddenOptions(['--cookies-from-browser=chrome']))
      .toThrow(/forbidden option rejected/);
    expect(() => assertNoForbiddenOptions(['--geo-bypass-country=US']))
      .toThrow(/forbidden option rejected/);
  });

  it('rejects PO Token injection in any spelling', () => {
    for (const value of [
      'po_token=ABC', 'youtube:player_client=web;po_token=XYZ', 'PO_TOKEN=abc',
      '--extractor-args=youtube:po_token=XYZ',
    ]) {
      expect(() => assertNoForbiddenOptions(['--no-playlist', value])).toThrow(/forbidden option rejected/);
    }
  });

  it('rejects an option-shaped element outside the whitelist', () => {
    expect(() => assertNoForbiddenOptions(['--unknown-option']))
      .toThrow(/not in ALLOWED_DOWNLOAD_OPTIONS/);
    expect(() => assertNoForbiddenOptions(['-Z']))
      .toThrow(/not in ALLOWED_DOWNLOAD_OPTIONS/);
  });

  it('rejects a non-array argv', () => {
    expect(() => assertNoForbiddenOptions(null as unknown as string[])).toThrow(/argv must be an array/);
  });
});

describe('B3 · benign values are never mistaken for options', () => {
  it('accepts a minimal compliant argv with the -- separator', () => {
    expect(() => assertNoForbiddenOptions([
      '--no-playlist', '--no-warnings', '--newline',
      '-P', 'C:/V', '-o', '%(title)s.%(ext)s',
      '--', 'https://example.org/v',
    ])).not.toThrow();
  });

  it('accepts all conditional M3 option names and their values', () => {
    expect(() => assertNoForbiddenOptions([
      '-4', '--downloader', 'aria2c', '--downloader-args', 'aria2c:C:/aria2c.exe',
      '--sponsorblock-remove', 'sponsor,intro', '--download-sections', '*00:00-00:30',
      '--split-chapters', '--replace-in-metadata', 'title', '.+', 'My_Title',
      '--verbose', '--embed-subs', '--remux-video', 'mkv',
      '--merge-output-format', 'mkv', '--embed-chapters',
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--extractor-args', 'youtube:skip=translated_subs',
      '--', 'https://example.org/v',
    ])).not.toThrow();
  });
});
