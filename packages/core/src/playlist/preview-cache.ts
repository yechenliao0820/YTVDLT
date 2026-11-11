/**
 * PlaylistPreviewCache — main-process ticket store for a live playlist probe.
 *
 * Reuses the CONTRACT of `subtitle-preview/preview-cache.ts` (same TTL, same
 * failure buckets, same URL binding / single-use / tombstone / capacity rules)
 * without touching that module: the subtitle cache is typed to `MediaInfo` and
 * changing it would put an unrelated feature at risk. A unit test pins the two
 * TTLs and the failure-code vocabulary together.
 *
 * The full `PlaylistInfo` — including every entry's own (possibly signed) URL
 * — lives here and NEVER leaves the main process. The renderer only sees the
 * opaque id plus `PlaylistPreviewDto` (no URL at all).
 *
 * Pure: no I/O, no clock of its own, no timers.
 */
import type { PlaylistInfo, PlaylistPreviewCode } from '@ytvdlt/shared';

/** 5 minutes, matching the existing subtitle preview ticket. */
export const DEFAULT_PLAYLIST_PREVIEW_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PLAYLIST_PREVIEW_MAX_ENTRIES = 16;

export type PlaylistPreviewFailureCode = Extract<PlaylistPreviewCode,
  'PREVIEW_EXPIRED' | 'PREVIEW_CONSUMED' | 'PREVIEW_UNKNOWN' | 'PREVIEW_URL_MISMATCH'>;

export interface PlaylistPreviewEntry {
  readonly id: string;
  /** Normalised original playlist URL. Never leaves the main process. */
  readonly urlKey: string;
  /** Full probe result, entry URLs included. Main-process memory ONLY. */
  readonly playlist: PlaylistInfo;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export type PlaylistPreviewLookup =
  | { readonly ok: true; readonly entry: PlaylistPreviewEntry }
  | { readonly ok: false; readonly code: PlaylistPreviewFailureCode };

export interface PlaylistPreviewCacheOptions {
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export interface PlaylistPreviewCachePut {
  readonly id: string;
  readonly urlKey: string;
  readonly playlist: PlaylistInfo;
}

export class PlaylistPreviewCache {
  private readonly entries = new Map<string, PlaylistPreviewEntry>();
  /** Consumed ids → expiry instant, so a replay is distinguishable. */
  private readonly consumed = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxEntries: number;

  constructor(options: PlaylistPreviewCacheOptions) {
    this.now = options.now;
    this.ttl = Math.max(1_000, Math.trunc(options.ttlMs ?? DEFAULT_PLAYLIST_PREVIEW_TTL_MS));
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_PLAYLIST_PREVIEW_MAX_ENTRIES));
  }

  get ttlMs(): number { return this.ttl; }
  get size(): number { return this.entries.size; }

  put(input: PlaylistPreviewCachePut): PlaylistPreviewEntry {
    this.purgeExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.oldestId();
      if (oldest === null) break;
      this.entries.delete(oldest);
    }
    const createdAtMs = this.now();
    const entry: PlaylistPreviewEntry = {
      id: input.id,
      urlKey: input.urlKey,
      playlist: input.playlist,
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttl,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  peek(id: string): PlaylistPreviewLookup {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { ok: false, code: this.consumed.has(id) ? 'PREVIEW_CONSUMED' : 'PREVIEW_UNKNOWN' };
    }
    if (this.now() >= entry.expiresAtMs) {
      this.entries.delete(id);
      this.consumed.delete(id);
      return { ok: false, code: 'PREVIEW_EXPIRED' };
    }
    return { ok: true, entry };
  }

  /** Spend a ticket. A URL mismatch leaves it intact (no accidental burn). */
  consume(id: string, urlKey: string): PlaylistPreviewLookup {
    const found = this.peek(id);
    if (!found.ok) return found;
    if (found.entry.urlKey !== urlKey) return { ok: false, code: 'PREVIEW_URL_MISMATCH' };
    this.entries.delete(id);
    this.consumed.set(id, found.entry.expiresAtMs);
    return found;
  }

  cancel(id: string): boolean {
    const existed = this.entries.delete(id);
    this.consumed.delete(id);
    return existed;
  }

  /** Window close / app quit. */
  clear(): void {
    this.entries.clear();
    this.consumed.clear();
  }

  purgeExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (now >= entry.expiresAtMs) { this.entries.delete(id); removed += 1; }
    }
    for (const [id, expiresAtMs] of [...this.consumed]) {
      if (now >= expiresAtMs) this.consumed.delete(id);
    }
    return removed;
  }

  private oldestId(): string | null {
    let oldest: PlaylistPreviewEntry | null = null;
    for (const entry of this.entries.values()) {
      if (oldest === null || entry.createdAtMs < oldest.createdAtMs) oldest = entry;
    }
    return oldest === null ? null : oldest.id;
  }
}
