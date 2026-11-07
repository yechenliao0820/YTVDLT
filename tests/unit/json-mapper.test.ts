/**
 * A-INF-08 / A-4.1-04 · JsonMapper pure mapping, no throw, no network, no spawn.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  toMediaInfo, toPlaylistInfo, mapProbeResult, isRecord, numOrNull,
  strOrNull, asArray, firstString,
} from '@ytvdlt/engine-ytdlp';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'));

describe('A-INF-08 JsonMapper · full field mapping', () => {
  it('maps every MediaInfo field with correct types from info-video.json', () => {
    const info = toMediaInfo(fixture('info-video.json'));
    expect(info.id).toBe('dQw4w9WgXcQ');
    expect(info.title).toBe('Recorded Fixture Video');
    expect(info.uploader).toBe('Fixture Channel');
    expect(info.uploader_id).toBe('UC_fixture');
    expect(info.duration).toBe(212);
    expect(info.thumbnail).toBe('https://example.org/thumb.jpg');
    expect(info.webpage_url).toBe('https://example.org/watch?v=dQw4w9WgXcQ');
    expect(info.extractor_key).toBe('generic');
    expect(info.description).toContain('offline');
    expect(info.upload_date).toBe('20261105');
    expect(info.ext).toBe('mp4');
    expect(info._type).toBe('video');
    expect(info.formats).toHaveLength(2);
    expect(info.formats[0]?.format_id).toBe('137');
    expect(info.formats[0]?.width).toBe(1920);
    expect(info.formats[1]?.filesize).toBeNull();
    expect(info.subtitles['en']?.[0]?.ext).toBe('vtt');
    expect(info.subtitles['zh-Hans']?.[0]?.name).toBeNull();
    expect(info.automatic_captions['en']?.[0]?.ext).toBe('vtt');
    expect(info.chapters).toHaveLength(2);
    expect(info.chapters?.[0]?.title).toBe('Intro');
  });

  it('maps flat-playlist JSON to PlaylistInfo with 3 entries', () => {
    const playlist = toPlaylistInfo(fixture('info-flat-playlist.json'));
    expect(playlist._type).toBe('playlist');
    expect(playlist.id).toBe('PL_fixture_01');
    expect(playlist.entries).toHaveLength(3);
    expect(playlist.entries[1]?.title).toBe('Episode 2');
    expect(playlist.entries[2]?.duration).toBeNull();
    expect(mapProbeResult(fixture('info-flat-playlist.json'))).toMatchObject({ _type: 'playlist' });
  });

  it('mapProbeResult dispatches by _type', () => {
    expect(mapProbeResult(fixture('info-video.json'))).toMatchObject({ _type: 'video' });
    expect(mapProbeResult(null)).toMatchObject({ _type: 'video', id: '' });
  });
});

describe('A-INF-08 JsonMapper · defensive fallbacks (never throws)', () => {
  it('fills defaults for a minimal / malformed / null payload', () => {
    for (const raw of [fixture('info-minimal.json'), null, undefined, 42, 'text', [], {}]) {
      expect(() => toMediaInfo(raw)).not.toThrow();
      const info = toMediaInfo(raw);
      expect(typeof info.id).toBe('string');
      expect(typeof info.title).toBe('string');
      expect(Array.isArray(info.formats)).toBe(true);
      expect(info.subtitles).toEqual({});
      expect(info.automatic_captions).toEqual({});
      expect(info.chapters).toBeNull();
      expect(info.duration).toBeNull();
    }
  });

  it('falls back through uploader/channel/creator and webpage_url/original_url/url', () => {
    const info = toMediaInfo({
      id: 'x', channel: 'Fallback Channel', channel_id: 'UC_fallback',
      original_url: 'https://example.org/original', url: 'https://example.org/direct',
    });
    expect(info.uploader).toBe('Fallback Channel');
    expect(info.uploader_id).toBe('UC_fallback');
    expect(info.webpage_url).toBe('https://example.org/original');
    expect(info.title).toBe('generic:x');
  });

  it('derives ext from formats[0] and thumbnail from thumbnails[last]', () => {
    const info = toMediaInfo({
      id: 'y', formats: [{ format_id: '1', ext: 'webm' }],
      thumbnails: [{ url: 'first.jpg' }, { url: 'last.jpg' }],
    });
    expect(info.ext).toBe('webm');
    expect(info.thumbnail).toBe('last.jpg');
  });

  it('skips malformed format/subtitle/chapter entries and invalid upload_date', () => {
    const info = toMediaInfo({
      id: 'z', upload_date: '2026-11-05',
      formats: [null, 5, { format_id: 'ok', ext: 'mp4' }],
      subtitles: { en: [null, { ext: 'srt' }], bad: 'not-an-array' },
      chapters: [null, { start_time: -1, end_time: 5 }, { start_time: 0, end_time: 10, title: 'OK' }],
    });
    expect(info.formats).toHaveLength(1);
    expect(info.subtitles['en']).toHaveLength(1);
    expect(info.subtitles['bad']).toBeUndefined();
    expect(info.chapters).toHaveLength(1);
    expect(info.upload_date).toBeNull();
  });

  it('media-guards are pure and total', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(asArray('x')).toEqual([]);
    expect(numOrNull(Infinity)).toBeNull();
    expect(numOrNull('5')).toBeNull();
    expect(strOrNull('')).toBeNull();
    expect(firstString({ a: null, b: 'found' }, ['a', 'b'])).toBe('found');
  });
});
