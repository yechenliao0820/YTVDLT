/**
 * Subtitle preview · metadata projection (stage 2).
 *
 * What is being pinned here is the SOURCE identity: manual vs automatic comes
 * from the yt-dlp bucket and nothing else. The old fixture dialog merged both
 * buckets by language code and lost the distinction, which is exactly the bug
 * this projection must not reintroduce.
 */
import { describe, it, expect } from 'vitest';
import {
  collectSubtitleTracks, sanitizeDisplayText, summarizeSubtitleTracks,
} from '@ytvdlt/core';
import {
  bucketOf, findUrlLeaks, mediaInfo, trackOf,
} from './helpers/subtitle-media.js';

describe('subtitle preview · manual vs automatic mapping', () => {
  it('maps both buckets and keeps the source identity intact', () => {
    const media = mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt', 'English'), trackOf('zh-Hans', 'srt')),
      automatic_captions: bucketOf(trackOf('en', 'vtt', 'English (auto)'), trackOf('de', 'vtt', 'German (auto)')),
    });
    const rows = collectSubtitleTracks(media);

    // Manual rows first (sorted by code), then automatic-only rows.
    expect(rows.map((row) => row.languageCode)).toEqual(['en', 'zh-Hans', 'de']);

    const en = rows[0];
    expect(en?.manualAvailable).toBe(true);
    expect(en?.automaticAvailable).toBe(true);
    expect(en?.manualFormats).toEqual(['vtt']);
    expect(en?.automaticFormats).toEqual(['vtt']);
    // The human label prefers the manual track, not the "(auto)" one.
    expect(en?.languageName).toBe('English');

    const zh = rows[1];
    expect(zh?.manualAvailable).toBe(true);
    expect(zh?.automaticAvailable).toBe(false);
    expect(zh?.manualFormats).toEqual(['srt']);
    expect(zh?.automaticFormats).toEqual([]);
    expect(zh?.languageName).toBeNull();

    const de = rows[2];
    expect(de?.manualAvailable).toBe(false);
    expect(de?.automaticAvailable).toBe(true);
    expect(de?.languageName).toBe('German (auto)');
  });

  it('returns no rows when the video has no subtitles at all', () => {
    const rows = collectSubtitleTracks(mediaInfo());
    expect(rows).toEqual([]);
    expect(summarizeSubtitleTracks(rows)).toEqual({
      manualLanguages: 0, automaticLanguages: 0, empty: true,
    });
  });

  it('keeps manual-only videos manual-only', () => {
    const rows = collectSubtitleTracks(mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt', 'English'), trackOf('ja', 'ass')),
    }));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.automaticAvailable === false)).toBe(true);
    expect(rows.every((row) => row.automaticFormats.length === 0)).toBe(true);
  });

  it('keeps automatic-only videos automatic-only', () => {
    const rows = collectSubtitleTracks(mediaInfo({
      automatic_captions: bucketOf(trackOf('en', 'vtt'), trackOf('ru', 'srv3')),
    }));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.manualAvailable === false)).toBe(true);
    expect(rows.every((row) => row.manualFormats.length === 0)).toBe(true);
    // `srv3` is a real yt-dlp subtitle format; it must survive, not be dropped.
    expect(rows.map((row) => row.automaticFormats)).toEqual([['vtt'], ['srv3']]);
  });

  it('merges the same language from both buckets into ONE row', () => {
    const rows = collectSubtitleTracks(mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('en', 'srt')),
      automatic_captions: bucketOf(trackOf('en', 'json3')),
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manualFormats).toEqual(['srt', 'vtt']);
    expect(rows[0]?.automaticFormats).toEqual(['json3']);
    expect(rows[0]?.manualAvailable && rows[0]?.automaticAvailable).toBe(true);
  });

  it('dedupes and normalises formats, dropping junk extensions', () => {
    const rows = collectSubtitleTracks(mediaInfo({
      subtitles: bucketOf(
        { lang: 'en', ext: ' VTT ', name: null },
        { lang: 'en', ext: 'vtt', name: null },
        { lang: 'en', ext: '', name: null },
        { lang: 'en', ext: '../evil', name: null },
      ),
    }));
    expect(rows[0]?.manualFormats).toEqual(['vtt']);
  });

  it('skips malformed buckets and tracks without throwing', () => {
    const longCode = 'x'.repeat(80);
    const media = mediaInfo({
      // A hand-edited / older snapshot can hold anything.
      subtitles: {
        en: 'not-an-array',
        '': [trackOf('', 'vtt')],
        fr: [{ ext: 'vtt', name: null }, 'junk', null],
        [longCode]: [trackOf(longCode, 'vtt')],
      } as unknown as Record<string, never>,
      automatic_captions: null as unknown as Record<string, never>,
    });
    expect(() => collectSubtitleTracks(media)).not.toThrow();
    const rows = collectSubtitleTracks(media);
    // Only `fr` survives: a non-array bucket, an empty code and an over-long
    // code are all rejected rather than truncated into a plausible language.
    expect(rows.map((row) => row.languageCode)).toEqual(['fr']);
    expect(rows[0]?.manualFormats).toEqual(['vtt']);
  });

  it('counts overlapping languages once per source', () => {
    const tracks = collectSubtitleTracks(mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt'), trackOf('zh-Hans', 'srt')),
      automatic_captions: bucketOf(trackOf('en', 'vtt'), trackOf('de', 'vtt')),
    }));
    expect(summarizeSubtitleTracks(tracks)).toEqual({
      manualLanguages: 2, automaticLanguages: 2, empty: false,
    });
  });
});

describe('subtitle preview · display-name hygiene', () => {
  it('strips control characters and bidi overrides', () => {
    expect(sanitizeDisplayText('Eng\u0000lish\u202E \u2066X')).toBe('English X');
  });

  it('collapses whitespace, trims and caps the length', () => {
    expect(sanitizeDisplayText('  English   (auto)  ')).toBe('English (auto)');
    expect(sanitizeDisplayText('a'.repeat(200))).toHaveLength(80);
    expect(sanitizeDisplayText('   ')).toBeNull();
    expect(sanitizeDisplayText(null)).toBeNull();
  });

  it('keeps markup as literal text (the renderer must use textContent)', () => {
    const rows = collectSubtitleTracks(mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt', '<img src=x onerror=alert(1)>')),
    }));
    expect(rows[0]?.languageName).toBe('<img src=x onerror=alert(1)>');
    expect(typeof rows[0]?.languageName).toBe('string');
  });
});

describe('subtitle preview · no credential reaches the DTO', () => {
  it('drops every signed subtitle URL and format URL', () => {
    const rows = collectSubtitleTracks(mediaInfo({
      subtitles: bucketOf(trackOf('en', 'vtt', 'English')),
      automatic_captions: bucketOf(trackOf('de', 'vtt', 'German (auto)')),
    }));
    expect(findUrlLeaks(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(rows)).not.toContain('http');
  });
});
