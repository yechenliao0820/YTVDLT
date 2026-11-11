/**
 * R1-01 (D-135) — the network context a URL pre-check runs under.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE LAMBDA: the requirement is not "pass a
 * proxy", it is "the pre-check and the download must agree". A pre-check that
 * runs WITHOUT the user's proxy / cookies / UA answers a different question
 * than the download will, so on any network that needs a proxy it degrades to
 * `INDETERMINATE` for every URL — the feature looks implemented and does
 * nothing. That is precisely the "两套配置" failure §3.4 names.
 *
 * THE SINGLE SOURCE OF TRUTH is `config.getDomain('network')` — the same
 * domain `core/decision/download-plan.ts` reads `proxy` / `cookiesFile` /
 * `userAgent` from when it builds the argv. Reading the config lazily (at call
 * time, never at startup) keeps a settings change inside one session from
 * leaving the pre-check answering for a network the download no longer uses.
 *
 * `''` and non-strings are DROPPED rather than forwarded: `--proxy ''` is not
 * "no proxy", it is a malformed argument, and an empty `--cookies` path makes
 * yt-dlp fail a run that would otherwise have worked. Dropping them makes the
 * pre-check's argv identical to the download's for the same config.
 *
 * No `electron`, no `node:*`: this file is pure so a unit test can prove the
 * mapping without a host, a config file, or a spawned process.
 */

/** What a pre-check may need to reach the same network the download uses. */
export interface SiteSupportNetwork {
  readonly proxy?: string;
  readonly cookiesFile?: string;
  readonly userAgent?: string;
}

/** The narrow slice of `IConfigStore` this needs (kept structural for tests). */
export interface NetworkDomainReader {
  getDomain(domain: 'network'): Readonly<Record<string, unknown>>;
}

/** A non-empty trimmed string, or `undefined`. Numbers/objects are rejected. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Resolve the pre-check network context from the live config.
 *
 * `null` (host not built yet) yields `{}` — "no context", not "no network":
 * the caller then forwards nothing and the engine uses its own defaults, which
 * is exactly what a download with an unset config does.
 */
export function readSiteSupportNetwork(config: NetworkDomainReader | null): SiteSupportNetwork {
  if (config === null) return {};
  const domain = config.getDomain('network');
  const proxy = nonEmptyString(domain['proxy']);
  const cookiesFile = nonEmptyString(domain['cookiesFile']);
  const userAgent = nonEmptyString(domain['userAgent']);
  // Built by spread, not by assigning `undefined`: `exactOptionalPropertyTypes`
  // treats an explicit `undefined` as a different type from an absent key, and
  // the adapter downstream spreads this object straight into the engine options.
  return {
    ...(proxy === undefined ? {} : { proxy }),
    ...(cookiesFile === undefined ? {} : { cookiesFile }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}
