/**
 * DownloadPlan — M3's ONLY derivation layer (M3-F001 / D-35).
 *
 * This is a NEW, INDEPENDENT type. It is NOT a field of `DownloadRequest` and
 * must never be added to the five frozen domains (C2 / Q-M3-11). In particular
 * `mergeToMkv` lives here (and in `SubtitlePlanner`'s return value) only — never
 * in `PathsDomain`, never in `DownloadContext`.
 *
 * `resolveDownloadPlan(req)` deterministically reduces a `DownloadRequest` into
 * this plan following the P0->P7 priority chain plus R1-R5. `buildDownload()`
 * consumes the plan, so every DTO source (UI, config import, contract tests,
 * M4 batch enqueue) produces the identical argv for identical input.
 */

export type PlanWarningCode =
  | 'R1_AUDIO_TRANSCODE_SUPPRESSES_ABR'
  | 'R5_SPLIT_SUPPRESSED_BY_SECTIONS'
  | 'R5_SPLIT_SUPPRESSES_EMBED'
  | 'R5_SPLIT_DISABLED_NO_CHAPTERS'
  | 'P1_AUDIO_MODE_SUPPRESSES_EMBED'
  | 'ARIA2C_SUPPRESSES_FRAGMENTS'
  | 'PPA_UNSUPPORTED_DOWNGRADED'
  | 'CUSTOM_COMMAND_IGNORED'
  | 'PLAYLIST_ITEMS_INVALID';

export interface PlanWarning {
  readonly code: PlanWarningCode;
  readonly detail: string;
}

/** Unique derivation output; never written back into the DTO. */
export interface DownloadPlan {
  // ---- format / audio (M2 frozen positions 13-20) ----
  readonly effectiveFormatId: string | null;
  readonly effectiveSort: string | null;
  readonly extractAudio: boolean;
  readonly audioFormat: 'mp3' | 'm4a' | null;
  /**
   * D-83 (append-only): ffmpeg quality for the transcode, emitted as
   * `--audio-quality`. Non-null only when `audioFormat !== null`; in that mode
   * R1 removes every `-S abr~N`, so this is the ONLY place an explicit audio
   * bitrate can still take effect.
   */
  readonly audioTranscodeQuality: string | null;
  readonly audioMultistreams: boolean;

  // ---- subtitles (M2 positions 21-27 + M3 conditional segments) ----
  readonly writeSubs: boolean;
  readonly subLangs: string;
  readonly autoCaptions: boolean;
  readonly skipTranslatedSubs: boolean;
  readonly convertTo: 'none' | 'ass' | 'srt' | 'vtt' | 'lrc';
  readonly embedSubs: boolean;
  readonly keepSubtitleFile: boolean;
  readonly mergeToMkv: boolean;

  // ---- advanced / R5 (M3 conditional segments) ----
  readonly downloadSections: string | null;
  readonly splitChapters: boolean;
  readonly suppressRemux: boolean;
  readonly chapterPrefix: string;
  readonly sponsorblockRemove: string | null;
  readonly replaceInMetadata: string | null;
  readonly ppa: string | null;
  readonly debug: boolean;

  // ---- paths (M2 positions 28-31 + M3 conditional segments) ----
  readonly outputDir: string;
  readonly outputTemplate: string;
  readonly restrictFilenames: boolean;
  readonly explicitTempDir: string | null;
  readonly privateMode: boolean;

  // ---- network (M2 positions 32-41 + M3 conditional segments) ----
  readonly rateLimit: string | null;
  readonly proxy: string | null;
  readonly cookiesFile: string | null;
  readonly userAgent: string | null;
  readonly ipv4Only: boolean;
  readonly concurrentFragments: number | null;
  readonly aria2cPath: string | null;

  // ---- metadata / thumbnail (no DTO fields; deterministically derived) ----
  readonly embedMetadata: boolean;
  readonly embedThumbnail: boolean;
  readonly writeThumbnail: boolean;
  readonly embedChapters: boolean;
  readonly downloadArchive: string | null;
  /** Validated `--playlist-items` expression (M4-4); null = single video. */
  readonly playlistItems: string | null;

  /** Conflict WARNINGs are recorded, never silently dropped. */
  readonly warnings: readonly PlanWarning[];
}
