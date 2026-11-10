/**
 * SubtitlePreviewCache (stage 2) — the main process' short-lived ticket store.
 *
 * The renderer never receives `MediaInfo`; it receives an opaque `previewId`
 * and the main process keeps the probed object here. Four properties make that
 * safe, and each one is a test:
 *
 *   1. **Bound to the target URL.** `consume()` refuses a ticket whose stored
 *      URL differs, so an id from task A cannot be spent on task B.
 *   2. **Single use.** Consuming deletes the entry and leaves a tombstone, so a
 *      replay answers `PREVIEW_CONSUMED` instead of silently reusing a signed
 *      subtitle URL that may already be stale.
 *   3. **Short-lived.** Default TTL is 5 minutes; expiry is checked on every
 *      read against an injected clock (no wall-clock math inside core, no
 *      background timer that can outlive the window).
 *   4. **Bounded.** A capacity ceiling evicts the oldest ticket, so a renderer
 *      that polls the preview endpoint cannot grow main-process memory.
 *
 * What this class deliberately does NOT do: probe, spawn, log, touch the disk.
 * Those belong to `subtitle-preview-service.ts` (desktop layer).
 */
import type {
  MediaInfo, SubtitlePreviewConsumeResult, SubtitlePreviewFailureCode, SubtitleTrackPreview,
} from '@ytvdlt/shared';

/** 5 minutes: long enough to pick languages, short enough to stale fast. */
export const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
/** At most a few concurrent previews are meaningful in a single-window app. */
export const DEFAULT_PREVIEW_MAX_ENTRIES = 16;

export interface SubtitlePreviewEntry {
  readonly id: string;
  /** Normalised target URL this ticket is bound to. Never leaves the main process. */
  readonly urlKey: string;
  /** The full probe result, including signed URLs. Main-process memory ONLY. */
  readonly media: MediaInfo;
  readonly tracks: readonly SubtitleTrackPreview[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export type SubtitlePreviewFailure = { readonly ok: false; readonly code: SubtitlePreviewFailureCode };
export type SubtitlePreviewLookup = { readonly ok: true; readonly entry: SubtitlePreviewEntry } | SubtitlePreviewFailure;

export interface SubtitlePreviewCacheOptions {
  /** Injected epoch-ms clock (`CorePorts.clock.nowEpochMs`). */
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export interface SubtitlePreviewCachePut {
  readonly id: string;
  readonly urlKey: string;
  readonly media: MediaInfo;
  readonly tracks: readonly SubtitleTrackPreview[];
}

export class SubtitlePreviewCache {
  private readonly entries = new Map<string, SubtitlePreviewEntry>();
  /**
   * Ids that WERE valid and got consumed → expiry instant. Kept only so a
   * replay can be told apart from an id that never existed; both are refused.
   */
  private readonly consumed = new Map<string, number>();
  private readonly now: () => number;
  /** Lifetime of one ticket, ms. Exposed through the `ttlMs` getter. */
  private readonly ttl: number;
  private readonly maxEntries: number;

  constructor(options: SubtitlePreviewCacheOptions) {
    this.now = options.now;
    this.ttl = Math.max(1_000, Math.trunc(options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS));
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_PREVIEW_MAX_ENTRIES));
  }

  get ttlMs(): number {
    return this.ttl;
  }

  /** Live (unconsumed) ticket count. */
  get size(): number {
    return this.entries.size;
  }

  /** Store a freshly probed media object under a new id. */
  put(input: SubtitlePreviewCachePut): SubtitlePreviewEntry {
    // Opportunistic sweep: keeps memory honest without a timer in core.
    this.purgeExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.oldestId();
      if (oldest === null) break;
      this.entries.delete(oldest);
    }
    const createdAtMs = this.now();
    const entry: SubtitlePreviewEntry = {
      id: input.id,
      urlKey: input.urlKey,
      media: input.media,
      tracks: [...input.tracks],
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttl,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /**
   * Read without consuming — used for diagnostics only.
   *
   * An expired entry is deleted here and reported as `PREVIEW_EXPIRED`, so the
   * caller can say "the preview timed out, refresh it" instead of "unknown id".
   */
  peek(id: string): SubtitlePreviewLookup {
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

  /**
   * Spend a ticket. Success removes it; a URL mismatch leaves it intact so an
   * accidental extra call from the wrong page cannot burn the user's preview.
   */
  consume(id: string, urlKey: string): SubtitlePreviewLookup {
    const found = this.peek(id);
    if (!found.ok) return found;
    if (found.entry.urlKey !== urlKey) return { ok: false, code: 'PREVIEW_URL_MISMATCH' };
    this.entries.delete(id);
    this.consumed.set(id, found.entry.expiresAtMs);
    return found;
  }

  /** Drop a ticket the user abandoned. Unknown ids are not an error. */
  cancel(id: string): boolean {
    const existed = this.entries.delete(id);
    this.consumed.delete(id);
    return existed;
  }

  /** Drop everything (window close / app quit). */
  clear(): void {
    this.entries.clear();
    this.consumed.clear();
  }

  /**
   * Remove expired tickets and tombstones. Called before every `put()`; exposed
   * so a host can also call it on a timer if it ever wants one.
   */
  purgeExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (now >= entry.expiresAtMs) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    for (const [id, expiresAtMs] of [...this.consumed]) {
      if (now >= expiresAtMs) this.consumed.delete(id);
    }
    return removed;
  }

  private oldestId(): string | null {
    let oldest: SubtitlePreviewEntry | null = null;
    for (const entry of this.entries.values()) {
      if (oldest === null || entry.createdAtMs < oldest.createdAtMs) oldest = entry;
    }
    return oldest === null ? null : oldest.id;
  }
}

/**
 * Narrow the cache lookup to the main-process consumption payload.
 *
 * Kept here (not in the desktop service) so the rule "only a successful
 * consume yields `MediaInfo`" lives next to the state machine that enforces it.
 */
export function toConsumption(found: SubtitlePreviewLookup): SubtitlePreviewConsumeResult {
  if (!found.ok) return found;
  return { ok: true, consumption: { media: found.entry.media, tracks: [...found.entry.tracks] } };
}
