/** B1 / F031 · language grouping, expression validation, R3, mergeToMkv hint. */
import { describe, it, expect } from 'vitest';
import {
  groupLanguages, matchesLanguagePattern, validateLanguageExpression, planSubtitles,
  DEFAULT_SUGGESTED_LANGUAGES,
} from '@ytvdlt/core';
import type { MediaInfo, SubtitleDomain, SubtitleSelection } from '@ytvdlt/shared';

const media = (subtitles: Record<string, unknown[]> = {}, automatic: Record<string, unknown[]> = {}): MediaInfo => ({
  id: 'x', title: 't', uploader: null, uploader_id: null, duration: 10,
  thumbnail: null, webpage_url: 'https://e.org', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4', formats: [],
  subtitles: subtitles as MediaInfo['subtitles'],
  automatic_captions: automatic as MediaInfo['automatic_captions'],
  chapters: null, _type: 'video',
});

const current: SubtitleDomain = {
  enabled: false, languages: 'en.*,.*-orig', autoCaptions: false,
  skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false,
};

const sel = (o: Partial<SubtitleSelection> = {}): SubtitleSelection => ({
  languages: [], autoCaptions: false, skipTranslated: true,
  convertTo: 'none', embed: false, keepSubtitleFile: false, ...o,
});

describe('B1 SubtitlePlanner · matchesLanguagePattern / groupLanguages', () => {
  it('matches glob-like yt-dlp patterns case-insensitively', () => {
    expect(matchesLanguagePattern('en-US', 'en.*')).toBe(true);
    expect(matchesLanguagePattern('en-orig', '.*-orig')).toBe(true);
    expect(matchesLanguagePattern('zh-Hans', 'zh-Hans')).toBe(true);
    expect(matchesLanguagePattern('fr', 'en.*')).toBe(false);
  });

  it('rejects empty / non-string patterns without throwing', () => {
    expect(matchesLanguagePattern('en', '')).toBe(false);
    expect(matchesLanguagePattern('en', null as unknown as string)).toBe(false);
    expect(matchesLanguagePattern(null as unknown as string, 'en')).toBe(false);
  });

  it('splits suggested / other / automatic groups', () => {
    const m = media(
      { en: [], 'en-US': [], 'zh-Hans': [], 'ja': [] },
      { 'en-auto': [], 'zh-auto': [] },
    );
    const grouped = groupLanguages(m, DEFAULT_SUGGESTED_LANGUAGES);
    expect(grouped.suggested).toContain('en-US');
    expect(grouped.other).toContain('zh-Hans');
    expect(grouped.other).toContain('ja');
    expect(grouped.automatic).toEqual(['en-auto', 'zh-auto']);
  });

  it('falls back to default suggestions when none supplied', () => {
    const grouped = groupLanguages(media({ 'en-US': [] }, {}), []);
    expect(grouped.suggested).toEqual(['en-US']);
  });

  it('handles an empty media result', () => {
    expect(groupLanguages(media(), [])).toEqual({ suggested: [], other: [], automatic: [] });
  });
});

describe('B1 SubtitlePlanner · validateLanguageExpression', () => {
  it('accepts real yt-dlp expressions', () => {
    for (const expr of ['en.*,.*-orig', 'zh-Hans,en', 'zh.*,en.*', 'all,-live_chat']) {
      expect(validateLanguageExpression(expr)).toEqual({ valid: true, reason: null });
    }
  });

  it('rejects empty, whitespace, control chars, illegal chars and empty tokens', () => {
    expect(validateLanguageExpression('').valid).toBe(false);
    expect(validateLanguageExpression('   ').valid).toBe(false);
    expect(validateLanguageExpression('en.*, fr').valid).toBe(false);
    expect(validateLanguageExpression('en\u0000.*').valid).toBe(false);
    expect(validateLanguageExpression('en;rm -rf').valid).toBe(false);
    expect(validateLanguageExpression('en.*,').valid).toBe(false);
    expect(validateLanguageExpression(null as unknown as string).valid).toBe(false);
  });
});

describe('B1 SubtitlePlanner · planSubtitles', () => {
  const m = media({ en: [], 'zh-Hans': [] }, { 'en-auto': [] });

  it('A-4.3-08: selecting languages forces enabled=true and writes all six fields', () => {
    const result = planSubtitles(m, current, sel({
      languages: ['zh-Hans', 'en'], autoCaptions: true, skipTranslated: false,
      convertTo: 'srt', embed: true, keepSubtitleFile: true,
    }), 'video');
    expect(result.subtitle.enabled).toBe(true);
    expect(result.subtitle.languages).toBe('zh-Hans,en');
    expect(result.subtitle.autoCaptions).toBe(true);
    expect(result.subtitle.skipTranslated).toBe(false);
    expect(result.subtitle.convertTo).toBe('srt');
    expect(result.subtitle.embed).toBe(true);
    expect(result.subtitle.keepSubtitleFile).toBe(true);
  });

  it('R3: audio mode forces embed=false and mergeToMkv=false with a WARNING', () => {
    const result = planSubtitles(m, current, sel({ languages: ['en'], embed: true }), 'audio');
    expect(result.subtitle.embed).toBe(false);
    expect(result.mergeToMkv).toBe(false);
    expect(result.warnings.join(' ')).toContain('仅音频模式');
  });

  it('video mode with embed derives mergeToMkv ONLY in the return value', () => {
    const result = planSubtitles(m, current, sel({ languages: ['en'], embed: true }), 'video');
    expect(result.mergeToMkv).toBe(true);
    expect('mergeToMkv' in result.subtitle).toBe(false);
  });

  it('empty selection disables subtitles', () => {
    const result = planSubtitles(m, current, sel(), 'video');
    expect(result.subtitle.enabled).toBe(false);
    expect(result.mergeToMkv).toBe(false);
  });

  it('warns about unknown languages and empty probe results', () => {
    const withUnknown = planSubtitles(m, current, sel({ languages: ['xx'] }), 'video');
    expect(withUnknown.warnings.join(' ')).toContain('xx');
    const emptyMedia = planSubtitles(media(), current, sel({ languages: ['en'] }), 'video');
    expect(emptyMedia.warnings.join(' ')).toContain('没有任何字幕语言');
  });

  it('flags an illegal language expression coming from the dialog', () => {
    const result = planSubtitles(m, current, sel({ languages: ['en fr'] }), 'video');
    expect(result.warnings.join(' ')).toContain('非法语言表达式');
  });
});
