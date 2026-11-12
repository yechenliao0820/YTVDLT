/**
 * GitHub Releases lookup (0.2.1, D-93).
 *
 * One function, because there are two callers that must agree on the rules:
 * the app-update service (this repository's own releases) and the component
 * version check (`yt-dlp/yt-dlp`). Both get the same treatment — `draft` and
 * `prerelease` are skipped, the tag is normalised, nothing is cached here.
 *
 * The network goes through `HttpPort`, so no `node:https` import leaks into the
 * service and the whole decision path stays testable with a fake port.
 */
import type { AppRelease, HttpPort } from '@ytvdlt/shared';
import { parseGitHubRelease } from '@ytvdlt/core';

export interface ReleaseSource {
  readonly owner: string;
  readonly repo: string;
}

/** `/repos/:owner/:repo/releases/latest` — the only endpoint used. */
export function latestReleaseApiUrl(source: ReleaseSource): string {
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}`
    + `/${encodeURIComponent(source.repo)}/releases/latest`;
}

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
