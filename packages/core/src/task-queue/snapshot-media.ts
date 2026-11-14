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
 */
import type { MediaFormat, MediaInfo, SubtitleTrack } from '@ytvdlt/shared';

/** Drop `url` from one format entry without changing any other field. */
function minimalFormat(format: MediaFormat): MediaFormat {
  if (format.url === undefined) return format;
  const { url: _dropped, ...rest } = format;
  return rest;
}

/** Drop `url` from one subtitle track. */
function minimalTrack(track: SubtitleTrack): SubtitleTrack {
  if (track.url === undefined) return track;
  const { url: _dropped, ...rest } = track;
  return rest;
}

function minimalBuckets(
  buckets: MediaInfo['subtitles'],
): MediaInfo['subtitles'] {
  const out: Record<string, SubtitleTrack[]> = {};
  for (const [lang, tracks] of Object.entries(buckets ?? {})) {
    out[lang] = tracks.map(minimalTrack);
  }
  return out;
}

/**
 * Return a copy of `info` that is safe to serialise. Field order and every
 * non-`url` value are preserved, so a snapshot written before this change and
 * one written after differ only by the removed links.
 */
export function stripCredentialUrls(info: MediaInfo): MediaInfo {
  return {
    ...info,
    formats: info.formats.map(minimalFormat),
    subtitles: minimalBuckets(info.subtitles),
    automatic_captions: minimalBuckets(info.automatic_captions),
  };
}
