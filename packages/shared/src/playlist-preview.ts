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
  | 'PREVIEW_URL_MISMATCH' | 'EMPTY_SELECTION' | 'TOO_MANY_ITEMS'
  // T5 (append-only): the user cancelled the in-flight pre-check — nothing was
  // enqueued. A cancellation is "the user said stop", not a gate judgement.
  | 'PRECHECK_CANCELLED';

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
  /**
   * R1-03 — how the per-entry pre-check split the selection.
   *
   * Absent when this build has no pre-check port. Present means the numbers are
   * real: `supported + unsupported + noMedia + indeterminate + skipped` equals
   * the number of entries the pre-check was given, so the dialog can say
   * "12 supported · 2 unsupported · 3 not confirmed · 4 not checked" instead of
   * only listing the refusals — and `skipped` must never be folded into
   * "supported".
   *
   * IDS, not URLs: this file is display-safe by contract (see the header), and
   * the selection UI already identifies entries by id.
   */
  readonly precheck?: PlaylistPrecheckReport;
  /**
   * T5 (append-only): true when the user cancelled the in-flight pre-check and
   * NOTHING was enqueued by this call. "Cancelled" is the user saying "stop",
   * not the gate misjudging a link, so the batch must not enqueue; the gate
   * itself still fails open for a CANCELLED verdict (it never blocks).
   * Absent on every older reply, so existing consumers keep compiling.
   */
  readonly cancelled?: boolean;
}

/** Per-bucket tally of a playlist batch pre-check. Ids only — never URLs. */
export interface PlaylistPrecheckReport {
  readonly examined: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly noMedia: number;
  readonly indeterminate: number;
  readonly skipped: number;
  readonly unsupportedIds: readonly string[];
  readonly noMediaIds: readonly string[];
  readonly indeterminateIds: readonly string[];
}
