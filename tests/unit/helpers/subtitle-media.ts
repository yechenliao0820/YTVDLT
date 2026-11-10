/**
 * Subtitle-preview test fixtures (stage 2).
 *
 * The signed URL below is a deliberate bait: any assertion that the DTO still
 * contains `SUPERSECRET` or the string `http` is proving a credential leak, so
 * the value never appears in a passing payload.
 */
import type { MediaInfo, SubtitleTrack } from '@ytvdlt/shared';

export const SIGNED_SUB_URL = 'https://cdn.example.org/sub.vtt?token=SUPERSECRET&sig=deadbeef';
export const SIGNED_PAGE_URL = 'https://example.org/watch?v=abc&token=SUPERSECRET';

/** One yt-dlp subtitle track. `lang` is the bucket key, as the mapper sets it. */
export function trackOf(lang: string, ext: string, name: string | null = null): SubtitleTrack {
  return { lang, ext, name, url: SIGNED_SUB_URL };
}

/** Group tracks into the `Record<lang, SubtitleTrack[]>` shape yt-dlp produces. */
export function bucketOf(...tracks: readonly SubtitleTrack[]): Record<string, SubtitleTrack[]> {
  const out: Record<string, SubtitleTrack[]> = {};
  for (const track of tracks) {
    const list = out[track.lang] ?? (out[track.lang] = []);
    list.push(track);
  }
  return out;
}

/** A complete `MediaInfo`; every field a preview must NOT leak is filled in. */
export function mediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    id: 'vid001',
    title: 'Fixture Video',
    uploader: 'Fixture Channel',
    uploader_id: 'UC_fixture',
    duration: 212,
    thumbnail: 'https://example.org/thumb.jpg',
    webpage_url: SIGNED_PAGE_URL,
    extractor_key: 'youtube',
    description: 'offline fixture',
    upload_date: '20261101',
    ext: 'mp4',
    formats: [{
      format_id: '137', ext: 'mp4', width: 1920, height: 1080, vcodec: 'avc1', acodec: 'none',
      filesize: 1000, filesize_approx: null, tbr: 4000, fps: 30, format_note: null,
      url: 'https://cdn.example.org/video.mp4?token=SUPERSECRET',
    }],
    subtitles: {},
    automatic_captions: {},
    chapters: null,
    _type: 'video',
    ...overrides,
  };
}

/** Every string reachable from `value` (own keys only). */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out); return out; }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

/** Every property name reachable from `value`. */
export function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, out); return out; }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

/**
 * Assert a payload a renderer can see carries no URL and no credential.
 * Returns the offending strings so a failure message names the leak.
 */
export function findUrlLeaks(value: unknown): string[] {
  const leaks = collectKeys(value).filter((key) => /url|token|signature|sig/i.test(key));
  for (const text of collectStrings(value)) {
    if (/https?:\/\//i.test(text) || /SUPERSECRET/.test(text)) leaks.push(text);
  }
  return leaks;
}
