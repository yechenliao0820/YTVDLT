/**
 * buildDownload — PURE argv builder for the download phase (A-M2-25).
 *
 * Frozen order per ARCHITECTURE-M2 §4.1. M3 (B3) adds ONLY conditional new
 * segments, all driven by `resolveDownloadPlan(req)` (the single decision
 * source). `buildDownload`'s signature, `DownloadContext`, the M2 relative
 * order and `DOWNLOAD_ARGV_FROZEN_ORDER` are UNCHANGED: with a default
 * `DownloadRequest` not a single M3 segment fires, so the hand-written
 * `EXPECTED_MINIMAL` literal still matches element-by-element.
 *
 * Every user-controllable token is sanitized by `sanitizeToken()` in the plan
 * before it enters argv, which keeps `argv.every(e => !/\s/.test(e))` true for
 * all >=60 M3 combination cases.
 */
import type { DownloadRequest } from '@ytvdlt/shared';
import { resolveDownloadPlan } from '@ytvdlt/core';
import { assertHttpUrl } from './argv-builder.js';
import { assertNoForbiddenOptions } from './argv-compliance.js';
import { YTVDLT_PROGRESS_TEMPLATE, PROGRESS_DELTA_SECONDS } from './progress-template.js';

export interface DownloadContext {
  /** Absolute path of the bundled node.exe (EJS JS runtime). */
  jsRuntimePath: string;
  /** Absolute directory containing ffmpeg.exe/ffprobe.exe. */
  ffmpegDir: string;
  /** Absolute path of the per-task artifact manifest file. */
  artifactManifestPath: string;
}

/** Documented argument order (tests assert against a literal copy, not this). */
export const DOWNLOAD_ARGV_FROZEN_ORDER: readonly string[] = [
  '--no-playlist', '--no-warnings', '--newline', '--socket-timeout', '-R',
  '--no-js-runtimes', '--js-runtimes', '--ffmpeg-location',
  '-f', '-S', '-x', '--audio-format', '--audio-multistreams',
  '--write-subs', '--sub-langs', '--write-auto-subs', '--embed-subs', '--convert-subs',
  '-P', '-o',
  '-r', '--proxy', '--cookies', '--add-header', '--concurrent-fragments',
  '--no-mtime', '--download-archive',
  '--progress-template', '--progress-delta', '--print-to-file',
  '--',
] as const;

/** Documentation-only description of an M3 conditional insertion segment. */
export interface M3Segment {
  readonly id: string;
  readonly anchor: string;
  readonly options: readonly string[];
  readonly trigger: string;
  /**
   * Documentation only (never read by the argv builder). `true` marks a segment
   * that a plain single-video request now emits — D-118 made `-P temp:` one of
   * them, because partial files are not a post-processing detail.
   */
  readonly firesForDefaultRequest: boolean;
}

/** Describes §4.2 insertion points; NEVER participates in argv construction. */
export const DOWNLOAD_ARGV_M3_SEGMENTS: readonly M3Segment[] = [
  { id: 'B0′', anchor: '-S value', options: ['-S'], trigger: 'composite sort (res/vcodec/abr/acodec)', firesForDefaultRequest: false },
  { id: 'B1′', anchor: 'after --audio-multistreams', options: ['--embed-metadata', '--embed-thumbnail'], trigger: 'extractAudio / audioFormat', firesForDefaultRequest: false },
  { id: 'B1″', anchor: 'after --audio-format value', options: ['--audio-quality'], trigger: 'plan.audioTranscodeQuality!==null (D-83)', firesForDefaultRequest: false },
  { id: 'B2′', anchor: 'after B1′', options: ['--ppa'], trigger: 'plan.ppa!==null (downgraded: never)', firesForDefaultRequest: false },
  { id: 'C1′', anchor: 'after --write-auto-subs, before --embed-subs', options: ['--extractor-args'], trigger: 'autoCaptions && skipTranslated', firesForDefaultRequest: false },
  { id: 'C2′', anchor: 'after --convert-subs', options: ['--remux-video', '--merge-output-format'], trigger: 'mergeToMkv (R2)', firesForDefaultRequest: false },
  { id: 'C3′', anchor: '--write-subs condition', options: ['--write-subs'], trigger: 'plan.writeSubs (no duplicate push)', firesForDefaultRequest: false },
  { id: 'C4′', anchor: 'after C2′', options: ['--embed-chapters', '--write-thumbnail', '--convert-thumbnails'], trigger: 'derived metadata flags', firesForDefaultRequest: false },
  { id: 'D0′', anchor: '-P / -o values', options: ['-P', '-o'], trigger: 'plan.outputDir / plan.outputTemplate', firesForDefaultRequest: false },
  { id: 'D1′', anchor: 'after -o', options: ['--restrict-filenames'], trigger: 'plan.restrictFilenames', firesForDefaultRequest: false },
  { id: 'D2′', anchor: 'after D1′', options: ['-P'], trigger: 'plan.tempDir!==null (D-118: every resolved download)', firesForDefaultRequest: true },
  { id: 'E1′', anchor: 'before --concurrent-fragments', options: ['-4'], trigger: 'plan.ipv4Only', firesForDefaultRequest: false },
  { id: 'E2′', anchor: 'after E1′', options: ['--downloader', '--downloader-args'], trigger: 'plan.aria2cPath!==null', firesForDefaultRequest: false },
  { id: 'E3′', anchor: '--concurrent-fragments condition', options: ['--concurrent-fragments'], trigger: 'plan.concurrentFragments!==null', firesForDefaultRequest: false },
  { id: 'F1′', anchor: 'after --download-archive', options: ['--sponsorblock-remove'], trigger: 'plan.sponsorblockRemove!==null', firesForDefaultRequest: false },
  { id: 'F2′', anchor: 'after F1′', options: ['--download-sections'], trigger: 'plan.downloadSections!==null (R5①)', firesForDefaultRequest: false },
  { id: 'F3′', anchor: 'after F2′', options: ['--split-chapters'], trigger: 'plan.splitChapters (R5②)', firesForDefaultRequest: false },
  { id: 'F4′', anchor: 'after F3′', options: ['--replace-in-metadata'], trigger: 'plan.replaceInMetadata!==null', firesForDefaultRequest: false },
  { id: 'F5′', anchor: 'after F4′', options: ['--verbose'], trigger: 'plan.debug', firesForDefaultRequest: false },
  { id: 'G0′', anchor: 'position 1 (replaces --no-playlist)', options: ['--yes-playlist', '--playlist-items'], trigger: 'plan.playlistItems !== null (M4-4 batch)', firesForDefaultRequest: false },
] as const;

/**
 * Build the frozen + conditionally extended download argv. Pure: identical
 * input -> identical (distinct) array.
 * @throws AppError(INVALID_URL) when the URL fails the http(s) whitelist.
 * @throws Error when a forbidden / non-whitelisted option would be emitted.
 */
export function buildDownload(req: DownloadRequest, ctx: DownloadContext): string[] {
  assertHttpUrl(req.url);

  const plan = resolveDownloadPlan(req);
  const argv: string[] = [
    // M4-4: a batch item needs playlist processing; every other request keeps
    // the frozen `--no-playlist` element at position 1 (EXPECTED_MINIMAL).
    ...(plan.playlistItems === null
      ? ['--no-playlist']
      : ['--yes-playlist', '--playlist-items', plan.playlistItems]),
    '--no-warnings',
    '--newline',
    '--socket-timeout', '5',
    '-R', '1',
    '--no-js-runtimes',
    '--js-runtimes', `node:${ctx.jsRuntimePath}`,
    '--ffmpeg-location', ctx.ffmpegDir,
  ];

  // ---- B · format / audio (M2 frozen positions 13-20) ----
  if (plan.effectiveFormatId !== null) argv.push('-f', plan.effectiveFormatId);
  if (plan.effectiveSort !== null) argv.push('-S', plan.effectiveSort);
  if (plan.extractAudio) argv.push('-x');
  if (plan.audioFormat !== null) argv.push('--audio-format', plan.audioFormat);
  // B1″ · D-83: transcode bitrate. R1 removed `-S abr~N`, so this is the only
  // place the user's audio-quality choice survives when mp3/m4a was picked.
  if (plan.audioTranscodeQuality !== null) argv.push('--audio-quality', plan.audioTranscodeQuality);
  if (plan.audioMultistreams) argv.push('--audio-multistreams');
  // B1′ · M3 conditional (audio mode only)
  if (plan.embedMetadata) argv.push('--embed-metadata');
  if (plan.embedThumbnail) argv.push('--embed-thumbnail');
  // B2′ · --ppa is deliberately NEVER generated (Q-M3-05 / D-36).
  if (plan.ppa !== null) argv.push('--ppa', plan.ppa);

  // ---- C · subtitles (M2 frozen positions 21-27) ----
  if (plan.writeSubs) argv.push('--write-subs', '--sub-langs', plan.subLangs);
  if (plan.autoCaptions) argv.push('--write-auto-subs');
  // C1′ · M3 conditional
  if (plan.autoCaptions && plan.skipTranslatedSubs) {
    argv.push('--extractor-args', 'youtube:skip=translated_subs');
  }
  // M-1 ruling: --embed-subs BEFORE --convert-subs (frozen M2 order).
  if (plan.embedSubs) argv.push('--embed-subs');
  if (plan.convertTo !== 'none') argv.push('--convert-subs', plan.convertTo);
  // C2′ · R2 remux/merge mkv
  if (plan.mergeToMkv) argv.push('--remux-video', 'mkv', '--merge-output-format', 'mkv');
  // C4′ · derived metadata / thumbnail flags
  if (plan.embedChapters) argv.push('--embed-chapters');
  if (plan.writeThumbnail) argv.push('--write-thumbnail', '--convert-thumbnails', 'jpg');

  // ---- D · paths (M2 frozen positions 28-31) ----
  argv.push('-P', plan.outputDir, '-o', plan.outputTemplate);
  // D1′ / D2′ · conditional only (never constant — M-2 ruling)
  if (plan.restrictFilenames) argv.push('--restrict-filenames');
  if (plan.tempDir !== null) argv.push('-P', `temp:${plan.tempDir}`);

  // ---- E · network (M2 frozen positions 32-41) ----
  if (plan.rateLimit !== null) argv.push('-r', plan.rateLimit);
  if (plan.proxy !== null) argv.push('--proxy', plan.proxy);
  if (plan.cookiesFile !== null) argv.push('--cookies', plan.cookiesFile);
  if (plan.userAgent !== null) argv.push('--add-header', `User-Agent:${plan.userAgent}`);
  // E1′ · M3 conditional
  if (plan.ipv4Only) argv.push('-4');
  // E2′ · M3 conditional (E3′ suppresses --concurrent-fragments via the plan)
  if (plan.aria2cPath !== null) {
    // `--downloader-args aria2c:<path>` used to smuggle the exe path in here —
    // that is not what the flag means: yt-dlp appends the value verbatim to the
    // aria2c command line, so the path was being passed as an extra URI.
    // `--downloader aria2c` is enough; the exe is found through the PATH that
    // the engine injects for its directory (see yt-dlp-engine.download()).
    argv.push('--downloader', 'aria2c');
  }
  if (plan.concurrentFragments !== null) {
    argv.push('--concurrent-fragments', String(plan.concurrentFragments));
  }

  // ---- F · other (M2 frozen positions 42-51) ----
  argv.push('--no-mtime');
  if (plan.downloadArchive !== null) argv.push('--download-archive', plan.downloadArchive);
  // F1′..F5′ · M3 conditional
  if (plan.sponsorblockRemove !== null) argv.push('--sponsorblock-remove', plan.sponsorblockRemove);
  if (plan.downloadSections !== null) argv.push('--download-sections', plan.downloadSections);
  if (plan.splitChapters) argv.push('--split-chapters');
  if (plan.replaceInMetadata !== null) {
    argv.push('--replace-in-metadata', 'title', '.+', plan.replaceInMetadata);
  }
  if (plan.debug) argv.push('--verbose');
  argv.push(
    '--progress-template', YTVDLT_PROGRESS_TEMPLATE,
    '--progress-delta', PROGRESS_DELTA_SECONDS,
    '--print-to-file', 'after_move:%(filepath)q', ctx.artifactManifestPath,
  );

  // ---- G · separator + the ONLY user token (must be last) ----
  argv.push('--', req.url);

  assertNoForbiddenOptions(argv);
  return argv;
}

export const ArgvBuilderDownload = { buildDownload } as const;
