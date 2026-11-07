/** M1 config domain defaults + schema version. Pure data, no I/O. */
import type { ConfigDomainName } from '../ports.js';

export const CONFIG_SCHEMA_VERSION = 1;

export const CONFIG_DOMAIN_NAMES: readonly ConfigDomainName[] = [
  'general', 'format', 'subtitle', 'paths', 'network', 'advanced', 'saved_links',
] as const;

export interface ConfigFile {
  schemaVersion: number;
  updatedAt: string;
  domains: Record<ConfigDomainName, Record<string, unknown>>;
}

/** Baseline defaults (HANDOFF §11 default values table, M1 subset only). */
export const DEFAULT_DOMAINS: Readonly<Record<ConfigDomainName, Record<string, unknown>>> = {
  general: {
    concurrency: 3,
    theme: 'system',
    language: 'zh-CN',
    privateMode: false,
    disablePreview: false,
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
    restrictFilenames: true,
    // M3 B2 (append-only, A-4.4-01 / 02): three directories + private mode +
    // explicit temp dir must survive a restart via ConfigStore.
    videoDir: '%USERPROFILE%/Downloads/YTVDLT',
    audioDir: '%USERPROFILE%/Downloads/YTVDLT/Audio',
    commandDir: '%USERPROFILE%/Downloads/YTVDLT/Commands',
    privateMode: false,
    tempDir: '',
  },
  network: {
    maxRate: 1000,
    concurrentFragments: 8,
    ipv4Only: false,
  },
  advanced: {
    debug: false,
    embedMetadata: true,
    updateChannel: 'stable',
    updateInterval: 'weekly',
    // M3 B2 (append-only): advanced fields now consumed by resolveDownloadPlan.
    sponsorblockRemove: null,
    downloadSections: null,
    splitChapters: false,
    customTitle: null,
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
