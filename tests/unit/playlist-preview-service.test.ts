/**
 * Playlist preview service · the display-safe DTO and the ticket lifecycle.
 *
 * The critical assertion: `PlaylistPreviewDto` contains NO entry URL. Signed
 * download links live only in the main-process cache and are consumed there.
 */
import { describe, it, expect } from 'vitest';
import { MAX_PLAYLIST_ITEMS, type PlaylistInfo } from '@ytvdlt/shared';
import type { PlaylistPreviewEntry } from '@ytvdlt/core';
import {
  PlaylistPreviewService, toPlaylistPreviewDto, failedPlaylistPreview,
  mapPlaylistProbeError, isPlaylistEntryAvailable,
} from '../../apps/desktop/src/main/playlist-preview-service.js';

const URL_A = 'https://www.youtube.com/playlist?list=PL_GTA_65';
const URL_B = 'https://www.youtube.com/playlist?list=PL_OTHER';

function info(count: number, options: {
  declared?: number | null;
  skipped?: number;
  missingUrlAt?: readonly number[];
  noDuration?: boolean;
} = {}): PlaylistInfo {
  const missing = new Set(options.missingUrlAt ?? []);
  return {
    id: 'PL_GTA_65',
    title: 'GTA 游戏合集',
    _type: 'playlist',
    extractor_key: 'youtube:playlist',
    webpage_url: URL_A,
    ...(options.declared === undefined ? {} : { playlistCount: options.declared }),
    ...(options.skipped === undefined ? {} : { skippedEntries: options.skipped }),
    entries: Array.from({ length: count }, (_v, i) => ({
      id: `ep${i + 1}`,
      title: `第 ${String(i + 1).padStart(2, '0')} 集 GTA 第 ${i + 1} 章`,
      url: missing.has(i) ? '' : `https://cdn.example.org/v${i + 1}?sig=SUPERSECRET${i + 1}`,
      duration: options.noDuration === true ? null : 600 + i,
      _type: 'url',
    })),
  };
}

function entry(playlist: PlaylistInfo, id = 'preview-ticket-0001'): PlaylistPreviewEntry {
  return { id, urlKey: URL_A, playlist, createdAtMs: 1_000, expiresAtMs: 301_000 };
}

function svc(options: {
  probe?: (url: string) => Promise<PlaylistInfo>;
  now?: () => number;
  id?: () => string;
  maxItems?: number;
} = {}) {
  let seq = 0;
  const probes: string[] = [];
  const service = new PlaylistPreviewService({
    probe: options.probe ?? (async (url) => { probes.push(url); return info(3); }),
    clock: { nowEpochMs: options.now ?? (() => 1_000) },
    newId: options.id ?? (() => `preview-ticket-${String(++seq).padStart(4, '0')}`),
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
  });
  return { service, probes };
}

describe('PlaylistPreviewDto · honest counts and no URL leaks', () => {
  it('reports declared / fetched / available / unavailable separately for 65 entries', () => {
    const dto = toPlaylistPreviewDto(entry(info(65, {
      declared: 65, skipped: 2, missingUrlAt: [3, 9],
    })));
    expect(dto.declaredCount).toBe(65);
    expect(dto.fetchedCount).toBe(65);
    expect(dto.availableCount).toBe(63);
    expect(dto.unavailableCount).toBe(4); // 2 URL-less + 2 skipped by mapper
    expect(dto.entries).toHaveLength(65);
    expect(dto.entries[0]?.position).toBe(1);
    expect(dto.entries[64]?.position).toBe(65);
    expect(dto.entries[3]?.available).toBe(false);
    expect(dto.truncated).toBe(false);
  });

  it('never claims 65 when only 20 entries were parsed', () => {
    const dto = toPlaylistPreviewDto(entry(info(20, { declared: 65 })));
    expect(dto.declaredCount).toBe(65);
    expect(dto.fetchedCount).toBe(20);
    expect(dto.entries).toHaveLength(20);
    expect(dto.ok).toBe(true);
  });

  it('leaks NO entry URL, no signature and no raw extractor payload', () => {
    const dto = toPlaylistPreviewDto(entry(info(5, { declared: 5 })));
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('cdn.example.org');
    expect(serialized).not.toContain('"url"');
    expect(dto.entries[0] && 'url' in dto.entries[0]).toBe(false);
    expect(serialized).not.toContain('webpage_url');
  });

  it('sanitises control characters and bounds display text', () => {
    const playlist = info(1);
    playlist.title = `GTA\u0001${'x'.repeat(400)}`;
    playlist.entries[0]!.title = `Ep\u007f${'y'.repeat(400)}`;
    const dto = toPlaylistPreviewDto(entry(playlist));
    expect(dto.title.length).toBeLessThanOrEqual(200);
    expect(dto.title).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(dto.entries[0]?.title.length).toBeLessThanOrEqual(200);
  });

  it('marks truncation at the 500-item boundary without silently dropping the count', () => {
    expect(MAX_PLAYLIST_ITEMS).toBe(500);
    const dto = toPlaylistPreviewDto(entry(info(503, { declared: 503 })), 500);
    expect(dto.fetchedCount).toBe(503);
    expect(dto.entries).toHaveLength(500);
    expect(dto.truncated).toBe(true);
  });

  it('sums durations when known and reports null when none are known', () => {
    const known = toPlaylistPreviewDto(entry(info(3)));
    expect(known.totalDurationSec).toBe(600 + 601 + 602);
    expect(toPlaylistPreviewDto(entry(info(3, { noDuration: true }))).totalDurationSec).toBeNull();
  });

  it('isPlaylistEntryAvailable only accepts a non-empty own URL', () => {
    expect(isPlaylistEntryAvailable({ url: 'https://x/v' })).toBe(true);
    expect(isPlaylistEntryAvailable({ url: '' })).toBe(false);
    expect(isPlaylistEntryAvailable({})).toBe(false);
  });
});

describe('PlaylistPreviewService · errors and ticket lifecycle', () => {
  it('rejects an invalid URL before any probe', async () => {
    const { service, probes } = svc();
    const dto = await service.preview('file:///C:/a.mp4');
    expect(dto).toMatchObject({ ok: false, code: 'INVALID_URL' });
    expect(probes).toEqual([]);
  });

  it('maps probe failures into stable buckets (never stderr text)', async () => {
    expect(mapPlaylistProbeError({ code: 'UNSUPPORTED_SITE' }, false)).toBe('NOT_PLAYLIST');
    expect(mapPlaylistProbeError({ code: 'UNSUPPORTED_SITE' }, true)).toBe('UNSUPPORTED_SITE');
    expect(mapPlaylistProbeError({ code: 'TIMEOUT' }, true)).toBe('TIMEOUT');
    expect(mapPlaylistProbeError({ code: 'ENOTFOUND' }, true)).toBe('NETWORK_ERROR');
    expect(mapPlaylistProbeError({ code: 'WHATEVER', message: 'https://x/v?token=SECRET' }, true))
      .toBe('PROBE_FAILED');
    expect(JSON.stringify(failedPlaylistPreview('PROBE_FAILED'))).not.toContain('SECRET');
  });

  it('reports EMPTY_PLAYLIST when the probe returned zero entries', async () => {
    const { service } = svc({ probe: async () => info(0) });
    expect(await service.preview(URL_A)).toMatchObject({ ok: false, code: 'EMPTY_PLAYLIST' });
  });

  it('a URL that is not a playlist maps to NOT_PLAYLIST', async () => {
    const { service } = svc({
      probe: async () => { throw { code: 'UNSUPPORTED_SITE' }; },
    });
    const dto = await service.preview('https://www.youtube.com/watch?v=abc');
    expect(dto.code).toBe('NOT_PLAYLIST');
  });

  it('two rapid previews of one URL share a single live probe', async () => {
    const resolvers: Array<(value: PlaylistInfo) => void> = [];
    let calls = 0;
    const { service } = svc({
      probe: () => {
        calls += 1;
        return new Promise<PlaylistInfo>((resolve) => { resolvers.push(resolve); });
      },
    });
    const a = service.preview(URL_A);
    const b = service.preview(URL_A);
    expect(calls).toBe(1);
    resolvers[0]?.(info(3));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
  });

  it('consume is URL-bound, single-use and does not burn on mismatch', async () => {
    const { service } = svc({ probe: async () => info(3) });
    const dto = await service.preview(URL_A);
    expect(service.consume(dto.previewId, URL_B)).toMatchObject({
      ok: false, code: 'PREVIEW_URL_MISMATCH',
    });
    const consumed = service.consume(dto.previewId, URL_A);
    expect(consumed.ok).toBe(true);
    expect(consumed.playlist?.entries).toHaveLength(3);
    expect(service.consume(dto.previewId, URL_A)).toMatchObject({
      ok: false, code: 'PREVIEW_CONSUMED',
    });
  });

  it('cancel releases the ticket; clear drops everything (app quit)', async () => {
    const { service } = svc();
    const dto = await service.preview(URL_A);
    expect(await service.cancel(dto.previewId)).toBe(true);
    expect(service.consume(dto.previewId, URL_A).ok).toBe(false);
    const other = await service.preview(URL_B);
    service.clear();
    expect(service.consume(other.previewId, URL_B).ok).toBe(false);
  });

  it('a changed URL releases the previous ticket', async () => {
    const { service } = svc();
    const first = await service.preview(URL_A);
    const second = await service.preview(URL_B, first.previewId);
    expect(service.peek(first.previewId).ok).toBe(false);
    expect(second.previewId).not.toBe(first.previewId);
  });
});
