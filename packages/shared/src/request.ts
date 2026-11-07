/** Probe options (M1 uses these only for `probe`). */
export interface ProbeOptions {
  timeoutMs?: number;
  retries?: number;
  proxy?: string;
  cookiesFile?: string;
  userAgent?: string;
  /** REQUIRED: absolute path of the bundled node.exe used as EJS JS runtime. */
  jsRuntimePath: string;
  noPlaylist?: boolean;
  flatPlaylist?: boolean;
}

/** Pure-function input for `ArgvBuilder.build()` (M1: probe branch only). */
export interface ProbeRequest {
  readonly url: string;
  readonly opts: ProbeOptions;
  /** Absolute path of yt-dlp.exe; used ONLY as spawn `file`, never enters argv. */
  readonly enginePath: string;
}

/** The five immutable domains of HANDOFF §6.4 — signatures frozen in M1. */
export interface FormatDomain {
  quality: 'best' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p' | 'lowest';
  videoCodecPref: 'av01' | 'vp9.2' | 'h264' | 'auto';
  formatId: string | null;
  sortingFields: string | null;
  extractAudio: boolean;
  audioQuality: 'best' | '192' | '128' | '64' | '32' | 'lowest';
  audioCodecPref: 'opus' | 'aac' | 'auto';
  audioFormat: 'mp3' | 'm4a' | null;
  audioMultistreams: boolean;
}

export interface SubtitleDomain {
  enabled: boolean;
  languages: string;
  autoCaptions: boolean;
  skipTranslated: boolean;
  convertTo: 'none' | 'ass' | 'srt' | 'vtt' | 'lrc';
  embed: boolean;
  keepSubtitleFile: boolean;
}

export interface PathsDomain {
  videoDir: string;
  audioDir: string;
  commandDir: string;
  privateMode: boolean;
  subdirByExtractor: boolean;
  subdirByPlaylist: boolean;
  outputTemplate: string;
  tempDir: string;
}

export interface NetworkDomain {
  rateLimit: string | null;
  proxy: string | null;
  cookiesFile: string | null;
  userAgent: string | null;
  ipv4Only: boolean;
  concurrentFragments: number | null;
  aria2cPath: string | null;
}

export interface AdvancedDomain {
  sponsorblockRemove: string | null;
  downloadSections: string | null;
  splitChapters: boolean;
  customTitle: string | null;
  debug: boolean;
  downloadArchive: string | null;
  customCommand: readonly string[] | null;
  /**
   * M4-4 (append-only, OPTIONAL): yt-dlp `--playlist-items` expression for a
   * batch task (e.g. `3` or `1,3,5-7`). Absent/null keeps the frozen
   * `--no-playlist` single-video semantics, so EXPECTED_MINIMAL is untouched.
   */
  playlistItems?: string | null;
}

export interface DownloadRequest {
  readonly taskId: string;
  readonly url: string;
  readonly format: Readonly<FormatDomain>;
  readonly subtitle: Readonly<SubtitleDomain>;
  readonly paths: Readonly<PathsDomain>;
  readonly network: Readonly<NetworkDomain>;
  readonly advanced: Readonly<AdvancedDomain>;
}
