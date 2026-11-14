/** M1 config domain defaults + schema version. Pure data, no I/O. */
import type { ConfigDomainName } from '../ports.js';

/**
 * v2 (D-110): `paths.restrictFilenames` flipped to `false`.
 *
 * The v1 default shipped `true`, which made yt-dlp receive
 * `--restrict-filenames`; that flag keeps ASCII only and deletes every
 * non-ASCII character, so a Chinese title became a string of underscores
 * (`_ [_].mp4`). The key was never exposed in Settings, so the stored `true`
 * was never a user decision — v1 -> v2 retires it.
 *
 * v3: `network.maxRate` legacy placeholder `1000` retired. Builds before
 * D-165 shipped `maxRate: 1000` as the default and `createDefaultConfig()`
 * persists the full defaults, so every config.json written by those builds
 * carries `1000`. D-165 then changed the default to `0` and wired the key to
 * yt-dlp's `-r`, which turned the stored placeholder into a real 1 MB/s cap
 * for every upgraded user. Settings has no `maxRate` input, so a stored
 * `1000` was never a choice made in the app — v2 -> v3 resets exactly this
 * one value to the current default; any other value is kept verbatim.
 */
export const CONFIG_SCHEMA_VERSION = 3;

export const CONFIG_DOMAIN_NAMES: readonly ConfigDomainName[] = [
  'general', 'format', 'subtitle', 'paths', 'network', 'advanced', 'saved_links',
] as const;

export interface ConfigFile {
  schemaVersion: number;
  updatedAt: string;
  domains: Record<ConfigDomainName, Record<string, unknown>>;
}

/**
 * 0.2.1 (D-98): the two download roots, in their STORED form.
 *
 * `%USERPROFILE%` / `%USERVIDEOS%` are expanded at request time
 * (`withExpandedPaths`); the literal token is what the settings page shows
 * before a user picks a folder, and what "恢复默认" writes back. A user-picked
 * folder is stored as an absolute path instead — `paths.videoDir` accepts both
 * shapes.
 *
 * D-117: the default root moved from `Downloads\YTVDLT` to the real Windows
 * "Videos" folder (`app.getPath('videos')`, which follows a OneDrive / folder
 * redirection), with a `YTVDLT` subfolder of its own. `%USERVIDEOS%` is
 * resolved by the MAIN process only — it is not a Windows environment variable,
 * so `expandEnvVars` gets it through an injected map, never from `process.env`.
 *
 * Stored values are NOT migrated: an existing config keeps whatever it has,
 * because "the old default" and "the folder this user picked on purpose" are
 * indistinguishable strings and guessing wrong moves a library.
 */
export const DEFAULT_PATH_TOKENS = {
  videoDir: '%USERVIDEOS%/YTVDLT',
  audioDir: '%USERVIDEOS%/YTVDLT/Audio',
} as const;

/** Baseline defaults (HANDOFF §11 default values table, M1 subset only). */
export const DEFAULT_DOMAINS: Readonly<Record<ConfigDomainName, Record<string, unknown>>> = {
  general: {
    concurrency: 3,
    theme: 'system',
    // D-147: `''` is the factory sentinel "language not determined yet". On the
    // FIRST start-up the main process detects once from the OS locale
    // (`resolveStartupLanguage`, bootstrap.ts) and immediately writes the
    // concrete value back through the normal SETTINGS_SET path. From then on
    // the stored value is never re-detected and never reset, so a manual switch
    // always wins and survives restarts. The empty string exists only between
    // config creation and that first write-back; every reader falls back to
    // zh-CN until then.
    language: '',
    privateMode: false,
    disablePreview: false,
    // D-166: written by the 「开机自启」 switch through SETTINGS_SET, applied to
    // `HKCU\...\CurrentVersion\Run` (no elevation). `false` for a fresh install
    // — an app must not add a startup entry the user never asked for.
    autostart: false,
  },
  format: {
    quality: 'best',
    videoCodecPref: 'auto',
    formatSelection: true,
    extractAudio: false,
  },
  subtitle: {
    languages: 'en.*,.*-orig',
    enabled: false,
    autoCaptions: false,
    convertTo: 'none',
  },
  paths: {
    outputTemplate: '%(title).200B [%(id)s].%(ext)s',
    subdirByExtractor: false,
    subdirByPlaylist: false,
    // D-110: OFF by default. `--restrict-filenames` means "ASCII only", and for
    // a CJK title that is a destructive rewrite (every ideograph becomes `_`),
    // not a cleanup. yt-dlp already replaces the Windows-illegal characters on
    // its own, so a readable title needs no extra flag.
    restrictFilenames: false,
    // M3 B2 (append-only, A-4.4-01 / 02): three directories + private mode +
    // explicit temp dir must survive a restart via ConfigStore.
    videoDir: DEFAULT_PATH_TOKENS.videoDir,
    audioDir: DEFAULT_PATH_TOKENS.audioDir,
    commandDir: '%USERPROFILE%/Downloads/YTVDLT/Commands',
    privateMode: false,
    tempDir: '',
  },
  network: {
    // D-165: KB/s; 0 = unlimited. Read by `toRateLimit()` (config-store), which
    // turns it into yt-dlp's `-r` token. Was 1000 with no reader and no unit —
    // a placeholder that lied. 0 keeps the historical behaviour (no limit) so
    // nobody is silently capped after the upgrade. A config that still carries
    // the pre-D-165 placeholder `1000` is reset here by the v2 -> v3 migration.
    maxRate: 0,
    concurrentFragments: 8,
    ipv4Only: false,
  },
  advanced: {
    debug: false,
    embedMetadata: true,
    updateChannel: 'stable',
    updateInterval: 'weekly',
    // 0.2.1 (append-only, D-93 / D-94): two independent update switches —
    // the app and the bundled yt-dlp fail for different reasons and are fixed
    // by different downloads, so they never share one toggle.
    autoCheckAppUpdate: true,
    autoCheckEngineUpdate: true,
    skippedAppVersion: '',
    lastAppUpdateCheckAt: '',
    lastEngineUpdateCheckAt: '',
    // D-103 (append-only): cover-image cache retention. The cache lives next
    // to the config (`<dataDir>/thumbs`); these are the shipped defaults and
    // can be changed from Settings or by editing config.json.
    autoCleanThumbnailCache: true,
    thumbnailCacheMaxBytes: 128 * 1024 * 1024,
    thumbnailCacheMaxFiles: 500,
    thumbnailCacheMaxAgeDays: 30,
    // M3 B2 (append-only): advanced fields now consumed by resolveDownloadPlan.
    sponsorblockRemove: null,
    downloadSections: null,
    splitChapters: false,
    customTitle: null,
    // D-148 (append-only): "Star on GitHub" prompt bookkeeping. Five flat keys,
    // same shape as `skippedAppVersion` above: plain values the main process
    // reads/writes through `advanced.*` (no Settings-page toggle by design —
    // the dialog's "不再提醒" button is the only opt-out the owner asked for).
    //   starPromptVersion        app version the counters belong to
    //   starPromptLaunches       1-based launch counter for that version
    //   starPromptPromptedCount  prompts already shown for that version (max 2)
    //   starPromptLastPromptedAt ISO timestamp of the last "later" answer
    //   starPromptNever          permanent silence ("去 Star" / "不再提醒")
    starPromptVersion: '',
    starPromptLaunches: 0,
    starPromptPromptedCount: 0,
    starPromptLastPromptedAt: '',
    starPromptNever: false,
  },
  saved_links: { items: [] },
};

/** Return a fresh, deeply-cloned default config document. */
export function createDefaultConfig(updatedAt: string): ConfigFile {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    updatedAt,
    domains: JSON.parse(JSON.stringify(DEFAULT_DOMAINS)) as Record<ConfigDomainName, Record<string, unknown>>,
  };
}

/** Structural validation of a parsed config document (pure). */
export function isValidConfigFile(value: unknown): value is ConfigFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['schemaVersion'] !== 'number') return false;
  if (typeof candidate['updatedAt'] !== 'string') return false;
  const domains = candidate['domains'];
  if (typeof domains !== 'object' || domains === null || Array.isArray(domains)) return false;
  const domainRecord = domains as Record<string, unknown>;
  for (const name of CONFIG_DOMAIN_NAMES) {
    const domain = domainRecord[name];
    if (typeof domain !== 'object' || domain === null || Array.isArray(domain)) return false;
  }
  return true;
}
