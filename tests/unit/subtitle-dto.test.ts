/**
 * Stage 4 · what the renderer is allowed to know about subtitles.
 *
 * Phase 5 must not have to parse file names: the DTO carries the language,
 * the format and the source bucket, and it keeps saying "unknown" for records
 * that never had this information (an old `tasks.json`), never "guessed".
 */
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '@ytvdlt/shared';
import { toTaskDetail, toTaskListItem } from '../../apps/desktop/src/main/m5-channels.js';

const SIGNED_URL = 'https://example.org/watch?v=abc&token=SUPERSECRET';

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    url: SIGNED_URL,
    kind: 'video',
    state: 'Completed',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    mediaInfo: {
      id: 'v', title: 'Video', uploader: 'Uploader', uploader_id: null, duration: 120,
      thumbnail: null, webpage_url: SIGNED_URL, extractor_key: 'generic', description: null,
      upload_date: null, ext: 'mp4', formats: [], subtitles: {}, automatic_captions: {},
      chapters: null, _type: 'video',
    },
    request: null,
    artifacts: ['C:/out/Clip [id].mp4', 'C:/out/Clip [id].en.srt', 'C:/out/Clip [id].zh-Hans.srt'],
    lastPercent: 100,
    error: null,
    privateMode: false,
    postprocessed: false,
    subtitleFiles: [
      { path: 'C:/out/Clip [id].en.srt', language: 'en', ext: 'srt', source: 'manual', mediaPath: 'C:/out/Clip [id].mp4' },
      { path: 'C:/out/Clip [id].zh-Hans.srt', language: 'zh-Hans', ext: 'srt', source: 'manual', mediaPath: 'C:/out/Clip [id].mp4' },
    ],
    subtitleOutcome: 'ok',
    ...overrides,
  };
}

describe('stage 4 · subtitle fields in the IPC DTOs', () => {
  it('exposes count, languages and outcome on the list item', () => {
    const dto = toTaskListItem(record());
    expect(dto.subtitleCount).toBe(2);
    expect(dto.subtitleLanguages).toEqual(['en', 'zh-Hans']);
    expect(dto.subtitleOutcome).toBe('ok');
    // Unchanged contract: the list still carries no URL.
    expect(Object.keys(dto)).not.toContain('url');
  });

  it('omits the fields entirely for a record that predates them', () => {
    const dto = toTaskListItem(record({ subtitleFiles: undefined, subtitleOutcome: undefined }));
    expect(dto.subtitleCount).toBeUndefined();
    expect(dto.subtitleOutcome).toBeUndefined();
    expect(Object.keys(dto)).not.toContain('subtitleLanguages');
  });

  it('de-duplicates languages but keeps one entry per file', () => {
    const dto = toTaskListItem(record({
      subtitleFiles: [
        { path: 'C:/out/a.en.srt', language: 'en', ext: 'srt', source: 'manual', mediaPath: 'C:/out/a.mp4' },
        { path: 'C:/out/a.en.vtt', language: 'en', ext: 'vtt', source: 'manual', mediaPath: 'C:/out/a.mp4' },
      ],
    }));
    expect(dto.subtitleCount).toBe(2);
    expect(dto.subtitleLanguages).toEqual(['en']);
  });

  it('uses an empty language list when no file name carried one', () => {
    const dto = toTaskListItem(record({
      subtitleFiles: [
        { path: 'C:/out/mystery.srt', language: '', ext: 'srt', source: 'unknown', mediaPath: '' },
      ],
    }));
    expect(dto.subtitleLanguages).toEqual([]);
    expect(dto.subtitleCount).toBe(1);
  });

  it('adds language / format / source to the detail DTO and still masks the URL', () => {
    const dto = toTaskDetail(record());
    expect(dto.subtitleFiles).toEqual([
      { path: 'C:/out/Clip [id].en.srt', language: 'en', ext: 'srt', source: 'manual' },
      { path: 'C:/out/Clip [id].zh-Hans.srt', language: 'zh-Hans', ext: 'srt', source: 'manual' },
    ]);
    expect(dto.subtitleOutcome).toBe('ok');
    expect(dto.url).not.toContain('SUPERSECRET');
  });
});
