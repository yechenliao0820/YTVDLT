/**
 * JsonMapper — PURE functions mapping `yt-dlp --dump-single-json` output to
 * `MediaInfo` / `PlaylistInfo` (ARCHITECTURE §4.4, A-4.1-04 / A-INF-08).
 *
 * Never throws, never touches the network, never spawns a process. Missing
 * fields are filled with contract default values; malformed items are skipped.
 */
import type {
  MediaInfo, PlaylistInfo, MediaFormat, SubtitleTrack, Chapter, PlaylistEntry,
} from '@ytvdlt/shared';
import {
  isRecord, asArray, numOrNull, strOrNull, strOr, firstString,
} from './media-guards.js';

function mapFormat(raw: unknown): MediaFormat | null {
  if (!isRecord(raw)) return null;
  return {
    format_id: strOr(raw['format_id'], ''),
    ext: strOr(raw['ext'], ''),
    width: numOrNull(raw['width']),
    height: numOrNull(raw['height']),
    vcodec: strOr(raw['vcodec'], 'none'),
    acodec: strOr(raw['acodec'], 'none'),
    filesize: numOrNull(raw['filesize']),
    filesize_approx: numOrNull(raw['filesize_approx']),
    tbr: numOrNull(raw['tbr']),
    fps: numOrNull(raw['fps']),
    format_note: strOrNull(raw['format_note']),
    ...(strOrNull(raw['url']) === null ? {} : { url: strOrNull(raw['url']) as string }),
  };
}

function mapSubtitleBuckets(raw: unknown): Record<string, SubtitleTrack[]> {
  const result: Record<string, SubtitleTrack[]> = {};
  if (!isRecord(raw)) return result;
  for (const [lang, tracks] of Object.entries(raw)) {
    if (!Array.isArray(tracks)) continue;
    const mapped: SubtitleTrack[] = [];
    for (const track of tracks) {
      if (!isRecord(track)) continue;
      const ext = strOrNull(track['ext']) ?? 'vtt';
      const name = strOrNull(track['name']);
      const url = strOrNull(track['url']);
      mapped.push({
        lang,
        ext,
        name,
        ...(url === null ? {} : { url }),
      });
    }
    result[lang] = mapped;
  }
  return result;
}

function mapChapters(raw: unknown): Chapter[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const chapters: Chapter[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const start = numOrNull(item['start_time']);
    const end = numOrNull(item['end_time']);
    if (start === null || end === null || start < 0 || end < start) continue;
    chapters.push({ start_time: start, end_time: end, title: strOr(item['title'], '') });
  }
  return chapters;
}

function mapType(raw: unknown): MediaInfo['_type'] {
  if (raw === 'url' || raw === 'url_transparent' || raw === 'video') return raw;
  return 'video';
}

/** Map a recorded single-video JSON object to `MediaInfo` (never throws). */
export function toMediaInfo(raw: unknown): MediaInfo {
  const record: Record<string, unknown> = isRecord(raw) ? raw : {};
  const id = strOr(record['id'], '');
  const extractorKey = (firstString(record, ['extractor_key', 'extractor']) ?? 'generic')
    .toLowerCase().replace(/\s+/g, '');
  const formats = asArray(record['formats'])
    .map(mapFormat)
    .filter((value): value is MediaFormat => value !== null);
  const uploadDate = strOrNull(record['upload_date']);
  return {
    id,
    title: strOr(record['title'], `${extractorKey}:${id}`),
    uploader: firstString(record, ['uploader', 'channel', 'creator']),
    uploader_id: firstString(record, ['uploader_id', 'channel_id']),
    duration: numOrNull(record['duration']),
    thumbnail: (() => {
      const direct = strOrNull(record['thumbnail']);
      if (direct !== null) return direct;
      const thumbs = asArray(record['thumbnails']);
      const last = thumbs[thumbs.length - 1];
      return isRecord(last) ? strOrNull(last['url']) : null;
    })(),
    webpage_url: firstString(record, ['webpage_url', 'original_url', 'url']) ?? '',
    extractor_key: extractorKey,
    description: strOrNull(record['description']),
    upload_date: uploadDate !== null && /^\d{8}$/.test(uploadDate) ? uploadDate : null,
    ext: strOrNull(record['ext']) ?? (strOrNull(formats[0]?.ext) ?? 'mp4'),
    formats,
    subtitles: mapSubtitleBuckets(record['subtitles']),
    automatic_captions: mapSubtitleBuckets(record['automatic_captions']),
    chapters: mapChapters(record['chapters']),
    _type: mapType(record['_type']),
  };
}

/** Map a recorded `--flat-playlist --dump-single-json` object to `PlaylistInfo`. */
export function toPlaylistInfo(raw: unknown): PlaylistInfo {
  const record: Record<string, unknown> = isRecord(raw) ? raw : {};
  const entries: PlaylistEntry[] = [];
  let skippedEntries = 0;
  for (const item of asArray(record['entries'])) {
    // yt-dlp emits `null` for a removed / private / unavailable slot.
    if (!isRecord(item)) { skippedEntries += 1; continue; }
    entries.push({
      id: strOr(item['id'], ''),
      title: strOr(item['title'], ''),
      url: strOr(item['url'], ''),
      duration: numOrNull(item['duration']),
      _type: strOr(item['_type'], 'url'),
    });
  }
  const declaredCount = numOrNull(record['playlist_count']);
  return {
    id: strOr(record['id'], ''),
    title: strOr(record['title'], ''),
    _type: 'playlist',
    extractor_key: (firstString(record, ['extractor_key', 'extractor']) ?? 'generic')
      .toLowerCase().replace(/\s+/g, ''),
    webpage_url: firstString(record, ['webpage_url', 'original_url', 'url']) ?? '',
    entries,
    // Conditional spread keeps the legacy object shape byte-identical for
    // fixtures without these keys (frozen M1/M4 mapper contracts).
    ...(declaredCount === null ? {} : { playlistCount: declaredCount }),
    ...(skippedEntries === 0 ? {} : { skippedEntries }),
  };
}

/** Dispatch by `_type` (playlist vs video). */
export function mapProbeResult(raw: unknown): MediaInfo | PlaylistInfo {
  return isRecord(raw) && raw['_type'] === 'playlist'
    ? toPlaylistInfo(raw)
    : toMediaInfo(raw);
}

export const JsonMapper = { toMediaInfo, toPlaylistInfo, mapProbeResult } as const;
