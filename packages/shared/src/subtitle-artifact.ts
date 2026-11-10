/**
 * Stage 4 (append-only): what a finished task actually got as SUBTITLE files,
 * and how each file relates to the media it belongs to.
 *
 * Ownership rule that must never be relaxed:
 *  1. A subtitle file is attributed to a task only because **that task's own
 *     yt-dlp process** reported writing it (`--print-to-file` on
 *     `requested_subtitles`). Never by scanning a download folder, never by
 *     matching a name against a directory listing.
 *  2. The file name is used for exactly ONE thing: recovering the language tag
 *     yt-dlp itself put there (`<media base>.<lang>.<ext>`). A name that does
 *     not follow that shape yields `language: ''` — "unknown", not a guess.
 *  3. `source` comes from the probe buckets (`subtitles` vs
 *     `automatic_captions`). If the language is not in either bucket the answer
 *     is `unknown`; it is never inferred from the name or the file content.
 *
 * This file is pure types only (no I/O), like the rest of `@ytvdlt/shared`.
 */

/** Which bucket the language came from (evidence, not a guess). */
export type SubtitleArtifactSource = 'manual' | 'automatic' | 'unknown';

/** One produced subtitle file, linked to the media it belongs to. */
export interface SubtitleFileLink {
  /** Absolute final path, as verified on disk at completion time. */
  readonly path: string;
  /**
   * yt-dlp language tag (`en`, `zh-Hans`, `pt-BR`). Empty string means the file
   * name carried no language segment — the UI must show it as "unlabelled"
   * instead of inventing a language.
   */
  readonly language: string;
  /** Lower-case extension without the dot (`srt`, `vtt`, `ass`, …). */
  readonly ext: string;
  readonly source: SubtitleArtifactSource;
  /**
   * Absolute path of the media this file belongs to. Empty only when the task
   * produced no media artifact at all (a broken run, not a normal outcome).
   */
  readonly mediaPath: string;
}

/**
 * Did a task that ASKED for subtitles actually end up with them?
 *
 * - `none`    — the request never asked for subtitles.
 * - `ok`      — every requested language produced at least one file.
 * - `partial` — some requested languages produced nothing (site had no such
 *               track, a 403 on one language, …).
 * - `missing` — subtitles were requested and NO file was produced.
 *
 * This is deliberately NOT a task state: a missing subtitle must never turn a
 * finished video into `Error` (D-127). The renderer is expected to surface it
 * as an annotation on a completed task.
 */
export type SubtitleOutcome = 'none' | 'ok' | 'partial' | 'missing';

/** One attachment probe (advisory, never part of C1–C12 verdicts). */
export interface AttachmentProbe {
  readonly path: string;
  readonly kind: 'subtitle' | 'thumbnail' | 'infojson';
  readonly status: 'PASS' | 'FAIL' | 'SKIPPED';
  readonly detail: string;
}
