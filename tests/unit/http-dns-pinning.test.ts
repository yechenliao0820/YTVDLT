/**
 * D-143 — DNS rebinding / address pinning, L2-local.
 *
 * Everything here runs against throw-away local servers. The hostnames never
 * reach real DNS: the resolver is injected through `RedirectPolicy.lookup` and
 * the connection is pinned to the addresses it returned via the request's
 * `lookup` option, so a fake `.test` name that cannot resolve anywhere still
 * connects — which is itself the proof that pinning (not the node resolver)
 * decides where the socket goes. The private addresses asserted below are the
 * ones `isPrivateHost` classifies: loopback, RFC 1918, link-local, unique-local.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  fetchFollowingRedirects, isPrivateHost, isPublicResolvedAddress,
  type HostLookup, type RedirectPolicy,
} from '../../apps/desktop/src/main/adapters/http-policy.js';
import { createNodePorts } from '../../apps/desktop/src/main/adapters/node-ports.js';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ytvdlt-dns-pin-${label}-`));
  dirs.push(dir);
  return dir;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface LocalServer {
  readonly url: string;
  readonly port: number;
  readonly requests: string[];
  /** `Host` header of every request — must stay the ORIGINAL hostname. */
  readonly hosts: string[];
  /** Client-side socket address of every connection that reached the server. */
  readonly remoteAddresses: string[];
}

async function serve(handler: Handler): Promise<LocalServer> {
  const requests: string[] = [];
  const hosts: string[] = [];
  const remoteAddresses: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    hosts.push(req.headers.host ?? '');
    remoteAddresses.push(req.socket.remoteAddress ?? '');
    res.on('error', () => { /* client aborted — expected in the blocked cases */ });
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
  return { url: `http://127.0.0.1:${port}`, port, requests, hosts, remoteAddresses };
}

const signal = (): AbortSignal => new AbortController().signal;

/**
 * The production hook (`isPublicResolvedAddress`) would reject the local
 * server's loopback address too. These tests whitelist 127.0.0.1 so the FIRST
 * hop can reach the throw-away server, while any OTHER private address the
 * policy sees is still rejected — exactly what the real public-address check
 * would do for a genuinely public first hop.
 */
const rejectPrivateExceptLoopback = (address: string): boolean =>
  address === '127.0.0.1' || !isPrivateHost(address);

describe('D-143 · address pinning on every hop', () => {
  it('pins the socket to the resolved address and keeps the URL hostname', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const lookedUp: string[] = [];
    const lookup: HostLookup = async (hostname) => {
      lookedUp.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const response = await fetchFollowingRedirects(
      `http://pinned.example.test:${s.port}/file`,
      { signal: signal() },
      { allow: () => true, lookup },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    // The fake `.test` hostname does not exist in any real resolver: reaching
    // the server at all proves the connection used the INJECTED address.
    expect(s.requests).toEqual(['/file']);
    expect(s.remoteAddresses).toEqual(['127.0.0.1']);
    // Host header (and therefore URL host) keeps the hostname — never the IP.
    expect(s.hosts).toEqual([`pinned.example.test:${s.port}`]);
    expect(lookedUp).toEqual(['pinned.example.test']);
  });

  it('tries verified addresses in order and only stops on a response', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    // Both candidates come from the injected resolver and are VERIFIED by the
    // hook below (the whole answer is validated BEFORE any connection). The
    // first is unreachable; only a connection-level failure may move the pin to
    // the next verified address.
    const lookup: HostLookup = async () => [
      { address: '127.0.0.2', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const response = await fetchFollowingRedirects(
      `http://multi.example.test:${s.port}/file`,
      { signal: signal() },
      {
        allow: () => true,
        lookup,
        allowResolvedAddress: (address) => address === '127.0.0.2' || address === '127.0.0.1',
      },
    );
    expect(response.status).toBe(200);
    expect(s.requests).toEqual(['/file']);
    expect(s.remoteAddresses).toEqual(['127.0.0.1']);
  });
});

describe('D-143 · resolved-address guard (fail closed)', () => {
  it('rejects loopback / private / link-local / unique-local resolutions before connecting', async () => {
    const s = await serve(() => { throw new Error('must never be reached'); });
    for (const address of ['127.0.0.1', '192.168.1.1', '::1', 'fe80::1', 'fd00::1']) {
      const lookup: HostLookup = async () => [{
        address, family: address.includes(':') ? 6 : 4,
      }];
      await expect(fetchFollowingRedirects(
        `http://rebind.example.test:${s.port}/file`,
        { signal: signal() },
        // The EXACT production hook: every private/loopback answer is refused.
        { allow: () => true, allowResolvedAddress: isPublicResolvedAddress, lookup },
      )).rejects.toThrow(new RegExp(`blocked resolved address.*${address.replace(':', '\\:')}`));
    }
    // Fail closed: nothing was ever contacted.
    expect(s.requests).toEqual([]);
  });

  it('rejects a zero-address resolution', async () => {
    const s = await serve(() => { throw new Error('must never be reached'); });
    await expect(fetchFollowingRedirects(
      `http://empty.example.test:${s.port}/file`,
      { signal: signal() },
      { allow: () => true, lookup: async () => [] },
    )).rejects.toThrow(/no resolved address/);
    expect(s.requests).toEqual([]);
  });
});

describe('D-143 · redirects re-resolve and re-validate every hop', () => {
  it('rejects a redirect hop whose hostname resolves to a private address', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://evil.example.test:${s.port}/final` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('pwned');
    });
    // URL-level check allows both hops (like a permissive allowlist would); the
    // ADDRESS check is what catches the hostile hop.
    const policy: RedirectPolicy = {
      allow: () => true,
      allowResolvedAddress: rejectPrivateExceptLoopback,
      lookup: async (hostname) => hostname === 'server.example.test'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '192.168.1.1', family: 4 }],
    };
    await expect(fetchFollowingRedirects(
      `http://server.example.test:${s.port}/start`, { signal: signal() }, policy,
    )).rejects.toThrow(/blocked resolved address.*192\.168\.1\.1/);
    expect(s.requests).toEqual(['/start']);
  });

  it('closes the TOCTOU: the SAME hostname is re-resolved and re-pinned per hop', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('pwned');
    });
    // DNS "changes" between the hops of one chain: first resolution is the
    // connectable server, second resolution silently turns private. D-137's
    // unresolved rebinding case — the second hop must be refused.
    const lookups: string[] = [];
    let call = 0;
    const policy: RedirectPolicy = {
      allow: () => true,
      allowResolvedAddress: rejectPrivateExceptLoopback,
      lookup: async (hostname) => {
        call += 1;
        lookups.push(hostname);
        return call === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '10.0.0.5', family: 4 }];
      },
    };
    await expect(fetchFollowingRedirects(
      `http://rebind.example.test:${s.port}/a`, { signal: signal() }, policy,
    )).rejects.toThrow(/blocked resolved address.*10\.0\.0\.5/);
    // One DNS round-trip per hop, both for the same hostname, second refused.
    expect(lookups).toEqual(['rebind.example.test', 'rebind.example.test']);
    expect(call).toBe(2);
    expect(s.requests).toEqual(['/a']);
  });
});

describe('D-143 · original hostname survives the pin', () => {
  it('keeps the hostname as TLS SNI while the socket connects to the pinned IP', async () => {
    // A raw TCP server is enough: the TLS ClientHello carries the SNI hostname
    // in plaintext, and the handshake never needs to complete.
    const chunks: Buffer[] = [];
    const server = createTcpServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        socket.destroy();
      });
      socket.on('error', () => { /* client aborted the broken handshake */ });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const lookup: HostLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    // The plaintext server cannot finish a TLS handshake — any rejection is fine.
    await expect(fetchFollowingRedirects(
      `https://sni.example.test:${port}/x`,
      { signal: signal() },
      { allow: () => true, lookup },
    )).rejects.toThrow();
    // ClientHello SNI extension carries the ORIGINAL hostname, not the pinned IP.
    const hello = Buffer.concat(chunks).toString('latin1');
    expect(hello).toContain('sni.example.test');
  });

  it('covers DNS resolution with the SAME AbortSignal as the request', async () => {
    const s = await serve(() => { throw new Error('must never be reached'); });
    const policy: RedirectPolicy = {
      allow: () => true,
      // A resolver that never answers: only the caller's deadline can end it.
      lookup: () => new Promise(() => {}),
    };
    await expect(fetchFollowingRedirects(
      `http://slow-dns.example.test:${s.port}/x`,
      { signal: AbortSignal.timeout(80) },
      policy,
    )).rejects.toThrow();
    expect(s.requests).toEqual([]);
  });
});

describe('D-143 · production wiring', () => {
  it('still fetches through the default resolver for a real local name', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    // Default policy (no address hook): localhost resolves to 127.0.0.1 and/or
    // ::1 via the system resolver; pinning must handle both without a hook.
    const response = await fetchFollowingRedirects(
      `http://localhost:${s.port}/file`, { signal: signal() },
    );
    expect(response.status).toBe(200);
    expect(s.requests).toEqual(['/file']);
    expect(s.remoteAddresses).toEqual(['127.0.0.1']);
  });

  it('HttpPort callers with a urlPolicy get the resolved-address guard too', async () => {
    const s = await serve(() => { throw new Error('must never be reached'); });
    const root = scratch('httpport-guard');
    const ports = createNodePorts({
      packaged: false,
      resourcesPath: root,
      runtimeDir: root,
      appDataDir: join(root, 'data'),
      configDir: join(root, 'data', 'config'),
      logsDir: join(root, 'data', 'logs'),
      appVersion: '0.2.9',
    });
    // A deliberately permissive URL policy lets 127.0.0.1 through; the D-143
    // guard attached by the adapter must still reject the private resolution.
    // (The thumbnail cache and the updater pass real policies and get the same
    // guard — this asserts the wiring itself, offline.)
    await expect(ports.http.getBytes(`${s.url}/img`, {
      timeoutMs: 3_000,
      urlPolicy: (raw) => raw.startsWith('http'),
    })).rejects.toThrow(/blocked resolved address/);
    expect(s.requests).toEqual([]);
  });
});
