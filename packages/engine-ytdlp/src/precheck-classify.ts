/**
 * D-134: URL pre-check classification helpers behind `checkUrlSupport()`.
 *
 * Extracted VERBATIM from `yt-dlp-engine.ts` (task 7, low-risk pure-logic
 * migration — one function cluster, the old import path stays alive through
 * re-exports there). Pure input→answer functions: no `this`, no ports, no
 * process, no I/O, no hidden globals, no closure state.
 *
 * This package must never import `node:*` / `electron` (layering gate,
 * `scripts/check-layering.mjs`).
 */

/**
 * D-134: which extractor did the engine attribute this URL to?
 *
 * Surfaced because it is what makes GenericIE TRANSPARENT: when this returns
 * `generic`, the engine guessed at the page rather than a dedicated extractor
 * matching it — a materially weaker guarantee that the UI must be able to state.
 */
export function readExtractorKey(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const record = raw as Record<string, unknown>;
  for (const key of ['extractor_key', 'extractor']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * A pre-check that exits 0 but reports no usable format is `NO_MEDIA`, not
 * `SUPPORTED`. `formats` and `url` are both checked: a progressive result may
 * carry `url` with no separate format list.
 *
 * MEASURED, NOT ASSUMED (D-134): the top-level `url` branch looked suspicious on
 * `/plain.txt` (`extractor=Generic`, `formats=undefined`, `url=...`, exit 0), so
 * the case was put through a REAL download — the engine wrote
 * `plain.unknown_video` to disk. The bytes genuinely are retrievable, so
 * SUPPORTED is the honest answer here and the branch stays. (This is the
 * GenericIE trade-off §3.1 warns about: it will happily fetch a text file.)
 *
 * `is_live` is deliberately NOT treated as media-less: a live stream that has
 * not started yet still returns formats, and one that has is downloadable as far
 * as the pre-check can tell. Judging live-ness belongs to the download.
 */
export function hasDownloadableFormat(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  const formats = record['formats'];
  if (Array.isArray(formats)) {
    for (const format of formats) {
      if (typeof format === 'object' && format !== null) return true;
    }
  }
  // A direct/progressive result carries the media URL at the top level.
  const direct = record['url'];
  if (typeof direct === 'string' && direct !== '') return true;
  // A playlist-shaped answer is not one downloadable item, but it is certainly
  // not "no media" — leave that judgement to the playlist preview.
  return record['_type'] === 'playlist';
}

/**
 * Best-effort extractor name from a FAILED pre-check's stderr.
 *
 * yt-dlp names the extractor inside its own error lines. The prefix is NOT at
 * the start of the line: the engine writes `ERROR: [generic] …`, `WARNING: …`
 * or `[debug] [youtube] …`. An earlier `^\s*\[…\]` pattern therefore NEVER
 * matched a real failure — caught by running the bundled engine, see D-134.
 * Purely informational: an empty result is fine and must never change the state.
 */
export function readExtractorKeyFromStderr(stderr: string): string {
  const match = /(?:^|\n)\s*(?:(?:ERROR|WARNING|DEBUG):\s*)?\[([A-Za-z0-9_.:-]+)\]/.exec(stderr);
  return match?.[1] ?? '';
}
