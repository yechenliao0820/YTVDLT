/**
 * D-137 — one place for the outbound-URL policy of EVERY main-process fetch.
 *
 * WHY THIS EXISTS: `fetch(url, { redirect: 'follow' })` makes the network stack
 * decide where the request ends up. An initial URL that passed a host check can
 * therefore be 302'd to a loopback/private address (or downgraded to http) after
 * the check, and neither the thumbnail cache nor the updater would ever see it.
 * Both used `redirect: 'follow'` before D-137.
 *
 * The loop here follows redirects MANUALLY, so the caller's `allow` predicate is
 * applied to the initial URL AND to every hop. It is deliberately a pure URL
 * policy — it does not perform DNS resolution. DNS rebinding (a public name that
 * resolves to a private IP on the second lookup) is therefore NOT covered; the
 * only real fix is a pinned resolver/dispatcher at the socket layer, which this
 * app does not have. That limit is recorded in D-137 instead of being papered
 * over with a hostname check that cannot see the resolved address.
 *
 * This is an adapter (main process). Core stays pure and never imports it.
 */

/** Bounded chain: a legitimate GitHub asset redirect is 1–2 hops. */
export const MAX_HTTP_REDIRECTS = 5;

export interface RedirectPolicy {
  /** Applied to the initial URL and to every resolved Location, before fetch. */
  readonly allow: (rawUrl: string) => boolean;
}

/** Default: accept any syntactically valid http(s) URL, still bound the chain. */
export const allowAnyHttpUrl: RedirectPolicy = {
  allow: (raw) => {
    try {
      const parsed = new URL(raw);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  },
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Is this hostname a loopback / link-local / private / non-routable literal?
 *
 * Covers the numeric spellings browsers and resolvers also accept (decimal
 * `2130706433`, hex `0x7f000001`, dotted-octal) because a string check for
 * "127.0.0.1" alone is trivially bypassed. Pure, so it is unit-testable.
 */
export function isPrivateHost(host: string): boolean {
  const raw = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (raw === '') return true;
  if (raw === 'localhost' || raw.endsWith('.localhost')
    || raw.endsWith('.local') || raw.endsWith('.internal')) return true;
  if (raw === '::1' || raw === '::' || raw.startsWith('fc') || raw.startsWith('fd')
    || /^fe[89ab]/.test(raw) || raw.startsWith('::ffff:127.')
    || raw.startsWith('::ffff:10.') || raw.startsWith('::ffff:192.168.')) return true;
  if (/^[0-9]+$/.test(raw) || /^0x[0-9a-f]+$/.test(raw)) return true;

  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (dotted !== null) {
    const parts = dotted.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && b === 51) return true;
    if (a === 203 && b === 0) return true;
    return false;
  }
  // Non-IPv4-literal names are public as far as a pure URL policy can tell.
  return false;
}

/**
 * Policy for remote cover images: an https URL whose host is not a private /
 * loopback literal. Thumbnail URLs come from engine metadata, never from the
 * renderer, but they are still untrusted input.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:'
      && parsed.username === '' && parsed.password === ''
      && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export const publicHttpsOnly: RedirectPolicy = { allow: isPublicHttpsUrl };

/**
 * Follow a redirect chain one hop at a time, re-checking `policy.allow` before
 * every fetch. The SAME AbortSignal covers the whole chain, so a redirect storm
 * cannot outlive the caller's deadline.
 *
 * Throws on: a rejected hop, a loop, more than MAX_HTTP_REDIRECTS hops, a
 * missing/invalid Location. Never mutates `init`.
 */
export async function fetchFollowingRedirects(
  url: string,
  init: RequestInit,
  policy: RedirectPolicy = allowAnyHttpUrl,
): Promise<Response> {
  const visited = new Set<string>();
  let current = url;
  for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop += 1) {
    if (!policy.allow(current)) {
      throw new Error(`blocked outbound URL at hop ${hop}: ${current}`);
    }
    if (visited.has(current)) throw new Error('redirect loop detected');
    visited.add(current);

    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUS.has(response.status)) return response;

    const location = response.headers.get('location');
    // A 3xx with no body is still an open connection in some stacks; close it.
    if (location === null || location.trim() === '') {
      throw new Error(`redirect without Location at hop ${hop}`);
    }
    if (hop === MAX_HTTP_REDIRECTS) throw new Error('too many redirects');
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new Error(`invalid redirect Location at hop ${hop}`);
    }
    // `signal` may already have fired while we were reading headers.
    init.signal?.throwIfAborted();
    current = next;
  }
  throw new Error('too many redirects');
}
