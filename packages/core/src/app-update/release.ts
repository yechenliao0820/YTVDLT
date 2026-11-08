/**
 * GitHub Releases payload → `AppRelease` (0.2.1, D-93).
 *
 * Everything here is pure: the HTTP call lives in the main process, so the
 * parsing rules (which asset is the installer, how long the notes may be, what
 * happens with a draft/prerelease) are L0-testable without a network.
 */
import type { AppRelease, AppReleaseAsset } from '@ytvdlt/shared';
import { normalizeVersion } from './version.js';

/** The dialog scrolls; a 40 KB changelog would only make it unreadable. */
export const MAX_RELEASE_NOTES_CHARS = 4000;

interface RawAsset {
  readonly name: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `sha256:abc…` → `abc…`; anything else → null (verification then falls back to size + PE header). */
function digestOf(raw: unknown): string | null {
  const text = str(raw).trim();
  const match = /^sha256:([a-fA-F0-9]{64})$/.exec(text);
  return match === null ? null : (match[1] as string).toLowerCase();
}

function toAsset(raw: unknown): RawAsset | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const name = str(record['name']).trim();
  const url = str(record['browser_download_url']).trim();
  const size = record['size'];
  const sizeBytes = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0;
  if (name === '' || !/^https?:\/\//i.test(url)) return null;
  return { name, url, sizeBytes, sha256: digestOf(record['digest']) };
}

/**
 * Which asset is "the installer".
 *
 * Scoring instead of a single regex because releases get renamed: a `Setup`
 * build always beats a generic `.exe`, a portable build never wins (it would
 * overwrite nothing that the NSIS uninstaller knows about), and blockmaps /
 * checksum files are not executables. When nothing scores, the largest `.exe`
 * is still a better guess than "no update possible".
 */
export function selectInstallerAsset(assets: readonly AppReleaseAsset[]): AppReleaseAsset | null {
  const executables = assets.filter((asset) => /\.exe$/i.test(asset.name)
    && !/\.blockmap$/i.test(asset.name)
    && !/^unins/i.test(asset.name));
  if (executables.length === 0) return null;

  let best: AppReleaseAsset | null = null;
  let bestScore = -1;
  for (const asset of executables) {
    const name = asset.name.toLowerCase();
    let score = 1;
    if (name.includes('setup') || name.includes('installer') || name.includes('安装')) score = 4;
    if (/-portable|portable-|便携/.test(name)) score = 0;
    if (/\bx64\b|amd64|x86_64/.test(name)) score += 1;
    if (score > bestScore || (score === bestScore && best !== null && asset.sizeBytes > best.sizeBytes)) {
      best = asset;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Markdown → readable plain text for a native dialog.
 *
 * The dialog is not a markdown renderer, and shipping one would mean a new
 * dependency. What matters is that the user reads sentences, not `**` noise.
 */
export function flattenReleaseNotes(markdown: string, maxChars = MAX_RELEASE_NOTES_CHARS): string {
  let text = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (text.trim() === '') return '';
  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}\n…`;
  }
  return text;
}

/**
 * Parse one `GET /repos/:owner/:repo/releases/latest` payload.
 *
 * Returns null for anything that is not a usable release (draft, prerelease,
 * no tag). A prerelease flag matters: GitHub's `/latest` already excludes them,
 * but the same parser is used for a version list, so the rule lives here.
 */
export function parseGitHubRelease(
  payload: unknown,
  options: { readonly maxNotesChars?: number } = {},
): AppRelease | null {
  const record = asRecord(payload);
  if (record === null) return null;
  if (record['draft'] === true || record['prerelease'] === true) return null;

  const tag = str(record['tag_name']).trim();
  const version = normalizeVersion(tag !== '' ? tag : str(record['name']));
  if (version === '') return null;

  const rawAssets = Array.isArray(record['assets']) ? record['assets'] : [];
  const assets: AppReleaseAsset[] = [];
  for (const item of rawAssets) {
    const asset = toAsset(item);
    if (asset !== null) assets.push(asset);
  }

  return {
    version,
    tag: tag !== '' ? tag : `v${version}`,
    name: str(record['name']).trim() || `v${version}`,
    notes: flattenReleaseNotes(str(record['body']), options.maxNotesChars ?? MAX_RELEASE_NOTES_CHARS),
    pageUrl: str(record['html_url']).trim(),
    publishedAt: str(record['published_at']).trim(),
    installer: selectInstallerAsset(assets),
  };
}
