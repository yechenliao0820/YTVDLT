/**
 * Artifact classification — the single extension table for the whole app.
 *
 * Why this exists (stage 4): the engine, the verifier, the history builder and
 * the task-detail service each kept their own extension lists, and all of them
 * treated "not a known subtitle" as "video". A downloaded `.srv3` / `.ttml` /
 * `.json3` subtitle therefore became the task's MAIN FILE: the verifier ran
 * ffprobe on it, the history wrote it as `videoPath`, and the detail page opened
 * it with the system player. One table, one answer.
 *
 * Policy (deliberate, not "any unknown extension is a subtitle"):
 *  - The 13 subtitle extensions the project was asked to support are listed
 *    plus `sbv`, which is a real yt-dlp subtitle format (`--sub-format sbv`).
 *  - Anything else is `other`. It is never guessed into `video` or `subtitle`.
 *  - Media selection does NOT read `kind`; it uses the extension tables below,
 *    so a future classification mistake cannot corrupt C3–C8 again.
 */
import type { Artifact } from '@ytvdlt/shared';

export type ArtifactKind = Artifact['kind'];

/** Container extensions a finished download can legitimately use as "the file". */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'ts', 'm4v', 'm2ts', 'mts',
  '3gp', 'ogv', 'wmv', 'mpg', 'mpeg', 'f4v', 'asf', 'vob',
]);

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'm4a', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'aac', 'oga', 'weba', 'mka',
]);

/**
 * Subtitle extensions this app recognises.
 *
 * The 13 the project asked for, plus `sbv` (SubViewer) — a real subtitle format
 * some sites serve, and harmless to classify correctly. Order is irrelevant:
 * this is a membership test.
 *
 * Anything else is `other`. That is deliberate: a blanket "unknown extension ⇒
 * subtitle" rule would swallow `.bin`, `.txt` and future media containers.
 */
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'vtt', 'srt', 'ass', 'ssa', 'lrc', 'ttml',
  'srv1', 'srv2', 'srv3', 'json3', 'dfxp', 'sami', 'smi',
  'sbv',
]);

export const THUMBNAIL_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp',
]);

/** `json` alone is yt-dlp's info dict; `json3` above is a subtitle and checked first. */
export const INFOJSON_EXTENSIONS: ReadonlySet<string> = new Set(['json']);

/** Lower-case extension without the dot; `''` when the path has none. */
export function extOf(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return (match?.[1] ?? '').toLowerCase();
}

export function classifyArtifact(path: string): ArtifactKind {
  const ext = extOf(path);
  // Subtitle membership is tested BEFORE `json` so `.json3` is never an info dict.
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  if (INFOJSON_EXTENSIONS.has(ext)) return 'infojson';
  if (THUMBNAIL_EXTENSIONS.has(ext)) return 'thumbnail';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'other';
}

export function isSubtitleArtifact(path: string): boolean {
  return SUBTITLE_EXTENSIONS.has(extOf(path));
}

export function isMediaArtifact(path: string): boolean {
  const ext = extOf(path);
  return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
}

/**
 * The artifact that represents the download itself.
 *
 * Never falls back to `artifacts[0]`: with `--write-thumbnail` or a subtitle
 * written first, index 0 is routinely a `.jpg` / `.srt`, and running ffprobe on
 * it produced "the video is corrupt" for a perfectly good download.
 *
 * A known media extension wins. If there is none, an UNKNOWN extension is
 * allowed as a last resort — yt-dlp really does emit `unknown_video` / exotic
 * containers, and ffprobe sniffs content, not names. What is never allowed is a
 * subtitle, thumbnail or info dict standing in for the media.
 *
 * Returns `null` when the task produced no media at all — the caller must treat
 * that as a real failure rather than pick a `.srt`.
 */
export function primaryMediaArtifact(artifacts: readonly string[]): string | null {
  for (const path of artifacts) {
    if (isMediaArtifact(path)) return path;
  }
  for (const path of artifacts) {
    if (classifyArtifact(path) === 'other') return path;
  }
  return null;
}

/** Every media artifact, in manifest order (a playlist batch may have several). */
export function mediaArtifactsOf(artifacts: readonly string[]): string[] {
  return artifacts.filter((path) => isMediaArtifact(path));
}

export function subtitleArtifactsOf(artifacts: readonly string[]): string[] {
  return artifacts.filter((path) => isSubtitleArtifact(path));
}

/** Video-only subset (used where an audio file must not be offered as "the video"). */
export function videoArtifactsOf(artifacts: readonly string[]): string[] {
  return artifacts.filter((path) => VIDEO_EXTENSIONS.has(extOf(path)));
}
