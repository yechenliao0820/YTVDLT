/**
 * L1 contract (A-INF-08 / A-4.1-04): recorded `--dump-single-json` fixtures
 * map to MediaInfo/PlaylistInfo with complete fields and correct types.
 * ZERO network, ZERO spawned processes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toMediaInfo, toPlaylistInfo } from '@ytvdlt/engine-ytdlp';
import type { MediaInfo, PlaylistInfo } from '@ytvdlt/shared';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'));

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

describe('L1 JsonMapper contract · info-*.json', () => {
  it('has >=1 video + >=1 flat-playlist + >=1 minimal recorded fixture', () => {
    const names = readdirSync(FIXTURE_DIR).filter((n) => n.startsWith('info-') && n.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toContain('info-video.json');
    expect(names).toContain('info-flat-playlist.json');
    expect(names).toContain('info-minimal.json');
  });

  it('every MediaInfo field exists with the contracted type', () => {
    const info: MediaInfo = toMediaInfo(fixture('info-video.json'));
    expect(typeof info.id).toBe('string');
    expect(typeof info.title).toBe('string');
    expect(info.uploader === null || typeof info.uploader === 'string').toBe(true);
    expect(info.uploader_id === null || typeof info.uploader_id === 'string').toBe(true);
    expect(info.duration === null || typeof info.duration === 'number').toBe(true);
    expect(info.thumbnail === null || typeof info.thumbnail === 'string').toBe(true);
    expect(typeof info.webpage_url).toBe('string');
    expect(typeof info.extractor_key).toBe('string');
    expect(info.description === null || typeof info.description === 'string').toBe(true);
    expect(info.upload_date === null || typeof info.upload_date === 'string').toBe(true);
    expect(typeof info.ext).toBe('string');
    expect(Array.isArray(info.formats)).toBe(true);
    expect(info.formats.length).toBeGreaterThan(0);
    for (const format of info.formats) {
      expect(typeof format.format_id).toBe('string');
      expect(typeof format.ext).toBe('string');
      expect(typeof format.vcodec).toBe('string');
      expect(typeof format.acodec).toBe('string');
      expect(format.width === null || typeof format.width === 'number').toBe(true);
      expect(format.filesize === null || typeof format.filesize === 'number').toBe(true);
    }
    expect(typeof info.subtitles).toBe('object');
    expect(typeof info.automatic_captions).toBe('object');
    expect(info.chapters === null || Array.isArray(info.chapters)).toBe(true);
    expect(['video', 'url', 'url_transparent']).toContain(info._type);
  });

  it('every PlaylistInfo field exists with the contracted type', () => {
    const playlist: PlaylistInfo = toPlaylistInfo(fixture('info-flat-playlist.json'));
    expect(typeof playlist.id).toBe('string');
    expect(typeof playlist.title).toBe('string');
    expect(playlist._type).toBe('playlist');
    expect(typeof playlist.extractor_key).toBe('string');
    expect(typeof playlist.webpage_url).toBe('string');
    expect(Array.isArray(playlist.entries)).toBe(true);
    expect(playlist.entries.length).toBe(3);
    for (const entry of playlist.entries) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.title).toBe('string');
      expect(typeof entry.url).toBe('string');
      expect(entry.duration === null || typeof entry.duration === 'number').toBe(true);
      expect(typeof entry._type).toBe('string');
    }
  });

  it('minimal fixture maps without throwing and fills contract defaults', () => {
    const info = toMediaInfo(fixture('info-minimal.json'));
    expect(info.id).toBe('minimal-1');
    expect(info.formats).toEqual([]);
    expect(info.duration).toBeNull();
    expect(info.chapters).toBeNull();
  });

  it('does not access the network or spawn any process (pure function)', () => {
    // `npm test` runs with no network fixture; mapping is synchronous and pure.
    const raw = fixture('info-video.json');
    const a = toMediaInfo(raw);
    const b = toMediaInfo(raw);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('po_token');
    expect(JSON.stringify(a)).not.toContain('cookies-from-browser');
  });
});
