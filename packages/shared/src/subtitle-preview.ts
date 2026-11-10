/**
 * Subtitle preview contract (stage 2, append-only).
 *
 * Why its own module: `request.ts` is byte-frozen (D-50) and a preview has
 * nothing to do with a download request. Everything here is a WHITELIST
 * projection of `MediaInfo.subtitles` / `automatic_captions`:
 *
 *   - no `SubtitleTrack.url` (signed, credential-bearing),
 *   - no `webpage_url` / `thumbnail` / `http_headers`,
 *   - no raw yt-dlp JSON, no `formats`,
 *   - no path, no cookie, no proxy.
 *
 * `previewId` is the only handle the renderer ever gets to the server-side
 * `MediaInfo`; the main process keeps the real object and decides who may
 * consume it (short TTL, single use, bound to the target URL).
 */
import type { MediaInfo } from './media.js';

/** Which yt-dlp bucket a track came from. The bucket IS the source. */
export type SubtitleSource = 'manual' | 'automatic';

/**
 * One language row, deliberately source-aware.
 *
 * A language may exist in both buckets at once (YouTube ships manual `en` and
 * automatic `en`), so the row carries BOTH flags and two separate format lists
 * instead of pretending one source wins. Nothing here says "pick one".
 */
export interface SubtitleTrackPreview {
  /** yt-dlp language key: `en`, `zh-Hans`, `en-orig`, `pt-BR`… */
  readonly languageCode: string;
  /**
   * Human label from the track's `name` field, sanitised for display.
   * `null` means "show the language code". The renderer MUST paint it through
   * `textContent` — it is site-supplied text, never markup.
   */
  readonly languageName: string | null;
  readonly manualAvailable: boolean;
  readonly automaticAvailable: boolean;
  /** Unique, lower-case `ext` values, sorted. Empty when that source is absent. */
  readonly manualFormats: readonly string[];
  readonly automaticFormats: readonly string[];
}

/** Media header for the preview panel — no URL, no cover, no description. */
export interface SubtitlePreviewMedia {
  readonly title: string;
  readonly uploader: string | null;
  readonly durationSec: number | null;
  readonly extractorKey: string;
}

/**
 * What `SUBTITLE_PREVIEW` answers on success.
 *
 * `empty: true` is a SUCCESS: "this video really has no subtitle", which is a
 * different fact from "the probe failed" and must not be shown as an error.
 */
export interface SubtitlePreviewDto {
  readonly previewId: string;
  readonly media: SubtitlePreviewMedia;
  readonly tracks: readonly SubtitleTrackPreview[];
  /** Languages with at least one manual track (convenience, derived). */
  readonly manualLanguages: number;
  /** Languages with at least one automatic track (may overlap the manual set). */
  readonly automaticLanguages: number;
  readonly empty: boolean;
  /** ISO instant after which this id is refused. Display-only, not a credential. */
  readonly expiresAt: string;
}

/**
 * Stable failure buckets — the renderer owns the sentence (same rule as D-109).
 *
 *   PREVIEW_UNAVAILABLE   this build ships no preview service
 *   PREVIEW_INVALID_URL   not http(s), too long, or carries control characters
 *   PREVIEW_FAILED        the probe itself failed (network, unsupported site…)
 *   PREVIEW_EXPIRED       the id existed but its TTL ran out
 *   PREVIEW_CONSUMED      the id was already used once (single-use by design)
 *   PREVIEW_URL_MISMATCH  the id belongs to a DIFFERENT target URL
 *   PREVIEW_UNKNOWN       never issued, or already released by cancel
 */
export type SubtitlePreviewFailureCode =
  | 'PREVIEW_UNAVAILABLE'
  | 'PREVIEW_INVALID_URL'
  | 'PREVIEW_FAILED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_CONSUMED'
  | 'PREVIEW_URL_MISMATCH'
  | 'PREVIEW_UNKNOWN';

export type SubtitlePreviewResult =
  | { readonly ok: true; readonly preview: SubtitlePreviewDto }
  | {
    readonly ok: false;
    readonly code: SubtitlePreviewFailureCode;
    /** Locale-neutral fallback; the UI normally maps `code` instead. */
    readonly message: string;
  };

/** `SUBTITLE_PREVIEW_CANCEL` answer. Cancelling an unknown id is not an error. */
export interface SubtitlePreviewCancelResult {
  readonly ok: boolean;
  readonly canceled: boolean;
}

/**
 * Main-process-only result of `consume()` — NOT an IPC payload.
 *
 * It exists so the enqueue path can hand the already-probed `MediaInfo` to a
 * `TaskRecord` and skip `TaskQueue`'s own probe (task-queue.ts: `mediaInfo
 * === null` is the only branch that calls `engine.probe`).
 */
export interface SubtitlePreviewConsumption {
  readonly media: MediaInfo;
  readonly tracks: readonly SubtitleTrackPreview[];
}

export type SubtitlePreviewConsumeResult =
  | { readonly ok: true; readonly consumption: SubtitlePreviewConsumption }
  | { readonly ok: false; readonly code: SubtitlePreviewFailureCode };
