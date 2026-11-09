/**
 * Post-process stage detection from yt-dlp's own log lines (D-115).
 *
 * Why parse text at all: `--progress-template` only covers the *download*
 * loop. Once every stream has been fetched, yt-dlp prints a small set of
 * well-known bracketed markers to stderr and the renderer had no way to know
 * whether the task was still merging or already verifying — the card sat at
 * "100.0%" while ffmpeg worked, which reads as "stuck".
 *
 * These markers are hard-coded literals inside yt-dlp's postprocessor classes
 * (`[Merger]`, `[ExtractAudio]`, …), not localized copy and not free-form
 * prose, so matching them is a contract with the engine rather than guesswork.
 * Anything unrecognised returns `null`: an unknown line must never be promoted
 * to "merging".
 */

/**
 * Bracketed markers yt-dlp prints while rewriting the finished streams.
 * `[Merger]` is deliberately separate: it is the only one that justifies the
 * specific "merging video" copy.
 */
const MERGER_MARKER = /^\[Merger\]\s/;

/**
 * Every other postprocessor that runs AFTER the last byte arrived. Kept as an
 * allow-list so a future yt-dlp line cannot silently change the UI stage.
 */
const POSTPROCESS_MARKERS: readonly RegExp[] = [
  /^\[ExtractAudio\]\s/,
  /^\[VideoConvertor\]\s/,
  /^\[VideoRemuxer\]\s/,
  /^\[FixupM3u8\]\s/,
  /^\[FixupM4a\]\s/,
  /^\[FixupStretched\]\s/,
  /^\[FixupDuplicateMoov\]\s/,
  /^\[Metadata\]\s/,
  /^\[EmbedThumbnail\]\s/,
  /^\[EmbedSubtitle\]\s/,
  /^\[SubtitlesConvertor\]\s/,
  /^\[MoveFiles\]\s/,
  /^\[ThumbnailsConvertor\]\s/,
  /^\[ModifyChapters\]\s/,
  /^\[SplitChapters\]\s/,
  /^\[SponsorBlock\]\s/,
];

export type DetectedStage = 'merging' | 'postprocess';

/**
 * `[Merger] Merging formats into "…"` → `merging`.
 *
 * A trailing-space requirement keeps `[Merger]`-prefixed noise (if any) from
 * matching, and the whole line must START with the marker: yt-dlp writes one
 * message per line under `--newline`.
 */
export function detectStageFromLine(line: string): DetectedStage | null {
  if (typeof line !== 'string') return null;
  const text = line.trim();
  if (text.length === 0) return null;
  if (MERGER_MARKER.test(text)) return 'merging';
  for (const marker of POSTPROCESS_MARKERS) {
    if (marker.test(text)) return 'postprocess';
  }
  return null;
}

/**
 * Incremental line splitter for a byte stream that arrives in arbitrary chunks.
 *
 * Used on stderr, which is NOT parsed for progress (that is stdout) but carries
 * the markers above. Keeping the tail avoids dropping a marker that straddles a
 * chunk boundary; the buffer is capped so a stream without newlines cannot grow
 * without bound.
 */
export interface LineSplitter {
  push(chunk: string): string[];
  flush(): string[];
}

export function createLineSplitter(maxBuffer = 8 * 1024): LineSplitter {
  let pending = '';
  return {
    push(chunk: string): string[] {
      if (typeof chunk !== 'string' || chunk.length === 0) return [];
      pending += chunk;
      if (pending.length > maxBuffer) {
        // A single "line" longer than this is not a marker we can trust; drop
        // the head so memory stays bounded, keeping the newest bytes.
        pending = pending.slice(-maxBuffer);
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      return lines;
    },
    flush(): string[] {
      const rest = pending;
      pending = '';
      return rest.length === 0 ? [] : [rest];
    },
  };
}

/**
 * Stage ordering lives in `@ytvdlt/shared` (D-115) so the queue can enforce it
 * without importing the engine (core must never depend on engine-ytdlp).
 * Re-exported here only because this module is the engine-side entry point.
 */
export { isForwardStage, stageRank } from '@ytvdlt/shared';
