/**
 * resolveDownloadPlan — M3's UNIQUE decision source (M3-F003 / §3.7).
 *
 * Pure, deterministic, never throws. Reduces the five frozen `DownloadRequest`
 * domains into a `DownloadPlan` following the P0->P7 priority chain and the
 * R1-R5 mutual-exclusion rules. Both the stage-1 UI helpers and `buildDownload`
 * consume this same reduction, so "same req -> same argv" holds for every DTO
 * source (UI / config import / contract tests / M4 batch enqueue).
 *
 * `mergeToMkv` is ONLY a plan-internal derived value (D-35): it is never
 * written back into `PathsDomain`, never added to `DownloadContext`.
 */
import type {
  DownloadRequest, DownloadPlan, PlanWarning, PlanWarningCode,
  FormatDomain, SubtitleDomain,
} from '@ytvdlt/shared';
import {
  buildOutputDir, sanitizeToken, truncateWindowsPath,
} from '../path-resolver/index.js';

/** Video qualities that map to `-S res:<N>` (best / lowest carry no constraint). */
const RESOLUTION_QUALITIES: Readonly<Record<string, string>> = {
  '2160p': '2160',
  '1440p': '1440',
  '1080p': '1080',
  '720p': '720',
  '480p': '480',
  '360p': '360',
};

const VIDEO_CODEC_FIELDS: Readonly<Record<FormatDomain['videoCodecPref'], string | null>> = {
  av01: 'vcodec:av01',
  'vp9.2': 'vcodec:vp9.2',
  h264: 'vcodec:h264',
  auto: null,
};

/**
 * Six audioQuality enum values (Q-M3-02): best/192/128/64/32/lowest.
 * EXPORTED (M4-0 / QA-D2): the M3 test used to keep a mirror table, which could
 * drift from this implementation. Tests now import THIS map — single source.
 */
export const AUDIO_BITRATE_FIELDS: Readonly<Record<FormatDomain['audioQuality'], string | null>> = {
  best: null,
  '192': 'abr~192',
  '128': 'abr~128',
  '64': 'abr~64',
  '32': 'abr~32',
  lowest: 'abr~0',
};

const AUDIO_CODEC_FIELDS: Readonly<Record<FormatDomain['audioCodecPref'], string | null>> = {
  opus: 'acodec:opus',
  aac: 'acodec:aac',
  auto: null,
};

/**
 * D-83: audio bitrate -> `--audio-quality` for the TRANSCODE path.
 *
 * R1 (M3) removes `-S abr~N` whenever `--audio-format` is set, because ffmpeg
 * re-encodes anyway. That left the user's bitrate choice with no effect at all:
 * picking "128 kbps" produced whatever ffmpeg's default VBR gave. yt-dlp has a
 * dedicated flag for exactly this case (`--audio-quality 0..10` or `<n>K`), so
 * the choice is carried there instead of being silently dropped.
 */
export const AUDIO_TRANSCODE_QUALITY: Readonly<Record<FormatDomain['audioQuality'], string>> = {
  best: '0',
  '192': '192K',
  '128': '128K',
  '64': '64K',
  '32': '32K',
  lowest: '10',
};

const SUBTITLE_FORMATS: readonly SubtitleDomain['convertTo'][] = ['none', 'ass', 'srt', 'vtt', 'lrc'];

/** Optional probe context. `DownloadRequest` has no chapters field (frozen M1). */
export interface ResolveOptions {
  /** Chapters presence for R5③. Defaults to true (unknown => do not disable split). */
  chaptersAvailable?: boolean;
}

function nonEmpty(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * M4-4: yt-dlp `--playlist-items` grammar, restricted to digits, commas and
 * `-`/`:` ranges. Anything else (option injection, shell metacharacters, `--`)
 * is rejected outright and the request falls back to single-video mode.
 */
const PLAYLIST_ITEMS_RE = /^\d{1,6}(?:[-:]\d{1,6})?(?:,\d{1,6}(?:[-:]\d{1,6})?)*$/;

export function sanitizePlaylistItems(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return PLAYLIST_ITEMS_RE.test(trimmed) ? trimmed : null;
}

/**
 * Derive the complete plan. Two callers with the same `req` always get an equal
 * plan (fresh array/object identity each call).
 */
export function resolveDownloadPlan(
  req: DownloadRequest,
  options: ResolveOptions = {},
): DownloadPlan {
  const { format, subtitle, paths, network, advanced } = req;
  const warnings: PlanWarning[] = [];
  const warn = (code: PlanWarningCode, detail: string): void => {
    warnings.push({ code, detail });
  };

  // ---- P0: compliance (never arbitrated, always rejected / ignored) ----
  if (advanced.customCommand !== null) {
    warn('CUSTOM_COMMAND_IGNORED', 'advanced.customCommand is never consumed in M3 (compliance P0 / D-44)');
  }

  const extractAudio = format.extractAudio === true;
  const audioFormat = format.audioFormat;
  const audioTranscode = audioFormat !== null;

  // ---- P1: audio mode suppresses embed + video-only sort fields ----
  if (extractAudio && subtitle.embed) {
    warn('P1_AUDIO_MODE_SUPPRESSES_EMBED', 'extractAudio=true forces subtitle embedding off (R3)');
  }

  // ---- P2 / R1: explicit audio transcode suppresses ALL `-S abr~N` ----
  if (audioTranscode && AUDIO_BITRATE_FIELDS[format.audioQuality] !== null) {
    warn('R1_AUDIO_TRANSCODE_SUPPRESSES_ABR', `audioFormat=${audioFormat} removes -S abr~N; acodec:* is kept`);
  }
  // D-83: that suppressed bitrate is re-expressed through ffmpeg's own knob so
  // the bitrate dropdown still means something after `--audio-format` fires.
  const audioTranscodeQuality = audioTranscode ? AUDIO_TRANSCODE_QUALITY[format.audioQuality] : null;

  // ---- P4 / R5: downloadSections > splitChapters > embed/mkv ----
  const hasSections = nonEmpty(advanced.downloadSections);
  const downloadSections = hasSections ? advanced.downloadSections : null;
  let splitChapters = advanced.splitChapters === true;
  if (hasSections && splitChapters) {
    splitChapters = false;
    warn('R5_SPLIT_SUPPRESSED_BY_SECTIONS', 'downloadSections wins over splitChapters (R5①)');
  }
  const chaptersAvailable = options.chaptersAvailable !== false;
  if (splitChapters && !chaptersAvailable) {
    splitChapters = false;
    warn('R5_SPLIT_DISABLED_NO_CHAPTERS', 'empty chapter list disables --split-chapters (R5③)');
  }
  const suppressRemux = splitChapters;
  const chapterPrefix = splitChapters ? 'chapter:' : '';
  if (splitChapters && subtitle.embed) {
    warn('R5_SPLIT_SUPPRESSES_EMBED', 'splitChapters suppresses remux/merge/embed (R5②)');
  }

  // ---- P5 / R2: subtitle embedding derives mergeToMkv (internal only) ----
  const embedSubs = subtitle.embed === true
    && !extractAudio
    && !suppressRemux
    && !hasSections;
  const mergeToMkv = embedSubs;
  const writeSubs = subtitle.enabled === true
    || (embedSubs && subtitle.keepSubtitleFile === true && !extractAudio);

  // ---- P6 / R4: multistream corrected by FormatSelector (stage 1) ----
  const audioMultistreams = format.audioMultistreams === true;

  // ---- P3 / P7: effective -f and -S ----
  const effectiveFormatId = nonEmpty(format.formatId) ? sanitizeToken(format.formatId) : null;
  let effectiveSort: string | null = null;
  if (nonEmpty(format.sortingFields)) {
    // Explicit sorting fields win over every preset (M2 frozen behaviour).
    // They are user text, so they are sanitized but never rewritten.
    effectiveSort = sanitizeToken(format.sortingFields);
  } else {
    const parts: string[] = [];
    if (!extractAudio && effectiveFormatId === null) {
      const resolution = RESOLUTION_QUALITIES[format.quality];
      if (resolution !== undefined) parts.push(`res:${resolution}`);
      const vcodec = VIDEO_CODEC_FIELDS[format.videoCodecPref];
      if (vcodec !== null) parts.push(vcodec);
    } else if (!extractAudio) {
      // P3: formatId wins over the resolution preset; codec preference remains.
      const vcodec = VIDEO_CODEC_FIELDS[format.videoCodecPref];
      if (vcodec !== null) parts.push(vcodec);
    }
    // R1: audio transcode removes abr~N but preserves acodec:*.
    if (!audioTranscode) {
      const abr = AUDIO_BITRATE_FIELDS[format.audioQuality];
      if (abr !== null) parts.push(abr);
    }
    const acodec = AUDIO_CODEC_FIELDS[format.audioCodecPref];
    if (acodec !== null) parts.push(acodec);
    effectiveSort = parts.length > 0 ? parts.join(',') : null;
  }

  // ---- advanced / metadata (no DTO fields; deterministically derived, D-45) ----
  const sponsorblockRemove = nonEmpty(advanced.sponsorblockRemove)
    ? sanitizeToken(advanced.sponsorblockRemove) : null;
  const replaceInMetadata = nonEmpty(advanced.customTitle)
    ? sanitizeToken(advanced.customTitle) : null;
  const downloadArchive = nonEmpty(advanced.downloadArchive)
    ? advanced.downloadArchive : null;
  const debug = advanced.debug === true;

  const embedMetadata = extractAudio;
  const embedThumbnail = extractAudio && audioTranscode;
  const writeThumbnail = embedSubs && !extractAudio && !suppressRemux;
  const embedChapters = mergeToMkv && !suppressRemux;
  // Q-M3-05 / D-36: `--ppa` is never generated (value contains spaces and the
  // bundled yt-dlp version's support is unverified). Cover crop is downgraded.
  const ppa = null;
  if (embedThumbnail) {
    warn('PPA_UNSUPPORTED_DOWNGRADED', '--ppa cover crop downgraded to no-crop (Q-M3-05 / D-36)');
  }

  // ---- paths (Q-M3-09 / D-43 purification order) ----
  const rawTemplate = typeof paths.outputTemplate === 'string' ? paths.outputTemplate : '';
  const safeTemplate = sanitizeToken(rawTemplate);
  // D-110: `--restrict-filenames` is a USER setting, never a side effect of the
  // template. Until 0.2.4 it was derived from `safeTemplate !== rawTemplate`,
  // so the shipped default template (which contains one space between the title
  // and `[id]`) permanently enabled "ASCII only" — every CJK title was rewritten
  // to `_`, i.e. an unreadable file name for the exact users this app ships to.
  // `sanitizeToken()` still runs (argv safety, unchanged); it just no longer
  // implies a second, destructive rewrite inside yt-dlp.
  //
  // The flag lives in the config `paths` domain but is NOT part of the frozen
  // `PathsDomain` (D-50), so it is read through a local widening: `buildRequest`
  // spreads the config domain verbatim, which is what makes it reach here.
  const restrictFilenames = (paths as unknown as Record<string, unknown>)['restrictFilenames'] === true;
  const outputTemplate = truncateWindowsPath(`${chapterPrefix}${safeTemplate}`);
  const outputDir = buildOutputDir(
    paths,
    '%(extractor_key)s',
    '%(playlist)s',
    extractAudio ? paths.audioDir : paths.videoDir,
  );
  const needsTempDir = downloadSections !== null
    || splitChapters
    || mergeToMkv
    || audioTranscode
    || extractAudio
    || embedSubs;
  const explicitTempDir = needsTempDir && nonEmpty(paths.tempDir) ? paths.tempDir : null;
  const privateMode = paths.privateMode === true;

  // ---- network ----
  const rateLimit = nonEmpty(network.rateLimit) ? sanitizeToken(network.rateLimit) : null;
  const proxy = nonEmpty(network.proxy) ? sanitizeToken(network.proxy) : null;
  const cookiesFile = nonEmpty(network.cookiesFile) ? network.cookiesFile : null;
  const userAgent = nonEmpty(network.userAgent) ? sanitizeToken(network.userAgent) : null;
  const ipv4Only = network.ipv4Only === true;
  const aria2cPath = nonEmpty(network.aria2cPath) ? network.aria2cPath : null;
  const concurrentFragments = aria2cPath !== null ? null : network.concurrentFragments;
  if (aria2cPath !== null && network.concurrentFragments !== null) {
    warn('ARIA2C_SUPPRESSES_FRAGMENTS', '--downloader aria2c suppresses --concurrent-fragments');
  }

  // ---- M4-4 playlist batch ----
  const requestedPlaylistItems = advanced.playlistItems ?? null;
  const playlistItems = sanitizePlaylistItems(requestedPlaylistItems);
  if (requestedPlaylistItems !== null && playlistItems === null) {
    warn('PLAYLIST_ITEMS_INVALID', '--playlist-items rejected (grammar/injection), single-video mode kept');
  }

  const convertTo = SUBTITLE_FORMATS.includes(subtitle.convertTo) ? subtitle.convertTo : 'none';
  const subLangs = sanitizeToken(subtitle.languages);
  const autoCaptions = subtitle.autoCaptions === true;
  const skipTranslatedSubs = autoCaptions && subtitle.skipTranslated === true;

  return {
    effectiveFormatId,
    effectiveSort,
    extractAudio,
    audioFormat,
    audioTranscodeQuality,
    audioMultistreams,
    writeSubs,
    subLangs,
    autoCaptions,
    skipTranslatedSubs,
    convertTo,
    embedSubs,
    keepSubtitleFile: subtitle.keepSubtitleFile === true,
    mergeToMkv,
    downloadSections: downloadSections === null ? null : sanitizeToken(downloadSections),
    splitChapters,
    suppressRemux,
    chapterPrefix,
    sponsorblockRemove,
    replaceInMetadata,
    ppa,
    debug,
    outputDir,
    outputTemplate,
    restrictFilenames,
    explicitTempDir,
    privateMode,
    rateLimit,
    proxy,
    cookiesFile,
    userAgent,
    ipv4Only,
    concurrentFragments,
    aria2cPath,
    embedMetadata,
    embedThumbnail,
    writeThumbnail,
    embedChapters,
    downloadArchive,
    playlistItems,
    warnings,
  };
}
