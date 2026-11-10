/**
 * Stage 4 · the SECOND `--print-to-file` directive.
 *
 * Measured on the bundled yt-dlp 2026.10.26: `after_move:%(filepath)q` records
 * the media file only — a run that wrote two `.srt` files still produced one
 * manifest line. The subtitle list therefore needs its own directive, and it
 * must NOT appear for a request that cannot produce subtitles, otherwise the
 * frozen minimal argv stops matching.
 */
import { describe, it, expect } from 'vitest';
import { buildDownload, SUBTITLE_PRINT_TEMPLATE } from '@ytvdlt/engine-ytdlp';
import type { DownloadRequest, SubtitleDomain } from '@ytvdlt/shared';
import { readFileSync } from 'node:fs';

const CTX = {
  jsRuntimePath: 'C:/runtime/node.exe',
  ffmpegDir: 'C:/runtime/ffmpeg',
  artifactManifestPath: 'C:/temp/ytvdlt-artifacts-t1.txt',
  subtitleManifestPath: 'C:/temp/ytvdlt-subtitles-t1.txt',
};

const subtitle = (overrides: Partial<SubtitleDomain> = {}): SubtitleDomain => ({
  enabled: false, languages: 'en.*', autoCaptions: false,
  skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false, ...overrides,
});

const req = (sub: Partial<SubtitleDomain> = {}): DownloadRequest => ({
  taskId: 't1',
  url: 'https://example.org/v',
  format: {
    quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
    extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
    audioFormat: null, audioMultistreams: false,
  },
  subtitle: subtitle(sub),
  paths: {
    videoDir: 'C:/V', audioDir: 'C:/A', commandDir: 'C:/C', privateMode: false,
    subdirByExtractor: false, subdirByPlaylist: false,
    outputTemplate: '%(title)s.%(ext)s', tempDir: '',
  },
  network: {
    rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
    ipv4Only: false, concurrentFragments: null, aria2cPath: null,
  },
  advanced: {
    sponsorblockRemove: null, downloadSections: null, splitChapters: false,
    customTitle: null, debug: false, downloadArchive: null, customCommand: null,
  },
});

const printDirectives = (argv: readonly string[]): string[] =>
  argv.reduce<string[]>((acc, token, index) => {
    if (token === '--print-to-file') acc.push(argv[index + 1] ?? '');
    return acc;
  }, []);

describe('stage 4 · subtitle print directive', () => {
  it('is absent for a request that cannot produce subtitles', () => {
    const argv = buildDownload(req(), CTX);
    expect(printDirectives(argv)).toEqual(['after_move:%(filepath)q']);
    expect(argv).not.toContain(CTX.subtitleManifestPath);
  });

  it('is emitted for manual subtitles', () => {
    const argv = buildDownload(req({ enabled: true, languages: 'en,zh-Hans', convertTo: 'srt' }), CTX);
    expect(printDirectives(argv)).toEqual([
      'after_move:%(filepath)q',
      'post_process:YTVDLT_SUBTITLE_MOVES:%(__files_to_move|{})j',
      SUBTITLE_PRINT_TEMPLATE,
    ]);
    expect(argv).toContain(CTX.subtitleManifestPath);
  });

  it('is emitted for auto-captions-only requests too', () => {
    const argv = buildDownload(req({ enabled: false, autoCaptions: true, languages: 'de' }), CTX);
    expect(printDirectives(argv)).toContain(SUBTITLE_PRINT_TEMPLATE);
  });

  it('is emitted for an embed-only request', () => {
    const argv = buildDownload(req({ enabled: true, embed: true }), CTX);
    expect(printDirectives(argv)).toContain(SUBTITLE_PRINT_TEMPLATE);
  });

  it('never prints the whole requested_subtitles dict (signed URLs / subtitle text)', () => {
    // The template is part of the contract: printing `%(requested_subtitles)s`
    // would write the signed subtitle URL and, after --convert-subs, the entire
    // subtitle body into a file the app reads.
    expect(SUBTITLE_PRINT_TEMPLATE).toBe('after_move:YTVDLT_SUBTITLE_PATHS:%(requested_subtitles.:.filepath|[])j');
    expect(SUBTITLE_PRINT_TEMPLATE).not.toMatch(/requested_subtitles\)/);
    for (const argv of [
      buildDownload(req({ enabled: true }), CTX),
      buildDownload(req({ autoCaptions: true }), CTX),
    ]) {
      expect(argv.join(' ')).not.toMatch(/requested_subtitles\)/);
    }
  });

  it('stays off when the caller supplies no subtitle manifest path', () => {
    const argv = buildDownload(req({ enabled: true }), {
      jsRuntimePath: CTX.jsRuntimePath,
      ffmpegDir: CTX.ffmpegDir,
      artifactManifestPath: CTX.artifactManifestPath,
    });
    expect(printDirectives(argv)).toEqual(['after_move:%(filepath)q']);
  });

  it('keeps every token whitespace-free (argv invariant)', () => {
    for (const argv of [buildDownload(req(), CTX), buildDownload(req({ enabled: true, convertTo: 'srt' }), CTX)]) {
      expect(argv.every((token) => !/\s/.test(token))).toBe(true);
    }
  });

  it('is documented in the frozen-order table (no silent reordering)', () => {
    const source = readFileSync('packages/engine-ytdlp/src/argv-builder-download.ts', 'utf8');
    expect(source).toContain('SUBTITLE_PRINT_TEMPLATE');
    expect(source).toContain('C5′');
  });
});
