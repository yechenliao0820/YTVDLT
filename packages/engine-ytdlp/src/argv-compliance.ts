/**
 * Download-argv compliance whitelist + forbidden-option interception (M3-F011).
 *
 * Layer ① (root cause): `buildDownload()` pushes ONLY options from
 * `ALLOWED_DOWNLOAD_OPTIONS`; `advanced.customCommand` is never read and there
 * is no path that turns user input into an option name.
 * Layer ② (defence in depth): `assertNoForbiddenOptions()` is called just
 * before `buildDownload()` returns. It rejects every PRD-M3 §7 forbidden token,
 * PO-Token injection, and any option-shaped element outside the whitelist.
 *
 * Throws a plain `Error` (no new ErrorCode is added; 17 codes stay frozen).
 */

/** Every option `buildDownload` is allowed to emit (option names, not values). */
export const ALLOWED_DOWNLOAD_OPTIONS: readonly string[] = [
  // A · fixed prefix
  '--no-playlist', '--no-warnings', '--newline', '--socket-timeout', '-R',
  // A′ · M4-4 playlist batch (position 1 replaces --no-playlist)
  '--yes-playlist', '--playlist-items',
  '--no-js-runtimes', '--js-runtimes', '--ffmpeg-location',
  // B · format / audio
  '-f', '-S', '-x', '--audio-format', '--audio-quality', '--audio-multistreams',
  '--embed-metadata', '--embed-thumbnail', '--ppa',
  // C · subtitles
  '--write-subs', '--sub-langs', '--write-auto-subs', '--extractor-args',
  '--embed-subs', '--convert-subs', '--remux-video', '--merge-output-format',
  '--embed-chapters', '--write-thumbnail', '--convert-thumbnails',
  // D · paths
  '-P', '-o', '--restrict-filenames',
  // E · network
  '-r', '--proxy', '--cookies', '--add-header', '-4',
  '--downloader', '--downloader-args', '--concurrent-fragments',
  // F · other
  '--no-mtime', '--download-archive', '--sponsorblock-remove',
  '--download-sections', '--split-chapters', '--replace-in-metadata', '--verbose',
  '--progress-template', '--progress-delta', '--print-to-file',
  // G · separator
  '--',
  // H · M4-5 long-form aliases reachable ONLY through a validated template
  '--format', '--output', '--rate-limit', '--retries',
] as const;

/** PRD-M3 §7 forbidden list — detected, never implemented. */
export const M3_FORBIDDEN_OPTIONS: readonly string[] = [
  '--cookies-from-browser',
  '--geo-bypass',
  '--geo-bypass-country',
  '--geo-bypass-ip-block',
  '--no-check-certificates',
  '--prefer-insecure',
  '--exec',
  '--config-locations',
  'po_token',
] as const;

/** Option-shaped argv elements (long options and single-letter short options). */
const OPTION_LIKE_RE = /^(?:--[a-z0-9][a-z0-9-]*|-[a-zA-Z0-9])$/;
const PO_TOKEN_RE = /po[_-]?token/i;

/**
 * Reject a non-compliant argv[].
 *
 * @throws Error when a forbidden token, a PO-Token injection, or an
 *         option-shaped element outside `ALLOWED_DOWNLOAD_OPTIONS` is present.
 */
export function assertNoForbiddenOptions(argv: readonly string[]): void {
  if (!Array.isArray(argv)) {
    throw new Error('[ytvdlt] assertNoForbiddenOptions: argv must be an array');
  }
  const allowed = new Set<string>(ALLOWED_DOWNLOAD_OPTIONS);
  for (const raw of argv) {
    const token = typeof raw === 'string' ? raw : String(raw);
    const eq = token.indexOf('=');
    const optionName = eq === -1 ? token : token.slice(0, eq);
    const lower = token.toLowerCase();

    for (const forbidden of M3_FORBIDDEN_OPTIONS) {
      if (optionName.toLowerCase() === forbidden || lower.includes(forbidden)) {
        throw new Error(`[ytvdlt] forbidden option rejected: ${forbidden}`);
      }
    }
    if (PO_TOKEN_RE.test(token)) {
      throw new Error('[ytvdlt] forbidden option rejected: PO Token injection');
    }
    if (token === '--') continue;
    if (OPTION_LIKE_RE.test(token) && !allowed.has(optionName)) {
      throw new Error(`[ytvdlt] option not in ALLOWED_DOWNLOAD_OPTIONS: ${optionName}`);
    }
  }
}
