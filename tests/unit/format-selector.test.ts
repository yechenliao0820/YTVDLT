/** B1 / F030 · three-column classification, recommended format, byte totals, R4. */
import { describe, it, expect } from 'vitest';
import {
  classifyFormats, recommendFormat, sumSelectedBytes, selectFormats,
} from '@ytvdlt/core';
import type {
  MediaFormat, MediaInfo, FormatDomain, FormatSelection,
} from '@ytvdlt/shared';

const f = (format_id: string, vcodec: string, acodec: string, extra: Partial<MediaFormat> = {}): MediaFormat => ({
  format_id, ext: 'mp4', width: 1920, height: 1080, vcodec, acodec,
  filesize: null, filesize_approx: null, tbr: null, fps: null, format_note: null,
  ...extra,
});

const media = (formats: MediaFormat[]): MediaInfo => ({
  id: 'x', title: 't', uploader: null, uploader_id: null, duration: 10,
  thumbnail: null, webpage_url: 'https://e.org', extractor_key: 'generic',
  description: null, upload_date: null, ext: 'mp4', formats,
  subtitles: {}, automatic_captions: {}, chapters: null, _type: 'video',
});

const current: FormatDomain = {
  quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
  extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
  audioFormat: null, audioMultistreams: false,
};

const sel = (o: Partial<FormatSelection> = {}): FormatSelection => ({
  videoFormatId: null, audioFormatIds: [], quality: 'best', videoCodecPref: 'auto',
  audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null,
  sortingFields: null, ...o,
});

describe('B1 FormatSelector · classifyFormats', () => {
  it('splits video-only / audio-only / merged and drops codec-less entries', () => {
    const result = classifyFormats([
      f('137', 'h264', 'none'), f('251', 'none', 'opus'), f('22', 'h264', 'aac'),
      f('empty', 'none', 'none'),
    ]);
    expect(result.videoOnly.map((x) => x.format_id)).toEqual(['137']);
    expect(result.audioOnly.map((x) => x.format_id)).toEqual(['251']);
    expect(result.merged.map((x) => x.format_id)).toEqual(['22']);
  });

  it('handles an empty / non-array input without throwing', () => {
    expect(classifyFormats([])).toEqual({ videoOnly: [], audioOnly: [], merged: [] });
    expect(classifyFormats(null as unknown as MediaFormat[])).toEqual({ videoOnly: [], audioOnly: [], merged: [] });
  });
});

describe('B1 FormatSelector · recommendFormat', () => {
  it('picks the highest tbr', () => {
    const a = f('a', 'h264', 'none', { tbr: 100 });
    const b = f('b', 'h264', 'none', { tbr: 900 });
    const c = f('c', 'h264', 'none', { tbr: 300 });
    expect(recommendFormat([a, b, c])?.format_id).toBe('b');
  });

  it('returns null when NO member has a usable tbr', () => {
    expect(recommendFormat([f('a', 'h264', 'none'), f('b', 'h264', 'none', { tbr: Number.NaN })])).toBeNull();
    expect(recommendFormat([])).toBeNull();
    expect(recommendFormat(null as unknown as MediaFormat[])).toBeNull();
  });

  it('skips entries with missing tbr but still picks a ranked one', () => {
    expect(recommendFormat([f('a', 'h264', 'none'), f('b', 'h264', 'none', { tbr: 5 })])?.format_id).toBe('b');
  });
});

describe('B1 FormatSelector · sumSelectedBytes', () => {
  it('sums filesize ?? filesize_approx and skips unknowns', () => {
    expect(sumSelectedBytes([
      f('a', 'h264', 'none', { filesize: 100 }),
      f('b', 'h264', 'none', { filesize_approx: 250 }),
      f('c', 'h264', 'none'),
    ])).toBe(350);
  });

  it('returns null ("—") when ALL sizes are missing', () => {
    expect(sumSelectedBytes([f('a', 'h264', 'none')])).toBeNull();
    expect(sumSelectedBytes([])).toBeNull();
    expect(sumSelectedBytes(null as unknown as MediaFormat[])).toBeNull();
  });

  it('ignores negative / non-finite sizes', () => {
    expect(sumSelectedBytes([
      f('a', 'h264', 'none', { filesize: -5 }),
      f('b', 'h264', 'none', { filesize: Number.POSITIVE_INFINITY }),
    ])).toBeNull();
  });
});

describe('B1 FormatSelector · selectFormats (R4 + P3 + A-M3-02)', () => {
  const mixed = media([
    f('137', 'h264', 'none', { filesize: 1000, tbr: 800 }),
    f('251', 'none', 'opus', { filesize: 100, tbr: 128 }),
    f('250', 'none', 'opus', { filesize: 90, tbr: 64 }),
    f('22', 'h264', 'aac', { filesize: 2000, tbr: 500 }),
  ]);

  it('builds -f 137+251+250 with total bytes and audioMultistreams=true', () => {
    const result = selectFormats(mixed, current, sel({
      videoFormatId: '137', audioFormatIds: ['251', '250'],
      quality: '1080p', audioFormat: 'mp3', sortingFields: 'res:720',
    }));
    expect(result.format.formatId).toBe('137+251+250');
    expect(result.totalBytes).toBe(1190);
    expect(result.audioOnlyCount).toBe(2);
    expect(result.format.audioMultistreams).toBe(true);
    expect(result.format.extractAudio).toBe(false);
    expect(result.format.quality).toBe('1080p');
    expect(result.format.audioFormat).toBe('mp3');
    expect(result.format.sortingFields).toBe('res:720');
  });

  it('R4: one audio-only format corrects audioMultistreams back to false', () => {
    const result = selectFormats(
      mixed,
      { ...current, audioMultistreams: true },
      sel({ videoFormatId: '137', audioFormatIds: ['251'] }),
    );
    expect(result.audioOnlyCount).toBe(1);
    expect(result.format.audioMultistreams).toBe(false);
    expect(result.warnings.join(' ')).toContain('R4');
  });

  it('R4: two audio-only formats enable multistreams', () => {
    const result = selectFormats(mixed, current, sel({ videoFormatId: null, audioFormatIds: ['251', '250'] }));
    expect(result.format.audioMultistreams).toBe(true);
    expect(result.format.extractAudio).toBe(true);
  });

  it('unknown format ids produce FORMAT_UNAVAILABLE warnings but no crash', () => {
    const result = selectFormats(mixed, current, sel({ videoFormatId: '999', audioFormatIds: ['missing'] }));
    expect(result.warnings.some((w) => w.includes('FORMAT_UNAVAILABLE: 999'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('FORMAT_UNAVAILABLE: missing'))).toBe(true);
    expect(result.totalBytes).toBeNull();
  });

  it('empty selection yields formatId=null / totalBytes=null / extractAudio=false', () => {
    const result = selectFormats(media([]), current, sel());
    expect(result.format.formatId).toBeNull();
    expect(result.totalBytes).toBeNull();
    expect(result.audioOnlyCount).toBe(0);
    expect(result.format.extractAudio).toBe(false);
  });

  it('skips empty audio ids', () => {
    const result = selectFormats(mixed, current, sel({ audioFormatIds: ['', '251'] }));
    expect(result.format.formatId).toBe('251');
    expect(result.audioOnlyCount).toBe(1);
  });
});
