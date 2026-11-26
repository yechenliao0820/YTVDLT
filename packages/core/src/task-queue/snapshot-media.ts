/**
 * D-163: the snapshot is the ONLY place `MediaInfo` is written to disk.
 *
 * yt-dlp returns `formats[].url` and `subtitles[].url` as *signed* CDN links
 * (they carry `expire` / `sig` / `X-Amz-*` credentials). Nothing in the
 * application ever reads them: the format selector uses `format_id` / size /
 * codec, the subtitle planner uses `lang` / `ext`, and every renderer-facing
 * DTO strips them. Keeping them in `<configDir>/tasks.json` therefore buys
 * nothing and leaks the user's session material into a plain-text file.
 *
 * `thumbnail` is deliberately NOT stripped. Unlike the links above it has a
 * real consumer: the main process re-fetches covers at boot from the RESTORED
 * records (`mediaInfo.thumbnail` -> `ThumbnailCache.ensure()`, whose cache key
 * is `sha1(url)`), and `restore()` rehydrates memory from this file — so a
 * stripped thumbnail would permanently lose every restored task's cover after
 * a restart. Residual risk, accepted for now: the URL never leaves the main
 * process (TASK_LIST only returns the local `thumbPath`) and grants a preview
 * image, not the media. The clean fix is a local cover reference in the
 * snapshot plus an URL-less boot re-attach, which is an apps/desktop change of
 * its own.
 *
 * In-memory records keep the full object (so `restart()` can reuse a cached
 * probe and `subtitleFiles` reconciliation still sees the links). Only the
 * persisted projection is minimised here.
 *
 * D-279: this function is part of the projection's ZERO-THROW contract.
 * D-268 hardened `request`, but `mediaInfo` still called `.map` on whatever
 * the snapshot held. `TaskStore.sanitizeRecord()` only guarantees `formats` is
 * an ARRAY — it never inspects the elements, and it leaves `subtitles` /
 * `automatic_captions` entirely alone — so a hand-edited or disk-damaged
 * `tasks.json` carrying `formats: [null]`, `subtitles: "x"` or `tracks: [1]`
 * made every structural write throw a TypeError ("Cannot read properties of
 * null (reading 'url')"). The projection runs on the boot `restore()`, on
 * every enqueue/remove/restart and inside `run().finally`, so that one row
 * cost the whole queue. Every access below is now shape-checked; malformed
 * values pass through UNTOUCHED (the load-side repair owns normalisation)
 * instead of throwing.
 */
import type { MediaInfo } from '@ytvdlt/shared';

/** Plain-object check: arrays and null are not records. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drop `url` from one object without changing any other field. */
function withoutUrl(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if (value['url'] === undefined) return value;
  const { url: _dropped, ...rest } = value;
  return rest;
}

function minimalFormats(formats: unknown): MediaInfo['formats'] {
  if (!Array.isArray(formats)) return formats as MediaInfo['formats'];
  return formats.map(withoutUrl) as MediaInfo['formats'];
}

/** `{ lang: tracks[] }`; a bucket that is not an array is left as-is. */
function minimalBuckets(buckets: unknown): MediaInfo['subtitles'] {
  if (!isPlainObject(buckets)) return buckets as MediaInfo['subtitles'];
  const out: Record<string, unknown> = {};
  for (const [lang, tracks] of Object.entries(buckets)) {
    out[lang] = Array.isArray(tracks) ? tracks.map(withoutUrl) : tracks;
  }
  return out as MediaInfo['subtitles'];
}

/**
 * Return a copy of `info` that is safe to serialise. Field order and every
 * non-`url` value are preserved, so a snapshot written before this change and
 * one written after differ only by the removed links. A non-object `info` is
 * returned untouched (D-279): the projection must never throw.
 */
export function stripCredentialUrls(info: MediaInfo): MediaInfo {
  if (!isPlainObject(info)) return info;
  return {
    ...(info as unknown as Record<string, unknown>),
    formats: minimalFormats((info as unknown as Record<string, unknown>)['formats']),
    subtitles: minimalBuckets((info as unknown as Record<string, unknown>)['subtitles']),
    automatic_captions: minimalBuckets(
      (info as unknown as Record<string, unknown>)['automatic_captions'],
    ),
  } as unknown as MediaInfo;
}
