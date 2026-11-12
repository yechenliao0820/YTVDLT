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
 * `2130706433`, hex `0x7f000001`) because a string check for "127.0.0.1" alone
 * is trivially bypassed. Pure, so it is unit-testable.
 *
 * D-138 fixes two defects in the first version:
 *   1. `startsWith('fc')` / `'fd'` was applied to the WHOLE hostname, so public
 *      domains such as `fcdn.example.com` were rejected (cover images lost);
 *   2. IPv4-mapped IPv6 was matched only in dotted form, while `new URL()`
 *      normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` — the pattern never
 *      fired, so the literal private-address guard was bypassed.
 * The fix classifies the input FIRST (IPv4 literal / IPv6 literal / domain) and
 * only then applies address-range rules.
 */
export function isPrivateHost(host: string): boolean {
  const raw = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (raw === '') return true;

  const ipv4 = parseIpv4(raw);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);

  // Decimal / hex spellings of an IPv4 address. Rejecting them outright is
  // deliberate: resolving what they mean is the ambiguity an attacker wants.
  if (/^[0-9]+$/.test(raw) || /^0x[0-9a-f]+$/.test(raw)) return true;

  if (raw.includes(':')) {
    const groups = parseIpv6(raw);
    // An IPv6 literal we cannot parse is treated as private: fail closed.
    if (groups === null) return true;
    return isPrivateIpv6(groups);
  }

  // Not an address literal: only the reserved local names are private. A public
  // domain that merely STARTS with "fc" / "fd" is NOT.
  return raw === 'localhost' || raw.endsWith('.localhost')
    || raw.endsWith('.local') || raw.endsWith('.internal');
}

type Ipv4 = readonly [number, number, number, number];

function parseIpv4(raw: string): Ipv4 | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part > 255)) return null;
  return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] as number];
}

/** RFC 1918 / loopback / link-local / CGNAT / TEST-NET / multicast / reserved. */
function isPrivateIpv4(parts: Ipv4): boolean {
  const [a, b] = parts;
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

/**
 * Parse an IPv6 literal into eight 16-bit groups. Accepts `::` compression and
 * an embedded dotted-quad tail. Returns null on anything malformed.
 */
function parseIpv6(raw: string): number[] | null {
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const head = parseIpv6Groups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseIpv6Groups(halves[1] ?? '');
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function parseIpv6Groups(text: string): number[] | null {
  if (text === '') return [];
  const groups: number[] = [];
  for (const part of text.split(':')) {
    if (part === '') return null;
    if (part.includes('.')) {
      const embedded = parseIpv4(part);
      if (embedded === null) return null;
      groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function isPrivateIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return true;
  const first = groups[0] as number;
  if (groups.every((group) => group === 0)) return true;                       // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  // ::ffff:0:0/96 — IPv4-mapped. `new URL()` normalises [::ffff:127.0.0.1] to
  // [::ffff:7f00:1], so THIS branch is the one that actually runs.
  if (groups[5] === 0xffff && groups.slice(0, 5).every((g) => g === 0)) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return isPrivateIpv4([
      (high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff,
    ]);
  }
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
