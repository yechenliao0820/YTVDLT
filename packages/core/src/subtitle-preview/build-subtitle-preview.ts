/**
 * Subtitle preview projection (stage 2) — PURE, no I/O, no `node:*`.
 *
 * The single job: turn `MediaInfo.subtitles` / `automatic_captions` into the
 * whitelisted `SubtitleTrackPreview[]` the renderer is allowed to see.
 *
 * Three rules that are easy to get wrong and were each a real bug in the old
 * fixture dialog:
 *
 *  1. **Source is the bucket, never the label.** `subtitles` = manual,
 *     `automatic_captions` = automatic. A track's `name` ("English (auto)"),
 *     its `ext`, or a `-orig` suffix prove nothing; guessing from them is how
 *     automatic captions used to be presented as manual.
 *  2. **One row per language.** The same code can exist in both buckets
 *     (YouTube ships manual `en` + automatic `en`), so the row carries two
 *     availability flags and two format lists — not two rows, and not one
 *     silently winning.
 *  3. **No URL leaves this module.** `SubtitleTrack.url` is signed and
 *     credential-bearing; only `ext` and `name` are read here.
 */
import type { MediaInfo, SubtitleTrack, SubtitleTrackPreview } from '@ytvdlt/shared';

/** `languageCode` ceiling — real codes (`zh-Hans`, `pt-BR`) are far shorter. */
const MAX_LANGUAGE_CODE = 40;
/**
 * yt-dlp language keys: `en`, `zh-Hans`, `pt-BR`, `en-orig`, `zh-Hant-TW`.
 * Anything else is a corrupted bucket key, not a language — reject it instead
 * of truncating it into a plausible-looking code.
 */
const LANGUAGE_CODE_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_LANGUAGE_CODE - 1}}$`);
/** Display names are site-supplied; keep them short and single-line. */
const MAX_DISPLAY_NAME = 80;
/** Only a plausible container token survives; `ttml`, `srv3`, `json3` pass. */
const EXT_RE = /^[a-z0-9]{1,8}$/;
/**
 * Control characters, zero-width joiners and the bidi overrides (U+202A…202E,
 * U+2066…2069). The last group can visually reverse a string — a display name
 * must never be able to spoof another language in the picker.
 */
const UNSAFE_DISPLAY_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strip control/bidi characters, collapse whitespace, cap the length. */
export function sanitizeDisplayText(raw: unknown, maxLength = MAX_DISPLAY_NAME): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_DISPLAY_RE, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

/** `'VTT '` → `'vtt'`; anything that is not a container token → `null`. */
function normalizeExt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ext = raw.trim().toLowerCase();
  return EXT_RE.test(ext) ? ext : null;
}

/** Bucket key → a real language code, or `null` for junk keys. */
export function normalizeLanguageCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  return LANGUAGE_CODE_RE.test(code) ? code : null;
}

/** Runtime-safe bucket read: a hand-edited snapshot may hold junk. */
function bucketOf(media: Pick<MediaInfo, 'subtitles' | 'automatic_captions'>, key: 'subtitles' | 'automatic_captions'): Record<string, unknown> {
  const value: unknown = media[key];
  return isRecord(value) ? value : {};
}

function tracksOf(bucket: Record<string, unknown>, code: string): readonly SubtitleTrack[] {
  const value = bucket[code];
  if (!Array.isArray(value)) return [];
  return value.filter((track): track is SubtitleTrack => isRecord(track));
}

/** Unique, sorted, valid extensions for one bucket+language. */
function formatsOf(tracks: readonly SubtitleTrack[]): string[] {
  const set = new Set<string>();
  for (const track of tracks) {
    const ext = normalizeExt(track.ext);
    if (ext !== null) set.add(ext);
  }
  return [...set].sort();
}

/** First usable display name in TICK ORDER (manual wins over automatic). */
function firstDisplayName(tracks: readonly SubtitleTrack[]): string | null {
  for (const track of tracks) {
    const name = sanitizeDisplayText(track.name);
    if (name !== null) return name;
  }
  return null;
}

/** ASCII comparison — deterministic across ICU versions (same reason as the queue). */
function compareCode(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return a < b ? -1 : a > b ? 1 : 0;
  return left < right ? -1 : 1;
}

/**
 * Project both buckets into source-aware language rows.
 *
 * Ordering: manual rows first (that is what a user wants to click), then
 * automatic-only rows; inside each group by language code. Deterministic, so a
 * screenshot/DOM baseline never depends on JSON key order.
 */
export function collectSubtitleTracks(
  media: Pick<MediaInfo, 'subtitles' | 'automatic_captions'>,
): SubtitleTrackPreview[] {
  const manualBucket = bucketOf(media, 'subtitles');
  const autoBucket = bucketOf(media, 'automatic_captions');
  const codes = [...new Set([...Object.keys(manualBucket), ...Object.keys(autoBucket)])];

  const rows: { row: SubtitleTrackPreview; manual: boolean }[] = [];
  for (const code of codes) {
    const languageCode = normalizeLanguageCode(code);
    if (languageCode === null) continue;
    const manualTracks = tracksOf(manualBucket, code);
    const autoTracks = tracksOf(autoBucket, code);
    const manualFormats = formatsOf(manualTracks);
    const autoFormats = formatsOf(autoTracks);
    // A key with an empty (or wholly malformed) array offers nothing.
    if (manualFormats.length === 0 && autoFormats.length === 0) continue;
    rows.push({
      manual: manualFormats.length > 0,
      row: {
        languageCode,
        languageName: firstDisplayName(manualTracks) ?? firstDisplayName(autoTracks),
        manualAvailable: manualFormats.length > 0,
        automaticAvailable: autoFormats.length > 0,
        manualFormats,
        automaticFormats: autoFormats,
      },
    });
  }

  rows.sort((a, b) => (a.manual === b.manual ? compareCode(a.row.languageCode, b.row.languageCode) : a.manual ? -1 : 1));
  return rows.map((item) => item.row);
}

/** Derived counters for the DTO — never recomputed by the renderer. */
export function summarizeSubtitleTracks(tracks: readonly SubtitleTrackPreview[]): {
  manualLanguages: number;
  automaticLanguages: number;
  empty: boolean;
} {
  return {
    manualLanguages: tracks.filter((track) => track.manualAvailable).length,
    automaticLanguages: tracks.filter((track) => track.automaticAvailable).length,
    empty: tracks.length === 0,
  };
}
