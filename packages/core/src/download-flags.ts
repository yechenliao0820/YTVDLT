/**
 * Pure post-processing detection (drives C2 vs C8, D-18).
 *
 * A remux/transcode/merge changes bytes, so C2 (byte hash) would always fail;
 * those cases must be verified with C8 (frame hash) instead.
 */
import type { DownloadRequest } from '@ytvdlt/shared';

/** argv flags whose presence implies post-processing. */
export const POSTPROCESS_ARGV_FLAGS: readonly string[] = [
  '--remux-video',
  '--merge-output-format',
  '--audio-format',
  '--split-chapters',
  // M3 B3 (append-only, D-19 / C2<->C8 dynamic switch must not regress):
  // these M3 segments also change bytes, so C8 (frame hash) is authoritative.
  '--embed-subs',
  '--convert-subs',
  '--embed-thumbnail',
  '--write-thumbnail',
  '--download-sections',
] as const;

/** stderr markers yt-dlp prints when running ffmpeg post-processors. */
export const POSTPROCESS_STDERR_MARKERS: readonly string[] = [
  '[PostProcess]',
  '[Merger]',
  '[ExtractAudio]',
] as const;

/**
 * Decide whether a request will trigger post-processing.
 * Pure: derived only from the immutable request snapshot.
 */
export function detectPostprocessed(req: DownloadRequest): boolean {
  if (req.format.audioFormat !== null) return true;
  if (req.format.extractAudio) return true;
  if (req.advanced.splitChapters) return true;
  if (req.advanced.downloadSections !== null) return true;
  if (req.subtitle.embed) return true;
  if (req.subtitle.enabled && req.subtitle.convertTo !== 'none') return true;
  return false;
}

/** Decide from a completed argv[]: any M2/M3 post-processing option present. */
export function detectPostprocessedFromArgv(argv: readonly string[]): boolean {
  if (!Array.isArray(argv)) return false;
  return argv.some((element) => POSTPROCESS_ARGV_FLAGS.includes(element));
}

/** Decide from a completed run: request flags OR observed argv/stderr markers. */
export function detectPostprocessedFromRun(
  req: DownloadRequest,
  stderr: string,
  argv: readonly string[] = [],
): boolean {
  if (detectPostprocessed(req)) return true;
  if (detectPostprocessedFromArgv(argv)) return true;
  return POSTPROCESS_STDERR_MARKERS.some((marker) => stderr.includes(marker));
}
