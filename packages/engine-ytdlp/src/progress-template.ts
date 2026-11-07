/**
 * Progress template constants (D-18).
 *
 * yt-dlp is told to emit exactly these 6 fields behind a unique prefix, so the
 * parser can ignore all human-readable `[download]` / `[info]` lines.
 */

/** Unique line prefix; only lines starting with this enter the event stream. */
export const PROGRESS_LINE_PREFIX = 'YTVDLT|';

/** Separator used by the template. */
export const PROGRESS_FIELD_SEPARATOR = '|';

/**
 * Value for `--progress-template`.
 * NOTE: this string already carries the `download:` stage prefix, so `buildDownload`
 * passes it verbatim (adding another `download:` would double the prefix).
 */
export const YTVDLT_PROGRESS_TEMPLATE =
  'download:YTVDLT|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|'
  + '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|'
  + '%(progress.elapsed)s';

/** `--progress-delta` value: throttle line rate to avoid flooding the stdout pipe. */
export const PROGRESS_DELTA_SECONDS = '0.5';

/** Number of `|`-separated segments in a progress line (prefix + 6 fields). */
export const PROGRESS_SEGMENT_COUNT = 7;
