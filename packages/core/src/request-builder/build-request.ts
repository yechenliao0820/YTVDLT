/**
 * buildDownloadRequest — default five-domain request assembly (M4 装配补口).
 *
 * The M3 dialogs only emit PARTIAL patches; nothing in the codebase turned a
 * config domain into a complete `DownloadRequest`. Batch enqueue needs one, so
 * this pure function fills the gap: caller supplies per-domain partials (from
 * ConfigStore), everything missing falls back to the documented defaults.
 *
 * Pure: no I/O, no clock, deterministic. The returned object is deeply fresh.
 */
import type {
  DownloadRequest, DownloadKind, FormatDomain, SubtitleDomain,
  PathsDomain, NetworkDomain, AdvancedDomain,
} from '@ytvdlt/shared';

export interface RequestDefaults {
  readonly format?: Partial<FormatDomain>;
  readonly subtitle?: Partial<SubtitleDomain>;
  readonly paths?: Partial<PathsDomain>;
  readonly network?: Partial<NetworkDomain>;
  readonly advanced?: Partial<AdvancedDomain>;
}

export interface BuildRequestInput {
  readonly taskId: string;
  readonly url: string;
  readonly kind: DownloadKind;
  readonly defaults?: RequestDefaults;
  /** Batch item position expression (`--playlist-items`). */
  readonly playlistItems?: string | null;
  /** Private mode is a path-domain flag but is often set per task. */
  readonly privateMode?: boolean;
}

const FORMAT_DEFAULTS: FormatDomain = {
  quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null,
  extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto',
  audioFormat: null, audioMultistreams: false,
};

const SUBTITLE_DEFAULTS: SubtitleDomain = {
  enabled: false, languages: 'en.*,.*-orig', autoCaptions: false, skipTranslated: true,
  convertTo: 'none', embed: false, keepSubtitleFile: false,
};

const PATHS_DEFAULTS: PathsDomain = {
  videoDir: '%USERPROFILE%/Downloads/YTVDLT',
  audioDir: '%USERPROFILE%/Downloads/YTVDLT/Audio',
  commandDir: '%USERPROFILE%/Downloads/YTVDLT/Commands',
  privateMode: false, subdirByExtractor: false, subdirByPlaylist: false,
  outputTemplate: '%(title).200B [%(id)s].%(ext)s', tempDir: '',
};

const NETWORK_DEFAULTS: NetworkDomain = {
  rateLimit: null, proxy: null, cookiesFile: null, userAgent: null,
  ipv4Only: false, concurrentFragments: null, aria2cPath: null,
};

const ADVANCED_DEFAULTS: AdvancedDomain = {
  sponsorblockRemove: null, downloadSections: null, splitChapters: false,
  customTitle: null, debug: false, downloadArchive: null, customCommand: null,
  playlistItems: null,
};

export function buildDownloadRequest(input: BuildRequestInput): DownloadRequest {
  const defaults = input.defaults ?? {};
  const privateMode = input.privateMode ?? defaults.paths?.privateMode ?? false;
  return {
    taskId: input.taskId,
    url: input.url,
    format: { ...FORMAT_DEFAULTS, ...defaults.format },
    subtitle: { ...SUBTITLE_DEFAULTS, ...defaults.subtitle },
    paths: { ...PATHS_DEFAULTS, ...defaults.paths, privateMode },
    network: { ...NETWORK_DEFAULTS, ...defaults.network },
    advanced: {
      ...ADVANCED_DEFAULTS,
      ...defaults.advanced,
      // Per-item expression always wins over a template default.
      playlistItems: input.playlistItems ?? defaults.advanced?.playlistItems ?? null,
    },
  };
}
