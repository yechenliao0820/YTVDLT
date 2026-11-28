/**
 * Playlist-title directory layer for URL-based batch records (P2 fix, 2026-11).
 *
 * The bug: `buildPlaylistBatchRecordsByUrl` gives every entry its OWN url and
 * `advanced.playlistItems = null` (D-69), so the download argv carries
 * `--no-playlist` and yt-dlp sees a SINGLE video — its `playlist` field is
 * None. The plan's categorized prefix therefore renders the `%(playlist|.)s`
 * layer as the relative no-op `.` (D-290) and `%(extractor_key)s` still works,
 * but the PLAYLIST layer — the one "按播放列表分类" is about — collapses for
 * exactly this, the production, entry-URL path. Only the rare no-entry-URL
 * fallback (which keeps `--yes-playlist --playlist-items`, i.e. real playlist
 * context inside yt-dlp) ever grouped by playlist.
 *
 * The fix: the app knows `playlist.title` at BATCH time, so the title is baked
 * into the record's `paths.outputTemplate` as a LITERAL directory layer. The
 * engine never needs playlist context for it — the layer survives `--no-playlist`
 * because it is plain text, not a `%(…)s` token.
 *
 * Two invariants hold by construction:
 *   1. Fallback records (no entry url) are NEVER baked — yt-dlp resolves the
 *      real `%(playlist)s` field there, and baking would produce the playlist
 *      directory TWICE (literal layer + field layer).
 *   2. The plan (`download-plan.ts`) concatenates
 *      `chapterPrefix + categorizedPrefix + '/' + sanitizeToken(template)`, so
 *      the baked layer always lands AFTER the `chapter:` segment in the final
 *      `-o` value and can never steal its first-token position (手册坑 46 /
 *      D-275). When the USER's own template starts with `chapter:`, the layer
 *      is inserted behind that selector segment instead of in front of it.
 *
 * Pure string rules only — no I/O, no clock, no node:* imports (A-INF-01).
 */
import { sanitizeFileName } from '../path-resolver/index.js';

/**
 * Upper bound for one baked title layer, mirroring `sanitizeTaskSegment`
 * (path-resolver/volume.ts). 64 characters is small enough to defend the
 * Windows MAX_PATH (260) budget — the plan also truncates the whole `-o`
 * ARGV element at 259, and the layer shares that budget with the chapter
 * prefix (`chapter:`, 8), the categorized prefix (`%(extractor_key)s/` +
 * `%(playlist|.)s/`, ≤ 34) and the rest of the user template (the longest
 * built-in is ~30 chars; `%(title).200B` bounds the title) — while staying
 * above the point where ordinary playlist titles get cut. The cap bounds OUR
 * contribution to ~65 chars so a normal template never reaches the truncation
 * boundary; a user template that was already near 259 keeps its pre-existing
 * (registered) truncation behaviour.
 */
export const PLAYLIST_TITLE_LAYER_MAX = 64;

/** Trailing dots/spaces that a mid-string slice can re-expose (same class as
 * `sanitizeFileName`'s TRAILING_DOT_SPACE_RE rule). */
const TRAILING_DOT_SPACE_RE = /[. ]+$/g;

/**
 * The literal directory layer for playlist-classified batch downloads.
 *
 * Returns `''` (bake nothing) when the switch is off, the title is
 * empty/whitespace, or the title sanitizes to nothing usable; otherwise
 * returns `<name>/` — a NON-EMPTY name plus a trailing forward slash, ready to
 * prefix an output template. Forward slashes are the template convention
 * (yt-dlp normalises them per platform).
 *
 * Sanitization reuses the repository's single filename purifier,
 * `sanitizeFileName` (D-270 chain parity): the 9 illegal Windows character
 * classes including `/` and `\` become `_`, reserved device names are
 * prefixed, and trailing dots/spaces are stripped — so the result can never
 * contain a separator, be `.`/`..`, or be a device name. What it deliberately
 * does NOT do is the `sanitizeToken` whitespace rewrite: spaces stay in the
 * baked template and the plan's argv-safety pass (`sanitizeToken`, applied to
 * the whole template in `download-plan.ts` AND in `resolveOutputPath`'s
 * preview) turns them into `_` — the same single rewrite on both chains, so
 * the preview and the on-disk name stay identical (a space renders as `_`,
 * which is the registered, honest behaviour).
 */
export function playlistTitleTemplateLayer(
  playlistTitle: string,
  subdirByPlaylist: boolean,
): string {
  if (subdirByPlaylist !== true) return '';
  if (typeof playlistTitle !== 'string') return '';
  const trimmed = playlistTitle.trim();
  if (trimmed === '') return '';
  // sanitizeFileName never returns '' or a separator-carrying value; it maps
  // `.`/`..`-like input to `_` (trailing-dot strip + empty fallback).
  let name = sanitizeFileName(trimmed);
  if (name.length > PLAYLIST_TITLE_LAYER_MAX) {
    name = name.slice(0, PLAYLIST_TITLE_LAYER_MAX);
    // The cap can cut inside a dots/spaces run and re-expose a trailing run.
    name = name.replace(TRAILING_DOT_SPACE_RE, '');
  }
  if (name === '' || name === '.' || name === '..') return '';
  return `${name}/`;
}

/**
 * Prefix a template with the literal layer, honouring a leading `chapter:`
 * SELECTOR segment in the user's own template: the selector must keep
 * selecting everything after it (including the layer), and the layer must
 * never end up in front of a `chapter:` token. `layer === ''` is a no-op.
 */
export function bakePlaylistTitleLayer(template: string, layer: string): string {
  const base = typeof template === 'string' ? template : '';
  if (typeof layer !== 'string' || layer === '') return base;
  if (base.startsWith('chapter:')) {
    return `chapter:${layer}${base.slice('chapter:'.length)}`;
  }
  return `${layer}${base}`;
}
