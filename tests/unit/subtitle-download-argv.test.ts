/**
 * Stage 3 · subtitle flags in the download argv.
 *
 * Every case goes through the REAL chain: `DownloadRequest` →
 * `resolveDownloadPlan()` → `buildDownload()`. No test here builds an argv by
 * hand, because the point is that one decision source produces both the plan and
 * the flags.
 *
 * The audit case (R1) is case 10/3: an automatic-captions-only request must
 * still carry `--sub-langs`. Before the fix it emitted `--write-auto-subs`
 * alone, i.e. "download every automatic track this site offers".
 */
import { describe, it, expect } from 'vitest';
import type { DownloadRequest, SubtitleDomain } from '@ytvdlt/shared';
import { resolveDownloadPlan } from '@ytvdlt/core';
import { buildDownload, type DownloadContext } from '@ytvdlt/engine-ytdlp';

const CTX: DownloadContext = {
  jsRuntimePath: 'C:/runtime/node.exe',
  ffmpegDir: 'C:/runtime',
  artifactManifestPath: 'C:/work/task/manifest.txt',
};

const SUBTITLE_BASE: SubtitleDomain = {
  enabled: false,
  languages: 'en.*,.*-orig',
  autoCaptions: false,
  skipTranslated: true,
  convertTo: 'none',
  embed: false,
  keepSubtitleFile: false,
};

function request(subtitle: Partial<SubtitleDomain> = {}, overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    taskId: 'sub-1',
    url: 'https://example.org/watch?v=abc',
    format: {
      quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
      extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
      audioFormat: null, audioMultistreams: false,
    },
    subtitle: { ...SUBTITLE_BASE, ...subtitle },
    paths: {
      videoDir: 'C:/V', audioDir: 'C:/V/Audio', commandDir: 'C:/V/Cmd',
      privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
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
    ...overrides,
  };
}

const argvOf = (subtitle: Partial<SubtitleDomain> = {}, overrides: Partial<DownloadRequest> = {}): string[] =>
  buildDownload(request(subtitle, overrides), CTX);

const valueOf = (argv: readonly string[], flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
};

describe('subtitle argv · 1. no subtitle request keeps the old argv', () => {
  it('emits no subtitle flag at all', () => {
    const argv = argvOf();
    expect(argv).not.toContain('--write-subs');
    expect(argv).not.toContain('--sub-langs');
    expect(argv).not.toContain('--write-auto-subs');
    expect(argv).not.toContain('--embed-subs');
    expect(argv).not.toContain('--convert-subs');
    // Sanity: the rest of the frozen prefix is still there.
    expect(argv.slice(0, 2)).toEqual(['--no-playlist', '--no-warnings']);
  });

  it('an explicit "enabled:false, autoCaptions:false" is byte-identical to the default', () => {
    const base = argvOf();
    const explicit = argvOf({ enabled: false, autoCaptions: false, languages: 'en.*' });
    expect(explicit).toEqual(base);
    expect(resolveDownloadPlan(request()).subLangsRequested).toBe(false);
  });
});

describe('subtitle argv · 2. manual subtitles only', () => {
  it('writes manual subs with the language filter and nothing auto', () => {
    const argv = argvOf({ enabled: true, languages: 'en' });
    expect(argv).toContain('--write-subs');
    expect(valueOf(argv, '--sub-langs')).toBe('en');
    expect(argv).not.toContain('--write-auto-subs');
    expect(argv).not.toContain('--embed-subs');
  });
});

describe('subtitle argv · 3./10. automatic captions only', () => {
  it('still emits --sub-langs (R1 fix)', () => {
    const plan = resolveDownloadPlan(request({ enabled: false, autoCaptions: true, languages: 'en' }));
    expect(plan.writeSubs).toBe(false);
    expect(plan.autoCaptions).toBe(true);
    expect(plan.subLangsRequested).toBe(true);

    const argv = argvOf({ enabled: false, autoCaptions: true, languages: 'en' });
    expect(argv).toContain('--write-auto-subs');
    expect(valueOf(argv, '--sub-langs')).toBe('en');
    expect(argv).not.toContain('--write-subs');
  });

  it('keeps the frozen order: --sub-langs before --write-auto-subs', () => {
    const argv = argvOf({ autoCaptions: true, languages: 'de' });
    expect(argv.indexOf('--sub-langs')).toBeLessThan(argv.indexOf('--write-auto-subs'));
  });

  it('omits the filter when the expression is empty (yt-dlp "all" fallback)', () => {
    const argv = argvOf({ autoCaptions: true, languages: '' });
    expect(argv).toContain('--write-auto-subs');
    expect(argv).not.toContain('--sub-langs');
  });
});

describe('subtitle argv · 4. manual and automatic together', () => {
  it('emits both switches and ONE shared filter', () => {
    const argv = argvOf({ enabled: true, autoCaptions: true, languages: 'en,de' });
    expect(argv).toContain('--write-subs');
    expect(argv).toContain('--write-auto-subs');
    expect(argv[argv.indexOf('--sub-langs') + 1]).toBe('en,de');
    // Exactly one --sub-langs, never one per bucket.
    expect(argv.filter((token) => token === '--sub-langs')).toHaveLength(1);
  });
});

describe('subtitle argv · 5./6. single and multiple languages', () => {
  it.each([
    ['en', 'en'],
    ['zh-Hans', 'zh-Hans'],
    ['en,zh-Hans', 'en,zh-Hans'],
    ['en.*,.*-orig', 'en.*,.*-orig'],
  ])('forwards the expression %s verbatim', (languages, expected) => {
    const argv = argvOf({ enabled: true, languages });
    expect(valueOf(argv, '--sub-langs')).toBe(expected);
  });
});

describe('subtitle argv · 7. format conversion', () => {
  it.each(['srt', 'vtt', 'ass', 'lrc'] as const)('emits --convert-subs %s', (convertTo) => {
    const argv = argvOf({ enabled: true, languages: 'en', convertTo });
    expect(valueOf(argv, '--convert-subs')).toBe(convertTo);
  });

  it('emits no --convert-subs for "none"', () => {
    expect(argvOf({ enabled: true, languages: 'en', convertTo: 'none' })).not.toContain('--convert-subs');
  });
});

describe('subtitle argv · 8. external subtitles (default)', () => {
  it('writes files, never embeds, never remuxes', () => {
    const argv = argvOf({ enabled: true, languages: 'en', convertTo: 'srt' });
    expect(argv).toContain('--write-subs');
    expect(argv).not.toContain('--embed-subs');
    expect(argv).not.toContain('--remux-video');
    expect(argv).not.toContain('--merge-output-format');
  });
});

describe('subtitle argv · 9. embedded soft subtitles', () => {
  it('embeds AND declares the MKV remux (R2)', () => {
    const argv = argvOf({ enabled: true, languages: 'en', embed: true });
    expect(argv).toContain('--embed-subs');
    expect(valueOf(argv, '--remux-video')).toBe('mkv');
    expect(valueOf(argv, '--merge-output-format')).toBe('mkv');
    // Frozen order: --embed-subs → --convert-subs → --remux-video.
    expect(argv.indexOf('--embed-subs')).toBeLessThan(argv.indexOf('--remux-video'));
  });

  it('orders --convert-subs between embed and remux', () => {
    const argv = argvOf({ enabled: true, languages: 'en', embed: true, convertTo: 'srt' });
    expect(argv.indexOf('--embed-subs')).toBeLessThan(argv.indexOf('--convert-subs'));
    expect(argv.indexOf('--convert-subs')).toBeLessThan(argv.indexOf('--remux-video'));
  });

  it('embeds without --write-subs only when the caller keeps the file', () => {
    // `embed` + no manual selection is impossible through the picker (the merge
    // rejects it), but the resolver must still be self-consistent: it only
    // turns writing on when the file is meant to survive.
    const keep = resolveDownloadPlan(request({ enabled: false, embed: true, keepSubtitleFile: true, languages: 'en' }));
    expect(keep.embedSubs).toBe(true);
    expect(keep.writeSubs).toBe(true);

    const drop = resolveDownloadPlan(request({ enabled: false, embed: true, keepSubtitleFile: false, languages: 'en' }));
    expect(drop.embedSubs).toBe(true);
    expect(drop.writeSubs).toBe(false);
    // Even then the language filter is emitted, because embedding needs it.
    expect(drop.subLangsRequested).toBe(true);
  });
});

describe('subtitle argv · 11. audio extraction', () => {
  it('never embeds, never remuxes, but can still write external subtitles', () => {
    const overrides: Partial<DownloadRequest> = {
      format: {
        quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
        extractAudio: true, audioQuality: 'best', audioCodecPref: 'auto',
        audioFormat: 'mp3', audioMultistreams: false,
      },
    };
    const plan = resolveDownloadPlan(request({ enabled: true, languages: 'en', embed: true }, overrides));
    expect(plan.extractAudio).toBe(true);
    expect(plan.embedSubs).toBe(false);
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.writeSubs).toBe(true);
    expect(plan.warnings.map((w) => w.code)).toContain('P1_AUDIO_MODE_SUPPRESSES_EMBED');

    const argv = argvOf({ enabled: true, languages: 'en', embed: true }, overrides);
    expect(argv).toContain('-x');
    expect(argv).not.toContain('--embed-subs');
    expect(argv).not.toContain('--remux-video');
    expect(argv).toContain('--write-subs');
  });
});

describe('subtitle argv · 12. chapter splitting', () => {
  it('suppresses embedding and the remux (R5②) while keeping external subs', () => {
    const overrides: Partial<DownloadRequest> = {
      advanced: {
        sponsorblockRemove: null, downloadSections: null, splitChapters: true,
        customTitle: null, debug: false, downloadArchive: null, customCommand: null,
      },
    };
    const plan = resolveDownloadPlan(request({ enabled: true, languages: 'en', embed: true }, overrides));
    expect(plan.splitChapters).toBe(true);
    expect(plan.embedSubs).toBe(false);
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.warnings.map((w) => w.code)).toContain('R5_SPLIT_SUPPRESSES_EMBED');

    const argv = argvOf({ enabled: true, languages: 'en', embed: true }, overrides);
    expect(argv).toContain('--split-chapters');
    expect(argv).not.toContain('--embed-subs');
    expect(argv).not.toContain('--remux-video');
  });

  it('suppresses embedding for a section download too (R5①)', () => {
    const overrides: Partial<DownloadRequest> = {
      advanced: {
        sponsorblockRemove: null, downloadSections: '*10:00-20:00', splitChapters: false,
        customTitle: null, debug: false, downloadArchive: null, customCommand: null,
      },
    };
    const plan = resolveDownloadPlan(request({ enabled: true, languages: 'en', embed: true }, overrides));
    expect(plan.embedSubs).toBe(false);
    expect(plan.downloadSections).toBe('*10:00-20:00');
  });
});

describe('subtitle argv · 13. regression for the pre-0.3 behaviour', () => {
  it('a manual request with the shipped default expression is unchanged', () => {
    // Exactly what the M3 dialog produced before stage 3: enabled + `en.*` glob.
    const argv = argvOf({ enabled: true, languages: 'en.*,.*-orig' });
    expect(argv).toContain('--write-subs');
    expect(valueOf(argv, '--sub-langs')).toBe('en.*,.*-orig');
    expect(argv).not.toContain('--write-auto-subs');
    expect(argv).not.toContain('--embed-subs');
  });

  it('every token stays whitespace-free (argv safety invariant)', () => {
    for (const argv of [
      argvOf({ enabled: true, languages: 'en,zh-Hans', convertTo: 'srt' }),
      argvOf({ enabled: true, autoCaptions: true, languages: 'en', embed: true }),
      argvOf({ autoCaptions: true, languages: 'de' }),
    ]) {
      expect(argv.every((token) => !/\s/.test(token))).toBe(true);
    }
  });
});
