/**
 * A-M2-25 · download argv is frozen element-by-element.
 * The expectation is a HAND-WRITTEN literal, not a reference to the
 * implementation constant, so a reordering bug cannot self-validate.
 */
import { describe, it, expect } from 'vitest';
import { buildDownload, YTVDLT_PROGRESS_TEMPLATE } from '@ytvdlt/engine-ytdlp';
import type { DownloadRequest, AdvancedDomain, FormatDomain, NetworkDomain, PathsDomain, SubtitleDomain } from '@ytvdlt/shared';

const CTX = {
  jsRuntimePath: 'C:/runtime/node.exe',
  ffmpegDir: 'C:/runtime/ffmpeg',
  artifactManifestPath: 'C:/temp/ytvdlt-artifacts-t1.txt',
};

const format = (overrides: Partial<FormatDomain> = {}): FormatDomain => ({
  quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
  extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
  audioFormat: null, audioMultistreams: false, ...overrides,
});
const subtitle = (overrides: Partial<SubtitleDomain> = {}): SubtitleDomain => ({
  enabled: false, languages: 'en.*,.*-orig', autoCaptions: false,
  skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false, ...overrides,
});
const paths = (overrides: Partial<PathsDomain> = {}): PathsDomain => ({
  videoDir: 'C:/V', audioDir: 'C:/A', commandDir: 'C:/C', privateMode: false,
  subdirByExtractor: false, subdirByPlaylist: false,
  outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp', ...overrides,
});
const network = (overrides: Partial<NetworkDomain> = {}): NetworkDomain => ({
  rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
  ipv4Only: false, concurrentFragments: null, aria2cPath: null, ...overrides,
});
const advanced = (overrides: Partial<AdvancedDomain> = {}): AdvancedDomain => ({
  sponsorblockRemove: null, downloadSections: null, splitChapters: false,
  customTitle: null, debug: false, downloadArchive: null, customCommand: null, ...overrides,
});

const req = (overrides: Partial<DownloadRequest> = {}): DownloadRequest => ({
  taskId: 't1',
  url: 'https://example.org/v',
  format: format(),
  subtitle: subtitle(),
  paths: paths(),
  network: network(),
  advanced: advanced(),
  ...overrides,
});

/** Hand-written expectation for the minimal request. */
const EXPECTED_MINIMAL: readonly string[] = [
  '--no-playlist',
  '--no-warnings',
  '--newline',
  '--socket-timeout', '5',
  '-R', '1',
  '--no-js-runtimes',
  '--js-runtimes', 'node:C:/runtime/node.exe',
  '--ffmpeg-location', 'C:/runtime/ffmpeg',
  '-P', 'C:/V',
  '-o', '%(title)s.%(ext)s',
  '--no-mtime',
  '--progress-template', YTVDLT_PROGRESS_TEMPLATE,
  '--progress-delta', '0.5',
  '--print-to-file', 'after_move:%(filepath)q', 'C:/temp/ytvdlt-artifacts-t1.txt',
  '--',
  'https://example.org/v',
];

describe('A-M2-25 buildDownload · frozen order', () => {
  it('matches the hand-written literal array exactly', () => {
    expect(buildDownload(req(), CTX)).toEqual([...EXPECTED_MINIMAL]);
  });

  it('is pure: identical input yields an equal but distinct array', () => {
    const a = buildDownload(req(), CTX);
    const b = buildDownload(req(), CTX);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('has exactly one `--` and the URL is the last element', () => {
    const argv = buildDownload(req(), CTX);
    expect(argv.filter((x) => x === '--')).toHaveLength(1);
    expect(argv.at(-1)).toBe('https://example.org/v');
    expect(argv.indexOf('--')).toBe(argv.length - 2);
  });

  it('never contains the engine path and never joins tokens into a shell string', () => {
    const argv = buildDownload(req(), CTX);
    expect(argv).not.toContain('yt-dlp.exe');
    expect(argv.every((element) => !/\s/.test(element))).toBe(true);
    expect(argv.every((element) => typeof element === 'string')).toBe(true);
  });

  it('keeps the whole argv URL-free except the final token', () => {
    const argv = buildDownload(req(), CTX);
    expect(argv.slice(0, -1).some((element) => element === 'https://example.org/v')).toBe(false);
  });
});

describe('A-M2-25 buildDownload · optional segments', () => {
  it('maps formatId, sortingFields (winning over quality), audio flags', () => {
    const argv = buildDownload(req({
      format: format({
        formatId: '137+251', sortingFields: 'res:720,ext:mp4', quality: '1080p',
        extractAudio: true, audioFormat: 'mp3', audioMultistreams: true,
      }),
      // audio mode writes into audioDir
    }), CTX);
    expect(argv).toContain('-f');
    expect(argv[argv.indexOf('-f') + 1]).toBe('137+251');
    expect(argv).toContain('-S');
    expect(argv[argv.indexOf('-S') + 1]).toBe('res:720,ext:mp4');
    expect(argv).not.toContain('res:1080');
    expect(argv).toContain('-x');
    expect(argv[argv.indexOf('--audio-format') + 1]).toBe('mp3');
    expect(argv).toContain('--audio-multistreams');
    expect(argv[argv.indexOf('-P') + 1]).toBe('C:/A');
  });

  it('maps a quality preset to `-S res:<N>` when no sorting fields are set', () => {
    const argv = buildDownload(req({ format: format({ quality: '720p' }) }), CTX);
    expect(argv[argv.indexOf('-S') + 1]).toBe('res:720');
    for (const [quality, res] of [['2160p', '2160'], ['1440p', '1440'], ['480p', '480'], ['360p', '360']]) {
      const mapped = buildDownload(req({ format: format({ quality: quality as never }) }), CTX);
      expect(mapped[mapped.indexOf('-S') + 1]).toBe(`res:${res}`);
    }
    // best/lowest carry no explicit resolution constraint.
    expect(buildDownload(req({ format: format({ quality: 'best' }) }), CTX)).not.toContain('-S');
    expect(buildDownload(req({ format: format({ quality: 'lowest' }) }), CTX)).not.toContain('-S');
  });

  it('maps the subtitle subset', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ enabled: true, languages: 'zh.*,en.*', autoCaptions: true, embed: true, convertTo: 'srt' }),
    }), CTX);
    expect(argv).toContain('--write-subs');
    expect(argv[argv.indexOf('--sub-langs') + 1]).toBe('zh.*,en.*');
    expect(argv).toContain('--write-auto-subs');
    expect(argv).toContain('--embed-subs');
    expect(argv[argv.indexOf('--convert-subs') + 1]).toBe('srt');
  });

  it('maps the network subset (rate/proxy/cookies/UA/fragments)', () => {
    const argv = buildDownload(req({
      network: network({
        rateLimit: '500K', proxy: 'http://127.0.0.1:8888',
        cookiesFile: 'C:/cookies.txt', userAgent: 'YTVDLT/1.0', concurrentFragments: 8,
      }),
    }), CTX);
    expect(argv[argv.indexOf('-r') + 1]).toBe('500K');
    expect(argv[argv.indexOf('--proxy') + 1]).toBe('http://127.0.0.1:8888');
    expect(argv[argv.indexOf('--cookies') + 1]).toBe('C:/cookies.txt');
    expect(argv[argv.indexOf('--add-header') + 1]).toBe('User-Agent:YTVDLT/1.0');
    expect(argv[argv.indexOf('--concurrent-fragments') + 1]).toBe('8');
    expect(argv).not.toContain('--cookies-from-browser');
  });

  it('maps --download-archive when set and omits it otherwise', () => {
    const withArchive = buildDownload(req({ advanced: advanced({ downloadArchive: 'C:/archive.txt' }) }), CTX);
    expect(withArchive[withArchive.indexOf('--download-archive') + 1]).toBe('C:/archive.txt');
    expect(buildDownload(req(), CTX)).not.toContain('--download-archive');
  });

  it('always carries progress template + delta + print-to-file', () => {
    const argv = buildDownload(req(), CTX);
    expect(argv[argv.indexOf('--progress-template') + 1]).toBe(YTVDLT_PROGRESS_TEMPLATE);
    expect(argv[argv.indexOf('--progress-delta') + 1]).toBe('0.5');
    expect(argv[argv.indexOf('--print-to-file') + 1]).toBe('after_move:%(filepath)q');
    expect(argv[argv.indexOf('--print-to-file') + 2]).toBe(CTX.artifactManifestPath);
  });

  it('rejects a non-http(s) URL with INVALID_URL', () => {
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

// M3 append-only (F064): the 9 frozen assertions and EXPECTED_MINIMAL above
// are deliberately left byte-for-byte unchanged.
describe('M3 buildDownload · conditional segments do not disturb the frozen minimal', () => {
  it('default request still equals the hand-written minimal literal', () => {
    expect(buildDownload(req(), CTX)).toEqual([...EXPECTED_MINIMAL]);
  });

  it('best / lowest still produce NO -S with all other fields at defaults', () => {
    expect(buildDownload(req({ format: format({ quality: 'best' }) }), CTX)).not.toContain('-S');
    expect(buildDownload(req({ format: format({ quality: 'lowest' }) }), CTX)).not.toContain('-S');
  });

  it('M3 embed adds remux+merge mkv AFTER --convert-subs, never before --embed-subs', () => {
    const argv = buildDownload(req({
      subtitle: subtitle({ enabled: true, embed: true, convertTo: 'srt' }),
    }), CTX);
    expect(argv).toContain('--embed-subs');
    expect(argv).toContain('--remux-video');
    expect(argv).toContain('--merge-output-format');
    expect(argv.indexOf('--embed-subs')).toBeLessThan(argv.indexOf('--convert-subs'));
    expect(argv.indexOf('--convert-subs')).toBeLessThan(argv.indexOf('--remux-video'));
    expect(argv.filter((x) => x === '--')).toHaveLength(1);
    expect(argv.indexOf('--')).toBe(argv.length - 2);
    expect(argv.at(-1)).toBe('https://example.org/v');
    expect(argv.every((x) => !/\s/.test(x))).toBe(true);
  });

  it('--ppa / --restrict-filenames / -P temp: are absent by default (M-2 / D-36)', () => {
    const argv = buildDownload(req(), CTX);
    expect(argv).not.toContain('--ppa');
    expect(argv).not.toContain('--restrict-filenames');
    expect(argv.some((x) => x.startsWith('temp:'))).toBe(false);
  });

});

describe('D-83 · --audio-quality (transcode bitrate)', () => {
  it('emits --audio-quality right after --audio-format when transcode is on', () => {
    const argv = buildDownload(req({
      format: format({ extractAudio: true, audioFormat: 'mp3', audioQuality: '192' }),
    }), CTX);
    const index = argv.indexOf('--audio-quality');
    expect(index).toBeGreaterThan(0);
    expect(argv[index + 1]).toBe('192K');
    expect(argv.indexOf('--audio-format')).toBeLessThan(index);
    // R1 still removes the source-selection knob.
    expect(argv.join(' ')).not.toContain('abr~');
  });

  it('never emits --audio-quality without --audio-format', () => {
    const argv = buildDownload(req({ format: format({ extractAudio: true, audioQuality: '192' }) }), CTX);
    expect(argv).not.toContain('--audio-quality');
    expect(argv[argv.indexOf('-S') + 1]).toContain('abr~192');
  });
});
