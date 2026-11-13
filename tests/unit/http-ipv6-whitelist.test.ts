/**
 * D-152 — IPv6 "public" becomes an ALLOWLIST: global unicast 2000::/3 minus
 * the IANA IPv6 Special-Purpose Address Registry ranges carved out of it.
 *
 * Two paths consume the same IPv6 classification and BOTH must tighten:
 *   1. the URL-host literal path (`isPrivateHost` / `isPublicHttpsUrl`);
 *   2. the resolved-address path (`isPublicResolvedAddress` — the D-143 hook
 *      wired into node-ports and app-update-service).
 *
 * The reject matrix is the audit's list; the accept matrix is real public
 * unicast space plus the mask-boundary addresses that pin every prefix check.
 * Everything is offline: the only server is a throw-away local one that must
 * never be reached.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import {
  isPrivateHost, isPublicHttpsUrl, isPublicResolvedAddress, fetchFollowingRedirects,
  type HostLookup,
} from '../../apps/desktop/src/main/adapters/http-policy.js';

/**
 * `[address, reason]` — every entry must be REJECTED by both paths
 * (isPublicResolvedAddress → false, isPrivateHost → true).
 */
const REJECT: ReadonlyArray<readonly [string, string]> = [
  ['2001:db8::1', 'documentation (RFC 3849)'],
  ['2001:DB8::1', 'documentation, upper-case spelling'],
  ['2001:db8:ffff:ffff::1', 'documentation, last address of the /32'],
  ['3fff::1', 'documentation (RFC 9637)'],
  ['3fff:0fff::1', 'documentation, top of the /20'],
  ['100::1', 'discard-only (RFC 6666)'],
  ['2001::1', 'Teredo (RFC 4380)'],
  ['2001:0:5678:9abc:def0::1', 'Teredo, non-zero server part'],
  ['2002::1', '6to4 (RFC 7526)'],
  ['2002:c058:6301::1', '6to4 with an embedded relay IPv4'],
  ['2001:10::1', 'ORCHID (RFC 4843)'],
  ['2001:1f::1', 'ORCHID, top of the /28'],
  ['2001:20::1', 'ORCHIDv2 (RFC 7343)'],
  ['2001:2f::1', 'ORCHIDv2, top of the /28'],
  ['ff01::1', 'interface-local multicast (ff00::/8)'],
  ['ff0e::1', 'global multicast (ff00::/8)'],
  ['fe80::1', 'link-local (fe80::/10)'],
  ['fec0::1', 'site-local, deprecated (outside 2000::/3)'],
  ['fc00::1', 'ULA (fc00::/7)'],
  ['fd12:3456:789a::1', 'ULA, random fd prefix'],
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback (dotted spelling)'],
  ['::ffff:7f00:1', 'IPv4-mapped loopback (hex spelling, as new URL emits)'],
  ['::ffff:192.168.1.1', 'IPv4-mapped private (dotted spelling)'],
  ['::ffff:c0a8:101', 'IPv4-mapped private (hex spelling)'],
  ['::8.8.8.8', 'IPv4-compatible form, deprecated (outside 2000::/3)'],
];

/**
 * `[address, reason]` — every entry must be ACCEPTED by both paths
 * (isPublicResolvedAddress → true, isPrivateHost → false).
 */
const ACCEPT: ReadonlyArray<readonly [string, string]> = [
  ['2606:4700::1111', 'Cloudflare DNS'],
  ['2606:4700:4700::6811:ba98', 'Cloudflare, full form'],
  ['2001:4860:4860::8888', 'Google DNS'],
  ['2001:4860:4860::8844', 'Google DNS secondary'],
  ['2620:fe::fe', 'Quad9 DNS'],
  ['2620:0:ccc::2', 'OpenDNS'],
  ['2a00:1450:4001:81d::200e', 'Google Europe (RIPE range)'],
  ['2400:cb00:2049:1::a29f:1804', 'Cloudflare (APNIC range)'],
  ['2001:1234:5678::1', 'generic 2001::/16 global form, no special prefix'],
  ['2001:db9::1', 'mask boundary: second group is NOT 2001:db8::/32'],
  ['2001:30::1', 'mask boundary: outside both ORCHID /28s'],
  ['3fff:1000::1', 'mask boundary: outside 3fff::/20'],
  ['::ffff:8.8.8.8', 'IPv4-mapped PUBLIC (dotted) stays public (D-138)'],
  ['::ffff:0808:0808', 'IPv4-mapped PUBLIC (hex spelling)'],
];

describe('D-152 · resolved-address allowlist (isPublicResolvedAddress)', () => {
  it('rejects every audit-listed IANA special-purpose / non-2000::/3 address', () => {
    for (const [address, why] of REJECT) {
      expect(isPublicResolvedAddress(address), `${address} — ${why}`).toBe(false);
    }
  });

  it('accepts real public unicast segments and mapped-public IPv4', () => {
    for (const [address, why] of ACCEPT) {
      expect(isPublicResolvedAddress(address), `${address} — ${why}`).toBe(true);
    }
  });

  it('fails closed on empty and unparseable literals', () => {
    for (const address of ['', '   ', '[::zz::1]', '2001:db8::zz', '::ffff:1.2.3.999', '1:2:3:4:5:6:7:8:9']) {
      expect(isPublicResolvedAddress(address), address).toBe(false);
    }
  });

  it('keeps a normal domain name out of the literal rules (pitfall 28)', () => {
    // The hook receives resolved ADDRESSES in production; a stray name must
    // not be misjudged by the literal rules either way.
    expect(isPublicResolvedAddress('fc00-cdn.example.com')).toBe(true);
    expect(isPublicResolvedAddress('fdic.gov')).toBe(true);
    expect(isPublicResolvedAddress('localhost')).toBe(false);
  });
});

describe('D-152 · URL-host literal path (isPrivateHost / isPublicHttpsUrl)', () => {
  it('isPrivateHost mirrors the allowlist on both literal spellings', () => {
    for (const [address] of REJECT) {
      expect(isPrivateHost(address), address).toBe(true);
    }
    for (const [address] of ACCEPT) {
      expect(isPrivateHost(address), address).toBe(false);
    }
  });

  it('isPublicHttpsUrl rejects special-purpose IPv6 URL hosts', () => {
    for (const [address, why] of REJECT) {
      expect(isPublicHttpsUrl(`https://[${address}]/x`), `https://[${address}] — ${why}`).toBe(false);
    }
  });

  it('isPublicHttpsUrl accepts real public IPv6 URL hosts', () => {
    for (const [address] of ACCEPT) {
      expect(isPublicHttpsUrl(`https://[${address}]/x`), `https://[${address}]`).toBe(true);
    }
  });

  it('fc/fd-prefixed DOMAIN names are still accepted (D-138 regression)', () => {
    expect(isPublicHttpsUrl('https://fc00-pixel.example.com/a.png')).toBe(true);
    expect(isPublicHttpsUrl('https://fdic.gov/image.png')).toBe(true);
    expect(isPrivateHost('fd00-cdn.example.org')).toBe(false);
  });
});

describe('D-152 · tightened guard at the transport layer (fail closed)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  type Handler = (req: IncomingMessage, res: ServerResponse) => void;

  async function serve(handler: Handler): Promise<{ port: number; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      try {
        handler(req, res);
      } catch {
        res.destroy();
      }
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { port, requests };
  }

  it('rejects a hop resolving to a now-blocked address BEFORE connecting', async () => {
    const s = await serve(() => { throw new Error('must never be reached'); });
    for (const address of ['2001:db8::1', '2002::1', 'ff0e::1', '100::1', '::ffff:7f00:1']) {
      const lookup: HostLookup = async () => [{ address, family: 6 }];
      await expect(fetchFollowingRedirects(
        `http://rebind.example.test:${s.port}/file`,
        { signal: new AbortController().signal },
        // The EXACT production hook (node-ports / app-update-service wiring).
        { allow: () => true, allowResolvedAddress: isPublicResolvedAddress, lookup },
      )).rejects.toThrow(new RegExp(`blocked resolved address.*${address}`));
    }
    // Fail closed: nothing was ever contacted.
    expect(s.requests).toEqual([]);
  });
});
