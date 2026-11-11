/**
 * Playlist preview DTOs (append-only) — the ONLY shape a renderer may see.
 *
 * The main process keeps the full `PlaylistInfo` (entry URLs, signed links,
 * raw extractor data) behind an opaque ticket. Everything in this file is
 * display-safe: no URL, no argv, no raw yt-dlp JSON.
 */

/**
 * Same ceiling as the frozen M3 `ipc-gateway.ts::MAX_BATCH_ITEMS`.
 * A unit test asserts the two stay equal so a future edit cannot silently
 * widen one of them.
 */
export const MAX_PLAYLIST_ITEMS = 500;

/** Stable failure buckets; the renderer owns the sentence. */
export type PlaylistPreviewCode =
  | '' | 'INVALID_URL' | 'NOT_PLAYLIST' | 'UNSUPPORTED_SITE' | 'EMPTY_PLAYLIST'
  | 'TIMEOUT' | 'NETWORK_ERROR' | 'PROBE_FAILED' | 'PREVIEW_UNAVAILABLE'
  | 'PREVIEW_EXPIRED' | 'PREVIEW_CONSUMED' | 'PREVIEW_UNKNOWN'
  | 'PREVIEW_URL_MISMATCH' | 'EMPTY_SELECTION' | 'TOO_MANY_ITEMS';

/** One row of the selection UI. Deliberately has NO `url` field. */
export interface PlaylistPreviewEntryDto {
  /** The extractor's entry id; used as the selection key. */
  readonly id: string;
  readonly title: string;
  /** 1-based position in the ORIGINAL playlist, not the click order. */
  readonly position: number;
  readonly durationSec: number | null;
  /** False when the entry has no usable URL of its own. */
  readonly available: boolean;
}

export interface PlaylistPreviewDto {
  readonly previewId: string;
  readonly title: string;
  readonly extractorKey: string;
  /** What yt-dlp declared (`playlist_count`); `null` when it did not say. */
  readonly declaredCount: number | null;
  /** How many entries were actually parsed from the probe. */
  readonly fetchedCount: number;
  /** Entries with a usable URL of their own. */
  readonly availableCount: number;
  /** Missing / inaccessible / URL-less entries. */
  readonly unavailableCount: number;
  /** Sum of known durations across all fetched entries; null if none known. */
  readonly totalDurationSec: number | null;
  readonly entries: readonly PlaylistPreviewEntryDto[];
  /** True when the list was cut at MAX_PLAYLIST_ITEMS. */
  readonly truncated: boolean;
  readonly expiresAt: string;
  readonly code: PlaylistPreviewCode;
  readonly ok: boolean;
}

export interface PlaylistPreviewCancelDto {
  readonly ok: boolean;
}

export interface PlaylistBatchEnqueueDto {
  readonly ok: boolean;
  readonly code: PlaylistPreviewCode | 'PARTIAL_SUCCESS' | 'ENQUEUE_FAILED';
  /** Number of ids the user confirmed (after ticket defaults). */
  readonly requested: number;
  /** Number of TaskRecords that REALLY reached the queue. */
  readonly enqueued: number;
  readonly failed: number;
  readonly taskIds: readonly string[];
  readonly failures: readonly { readonly id: string; readonly reason: string }[];
}
