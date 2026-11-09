/**
 * B1 / A-M3-10 · R1-R5 positive + negative examples, P0->P7 enumerable chain,
 * mergeToMkv derivation, customCommand rejection, path resolution.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDownloadPlan, PRIVATE_OUTPUT_DIR,
} from '@ytvdlt/core';
import type {
  DownloadRequest, FormatDomain, SubtitleDomain, PathsDomain,
  NetworkDomain, AdvancedDomain, PlanWarningCode,
} from '@ytvdlt/shared';

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
  // D-118: '' is the shipped default; a non-empty value is a user decision.
  outputTemplate: '%(title)s.%(ext)s', tempDir: '', ...o,
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
const codes = (r: DownloadRequest): PlanWarningCode[] =>
  resolveDownloadPlan(r).warnings.map((w) => w.code);

describe('B1 · default request produces a completely inert plan', () => {
  it('triggers NO M3 conditional segment (frozen EXPECTED_MINIMAL stays valid)', () => {
    const plan = resolveDownloadPlan(req());
    expect(plan.effectiveFormatId).toBeNull();
    expect(plan.effectiveSort).toBeNull();
    expect(plan.extractAudio).toBe(false);
    expect(plan.audioFormat).toBeNull();
    expect(plan.audioMultistreams).toBe(false);
    expect(plan.writeSubs).toBe(false);
    expect(plan.autoCaptions).toBe(false);
    expect(plan.embedSubs).toBe(false);
    expect(plan.convertTo).toBe('none');
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.downloadSections).toBeNull();
    expect(plan.splitChapters).toBe(false);
    expect(plan.chapterPrefix).toBe('');
    expect(plan.restrictFilenames).toBe(false);
    expect(plan.tempDir).toBeNull();
    expect(plan.ppa).toBeNull();
    expect(plan.debug).toBe(false);
    expect(plan.ipv4Only).toBe(false);
    expect(plan.aria2cPath).toBeNull();
    expect(plan.sponsorblockRemove).toBeNull();
    expect(plan.replaceInMetadata).toBeNull();
    expect(plan.downloadArchive).toBeNull();
    expect(plan.embedMetadata).toBe(false);
    expect(plan.embedThumbnail).toBe(false);
    expect(plan.writeThumbnail).toBe(false);
    expect(plan.embedChapters).toBe(false);
    expect(plan.warnings).toEqual([]);
    expect(plan.outputDir).toBe('C:/V');
    expect(plan.outputTemplate).toBe('%(title)s.%(ext)s');
  });

  it('is deterministic: same req -> equal but distinct plan objects', () => {
    const a = resolveDownloadPlan(req());
    const b = resolveDownloadPlan(req());
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('B1 · R1 audio transcode <-> -S abr~N (positive + negative)', () => {
  it('R1 POSITIVE: audioFormat=mp3 removes abr~N but keeps acodec:*', () => {
    const plan = resolveDownloadPlan(req({
      format: format({ audioFormat: 'mp3', audioQuality: '128', audioCodecPref: 'opus' }),
    }));
    expect(plan.audioFormat).toBe('mp3');
    expect(plan.effectiveSort).toBe('acodec:opus');
    expect(plan.effectiveSort?.includes('abr~')).toBe(false);
    expect(codes(req({ format: format({ audioFormat: 'mp3', audioQuality: '128' }) })))
      .toContain('R1_AUDIO_TRANSCODE_SUPPRESSES_ABR');
  });

  it('R1 NEGATIVE: no transcode -> abr~N present, no audioFormat', () => {
    const plan = resolveDownloadPlan(req({ format: format({ audioQuality: '128' }) }));
    expect(plan.audioFormat).toBeNull();
    expect(plan.effectiveSort).toContain('abr~128');
  });

  it('never contains abr~ AND --audio-format at once (R1 exclusivity)', () => {
    for (const audioQuality of ['best', '192', '128', '64', '32', 'lowest'] as const) {
      const plan = resolveDownloadPlan(req({ format: format({ audioQuality, audioFormat: 'm4a' }) }));
      expect(plan.effectiveSort === null || !plan.effectiveSort.includes('abr~')).toBe(true);
    }
  });
});

describe('B1 · R2 embed -> mergeToMkv (positive + negative)', () => {
  it('R2 POSITIVE: embed=true produces embedSubs + mergeToMkv + writeSubs', () => {
    const plan = resolveDownloadPlan(req({ subtitle: subtitle({ embed: true }) }));
    expect(plan.embedSubs).toBe(true);
    expect(plan.mergeToMkv).toBe(true);
    // C3': --write-subs is forced only by `enabled` or embed+keep, not by embed alone.
    expect(plan.writeSubs).toBe(false);
    expect(plan.embedChapters).toBe(true);
    expect(plan.writeThumbnail).toBe(true);
  });

  it('R2 NEGATIVE: embed=false keeps all three off', () => {
    const plan = resolveDownloadPlan(req({ subtitle: subtitle({ embed: false }) }));
    expect(plan.embedSubs).toBe(false);
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.embedChapters).toBe(false);
  });

  it('keepSubtitleFile with embed forces writeSubs=true (never duplicated)', () => {
    const plan = resolveDownloadPlan(req({
      subtitle: subtitle({ embed: true, keepSubtitleFile: true, enabled: false }),
    }));
    expect(plan.writeSubs).toBe(true);
  });
});

describe('B1 · R3 audio mode suppresses embed (positive + negative)', () => {
  it('R3 POSITIVE: extractAudio=true kills embed/remux/merge, still allows writeSubs', () => {
    const r = req({
      format: format({ extractAudio: true }),
      subtitle: subtitle({ enabled: true, embed: true }),
    });
    const plan = resolveDownloadPlan(r);
    expect(plan.embedSubs).toBe(false);
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.writeSubs).toBe(true);
    expect(plan.outputDir).toBe('C:/A');
    expect(plan.embedMetadata).toBe(true);
    expect(codes(r)).toContain('P1_AUDIO_MODE_SUPPRESSES_EMBED');
  });

  it('R3 NEGATIVE: video mode + embed restores R2', () => {
    const plan = resolveDownloadPlan(req({ subtitle: subtitle({ embed: true }) }));
    expect(plan.embedSubs).toBe(true);
    expect(plan.mergeToMkv).toBe(true);
  });

  it('audio mode with transcode derives embed-thumbnail + ppa downgrade WARNING', () => {
    const r = req({ format: format({ extractAudio: true, audioFormat: 'mp3' }) });
    const plan = resolveDownloadPlan(r);
    expect(plan.embedThumbnail).toBe(true);
    expect(plan.ppa).toBeNull();
    expect(codes(r)).toContain('PPA_UNSUPPORTED_DOWNGRADED');
  });
});

describe('B1 · R4 multistream (DTO already corrected by FormatSelector)', () => {
  it('mirrors the corrected DTO value in both directions', () => {
    expect(resolveDownloadPlan(req({ format: format({ audioMultistreams: true }) })).audioMultistreams).toBe(true);
    expect(resolveDownloadPlan(req({ format: format({ audioMultistreams: false }) })).audioMultistreams).toBe(false);
  });
});

describe('B1 · R5 sections > split > embed mkv (all 4 combinations)', () => {
  it('R5① sections + split -> sections only, split suppressed + WARNING', () => {
    const r = req({ advanced: advanced({ downloadSections: '*00:30-01:00', splitChapters: true }) });
    const plan = resolveDownloadPlan(r);
    expect(plan.downloadSections).toBe('*00:30-01:00');
    expect(plan.splitChapters).toBe(false);
    expect(plan.chapterPrefix).toBe('');
    expect(codes(r)).toContain('R5_SPLIT_SUPPRESSED_BY_SECTIONS');
  });

  it('R5① reverse: split only -> --split-chapters + chapter: prefix', () => {
    const plan = resolveDownloadPlan(req({ advanced: advanced({ splitChapters: true }) }));
    expect(plan.splitChapters).toBe(true);
    expect(plan.chapterPrefix).toBe('chapter:');
    expect(plan.outputTemplate.startsWith('chapter:')).toBe(true);
  });

  it('R5② split + embed -> embed/remux/merge suppressed, WARNING recorded', () => {
    const r = req({
      subtitle: subtitle({ embed: true }),
      advanced: advanced({ splitChapters: true }),
    });
    const plan = resolveDownloadPlan(r);
    expect(plan.splitChapters).toBe(true);
    expect(plan.suppressRemux).toBe(true);
    expect(plan.embedSubs).toBe(false);
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.embedChapters).toBe(false);
    expect(codes(r)).toContain('R5_SPLIT_SUPPRESSES_EMBED');
  });

  it('R5② reverse: no split + sections + embed -> R2 restored', () => {
    const plan = resolveDownloadPlan(req({
      subtitle: subtitle({ embed: true }),
      advanced: advanced({ splitChapters: false, downloadSections: null }),
    }));
    expect(plan.embedSubs).toBe(true);
    expect(plan.mergeToMkv).toBe(true);
    expect(plan.suppressRemux).toBe(false);
  });

  it('R5③ chapters empty disables split via ResolveOptions', () => {
    const r = req({ advanced: advanced({ splitChapters: true }) });
    const plan = resolveDownloadPlan(r, { chaptersAvailable: false });
    expect(plan.splitChapters).toBe(false);
    expect(plan.chapterPrefix).toBe('');
    expect(plan.warnings.map((w) => w.code)).toContain('R5_SPLIT_DISABLED_NO_CHAPTERS');
    expect(resolveDownloadPlan(r).splitChapters).toBe(true);
  });

  it('sections alone also suppresses embed/remux (裁剪 > 嵌入 mkv)', () => {
    const plan = resolveDownloadPlan(req({
      subtitle: subtitle({ embed: true }),
      advanced: advanced({ downloadSections: '*00:00-00:30' }),
    }));
    expect(plan.embedSubs).toBe(false);
    expect(plan.mergeToMkv).toBe(false);
    expect(plan.downloadSections).toBe('*00:00-00:30');
  });
});

describe('B1 · P0->P7 priority chain is enumerable', () => {
  it('P7: all 8 quality values map to res:N or no constraint', () => {
    const expected: Record<string, string | null> = {
      best: null, '2160p': 'res:2160', '1440p': 'res:1440', '1080p': 'res:1080',
      '720p': 'res:720', '480p': 'res:480', '360p': 'res:360', lowest: null,
    };
    for (const [quality, res] of Object.entries(expected)) {
      const plan = resolveDownloadPlan(req({ format: format({ quality: quality as FormatDomain['quality'] }) }));
      if (res === null) expect(plan.effectiveSort === null || !plan.effectiveSort.includes('res:')).toBe(true);
      else expect(plan.effectiveSort).toContain(res);
    }
  });

  it('P7: videoCodecPref 4 branches', () => {
    expect(resolveDownloadPlan(req({ format: format({ videoCodecPref: 'av01' }) })).effectiveSort).toContain('vcodec:av01');
    expect(resolveDownloadPlan(req({ format: format({ videoCodecPref: 'vp9.2' }) })).effectiveSort).toContain('vcodec:vp9.2');
    expect(resolveDownloadPlan(req({ format: format({ videoCodecPref: 'h264' }) })).effectiveSort).toContain('vcodec:h264');
    expect(resolveDownloadPlan(req({ format: format({ videoCodecPref: 'auto' }) })).effectiveSort).toBeNull();
  });

  it('P7: all 6 audioQuality values, suppressed by R1', () => {
    for (const [quality, abr] of [
      ['best', null], ['192', 'abr~192'], ['128', 'abr~128'],
      ['64', 'abr~64'], ['32', 'abr~32'], ['lowest', 'abr~0'],
    ] as const) {
      const plan = resolveDownloadPlan(req({ format: format({ audioQuality: quality }) }));
      if (abr === null) expect(plan.effectiveSort === null || !plan.effectiveSort.includes('abr~')).toBe(true);
      else expect(plan.effectiveSort).toContain(abr);
    }
  });

  it('P7: audioCodecPref 3 branches (kept even under R1)', () => {
    expect(resolveDownloadPlan(req({ format: format({ audioCodecPref: 'opus' }) })).effectiveSort).toContain('acodec:opus');
    expect(resolveDownloadPlan(req({ format: format({ audioCodecPref: 'aac' }) })).effectiveSort).toContain('acodec:aac');
    expect(resolveDownloadPlan(req({ format: format({ audioCodecPref: 'auto' }) })).effectiveSort).toBeNull();
    expect(resolveDownloadPlan(req({ format: format({ audioCodecPref: 'opus', audioFormat: 'mp3' }) })).effectiveSort)
      .toBe('acodec:opus');
  });

  it('P3 / custom sortingFields wins verbatim over every preset', () => {
    const plan = resolveDownloadPlan(req({
      format: format({ sortingFields: 'res:720,ext:mp4', quality: '1080p', formatId: '137+251' }),
    }));
    expect(plan.effectiveSort).toBe('res:720,ext:mp4');
    expect(plan.effectiveFormatId).toBe('137+251');
    expect(plan.effectiveSort?.includes('res:1080')).toBe(false);
  });

  it('P3: formatId suppresses the resolution preset but keeps codec preference', () => {
    const plan = resolveDownloadPlan(req({
      format: format({ formatId: '137+251', quality: '1080p', videoCodecPref: 'h264' }),
    }));
    expect(plan.effectiveSort).toBe('vcodec:h264');
    expect(plan.effectiveSort?.includes('res:1080')).toBe(false);
  });

  it('P1: audio mode strips res:N/vcodec:* from the AUTO preset only', () => {
    const plan = resolveDownloadPlan(req({
      format: format({ extractAudio: true, quality: '1080p', videoCodecPref: 'av01', audioQuality: '128' }),
    }));
    expect(plan.effectiveSort).toBe('abr~128');
  });

  it('P0: customCommand is ignored with a WARNING, never consumed', () => {
    const r = req({ advanced: advanced({ customCommand: ['--exec', 'evil'] }) });
    const plan = resolveDownloadPlan(r);
    expect(codes(r)).toContain('CUSTOM_COMMAND_IGNORED');
    expect(plan.ppa).toBeNull();
    expect(plan.effectiveFormatId).toBeNull();
  });
});

describe('B1 · network / advanced / path derivation', () => {
  it('aria2c suppresses concurrentFragments with a WARNING', () => {
    const r = req({ network: network({ aria2cPath: 'C:/aria2c.exe', concurrentFragments: 8 }) });
    const plan = resolveDownloadPlan(r);
    expect(plan.aria2cPath).toBe('C:/aria2c.exe');
    expect(plan.concurrentFragments).toBeNull();
    expect(codes(r)).toContain('ARIA2C_SUPPRESSES_FRAGMENTS');
    expect(resolveDownloadPlan(req({ network: network({ concurrentFragments: 8 }) })).concurrentFragments).toBe(8);
  });

  it('maps every network field and ipv4Only', () => {
    const plan = resolveDownloadPlan(req({
      network: network({
        rateLimit: '500K', proxy: 'http://127.0.0.1:8888',
        cookiesFile: 'C:/cookies.txt', userAgent: 'YTVDLT/1.0', ipv4Only: true,
      }),
    }));
    expect(plan.rateLimit).toBe('500K');
    expect(plan.proxy).toBe('http://127.0.0.1:8888');
    expect(plan.cookiesFile).toBe('C:/cookies.txt');
    expect(plan.userAgent).toBe('YTVDLT/1.0');
    expect(plan.ipv4Only).toBe(true);
  });

  it('maps advanced fields and sanitizes customTitle', () => {
    const plan = resolveDownloadPlan(req({
      advanced: advanced({
        sponsorblockRemove: 'sponsor,intro', customTitle: 'My New Title',
        debug: true, downloadArchive: 'C:/archive.txt',
      }),
    }));
    expect(plan.sponsorblockRemove).toBe('sponsor,intro');
    expect(plan.replaceInMetadata).toBe('My_New_Title');
    expect(/\s/.test(plan.replaceInMetadata ?? '')).toBe(false);
    expect(plan.debug).toBe(true);
    expect(plan.downloadArchive).toBe('C:/archive.txt');
  });

  it('buildOutputDir 4 combinations (00/10/01/11)', () => {
    const base = { subdirByExtractor: false, subdirByPlaylist: false };
    expect(resolveDownloadPlan(req({ paths: paths(base) })).outputDir).toBe('C:/V');
    expect(resolveDownloadPlan(req({ paths: paths({ ...base, subdirByExtractor: true }) })).outputDir)
      .toBe('C:/V/%(extractor_key)s');
    expect(resolveDownloadPlan(req({ paths: paths({ ...base, subdirByPlaylist: true }) })).outputDir)
      .toBe('C:/V/%(playlist)s');
    expect(resolveDownloadPlan(req({ paths: paths({ subdirByExtractor: true, subdirByPlaylist: true }) })).outputDir)
      .toBe('C:/V/%(extractor_key)s/%(playlist)s');
  });

  it('privateMode routes output to the private directory', () => {
    const plan = resolveDownloadPlan(req({ paths: paths({ privateMode: true }) }));
    expect(plan.outputDir).toBe(PRIVATE_OUTPUT_DIR);
    expect(plan.privateMode).toBe(true);
  });

  it('D-118: the temp dir follows the CONFIG, not the post-processing need', () => {
    // Audio mode still writes to audioDir…
    const audio = resolveDownloadPlan(req({ format: format({ extractAudio: true }) }));
    expect(audio.outputDir).toBe('C:/A');
    // …and a plain single-file download now carries a temp dir too, because
    // `.part` / `.part-FragN.part` / `.ytdl` exist for every transfer. The old
    // rule ("only when merging") is what left partials next to the media.
    const plain = resolveDownloadPlan(req({ paths: paths({ tempDir: 'C:/work/t1' }) }));
    expect(plain.extractAudio).toBe(false);
    expect(plain.tempDir).toBe('C:/work/t1');
    // No configured dir and no resolved one → emit nothing (legacy behaviour).
    expect(resolveDownloadPlan(req()).tempDir).toBeNull();
  });

  it('whitespace in the output template is sanitized but does NOT enable --restrict-filenames (D-110)', () => {
    const plan = resolveDownloadPlan(req({ paths: paths({ outputTemplate: '%(title).200B [%(id)s].%(ext)s' }) }));
    // The template's space still becomes `_` (argv safety), but that is a local
    // rewrite; it must never turn into yt-dlp's "ASCII only" flag.
    expect(plan.restrictFilenames).toBe(false);
    expect(/\s/.test(plan.outputTemplate)).toBe(false);
    expect(plan.outputTemplate).toBe('%(title).200B_[%(id)s].%(ext)s');
  });

  it('restrictFilenames comes from the config key, not from the template (D-110)', () => {
    const plan = resolveDownloadPlan(req({
      paths: { ...paths(), restrictFilenames: true } as PathsDomain,
    }));
    expect(plan.restrictFilenames).toBe(true);
  });

  it('subtitle flags map to plan fields incl. skipTranslated gating', () => {
    expect(resolveDownloadPlan(req({ subtitle: subtitle({ autoCaptions: true }) })).skipTranslatedSubs).toBe(true);
    expect(resolveDownloadPlan(req({ subtitle: subtitle({ autoCaptions: false, skipTranslated: true }) })).skipTranslatedSubs).toBe(false);
    const plan = resolveDownloadPlan(req({ subtitle: subtitle({ enabled: true, languages: 'zh.*,en.*', convertTo: 'srt' }) }));
    expect(plan.writeSubs).toBe(true);
    expect(plan.subLangs).toBe('zh.*,en.*');
    expect(plan.convertTo).toBe('srt');
  });
});

describe('D-83 · audio transcode quality survives R1', () => {
  it('no transcode -> no --audio-quality value, abr~N kept', () => {
    const plan = resolveDownloadPlan(req({ format: format({ extractAudio: true, audioQuality: '128' }) }));
    expect(plan.audioTranscodeQuality).toBeNull();
    expect(plan.effectiveSort).toContain('abr~128');
  });

  it('mp3 transcode -> --audio-quality value derived from the bitrate preset', () => {
    const cases: readonly [FormatDomain['audioQuality'], string][] = [
      ['best', '0'], ['192', '192K'], ['128', '128K'], ['64', '64K'], ['32', '32K'], ['lowest', '10'],
    ];
    for (const [audioQuality, expected] of cases) {
      const plan = resolveDownloadPlan(req({
        format: format({ extractAudio: true, audioFormat: 'm4a', audioQuality }),
      }));
      expect(plan.audioTranscodeQuality).toBe(expected);
      // R1 still wins for the source selection: no abr~N in the sort string.
      expect(plan.effectiveSort ?? '').not.toContain('abr~');
    }
  });
});
