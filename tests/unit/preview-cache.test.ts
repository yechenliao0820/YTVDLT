/**
 * Subtitle preview · ticket cache (stage 2).
 *
 * The four properties that make the ticket safe are each pinned here: URL
 * binding, single use, TTL, and a hard capacity ceiling. A regression in any of
 * them would let a renderer replay a signed subtitle URL that the main process
 * already handed out once.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PREVIEW_TTL_MS, SubtitlePreviewCache,
} from '@ytvdlt/core';
import { mediaInfo } from './helpers/subtitle-media.js';

const URL_A = 'https://example.org/watch?v=aaa';
const URL_B = 'https://example.org/watch?v=bbb';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => { value += ms; },
    set: (ms: number) => { value = ms; },
  };
}

function cacheWith(options: { ttlMs?: number; maxEntries?: number } = {}): {
  cache: SubtitlePreviewCache;
  time: ReturnType<typeof clock>;
} {
  const time = clock();
  return {
    time,
    cache: new SubtitlePreviewCache({
      now: time.now,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    }),
  };
}

describe('subtitle preview cache · normal flow', () => {
  it('stores a ticket and returns the same entry on peek', () => {
    const { cache } = cacheWith();
    const media = mediaInfo();
    const entry = cache.put({ id: 'ticket-0001', urlKey: URL_A, media, tracks: [] });
    expect(entry.expiresAtMs - entry.createdAtMs).toBe(DEFAULT_PREVIEW_TTL_MS);
    const found = cache.peek('ticket-0001');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entry.media).toBe(media);
    expect(found.entry.urlKey).toBe(URL_A);
    expect(cache.size).toBe(1);
  });

  it('consumes exactly once and remembers that it was consumed', () => {
    const { cache } = cacheWith();
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });

    const first = cache.consume('ticket-0001', URL_A);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.entry.id).toBe('ticket-0001');
    expect(cache.size).toBe(0);

    const replay = cache.consume('ticket-0001', URL_A);
    expect(replay).toEqual({ ok: false, code: 'PREVIEW_CONSUMED' });
  });

  it('answers PREVIEW_UNKNOWN for an id that was never issued', () => {
    const { cache } = cacheWith();
    expect(cache.consume('never-issued-1', URL_A)).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
    expect(cache.peek('never-issued-1')).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
  });
});

describe('subtitle preview cache · expiry', () => {
  it('expires after the TTL and deletes the entry', () => {
    const { cache, time } = cacheWith({ ttlMs: 5_000 });
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });

    time.advance(4_999);
    expect(cache.peek('ticket-0001').ok).toBe(true);

    time.advance(1);
    expect(cache.consume('ticket-0001', URL_A)).toEqual({ ok: false, code: 'PREVIEW_EXPIRED' });
    expect(cache.size).toBe(0);
  });

  it('purgeExpired reports what it removed and keeps live tickets', () => {
    const { cache, time } = cacheWith({ ttlMs: 1_000 });
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    time.advance(600);
    cache.put({ id: 'ticket-0002', urlKey: URL_B, media: mediaInfo(), tracks: [] });

    time.advance(500); // first is 1100ms old, second is 500ms old
    expect(cache.purgeExpired()).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.peek('ticket-0002').ok).toBe(true);
  });

  it('forgets an expired tombstone so the id reads as unknown again', () => {
    const { cache, time } = cacheWith({ ttlMs: 1_000 });
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    expect(cache.consume('ticket-0001', URL_A).ok).toBe(true);
    time.advance(1_000);
    cache.purgeExpired();
    expect(cache.peek('ticket-0001')).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
  });
});

describe('subtitle preview cache · URL binding', () => {
  it('refuses a mismatched URL without burning the ticket', () => {
    const { cache } = cacheWith();
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });

    expect(cache.consume('ticket-0001', URL_B)).toEqual({ ok: false, code: 'PREVIEW_URL_MISMATCH' });
    // The rightful caller can still spend it — a stray call must not be a DoS.
    expect(cache.size).toBe(1);
    expect(cache.consume('ticket-0001', URL_A).ok).toBe(true);
  });

  it('requires an exact URL (no trailing-slash or case folding)', () => {
    const { cache } = cacheWith();
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    expect(cache.consume('ticket-0001', `${URL_A}&t=1`)).toEqual({ ok: false, code: 'PREVIEW_URL_MISMATCH' });
    expect(cache.consume('ticket-0001', `${URL_A}/`)).toEqual({ ok: false, code: 'PREVIEW_URL_MISMATCH' });
    expect(cache.consume('ticket-0001', URL_A).ok).toBe(true);
  });
});

describe('subtitle preview cache · release paths', () => {
  it('cancel removes the ticket and a later consume is unknown', () => {
    const { cache } = cacheWith();
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    expect(cache.cancel('ticket-0001')).toBe(true);
    expect(cache.cancel('ticket-0001')).toBe(false);
    expect(cache.consume('ticket-0001', URL_A)).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
  });

  it('clear() drops tickets and tombstones (app quit)', () => {
    const { cache } = cacheWith();
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    cache.put({ id: 'ticket-0002', urlKey: URL_B, media: mediaInfo(), tracks: [] });
    expect(cache.consume('ticket-0002', URL_B).ok).toBe(true);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.consume('ticket-0001', URL_A)).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
    expect(cache.consume('ticket-0002', URL_B)).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
  });
});

describe('subtitle preview cache · capacity', () => {
  it('evicts the oldest ticket once the ceiling is reached', () => {
    const { cache, time } = cacheWith({ maxEntries: 2 });
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    time.advance(10);
    cache.put({ id: 'ticket-0002', urlKey: URL_B, media: mediaInfo(), tracks: [] });
    time.advance(10);
    cache.put({ id: 'ticket-0003', urlKey: 'https://example.org/watch?v=ccc', media: mediaInfo(), tracks: [] });

    expect(cache.size).toBe(2);
    expect(cache.peek('ticket-0001')).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
    expect(cache.peek('ticket-0002').ok).toBe(true);
    expect(cache.peek('ticket-0003').ok).toBe(true);
  });

  it('clamps nonsense options instead of accepting a zero-capacity cache', () => {
    const time = clock();
    const cache = new SubtitlePreviewCache({ now: time.now, ttlMs: 0, maxEntries: 0 });
    expect(cache.ttlMs).toBeGreaterThanOrEqual(1_000);
    cache.put({ id: 'ticket-0001', urlKey: URL_A, media: mediaInfo(), tracks: [] });
    expect(cache.peek('ticket-0001').ok).toBe(true);
  });
});
