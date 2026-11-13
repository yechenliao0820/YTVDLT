/**
 * D-137 — one place for the outbound-URL policy of EVERY main-process fetch.
 * D-143 — closes the DNS rebinding gap D-137 had to admit: the connection is
 * now PINNED to policy-verified addresses at the socket layer.
 * D-152 — IPv6 "public" is an ALLOWLIST: 2000::/3 minus the IANA IPv6
 * Special-Purpose Address Registry ranges, instead of "everything the private
 * list did not happen to cover".
 *
 * WHY THIS EXISTS: `fetch(url, { redirect: 'follow' })` makes the network stack
 * decide where the request ends up. An initial URL that passed a host check can
 * therefore be 302'd to a loopback/private address (or downgraded to http) after
 * the check, and neither the thumbnail cache nor the updater would ever see it.
 * Both used `redirect: 'follow'` before D-137.
 *
 * The loop here follows redirects MANUALLY, so the caller's `allow` predicate is
 * applied to the initial URL AND to every hop. The transport is `node:http` /
 * `node:https` (NOT global fetch, D-143). Before every hop:
 *   1. `policy.allow(url)` gates the hop on the URL, as before;
 *   2. the hop's hostname is resolved to ALL addresses (injectable
 *      `RedirectPolicy.lookup`, default `dns.promises.lookup(host,
 *      { all: true, verbatim: true })`);
 *   3. every resolved address must pass the optional
 *      `policy.allowResolvedAddress` hook — a single private/loopback answer
 *      fails the whole hop (fail closed);
 *   4. the socket is pinned to the verified addresses through the request's
 *      `lookup` option, so the node resolver is never consulted again for that
 *      connection.
 * A hostname whose first resolution is public but whose second resolution is
 * private (DNS rebinding / TOCTOU) is therefore rejected hop by hop. The URL
 * always keeps its original hostname: TLS SNI (`servername`), certificate
 * validation and the Host header stay correct — the pinned address is used for
 * the TCP connection only.
 *
 * Residual limits (D-143, stated on purpose):
 *   - a policy WITHOUT `allowResolvedAddress` (e.g. the permissive
 *     `allowAnyHttpUrl` default) still pins the socket to what was resolved but
 *     does not classify addresses — 127.0.0.1 test/dev traffic must keep working;
 *   - the guard can only validate what the resolver returns: a fully hostile
 *     resolver that hides a private answer behind a public one per connection is
 *     resolver poisoning rather than rebinding, and for https the certificate
 *     check remains the content gate.
 *
 * This is an adapter (main process). Core stays pure and never imports it.
 */
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

/** Bounded chain: a legitimate GitHub asset redirect is 1–2 hops. */
export const MAX_HTTP_REDIRECTS = 5;

/** One DNS answer for a hostname, with its address family (D-143). */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Injectable resolver (D-143): hostname → ALL of its addresses, in resolver
 * order. Tests inject a fake one; production uses the default
 * `dns.promises.lookup(host, { all: true, verbatim: true })`.
 */
export type HostLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface RedirectPolicy {
  /** Applied to the initial URL and to every resolved Location, before fetch. */
  readonly allow: (rawUrl: string) => boolean;
  /**
   * D-143: DNS rebinding guard. When present, EVERY address the hop's hostname
   * resolves to must pass it — one private/loopback answer fails the hop
   * (fail closed), and the connection is only ever pinned to addresses that
   * passed. Absent = no address-level classification; the URL check above still
   * runs and the socket is still pinned to the resolved addresses.
   */
  readonly allowResolvedAddress?: (address: string) => boolean;
  /** D-143: injectable resolver, for tests. Defaults to the system resolver. */
  readonly lookup?: HostLookup;
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
  // D-143: deliberately NO `allowResolvedAddress` here — the permissive default
  // also serves 127.0.0.1 test/dev traffic. Address classification is opt-in
  // (`isPublicResolvedAddress`); the pinning itself always happens.
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Trim/lower-case, strip URL brackets and a trailing root dot — the shared
 * host normalisation for the literal classifiers below (D-152). */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

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
 *
 * D-152: for IPv6 literals the answer is now the exact complement of the
 * `isPublicIpv6` allowlist below, so EVERY IANA special-purpose range
 * (multicast, discard-only, documentation, Teredo, 6to4, ORCHID) is rejected —
 * not just the blocks that used to be hand-listed.
 */
export function isPrivateHost(host: string): boolean {
  const raw = normalizeHost(host);
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

/**
 * D-152 — the IPv6 PUBLIC classifier, written as an allowlist. The previous
 * negation style ("private list → else public") silently treated every range
 * it did not know as routable internet, so IANA special-purpose blocks inside
 * the global-unicast space kept slipping through (documentation, Teredo,
 * 6to4, ORCHID). The allowlist closes that whole class of hole: an IPv6
 * address is public ONLY when
 *   1. it is IPv4-mapped (::ffff:0:0/96) — then the embedded IPv4 address
 *      decides (a mapped PUBLIC address stays public, D-138); or
 *   2. it lives in the global-unicast block 2000::/3 (RFC 4291) AND is not
 *      one of the IANA IPv6 Special-Purpose Address Registry ranges carved
 *      out of that block (checked below).
 * Everything else — ::, ::1, fc00::/7 (ULA), fe80::/10 (link-local),
 * ff00::/8 (multicast), 100::/64 (discard-only), 64:ff9b::/96 (NAT64),
 * fec0::/10 (deprecated site-local) and all unallocated space — fails closed
 * by construction. Pure, so it is unit-testable.
 */
function isPublicIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return false;
  // ::ffff:0:0/96 — IPv4-mapped (IANA special-purpose, RFC 4291). The socket
  // is really IPv4 to the low 32 bits, so unwrap and reuse the unchanged IPv4
  // rules. `new URL()` normalises [::ffff:127.0.0.1] to [::ffff:7f00:1], so
  // the HEX form is the one that actually arrives here.
  if (groups[5] === 0xffff && groups.slice(0, 5).every((g) => g === 0)) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return !isPrivateIpv4([
      (high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff,
    ]);
  }
  const first = groups[0] as number;
  const second = groups[1] as number;
  // Global unicast 2000::/3 (RFC 4291): the first three bits must be 001.
  // Everything else lands here fail-closed, including the IANA special-purpose
  // entries outside the block (::, ::1, fc00::/7, fe80::/10, ff00::/8,
  // 100::/64, 64:ff9b::/96, …).
  if ((first & 0xe000) !== 0x2000) return false;
  // IANA IPv6 Special-Purpose Address Registry entries INSIDE 2000::/3:
  if (first === 0x2001 && second === 0x0000) return false;            // 2001::/32 Teredo (RFC 4380)
  if (first === 0x2001 && second === 0x0db8) return false;            // 2001:db8::/32 documentation (RFC 3849)
  if (first === 0x2001 && (second & 0xfff0) === 0x0010) return false; // 2001:10::/28 ORCHID (RFC 4843)
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return false; // 2001:20::/28 ORCHIDv2 (RFC 7343)
  if (first === 0x2002) return false;                                 // 2002::/16 6to4 (RFC 7526, relays withdrawn)
  if (first === 0x3fff && (second & 0xf000) === 0x0000) return false; // 3fff::/20 documentation (RFC 9637)
  return true;
}

/** D-152: the private-side IPv6 answer is the exact allowlist complement. */
function isPrivateIpv6(groups: readonly number[]): boolean {
  return !isPublicIpv6(groups);
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

/**
 * D-143: address-side twin of a URL host policy. D-152 turns the IPv6 answer
 * into an allowlist: a RESOLVED address is public only when it is an IPv6
 * literal inside 2000::/3 that misses every IANA special-purpose carve-out
 * (`isPublicIpv6`), or an IPv4 literal that the unchanged IPv4 rules call
 * public. Empty or unparseable input fails closed. A stray hostname (never
 * produced by the D-143 resolver, but defensive) keeps the old `!isPrivateHost`
 * answer so normal fc/fd-prefixed domains are not misjudged here — pitfall 28.
 */
export function isPublicResolvedAddress(address: string): boolean {
  const raw = normalizeHost(address);
  if (raw === '') return false;
  if (raw.includes(':')) {
    const groups = parseIpv6(raw);
    // An IPv6 literal we cannot parse is not public: fail closed.
    if (groups === null) return false;
    return isPublicIpv6(groups);
  }
  // IPv4 literals (and stray names): the negation rules are unchanged.
  return !isPrivateHost(raw);
}

export const publicHttpsOnly: RedirectPolicy = {
  allow: isPublicHttpsUrl,
  // D-143: the URL check above only sees the hostname literal; this hook checks
  // what the name ACTUALLY resolves to on every hop and pins the socket to it.
  allowResolvedAddress: isPublicResolvedAddress,
};

const defaultLookup: HostLookup = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
};

/** Reject with the caller's abort reason when the signal fires mid-resolution. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === undefined || signal === null) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      // Keep the fetch-like `signal.reason`, but never reject with a non-Error.
      reject(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Resolve the hop's hostname and gate EVERY answer through the policy. Zero
 * answers or ONE rejected answer throws — the security boundary fails closed
 * (D-143). The SAME AbortSignal covers DNS: a deadline that fires while the
 * resolver is pending fails the hop (the underlying query cannot be cancelled;
 * its result is discarded).
 */
async function resolveVerifiedAddresses(
  hostname: string,
  policy: RedirectPolicy,
  hop: number,
  signal: AbortSignal | null | undefined,
): Promise<readonly ResolvedAddress[]> {
  const lookup = policy.lookup ?? defaultLookup;
  const records = await raceAbort(lookup(hostname), signal);
  if (records.length === 0) {
    throw new Error(`no resolved address for ${hostname} at hop ${hop}`);
  }
  const guard = policy.allowResolvedAddress;
  if (guard !== undefined) {
    for (const record of records) {
      if (!guard(record.address)) {
        throw new Error(`blocked resolved address at hop ${hop}: ${record.address} (${hostname})`);
      }
    }
  }
  return records;
}

/**
 * `RequestInit.headers` → a plain record for node:http. Callers pass a plain
 * record today; `Headers` instances and header tuples are normalised anyway.
 */
function headersRecordOf(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined || headers === null) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { record[key.toLowerCase()] = value; });
  } else if (Array.isArray(headers)) {
    for (const entry of headers) {
      const [key, value] = entry;
      if (key !== undefined && value !== undefined) record[key.toLowerCase()] = value;
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) record[key.toLowerCase()] = String(value);
    }
  }
  return record;
}

/** Body-less statuses per RFC 7230: `new Response(body)` throws for these. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Wrap a client `IncomingMessage` as a real fetch-style `Response`. The body is
 * STREAMED (`Readable.toWeb`), so callers keep their byte-counted readers and
 * backpressure; status / ok / headers behave exactly like the previous global
 * fetch. A socket error mid-body surfaces through this stream, as with fetch.
 */
function toWebResponse(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === 'string') {
      headers.append(key, value);
    }
  }
  const status = message.statusCode ?? 0;
  if (NULL_BODY_STATUS.has(status)) return new Response(null, { status, headers });
  return new Response(
    Readable.toWeb(message) as unknown as ReadableStream,
    { status, headers },
  );
}

interface PinnedResponseEntry {
  readonly response: Response;
  /** Kept so a consumed redirect hop can be torn down socket-level. */
  readonly message: IncomingMessage;
}

/**
 * ONE pinned connection attempt (D-143). `lookup` is overridden so the socket
 * layer can never resolve anything by itself: it hands out EXACTLY the verified
 * candidate — in the `all: true` shape the autoSelectFamily path uses and in the
 * classic single-address shape. The URL keeps its original hostname, so TLS
 * `servername` (SNI), certificate validation and the Host header all derive
 * from it; the pinned address is used for the TCP connection only.
 *
 * `init.method` / `init.headers` / `init.signal` are forwarded (the only fields
 * callers use — grep `fetchFollowingRedirects`). `init.body` is deliberately
 * UNSUPPORTED: no caller sends one, and a silently dropped body would be worse
 * than this explicit gap.
 */
function pinnedRequestOnce(
  target: URL,
  init: RequestInit,
  candidate: ResolvedAddress,
): Promise<PinnedResponseEntry> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestOptions: https.RequestOptions = {
      method: init.method ?? 'GET',
      headers: headersRecordOf(init.headers),
      // Pin the family AND the address (see `lookup` below).
      family: candidate.family,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: candidate.address, family: candidate.family }]);
        } else {
          callback(null, candidate.address, candidate.family);
        }
      },
      // D-143: no keep-alive pooling. A pooled socket would skip the pinned
      // lookup on reuse and could outlive the policy's decision; the outbound
      // traffic here is low-frequency (thumbnails, release checks, downloads).
      agent: false,
    };
    if (init.signal !== undefined && init.signal !== null) requestOptions.signal = init.signal;
    // https: make the SNI hostname explicit instead of relying on the default,
    // so it is obvious it never becomes the pinned IP.
    if (target.protocol === 'https:') requestOptions.servername = target.hostname;

    const onMessage = (message: IncomingMessage): void => {
      settled = true;
      resolve({ response: toWebResponse(message), message });
    };
    const request = target.protocol === 'https:'
      ? https.request(target, requestOptions, onMessage)
      : http.request(target, requestOptions, onMessage);
    request.on('error', (error) => {
      // After `settled` the body belongs to the caller; a late socket error
      // surfaces through the wrapped Response stream instead.
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.end();
  });
}

/**
 * Resolve → validate → connect for ONE hop (D-143). Verified addresses are
 * tried in resolver order; only a connection-level failure (no response
 * received yet) moves to the next candidate, and the first response wins.
 */
async function pinnedHopRequest(
  target: URL,
  init: RequestInit,
  policy: RedirectPolicy,
  hop: number,
): Promise<PinnedResponseEntry> {
  // `new URL()` keeps brackets on IPv6 literals ('[::1]'); the resolver and the
  // policy want the bare address form.
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const candidates = await resolveVerifiedAddresses(hostname, policy, hop, init.signal);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await pinnedRequestOnce(target, init, candidate);
    } catch (error) {
      lastError = error;
      // An abort is not a bad address: stop instead of trying the next one.
      if (init.signal?.aborted) throw error;
    }
  }
  throw lastError ?? new Error(`request failed for ${target.href}`);
}

/** Cancel the web stream and hard-destroy the socket underneath it. */
async function discardRedirectResponse(entry: PinnedResponseEntry): Promise<void> {
  try {
    await entry.response.body?.cancel();
  } catch {
    // Already errored or fully consumed — nothing left to free.
  }
  entry.message.destroy();
}

/**
 * Follow a redirect chain one hop at a time, re-checking `policy.allow` AND
 * re-resolving + re-pinning the DNS answer before every hop (D-143). The SAME
 * AbortSignal covers the whole chain (DNS + request), so a redirect storm
 * cannot outlive the caller's deadline.
 *
 * Throws on: a rejected hop (URL or resolved address), a loop, more than
 * MAX_HTTP_REDIRECTS hops, a missing/invalid Location. Never mutates `init`.
 */
export async function fetchFollowingRedirects(
  url: string,
  init: RequestInit,
  policy: RedirectPolicy = allowAnyHttpUrl,
): Promise<Response> {
  if (init.body !== undefined && init.body !== null) {
    throw new Error('fetchFollowingRedirects does not support a request body');
  }
  const visited = new Set<string>();
  let current = url;
  for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop += 1) {
    if (!policy.allow(current)) {
      throw new Error(`blocked outbound URL at hop ${hop}: ${current}`);
    }
    if (visited.has(current)) throw new Error('redirect loop detected');
    visited.add(current);

    const entry = await pinnedHopRequest(new URL(current), init, policy, hop);
    if (!REDIRECT_STATUS.has(entry.response.status)) return entry.response;

    const location = entry.response.headers.get('location');
    // D-143: consume/destroy the redirect body BEFORE the next hop. Under the
    // raw http transport an unread body keeps the socket open; under the old
    // global fetch the close this comment used to promise never happened.
    await discardRedirectResponse(entry);
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
