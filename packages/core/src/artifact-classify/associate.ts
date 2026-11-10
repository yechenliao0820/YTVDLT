/**
 * Subtitle ↔ media association (stage 4).
 *
 * The hard requirement: **ownership is never guessed from a directory.**
 * A file enters this function only because the task's own yt-dlp process
 * printed it, so "does this file belong to this task" is already answered. What
 * is left is the *secondary* question — which media of that task, and which
 * language — and both are answered from evidence:
 *
 *   1. media   — the longest media basename that is a prefix of the subtitle
 *                file name; a single-media task simply uses its media.
 *   2. language— the middle segment of `<media base>.<lang>.<ext>`, validated.
 *                No prefix match ⇒ `''` (unlabelled), never the whole filename
 *                posing as a language code.
 *   3. source  — the probe buckets (`subtitles` / `automatic_captions`).
 *
 * Cases the caller must keep in mind (documented, tested):
 *  - same language, several files: yt-dlp writes ONE file per language, so this
 *    only happens when a previous run left another format behind. Each file is
 *    still listed (it exists, it is this task's), and each carries the same
 *    language so the UI can group them.
 *  - different videos, same title: names carry `[id]` and/or ` (n)`, so the
 *    prefix differs per task; and a file is only ever considered here if THIS
 *    task's process reported it.
 *  - retry / partial download: the list is recomputed from the new run's
 *    artifacts; `restart()` clears it, so nothing stale survives.
 */
import type { MediaInfo, SubtitleArtifactSource, SubtitleDomain, SubtitleFileLink } from '@ytvdlt/shared';
import { extOf, isMediaArtifact, isSubtitleArtifact, mediaArtifactsOf } from './kinds.js';

/** `D:/a/b/file.srt` → `file.srt` (both separators, no `node:path`). */
export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** `file.en.srt` → `file.en` (strips the LAST extension only). */
export function stripExtOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? name : name.slice(0, index);
}

const LANGUAGE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * Language segment of `<media base>.<lang>.<ext>`, or `''` when the name does
 * not follow that shape.
 *
 * `mediaBase` is passed explicitly (not derived from a directory listing): it
 * comes from the media path yt-dlp printed for the SAME task.
 */
export function languageFromName(subtitlePath: string, mediaPath: string): string {
  const name = basenameOf(subtitlePath);
  const base = stripExtOf(name);
  if (mediaPath === '') return '';
  const mediaBase = stripExtOf(basenameOf(mediaPath));
  if (mediaBase === '' || !base.startsWith(`${mediaBase}.`)) return '';
  const candidate = base.slice(mediaBase.length + 1);
  if (candidate === '') return '';
  return LANGUAGE_TAG.test(candidate) ? candidate : '';
}

/**
 * Which media of this task the subtitle belongs to.
 *
 * Longest matching base wins, so `video.1080p [id].en.srt` is not attributed to
 * `video [id].mp4` merely because the shorter name is also a prefix.
 */
export function mediaForSubtitle(subtitlePath: string, mediaPaths: readonly string[]): string {
  const name = stripExtOf(basenameOf(subtitlePath));
  let best = '';
  let bestLength = -1;
  for (const media of mediaPaths) {
    const base = stripExtOf(basenameOf(media));
    if (base === '') continue;
    if (name === base || name.startsWith(`${base}.`)) {
      if (base.length > bestLength) {
        best = media;
        bestLength = base.length;
      }
    }
  }
  if (best !== '') return best;
  // A single-media task is unambiguous even when the names do not line up
  // (custom template without the media name, chapter split, …).
  return mediaPaths.length === 1 ? mediaPaths[0] as string : '';
}

/** Evidence-based source: which probe bucket carries this language. */
export function subtitleSourceOf(mediaInfo: MediaInfo | null, language: string, subtitle?: SubtitleDomain | null): SubtitleArtifactSource {
  if (mediaInfo === null || language === '') return 'unknown';
  const manual = mediaInfo.subtitles?.[language];
  const wantsManual = subtitle === undefined || (subtitle !== null
    && (subtitle.enabled || (subtitle.embed && !subtitle.autoCaptions)));
  if (wantsManual && Array.isArray(manual) && manual.length > 0) return 'manual';
  const automatic = mediaInfo.automatic_captions?.[language];
  if ((subtitle === undefined || subtitle?.autoCaptions === true)
    && Array.isArray(automatic) && automatic.length > 0) return 'automatic';
  return 'unknown';
}

/**
 * Build the task's subtitle links from the artifacts it really produced.
 * Order follows the artifact list, so the result is deterministic.
 */
export function buildSubtitleLinks(input: {
  readonly artifacts: readonly string[];
  readonly mediaInfo: MediaInfo | null;
  readonly subtitle?: SubtitleDomain | null;
}): SubtitleFileLink[] {
  const mediaPaths = mediaArtifactsOf(input.artifacts);
  const links: SubtitleFileLink[] = [];
  const seen = new Set<string>();
  for (const path of input.artifacts) {
    if (!isSubtitleArtifact(path)) continue;
    const key = path.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const mediaPath = mediaForSubtitle(path, mediaPaths);
    const language = languageFromName(path, mediaPath);
    links.push({
      path,
      language,
      ext: extOf(path),
      source: subtitleSourceOf(input.mediaInfo, language, input.subtitle),
      mediaPath,
    });
  }
  return links;
}

/**
 * True when the task produced at least one media file. Used to distinguish
 * "audio/video task" from a degenerate artifact list before reporting a
 * subtitle outcome.
 */
export function hasMediaArtifact(artifacts: readonly string[]): boolean {
  return artifacts.some((path) => isMediaArtifact(path));
}
