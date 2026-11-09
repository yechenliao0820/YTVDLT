/**
 * B3 / F033 · full argv matrix (>=60 combination cases) + §4.4 invariants.
 *
 * Dimensions (all enumerated): quality 8 x videoCodecPref 2 x audioQuality 6
 * x convertTo 5 x path 4 combinations. `EXPECTED_DOWNLOAD_ARGV` is a HAND
 * WRITTEN LITERAL (not a reference to any implementation constant), so a
 * reordering bug cannot self-validate. `EXPECTED_MINIMAL` is re-checked too.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDownload, DOWNLOAD_ARGV_FROZEN_ORDER, DOWNLOAD_ARGV_M3_SEGMENTS,
  assertNoForbiddenOptions, segmentProgressByStage,
} from '@ytvdlt/engine-ytdlp';
import { detectPostprocessedFromArgv, AUDIO_BITRATE_FIELDS } from '@ytvdlt/core';
import type {
  DownloadRequest, FormatDomain, SubtitleDomain, PathsDomain,
  NetworkDomain, AdvancedDomain,
} from '@ytvdlt/shared';

const CTX = {
  jsRuntimePath: 'C:/runtime/node.exe',
  ffmpegDir: 'C:/runtime/ffmpeg',
  artifactManifestPath: 'C:/temp/ytvdlt-artifacts-t1.txt',
};

/** Hand-written literal of the frozen progress template (no import). */
const PROGRESS_TEMPLATE_LITERAL =
  'download:YTVDLT|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|'
  + '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|'
  + '%(progress.elapsed)s';

const format = (o: Partial<FormatDomain> = {}): FormatDomain => ({
  quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
  extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
  audioFormat: null, audioMultistreams: false, ...o,
});
const subtitle = (o: Partial<SubtitleDomain> = {}): SubtitleDomain => ({
  enabled: false, languages: 'en.*,.*-orig', autoCaptions: false,
  skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false, ...o,
});
const paths = (o: Partial<PathsDomain> = {}): PathsDomain => ({
  videoDir: 'C:/V', audioDir: 'C:/A', commandDir: 'C:/C', privateMode: false,
  subdirByExtractor: false, subdirByPlaylist: false,
  outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp', ...o,
});
const network = (o: Partial<NetworkDomain> = {}): NetworkDomain => ({
  rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
  ipv4Only: false, concurrentFragments: null, aria2cPath: null, ...o,
});
const advanced = (o: Partial<AdvancedDomain> = {}): AdvancedDomain => ({
  sponsorblockRemove: null, downloadSections: null, splitChapters: false,
  customTitle: null, debug: false, downloadArchive: null, customCommand: null, ...o,
});
const req = (o: Partial<DownloadRequest> = {}): DownloadRequest => ({
  taskId: 't1', url: 'https://example.org/v',
  format: format(), subtitle: subtitle(), paths: paths(),
  network: network(), advanced: advanced(), ...o,
});

/** The §4.4 eight invariants, asserted for EVERY combination case. */
function assertInvariants(argv: string[], url = 'https://example.org/v'): void {
  expect(argv.filter((x) => x === '--')).toHaveLength(1);
  expect(argv.indexOf('--')).toBe(argv.length - 2);
  expect(argv.at(-1)).toBe(url);
  expect(argv.slice(0, -1).some((x) => x === url)).toBe(false);
  expect(argv).not.toContain('yt-dlp.exe');
  expect(argv.some((x) => /yt-dlp\.exe$/i.test(x))).toBe(false);
  expect(argv.every((x) => typeof x === 'string')).toBe(true);
  // A-M2-25:92 — no whitespace element (sanitizeToken guarantees this).
  expect(argv.every((x) => !/\s/.test(x))).toBe(true);
  expect(() => assertNoForbiddenOptions(argv)).not.toThrow();
  for (const forbidden of [
    '--cookies-from-browser', '--geo-bypass', '--geo-bypass-country',
    '--geo-bypass-ip-block', '--no-check-certificates', '--prefer-insecure',
    '--exec', '--config-locations', 'po_token',
  ]) {
    expect(argv.some((x) => x.toLowerCase().includes(forbidden))).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Hand-written literal expectation (one rich but deterministic request).
// ---------------------------------------------------------------------------
const RICH_REQUEST: DownloadRequest = req({
  format: format({ quality: '720p', videoCodecPref: 'av01' }),
  subtitle: subtitle({ enabled: true, languages: 'zh.*,en.*', convertTo: 'srt' }),
  network: network({ rateLimit: '500K' }),
});

const EXPECTED_DOWNLOAD_ARGV: readonly string[] = [
  '--no-playlist',
  '--no-warnings',
  '--newline',
  '--socket-timeout', '5',
  '-R', '1',
  '--no-js-runtimes',
  '--js-runtimes', 'node:C:/runtime/node.exe',
  '--ffmpeg-location', 'C:/runtime/ffmpeg',
  '-S', 'res:720,vcodec:av01',
  '--write-subs', '--sub-langs', 'zh.*,en.*',
  '--convert-subs', 'srt',
  '-P', 'C:/V',
  '-o', '%(title)s.%(ext)s',
  '-r', '500K',
  '--no-mtime',
  '--progress-template', PROGRESS_TEMPLATE_LITERAL,
  '--progress-delta', '0.5',
  '--print-to-file', 'after_move:%(filepath)q', 'C:/temp/ytvdlt-artifacts-t1.txt',
  '--', 'https://example.org/v',
];

const EXPECTED_MINIMAL_M3: readonly string[] = [
  '--no-playlist', '--no-warnings', '--newline', '--socket-timeout', '5',
  '-R', '1', '--no-js-runtimes', '--js-runtimes', 'node:C:/runtime/node.exe',
  '--ffmpeg-location', 'C:/runtime/ffmpeg',
  '-P', 'C:/V', '-o', '%(title)s.%(ext)s', '--no-mtime',
  '--progress-template', PROGRESS_TEMPLATE_LITERAL,
  '--progress-delta', '0.5',
  '--print-to-file', 'after_move:%(filepath)q', 'C:/temp/ytvdlt-artifacts-t1.txt',
  '--', 'https://example.org/v',
];

describe('B3 · literal expectations (EXPECTED_DOWNLOAD_ARGV / EXPECTED_MINIMAL)', () => {
  it('matches the hand-written literal array exactly', () => {
    expect(buildDownload(RICH_REQUEST, CTX)).toEqual([...EXPECTED_DOWNLOAD_ARGV]);
  });

  it('default request triggers NO M3 segment (frozen minimal unchanged)', () => {
    expect(buildDownload(req(), CTX)).toEqual([...EXPECTED_MINIMAL_M3]);
  });

  it('is pure: identical input yields equal but distinct arrays', () => {
    const a = buildDownload(RICH_REQUEST, CTX);
    const b = buildDownload(RICH_REQUEST, CTX);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('DOWNLOAD_ARGV_FROZEN_ORDER is untouched (31 option names + separator)', () => {
    expect(DOWNLOAD_ARGV_FROZEN_ORDER).toHaveLength(31);
    expect(DOWNLOAD_ARGV_FROZEN_ORDER[0]).toBe('--no-playlist');
    expect(DOWNLOAD_ARGV_FROZEN_ORDER.at(-1)).toBe('--');
  });

  it('every documented M3 segment is conditional (never fires by default)', () => {
    expect(DOWNLOAD_ARGV_M3_SEGMENTS.length).toBeGreaterThanOrEqual(18);
    for (const segment of DOWNLOAD_ARGV_M3_SEGMENTS) {
      expect(segment.firesForDefaultRequest).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// >=60 combination cases: quality 8 x codec 2 x audio 6 x subtitle 5 x path 4
// ---------------------------------------------------------------------------
const QUALITIES: readonly FormatDomain['quality'][] = [
  'best', '2160p', '1440p', '1080p', '720p', '480p', '360p', 'lowest',
];
const VIDEO_CODECS: readonly FormatDomain['videoCodecPref'][] = ['av01', 'h264'];
const AUDIO_QUALITIES: readonly FormatDomain['audioQuality'][] = [
  'best', '192', '128', '64', '32', 'lowest',
];
const SUBTITLE_FORMATS: readonly SubtitleDomain['convertTo'][] = [
  'none', 'ass', 'srt', 'vtt', 'lrc',
];
const PATH_COMBOS: readonly (readonly [boolean, boolean])[] = [
  [false, false], [true, false], [false, true], [true, true],
];
const RESOLUTION: Readonly<Record<string, string>> = {
  '2160p': '2160', '1440p': '1440', '1080p': '1080',
  '720p': '720', '480p': '480', '360p': '360',
};
const CODEC_FIELD: Readonly<Record<string, string>> = {
  av01: 'vcodec:av01', h264: 'vcodec:h264',
};
// M4-0 / QA-D2: no mirror table — the implementation's exported map is the
// single source of truth, so a drifted `abr~` value fails the test immediately.
const ABR_FIELD: Readonly<Record<string, string | null>> = AUDIO_BITRATE_FIELDS;
const EXPECTED_DIRS: readonly string[] = [
  'C:/V', 'C:/V/%(extractor_key)s', 'C:/V/%(playlist)s',
  'C:/V/%(extractor_key)s/%(playlist)s',
];

function combinationRequest(index: number): DownloadRequest {
  const quality = QUALITIES[index % 8] as FormatDomain['quality'];
  const codec = VIDEO_CODECS[Math.floor(index / 8) % 2] as FormatDomain['videoCodecPref'];
  const audio = AUDIO_QUALITIES[index % 6] as FormatDomain['audioQuality'];
  const convertTo = SUBTITLE_FORMATS[index % 5] as SubtitleDomain['convertTo'];
  const pathCombo = PATH_COMBOS[index % 4] as readonly [boolean, boolean];
  return req({
    format: format({ quality, videoCodecPref: codec, audioQuality: audio }),
    subtitle: subtitle({ enabled: true, languages: 'zh.*,en.*', convertTo }),
    paths: paths({
      subdirByExtractor: pathCombo[0],
      subdirByPlaylist: pathCombo[1],
    }),
  });
}

describe('B3 · 64 combination cases (8 x 2 x 6 x 5 x 4, all dimensions enumerated)', () => {
  for (let index = 0; index < 64; index += 1) {
    const quality = QUALITIES[index % 8];
    const codec = VIDEO_CODECS[Math.floor(index / 8) % 2];
    const audio = AUDIO_QUALITIES[index % 6];
    const convertTo = SUBTITLE_FORMATS[index % 5];
    const pathCombo = PATH_COMBOS[index % 4];
    it(`case ${String(index).padStart(2, '0')}: q=${quality} codec=${codec} audio=${audio} sub=${convertTo} path=${pathCombo?.join('/')}`, () => {
      const request = combinationRequest(index);
      const argv = buildDownload(request, CTX);
      assertInvariants(argv);

      // -S composite string from the P0->P7 chain.
      const sortIndex = argv.indexOf('-S');
      const parts: string[] = [];
      const resolution = RESOLUTION[quality ?? ''];
      if (resolution !== undefined) parts.push(`res:${resolution}`);
      const codecField = CODEC_FIELD[codec ?? ''];
      if (codecField !== undefined) parts.push(codecField);
      const abr = ABR_FIELD[audio ?? ''] ?? null;
      if (abr !== null) parts.push(abr);
      if (parts.length === 0) {
        expect(sortIndex).toBe(-1);
      } else {
        expect(sortIndex).toBeGreaterThan(-1);
        expect(argv[sortIndex + 1]).toBe(parts.join(','));
      }
      // best/lowest with all-default other fields never carry a res constraint.
      if (quality === 'best' || quality === 'lowest') {
        expect(argv[sortIndex + 1] ?? '').not.toContain('res:');
      }

      // subtitle conversion.
      if (convertTo === 'none') expect(argv).not.toContain('--convert-subs');
      else expect(argv[argv.indexOf('--convert-subs') + 1]).toBe(convertTo);
      expect(argv.filter((x) => x === '--write-subs')).toHaveLength(1);

      // path 4 combinations.
      expect(argv[argv.indexOf('-P') + 1]).toBe(EXPECTED_DIRS[index % 4]);
      expect(argv).not.toContain('--restrict-filenames');
      expect(argv).not.toContain('--ppa');
      expect(argv.some((x) => x.startsWith('temp:'))).toBe(false);

      // purity.
      expect(buildDownload(request, CTX)).toEqual(argv);
      expect(buildDownload(request, CTX)).not.toBe(argv);
    });
  }
});

describe('B3 · R1-R5 argv-level mutual exclusion', () => {
  it('R1 positive: audioFormat=mp3 removes abr~N, keeps acodec:*', () => {
    const argv = buildDownload(req({
      format: format({ audioFormat: 'mp3', audioQuality: '128', audioCodecPref: 'opus' }),
    }), CTX);
    assertInvariants(argv);
    expect(argv[argv.indexOf('--audio-format') + 1]).toBe('mp3');
    expect(argv[argv.indexOf('-S') + 1]).toBe('acodec:opus');
    expect(argv.join(' ')).not.toContain('abr~');
  });

  it('R1 negative: no audioFormat -> abr~N present, no --audio-format', () => {
    const argv = buildDownload(req({ format: format({ audioQuality: '128' }) }), CTX);
    assertInvariants(argv);
    expect(argv[argv.indexOf('-S') + 1]).toContain('abr~128');
    expect(argv).not.toContain('--audio-format');
  });

  it('R2 positive: embed=true -> --embed-subs + --remux-video mkv + --merge-output-format mkv', () => {
    const argv = buildDownload(req({ subtitle: subtitle({ embed: true }) }), CTX);
    assertInvariants(argv);
    expect(argv).toContain('--embed-subs');
    expect(argv[argv.indexOf('--remux-video') + 1]).toBe('mkv');
    expect(argv[argv.indexOf('--merge-output-format') + 1]).toBe('mkv');
    expect(argv).toContain('--embed-chapters');
    expect(argv).toContain('--write-thumbnail');
    expect(argv[argv.indexOf('--convert-thumbnails') + 1]).toBe('jpg');
  });

  it('R2 negative: embed=false -> all three absent', () => {
    const argv = buildDownload(req(), CTX);
    for (const flag of ['--embed-subs', '--remux-video', '--merge-output-format']) {
      expect(argv).not.toContain(flag);
    }
  });

  it('R3: audio mode suppresses embed/remux/merge but keeps -x + audioDir + metadata', () => {
    const argv = buildDownload(req({
      format: format({ extractAudio: true, audioFormat: 'mp3' }),
      subtitle: subtitle({ enabled: true, embed: true }),
    }), CTX);
    assertInvariants(argv);
    expect(argv).toContain('-x');
    expect(argv[argv.indexOf('-P') + 1]).toBe('C:/A');
    expect(argv).toContain('--embed-metadata');
    expect(argv).toContain('--embed-thumbnail');
    for (const flag of ['--embed-subs', '--remux-video', '--merge-output-format']) {
      expect(argv).not.toContain(flag);
    }
    expect(argv).not.toContain('--ppa');
  });

  it('R4: audioMultistreams appears only when the DTO flag is true', () => {
    const withFlag = buildDownload(req({ format: format({ audioMultistreams: true }) }), CTX);
    const without = buildDownload(req(), CTX);
    expect(withFlag).toContain('--audio-multistreams');
    expect(without).not.toContain('--audio-multistreams');
    assertInvariants(withFlag);
  });

  it('R5①: sections + split -> only --download-sections, no --split-chapters', () => {
    const argv = buildDownload(req({
      advanced: advanced({ downloadSections: '*00:30-01:00', splitChapters: true }),
    }), CTX);
    assertInvariants(argv);
    expect(argv).toContain('--download-sections');
    expect(argv[argv.indexOf('--download-sections') + 1]).toBe('*00:30-01:00');
    expect(argv).not.toContain('--split-chapters');
    expect(argv[argv.indexOf('-o') + 1].startsWith('chapter:')).toBe(false);
  });

  it('R5②: split + embed -> split present, embed/remux/merge absent, chapter: prefix', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ embed: true }),
      advanced: advanced({ splitChapters: true }),
    }), CTX);
    assertInvariants(argv);
    expect(argv).toContain('--split-chapters');
    expect(argv[argv.indexOf('-o') + 1].startsWith('chapter:')).toBe(true);
    for (const flag of ['--embed-subs', '--remux-video', '--merge-output-format']) {
      expect(argv).not.toContain(flag);
    }
  });
});

describe('B3 · M3 conditional segments + argv iron rules', () => {
  it('M-1 ruling: --embed-subs comes BEFORE --convert-subs', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ embed: true, convertTo: 'srt' }),
    }), CTX);
    expect(argv.indexOf('--embed-subs')).toBeLessThan(argv.indexOf('--convert-subs'));
    argv.slice(0, -1).forEach((element) => expect(element).not.toContain(' '));
  });

  it('--restrict-filenames follows the config key only, never the template (D-110)', () => {
    const clean = buildDownload(req(), CTX);
    // A space in the template is sanitized to `_`, which used to switch this
    // flag on and delete every non-ASCII character from the file name.
    const spaced = buildDownload(req({
      paths: paths({ outputTemplate: '%(title).200B [%(id)s].%(ext)s' }),
    }), CTX);
    const asciiOnly = buildDownload(req({
      paths: { ...paths(), restrictFilenames: true } as PathsDomain,
    }), CTX);
    expect(clean).not.toContain('--restrict-filenames');
    expect(spaced).not.toContain('--restrict-filenames');
    expect(asciiOnly).toContain('--restrict-filenames');
    assertInvariants(spaced);
    expect(spaced[argv_indexOf(spaced, '-o') + 1]).toBe('%(title).200B_[%(id)s].%(ext)s');
  });

  it('-P temp:<dir> appears only for post-processing requests', () => {
    expect(buildDownload(req(), CTX).some((x) => x.startsWith('temp:'))).toBe(false);
    const remux = buildDownload(req({ subtitle: subtitle({ embed: true }) }), CTX);
    expect(remux).toContain('temp:C:/temp');
    assertInvariants(remux);
  });

  it('--ppa is never generated (Q-M3-05 / D-36 downgrade)', () => {
    expect(buildDownload(req({
      format: format({ extractAudio: true, audioFormat: 'mp3' }),
    }), CTX)).not.toContain('--ppa');
  });

  it('sanitizeToken keeps <newTitle> / --sub-langs / User-Agent free of whitespace', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ enabled: true, languages: 'zh .*, en.*' }),
      network: network({ userAgent: 'YTVDLT Browser 1.0' }),
      advanced: advanced({ customTitle: 'My New Title' }),
    }), CTX);
    assertInvariants(argv);
    expect(argv[argv.indexOf('--sub-langs') + 1]).toBe('zh_.*,_en.*');
    expect(argv[argv.indexOf('--add-header') + 1]).toBe('User-Agent:YTVDLT_Browser_1.0');
    expect(argv[argv.indexOf('--replace-in-metadata') + 3]).toBe('My_New_Title');
    expect(argv[argv.indexOf('--replace-in-metadata') + 1]).toBe('title');
    expect(argv[argv.indexOf('--replace-in-metadata') + 2]).toBe('.+');
  });

  it('aria2c suppresses --concurrent-fragments and selects the downloader by name', () => {
    const argv = buildDownload(req({
      network: network({ aria2cPath: 'C:/runtime/aria2c.exe', concurrentFragments: 8 }),
    }), CTX);
    assertInvariants(argv);
    expect(argv[argv.indexOf('--downloader') + 1]).toBe('aria2c');
    // D-65: the exe path must NOT be smuggled through --downloader-args — yt-dlp
    // appends that value verbatim to the aria2c command line, so a path would be
    // treated as an extra download target. The engine puts the directory on PATH.
    expect(argv).not.toContain('--downloader-args');
    expect(argv).not.toContain('C:/runtime/aria2c.exe');
    expect(argv).not.toContain('--concurrent-fragments');
  });

  it('ipv4Only / debug / archive / sponsorblock / download-sections / verbose map correctly', () => {
    const argv = buildDownload(req({
      network: network({ ipv4Only: true }),
      advanced: advanced({
        debug: true, downloadArchive: 'C:/archive.txt',
        sponsorblockRemove: 'sponsor,intro', downloadSections: '*00:00-00:30',
      }),
    }), CTX);
    assertInvariants(argv);
    expect(argv).toContain('-4');
    expect(argv).toContain('--verbose');
    expect(argv[argv.indexOf('--download-archive') + 1]).toBe('C:/archive.txt');
    expect(argv[argv.indexOf('--sponsorblock-remove') + 1]).toBe('sponsor,intro');
    expect(argv[argv.indexOf('--download-sections') + 1]).toBe('*00:00-00:30');
  });

  it('--extractor-args fires only with autoCaptions && skipTranslated', () => {
    const on = buildDownload(req({ subtitle: subtitle({ autoCaptions: true, skipTranslated: true }) }), CTX);
    const off = buildDownload(req({ subtitle: subtitle({ autoCaptions: false, skipTranslated: true }) }), CTX);
    expect(on[on.indexOf('--extractor-args') + 1]).toBe('youtube:skip=translated_subs');
    expect(off).not.toContain('--extractor-args');
    expect(on.indexOf('--extractor-args')).toBeLessThan(on.indexOf('--') );
    assertInvariants(on);
  });

  // M4-0 / QA-D1: the M3 suite covered (true,true) and (false,true) but never
  // the (true,false) branch — "auto captions WITHOUT skipping translated subs
  // must emit no --extractor-args". Without this case a regression that always
  // emitted skip=translated_subs stayed green.
  it('A-4.3-04 · autoCaptions=true without skipTranslated emits NO --extractor-args', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ enabled: true, autoCaptions: true, skipTranslated: false }),
    }), CTX);
    assertInvariants(argv);
    expect(argv).toContain('--write-auto-subs');
    expect(argv).not.toContain('--extractor-args');
    expect(argv).not.toContain('youtube:skip=translated_subs');
  });

  it('customCommand is ignored (compliance P0 / D-44)', () => {
    const argv = buildDownload(req({
      advanced: advanced({ customCommand: ['--exec', 'calc.exe', '--geo-bypass'] }),
    }), CTX);
    assertInvariants(argv);
    expect(argv).toEqual(buildDownload(req(), CTX));
  });

  it('keeps --convert-subs AFTER --embed-subs and before -P in a full request', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ enabled: true, embed: true, convertTo: 'ass', autoCaptions: true }),
    }), CTX);
    assertInvariants(argv);
    expect(argv.indexOf('--write-auto-subs')).toBeLessThan(argv.indexOf('--extractor-args'));
    expect(argv.indexOf('--extractor-args')).toBeLessThan(argv.indexOf('--embed-subs'));
    expect(argv.indexOf('--embed-subs')).toBeLessThan(argv.indexOf('--convert-subs'));
    expect(argv.indexOf('--convert-subs')).toBeLessThan(argv.indexOf('--remux-video'));
    expect(argv.indexOf('--remux-video')).toBeLessThan(argv.indexOf('-P'));
  });

  it('rejects a non-http(s) URL with INVALID_URL before any argv is built', () => {
    for (const url of ['file:///C:/a.mp4', 'C:\\a.mp4', 'not a url']) {
      try {
        buildDownload(req({ url }), CTX);
        expect.unreachable(`${url} should be rejected`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('INVALID_URL');
      }
    }
  });
});

describe('B3 · M2 legacy closure (D-18 / D-19 / C11 evidence helpers)', () => {
  it('detectPostprocessedFromArgv sees the M3 post-processing flags', () => {
    expect(detectPostprocessedFromArgv(['--embed-subs', '--remux-video', 'mkv'])).toBe(true);
    expect(detectPostprocessedFromArgv(['--split-chapters'])).toBe(true);
    expect(detectPostprocessedFromArgv(['--download-sections', '*0-1'])).toBe(true);
    expect(detectPostprocessedFromArgv(['--no-mtime'])).toBe(false);
    expect(detectPostprocessedFromArgv(null as unknown as string[])).toBe(false);
  });

  it('D-18: two 0->100 streams become two monotonic segments', () => {
    const events = [
      { stage: 'downloading' as const, percent: 0 }, { stage: 'downloading' as const, percent: 50 },
      { stage: 'downloading' as const, percent: 100 },
      { stage: 'downloading' as const, percent: 0 }, { stage: 'downloading' as const, percent: 60 },
      { stage: 'postprocess' as const, percent: 100 },
    ].map((e) => ({
      taskId: 't1', stage: e.stage, percent: e.percent,
      downloadedBytes: null, totalBytes: null, speedBps: null,
      etaSec: null, elapsedSec: null, rawLine: 'YTVDLT|',
    }));
    const segments = segmentProgressByStage(events);
    expect(segments).toHaveLength(3);
    expect(segments.every((s) => s.monotonic)).toBe(true);
    expect(segments[0]?.percents).toEqual([0, 50, 100]);
    expect(segments[1]?.percents).toEqual([0, 60]);
    expect(segments[2]?.stage).toBe('postprocess');
    expect(segmentProgressByStage([])).toEqual([]);
  });

  it('D-18: a genuinely decreasing single stream is reported non-monotonic', () => {
    const events = [10, 5, 3].map((percent) => ({
      taskId: 't1', stage: 'downloading' as const, percent,
      downloadedBytes: null, totalBytes: null, speedBps: null,
      etaSec: null, elapsedSec: null, rawLine: 'YTVDLT|',
    }));
    const segments = segmentProgressByStage(events);
    // A drop starts a NEW segment, so each segment is monotonic by construction.
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.percents)).toEqual([[10], [5], [3]]);
    expect(segments.every((s) => s.monotonic)).toBe(true);
  });
});

/** Small helper (kept local so the literal expectations stay readable). */
function argv_indexOf(argv: readonly string[], option: string): number {
  return argv.indexOf(option);
}
