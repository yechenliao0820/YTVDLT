/**
 * PlaylistPreviewService — the live playlist probe behind the batch selector.
 *
 * Trust boundary:
 *   - the ONLY input from the renderer is a URL (plus an id to release);
 *   - the full `PlaylistInfo` stays in `PlaylistPreviewCache` (main memory);
 *   - the renderer receives `PlaylistPreviewDto`, which has NO url field;
 *   - enqueue consumes the ticket by (previewId, URL) and uses the CACHED
 *     playlist, so a page can neither submit its own JSON nor replay a probe.
 *
 * Reuses `normalizePreviewUrl()` from the existing subtitle preview service so
 * both probes apply the engine's identical http(s) whitelist. The ticket
 * contract (5 min TTL, single use, URL binding, tombstones, capacity) is the
 * same one `SubtitlePreviewCache` implements — see `core/playlist/preview-cache`.
 */
import type {
  ClockPort, PlaylistInfo, PlaylistPreviewCode, PlaylistPreviewDto,
  PlaylistPreviewEntryDto,
} from '@ytvdlt/shared';
import { MAX_PLAYLIST_ITEMS } from '@ytvdlt/shared';
import { looksLikePlaylistUrl, PlaylistPreviewCache } from '@ytvdlt/core';
import type {
  PlaylistPreviewEntry, PlaylistPreviewLookup,
} from '@ytvdlt/core';
import { normalizePreviewUrl } from './subtitle-preview-service.js';

const MAX_TITLE_LENGTH = 200;
const MAX_ENTRY_TITLE_LENGTH = 200;

export interface PlaylistPreviewServiceOptions {
  /** Live probe, already bound to the bundled yt-dlp + JS runtime paths. */
  readonly probe: (url: string) => Promise<PlaylistInfo>;
  readonly clock: Pick<ClockPort, 'nowEpochMs'>;
  /** Opaque id source; production passes `crypto.randomUUID`. */
  readonly newId: () => string;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxItems?: number;
}

export interface PlaylistPreviewConsumeResult {
  readonly ok: boolean;
  readonly code: PlaylistPreviewCode;
  /** Present ONLY on success. Never returned to the renderer. */
  readonly playlist?: PlaylistInfo;
  readonly urlKey?: string;
}

export interface PlaylistPreviewPortLike {
  preview(url: unknown, previousPreviewId?: string): Promise<PlaylistPreviewDto>;
  cancel(previewId: string): Promise<boolean>;
  consume(previewId: string, url: unknown): PlaylistPreviewConsumeResult;
  clear(): void;
}

/** Strip control characters and bound display strings. */
function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function durationOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Does this flat entry carry a usable URL of its own? */
export function isPlaylistEntryAvailable(entry: { readonly url?: string }): boolean {
  return typeof entry.url === 'string' && entry.url.trim() !== '';
}

/**
 * Build the display-safe DTO. Pure and exported so the "no URL leaks" rule is
 * a unit-testable fact rather than a comment.
 */
export function toPlaylistPreviewDto(
  entry: PlaylistPreviewEntry,
  maxItems: number = MAX_PLAYLIST_ITEMS,
): PlaylistPreviewDto {
  const playlist = entry.playlist;
  const limit = Math.max(1, Math.trunc(maxItems));
  const visible = playlist.entries.slice(0, limit);
  const rows: PlaylistPreviewEntryDto[] = visible.map((item, index) => ({
    id: safeText(item.id, 200),
    title: safeText(item.title, MAX_ENTRY_TITLE_LENGTH),
    position: index + 1,
    durationSec: durationOf(item.duration),
    available: isPlaylistEntryAvailable(item),
  }));
  const availableCount = playlist.entries.filter(isPlaylistEntryAvailable).length;
  const skipped = typeof playlist.skippedEntries === 'number' && Number.isFinite(playlist.skippedEntries)
    ? Math.max(0, Math.trunc(playlist.skippedEntries)) : 0;
  let totalDuration = 0;
  let knownDurations = 0;
  for (const item of playlist.entries) {
    const seconds = durationOf(item.duration);
    if (seconds === null) continue;
    totalDuration += seconds;
    knownDurations += 1;
  }
  return {
    previewId: entry.id,
    title: safeText(playlist.title, MAX_TITLE_LENGTH),
    extractorKey: safeText(playlist.extractor_key, 40),
    declaredCount: typeof playlist.playlistCount === 'number' && Number.isFinite(playlist.playlistCount)
      ? Math.max(0, Math.trunc(playlist.playlistCount)) : null,
    fetchedCount: playlist.entries.length,
    availableCount,
    unavailableCount: (playlist.entries.length - availableCount) + skipped,
    totalDurationSec: knownDurations === 0 ? null : totalDuration,
    entries: rows,
    truncated: playlist.entries.length > limit,
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    code: '',
    ok: true,
  };
}

export function failedPlaylistPreview(code: PlaylistPreviewCode): PlaylistPreviewDto {
  return {
    previewId: '', title: '', extractorKey: '', declaredCount: null,
    fetchedCount: 0, availableCount: 0, unavailableCount: 0,
    totalDurationSec: null, entries: [], truncated: false, expiresAt: '',
    code, ok: false,
  };
}

/** Stable buckets only: stderr and extractor text never reach the renderer. */
export function mapPlaylistProbeError(error: unknown, urlLooksLikePlaylist: boolean): PlaylistPreviewCode {
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code : '';
  if (code === 'UNSUPPORTED_SITE' || code === 'NOT_PLAYLIST') {
    return urlLooksLikePlaylist ? 'UNSUPPORTED_SITE' : 'NOT_PLAYLIST';
  }
  if (code === 'TIMEOUT' || code === 'PROCESS_TIMEOUT' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'NETWORK_ERROR' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN') return 'NETWORK_ERROR';
  return 'PROBE_FAILED';
}

export class PlaylistPreviewService implements PlaylistPreviewPortLike {
  private readonly cache: PlaylistPreviewCache;
  private readonly options: PlaylistPreviewServiceOptions;
  /** Two rapid clicks on one URL share a single live probe. */
  private readonly inflight = new Map<string, Promise<PlaylistInfo>>();

  constructor(options: PlaylistPreviewServiceOptions) {
    this.options = options;
    this.cache = new PlaylistPreviewCache({
      now: () => options.clock.nowEpochMs(),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
  }

  async preview(rawUrl: unknown, previousPreviewId?: string): Promise<PlaylistPreviewDto> {
    if (previousPreviewId !== undefined && previousPreviewId !== '') {
      this.cache.cancel(previousPreviewId);
    }
    const url = normalizePreviewUrl(rawUrl);
    if (url === null) return failedPlaylistPreview('INVALID_URL');

    let probe = this.inflight.get(url);
    if (probe === undefined) {
      probe = this.options.probe(url).finally(() => { this.inflight.delete(url); });
      this.inflight.set(url, probe);
    }
    let playlist: PlaylistInfo;
    try {
      playlist = await probe;
    } catch (error) {
      return failedPlaylistPreview(mapPlaylistProbeError(error, looksLikePlaylistUrl(url)));
    }
    if (playlist.entries.length === 0) return failedPlaylistPreview('EMPTY_PLAYLIST');

    const entry = this.cache.put({ id: this.options.newId(), urlKey: url, playlist });
    return toPlaylistPreviewDto(entry, this.options.maxItems ?? MAX_PLAYLIST_ITEMS);
  }

  async cancel(previewId: string): Promise<boolean> {
    return this.cache.cancel(previewId);
  }

  /** Main-process only. A URL mismatch does NOT burn the ticket. */
  consume(previewId: string, rawUrl: unknown): PlaylistPreviewConsumeResult {
    const url = normalizePreviewUrl(rawUrl);
    if (url === null) return { ok: false, code: 'INVALID_URL' };
    const found = this.cache.consume(previewId, url);
    if (!found.ok) return { ok: false, code: found.code };
    return { ok: true, code: '', playlist: found.entry.playlist, urlKey: found.entry.urlKey };
  }

  /** Diagnostics / shutdown. */
  peek(id: string): PlaylistPreviewLookup { return this.cache.peek(id); }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
