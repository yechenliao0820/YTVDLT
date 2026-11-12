/**
 * GitHub Releases lookup (0.2.1, D-93; list form 0.3.1, D-140).
 *
 * Two endpoints, one set of rules: `/releases/latest` answers "is there a newer
 * version", `/releases` answers "what changed since the build you are running".
 * Neither is cached here, and `draft` / `prerelease` are skipped by both — the
 * app-update service and the component version check (`yt-dlp/yt-dlp`) share
 * the same parsers.
 *
 * The network goes through `HttpPort`, so no `node:https` import leaks into the
 * service and the whole decision path stays testable with a fake port.
 */
import type { AppRelease, HttpPort } from '@ytvdlt/shared';
import { parseGitHubRelease, parseGitHubReleaseList } from '@ytvdlt/core';

export interface ReleaseSource {
  readonly owner: string;
  readonly repo: string;
}

/** `/repos/:owner/:repo/releases/latest` — the release being offered. */
export function latestReleaseApiUrl(source: ReleaseSource): string {
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}`
    + `/${encodeURIComponent(source.repo)}/releases/latest`;
}

/**
 * How many releases one history lookup may read. The project ships one patch
 * per day at most, so 30 covers a month of skipped versions; the dialog itself
 * caps how many it will display.
 */
export const RELEASE_LIST_PAGE_SIZE = 30;

/** The list endpoint — same host and same trust rules as `/releases/latest`. */
export function releaseListApiUrl(
  source: ReleaseSource,
  perPage: number = RELEASE_LIST_PAGE_SIZE,
): string {
  const count = Number.isFinite(perPage) && perPage > 0 ? Math.floor(perPage) : RELEASE_LIST_PAGE_SIZE;
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}`
    + `/${encodeURIComponent(source.repo)}/releases?per_page=${count}`;
}

/** A 30-release page is ~150 KB; anything past this is not a release list. */
export const RELEASE_LIST_MAX_BYTES = 2 * 1024 * 1024;

/** `null` = no usable release (404, draft, prerelease, malformed). */
export async function fetchLatestRelease(
  http: HttpPort,
  source: ReleaseSource,
  options: { readonly timeoutMs?: number } = {},
): Promise<AppRelease | null> {
  const text = await http.getText(latestReleaseApiUrl(source), {
    timeoutMs: options.timeoutMs ?? 15_000,
    // D-137: the release JSON is untrusted input. Keep every redirect hop on a
    // GitHub host too, instead of letting the network stack decide the final
    // address after we validated only the initial URL.
    urlPolicy: isTrustedReleaseHost,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return parseGitHubRelease(payload);
}

/**
 * `GET /releases` → the recent published releases (0.3.1, D-140).
 *
 * Needed because `/releases/latest` answers only "what is newest", while the
 * dialog has to explain the whole interval a user skipped. A malformed payload
 * yields `[]`; a network failure throws, so the caller can fall back to the
 * single-release notes instead of losing the update prompt.
 */
export async function fetchReleaseList(
  http: HttpPort,
  source: ReleaseSource,
  options: { readonly timeoutMs?: number; readonly perPage?: number } = {},
): Promise<AppRelease[]> {
  const text = await http.getText(releaseListApiUrl(source, options.perPage), {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBytes: RELEASE_LIST_MAX_BYTES,
    urlPolicy: isTrustedReleaseHost,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  return parseGitHubReleaseList(payload);
}

/**
 * Only GitHub hosts may serve an installer.
 *
 * The download URL comes from a JSON document, so treating it as trusted input
 * would let a compromised/typo'd release point the updater at an arbitrary
 * host. Restricting the redirect target to the two GitHub domains keeps the
 * blast radius at "GitHub served us the wrong file", which the checksum catches.
 */
export function isTrustedReleaseHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'github.com'
      || host.endsWith('.github.com')
      || host === 'githubusercontent.com'
      || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}
