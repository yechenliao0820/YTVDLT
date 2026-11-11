/**
 * Playlist preview ticket store — the four invariants borrowed from the
 * existing SubtitlePreviewCache, proved against the REAL class.
 */
import { describe, it, expect } from 'vitest';
import {
  PlaylistPreviewCache, DEFAULT_PLAYLIST_PREVIEW_TTL_MS,
  DEFAULT_PREVIEW_TTL_MS,
} from '@ytvdlt/core';
import type { PlaylistInfo } from '@ytvdlt/shared';

const URL_A = 'https://example.org/playlist?list=AAA';
const URL_B = 'https://example.org/playlist?list=BBB';

function info(count = 3): PlaylistInfo {
  return {
    id: 'PL_AAA', title: 'GTA collection', _type: 'playlist',
    extractor_key: 'generic', webpage_url: URL_A,
    entries: Array.from({ length: count }, (_v, i) => ({
      id: `a${i + 1}`, title: `Episode ${i + 1}`,
      url: `https://cdn.example.org/v${i + 1}?sig=SECRET${i + 1}`,
      duration: 100 + i, _type: 'url',
    })),
  };
}

function cache(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
  let clock = options.now === undefined ? 1_000 : 0;
  const now = options.now ?? (() => clock);
  const store = new PlaylistPreviewCache({
    now,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  return { store, advance: (ms: number) => { clock += ms; } };
}

describe('PlaylistPreviewCache · reuses the existing preview contract', () => {
  it('has the SAME 5-minute TTL as SubtitlePreviewCache', () => {
    expect(DEFAULT_PLAYLIST_PREVIEW_TTL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_PLAYLIST_PREVIEW_TTL_MS).toBe(DEFAULT_PREVIEW_TTL_MS);
    expect(cache().store.ttlMs).toBe(5 * 60 * 1000);
  });

  it('stores and consumes a ticket once', () => {
    const { store } = cache();
    const entry = store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    expect(entry.playlist.entries).toHaveLength(3);
    expect(store.size).toBe(1);
    expect(store.consume('ticket-0001', URL_A).ok).toBe(true);
    expect(store.size).toBe(0);
  });

  it('a replay is PREVIEW_CONSUMED, not a second batch', () => {
    const { store } = cache();
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    store.consume('ticket-0001', URL_A);
    const replay = store.consume('ticket-0001', URL_A);
    expect(replay).toEqual({ ok: false, code: 'PREVIEW_CONSUMED' });
  });

  it('a ticket CANNOT be used across URLs, and a mismatch does not burn it', () => {
    const { store } = cache();
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    expect(store.consume('ticket-0001', URL_B)).toEqual({
      ok: false, code: 'PREVIEW_URL_MISMATCH',
    });
    expect(store.size).toBe(1);
    expect(store.consume('ticket-0001', URL_A).ok).toBe(true);
  });

  it('expires after the TTL', () => {
    let clock = 0;
    const { store } = cache({ now: () => clock, ttlMs: 5_000 });
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    clock = 5_000;
    expect(store.peek('ticket-0001')).toEqual({ ok: false, code: 'PREVIEW_EXPIRED' });
    expect(store.size).toBe(0);
  });

  it('unknown ids and cancelled tickets are refused', () => {
    const { store } = cache();
    expect(store.peek('ticket-unknown')).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    expect(store.cancel('ticket-0001')).toBe(true);
    expect(store.consume('ticket-0001', URL_A)).toEqual({
      ok: false, code: 'PREVIEW_UNKNOWN',
    });
  });

  it('clear() drops everything (window close / app quit)', () => {
    const { store } = cache();
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    store.put({ id: 'ticket-0002', urlKey: URL_B, playlist: info() });
    store.clear();
    expect(store.size).toBe(0);
    expect(store.consume('ticket-0001', URL_A).ok).toBe(false);
  });

  it('evicts the oldest ticket at the capacity ceiling', () => {
    const { store } = cache({ maxEntries: 2 });
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    store.put({ id: 'ticket-0002', urlKey: URL_A, playlist: info() });
    store.put({ id: 'ticket-0003', urlKey: URL_A, playlist: info() });
    expect(store.size).toBe(2);
    expect(store.peek('ticket-0001')).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
    expect(store.peek('ticket-0003').ok).toBe(true);
  });

  it('peek() is read-only; purgeExpired() only removes stale tickets', () => {
    let clock = 0;
    const { store } = cache({ now: () => clock, ttlMs: 10_000 });
    store.put({ id: 'ticket-0001', urlKey: URL_A, playlist: info() });
    expect(store.peek('ticket-0001').ok).toBe(true);
    expect(store.peek('ticket-0001').ok).toBe(true);
    clock = 11_000;
    expect(store.purgeExpired()).toBe(1);
    expect(store.size).toBe(0);
  });
});
