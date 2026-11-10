/**
 * Stage 3 · subtitle choice → `SubtitleDomain` patch.
 *
 * The three switches must stay independent, because each maps to a DIFFERENT
 * yt-dlp flag:
 *   enabled      → `--write-subs`   (manual tracks)
 *   autoCaptions → `--write-auto-subs`
 *   embed        → `--embed-subs` + (resolver) a remux to MKV
 *
 * The audit bug this protects against: choosing only automatic captions used to
 * force `enabled = true` ("any language means write subs"), which asked the
 * site for manual tracks that do not exist and dropped the language filter.
 */
import { describe, it, expect } from 'vitest';
import { MAX_SUBTITLE_LANGUAGES, mergeSubtitleChoice, type SubtitleChoice } from '@ytvdlt/core';
import type { SubtitleTrackPreview } from '@ytvdlt/shared';

const track = (overrides: Partial<SubtitleTrackPreview> & { languageCode: string }): SubtitleTrackPreview => ({
  languageName: null,
  manualAvailable: false,
  automaticAvailable: false,
  manualFormats: [],
  automaticFormats: [],
  ...overrides,
});

/** en: manual+auto · zh-Hans: manual only · de: auto only */
const AVAILABLE: readonly SubtitleTrackPreview[] = [
  track({ languageCode: 'en', manualAvailable: true, automaticAvailable: true, manualFormats: ['vtt'], automaticFormats: ['vtt'] }),
  track({ languageCode: 'zh-Hans', manualAvailable: true, manualFormats: ['srt'] }),
  track({ languageCode: 'de', automaticAvailable: true, automaticFormats: ['vtt'] }),
];

const choice = (overrides: Partial<SubtitleChoice> = {}): SubtitleChoice => ({
  languages: ['en'],
  includeAutomatic: false,
  convertTo: 'none',
  embed: false,
  keepSubtitleFile: false,
  ...overrides,
});

describe('subtitle choice · manual vs automatic switches', () => {
  it('manual-only language enables --write-subs and nothing else', () => {
    const result = mergeSubtitleChoice({ choice: choice({ languages: ['zh-Hans'] }), available: AVAILABLE, mode: 'video' });
    expect(result.usable).toBe(true);
    expect(result.patch).toMatchObject({
      enabled: true, languages: 'zh-Hans', autoCaptions: false, embed: false, convertTo: 'none',
    });
    expect(result.warnings).toEqual([]);
  });

  it('automatic-only language does NOT enable manual writing', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['de'], includeAutomatic: true }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.usable).toBe(true);
    // This is the audit R1 fix: enabled stays false, so no `--write-subs`.
    expect(result.patch.enabled).toBe(false);
    expect(result.patch.autoCaptions).toBe(true);
    expect(result.patch.languages).toBe('de');
    expect(result.warnings.map((w) => w.code)).toContain('SUBTITLE_NO_MANUAL_TRACK');
  });

  it.each([['de'], ['en', 'de']])('refuses automatic-only selections without automatic captions: %j', (...languages) => {
    const result = mergeSubtitleChoice({ choice: choice({ languages }), available: AVAILABLE, mode: 'video' });
    expect(result.usable).toBe(false);
    expect(result.patch).toEqual({});
    expect(result.warnings.map((warning) => warning.code)).toContain('SUBTITLE_NO_MANUAL_TRACK');
  });

  it('a language with both sources can request both', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['en'], includeAutomatic: true }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch).toMatchObject({ enabled: true, autoCaptions: true, languages: 'en' });
    expect(result.warnings).toEqual([]);
  });

  it('drops the automatic option when no selected language has one', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['zh-Hans'], includeAutomatic: true }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch.enabled).toBe(true);
    expect(result.patch.autoCaptions).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('SUBTITLE_NO_AUTOMATIC_TRACK');
  });
});

describe('subtitle choice · languages', () => {
  it('keeps the selection order for multiple languages', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['zh-Hans', 'en'] }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch.languages).toBe('zh-Hans,en');
    expect(result.acceptedLanguages).toEqual(['zh-Hans', 'en']);
  });

  it('drops a language the video does not have', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['en', 'ja'] }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch.languages).toBe('en');
    expect(result.warnings[0]?.code).toBe('SUBTITLE_LANGUAGE_UNKNOWN');
    expect(result.warnings[0]?.detail).toContain('ja');
  });

  it('refuses the whole choice when no language matches', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['ja', 'ko'] }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.usable).toBe(false);
    expect(result.patch).toEqual({});
    expect(result.acceptedLanguages).toEqual([]);
  });

  it('rejects glob patterns and junk codes instead of forwarding them', () => {
    // The picker sends exact codes; a glob here would reach `--sub-langs` and
    // silently widen the request.
    for (const bad of [['en.*'], ['../etc/passwd'], ['-en'], ['']]) {
      const result = mergeSubtitleChoice({ choice: choice({ languages: bad }), available: AVAILABLE, mode: 'video' });
      expect(result.usable).toBe(false);
    }
  });

  it('dedupes repeated languages', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['en', 'en', 'zh-Hans'] }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch.languages).toBe('en,zh-Hans');
  });

  it('caps the number of languages and says so', () => {
    const many = Array.from({ length: MAX_SUBTITLE_LANGUAGES + 3 }, (_, index) => `l${index}`);
    const available = many.map((code) => track({ languageCode: code, manualAvailable: true, manualFormats: ['vtt'] }));
    const result = mergeSubtitleChoice({ choice: choice({ languages: many }), available, mode: 'video' });
    expect(result.acceptedLanguages).toHaveLength(MAX_SUBTITLE_LANGUAGES);
    expect(result.warnings.map((w) => w.code)).toContain('SUBTITLE_TOO_MANY_LANGUAGES');
  });
});

describe('subtitle choice · format conversion', () => {
  it.each(['none', 'srt', 'vtt', 'ass', 'lrc'] as const)('carries %s through', (convertTo) => {
    const result = mergeSubtitleChoice({ choice: choice({ convertTo }), available: AVAILABLE, mode: 'video' });
    expect(result.patch.convertTo).toBe(convertTo);
  });

  it('falls back to none for an out-of-enum value', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ convertTo: 'mkv' as never }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch.convertTo).toBe('none');
  });
});

describe('subtitle choice · embedding', () => {
  it('embeds only in video mode', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ embed: true, keepSubtitleFile: true }),
      available: AVAILABLE,
      mode: 'audio',
    });
    expect(result.patch.embed).toBe(false);
    // "keep the file" only means something when embedding.
    expect(result.patch.keepSubtitleFile).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('SUBTITLE_EMBED_IGNORED_AUDIO');
  });

  it('keeps the external file when asked, only for embed', () => {
    const withKeep = mergeSubtitleChoice({
      choice: choice({ embed: true, keepSubtitleFile: true }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(withKeep.patch).toMatchObject({ embed: true, keepSubtitleFile: true, enabled: true });

    const withoutKeep = mergeSubtitleChoice({
      choice: choice({ embed: true }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(withoutKeep.patch).toMatchObject({ embed: true, keepSubtitleFile: false });
  });

  it('refuses embedding an automatic-only language', () => {
    const result = mergeSubtitleChoice({
      choice: choice({ languages: ['de'], includeAutomatic: true, embed: true }),
      available: AVAILABLE,
      mode: 'video',
    });
    expect(result.patch.embed).toBe(false);
    expect(result.patch.autoCaptions).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('SUBTITLE_EMBED_NEEDS_MANUAL');
  });
});

describe('subtitle choice · config defaults are preserved', () => {
  it('keeps skipTranslated from the config when the user did not touch it', () => {
    const result = mergeSubtitleChoice({
      choice: choice(),
      available: AVAILABLE,
      mode: 'video',
      current: { skipTranslated: false, keepSubtitleFile: true },
    });
    expect(result.patch.skipTranslated).toBe(false);
    // No embed → the "keep file" flag is the config's, not the choice's.
    expect(result.patch.keepSubtitleFile).toBe(true);
  });

  it('defaults skipTranslated to true (config default) when absent', () => {
    const result = mergeSubtitleChoice({ choice: choice(), available: AVAILABLE, mode: 'video' });
    expect(result.patch.skipTranslated).toBe(true);
  });
});
