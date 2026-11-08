/**
 * D-101: repeated downloads get their own numbered name instead of an error.
 * Pure functions, no filesystem.
 *
 * The separator is `_` on purpose: the queue sanitises the output template
 * (whitespace → `_`) before yt-dlp sees it, so ` (1)` would land on disk as
 * `_(1)` anyway. Emitting the final form keeps detection and generation
 * symmetric — the real file in the report was `BBC_News_[jBfrX44Y-8s].webm`.
 */
import { describe, expect, it } from 'vitest';
import { applyCopySuffix, nextCopySuffix } from '@ytvdlt/core';

describe('copy suffix · nextCopySuffix', () => {
  it('returns an empty suffix when nothing for this id exists yet', () => {
    expect(nextCopySuffix([], 'jBfrX44Y-8s')).toBe('');
    expect(nextCopySuffix(['Other_[zzz].mp4'], 'jBfrX44Y-8s')).toBe('');
  });

  it('starts at _1 when only the plain file exists', () => {
    expect(nextCopySuffix(['BBC_News_[jBfrX44Y-8s].webm'], 'jBfrX44Y-8s')).toBe('_(1)');
  });

  it('continues after the highest existing copy', () => {
    const names = ['A_[id].webm', 'A_[id]_(1).webm', 'B_[other].mp4'];
    expect(nextCopySuffix(names, 'id')).toBe('_(2)');
    expect(nextCopySuffix(['A_[id]_(3).mp4'], 'id')).toBe('_(4)');
  });

  it('also reads names that kept the literal space', () => {
    // Older/foreign files may still be ` (1)`; they must not trigger a collision.
    expect(nextCopySuffix(['A_[id] (1).mp4'], 'id')).toBe('_(2)');
  });

  it('ignores other ids, even when the numbers match', () => {
    expect(nextCopySuffix(['X_[other]_(7).mp4'], 'id')).toBe('');
  });

  it('counts subtitles and thumbnails of the same id as one family', () => {
    const mixed = ['A_[id].webm', 'A_[id]_(1).webm', 'A_[id]_(1).en.vtt', 'A_[id]_(1).jpg'];
    expect(nextCopySuffix(mixed, 'id')).toBe('_(2)');
  });

  it('does not mistake a year in the title for a copy number', () => {
    expect(nextCopySuffix(['News_(2024)_[id].mp4'], 'id')).toBe('_(1)');
  });

  it('is case-sensitive on the id and tolerant of an empty id', () => {
    expect(nextCopySuffix(['A_[ID].mp4'], 'id')).toBe('');
    expect(nextCopySuffix(['A_[id].mp4'], '')).toBe('');
  });
});

describe('copy suffix · applyCopySuffix', () => {
  it('inserts before the extension placeholder', () => {
    expect(applyCopySuffix('%(title).200B [%(id)s].%(ext)s', '_(1)'))
      .toBe('%(title).200B [%(id)s]_(1).%(ext)s');
  });

  it('keeps a suffix-less template untouched', () => {
    expect(applyCopySuffix('%(title)s.%(ext)s', '')).toBe('%(title)s.%(ext)s');
  });

  it('handles a template that does not end with the placeholder', () => {
    expect(applyCopySuffix('%(id)s/%(title)s.%(ext)s.part', '_(2)'))
      .toBe('%(id)s/%(title)s_(2).%(ext)s.part');
  });

  it('refuses templates with no extension placeholder', () => {
    expect(applyCopySuffix('%(title)s', '_(1)')).toBeNull();
  });
});
