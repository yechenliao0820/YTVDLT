/**
 * D-137 (F-02 / F-05) — outbound network boundary, L2-local.
 *
 * Everything here runs against a throw-away `node:http` server on 127.0.0.1.
 * NO international traffic, NO real site, NO media download. The server lets us
 * forge the exact hostile shapes the audit asked about: a body with no honest
 * Content-Length, a slow trickle, a redirect to a different origin, a loop and
 * an over-long chain — plus a normal image to prove nothing regressed.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  MAX_HTTP_REDIRECTS, isPrivateHost, isPublicHttpsUrl, fetchFollowingRedirects,
} from '../../apps/desktop/src/main/adapters/http-policy.js';
import { createNodePorts } from '../../apps/desktop/src/main/adapters/node-ports.js';
import { downloadToFile } from '../../apps/desktop/src/main/adapters/http-download.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // closeAllConnections is what makes an aborted slow-stream test finish.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ytvdlt-http-${label}-`));
  dirs.push(dir);
  return dir;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface LocalServer {
  readonly url: string;
  readonly requests: string[];
}

async function serve(handler: Handler): Promise<LocalServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.on('error', () => { /* client aborted — expected in the hostile cases */ });
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
  return { url: `http://127.0.0.1:${port}`, requests };
}

function ports(root: string) {
  return createNodePorts({
    packaged: false,
    resourcesPath: root,
    runtimeDir: root,
    appDataDir: join(root, 'data'),
    configDir: join(root, 'data', 'config'),
    logsDir: join(root, 'data', 'logs'),
    appVersion: '0.2.9',
  });
}

describe('D-137 · pure URL policy', () => {
  it('rejects loopback / private / non-routable literals and their numeric spellings', () => {
    for (const host of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', 'localhost',
      'a.localhost', 'printer.local', 'box.internal', '::1', 'fd00::1',
      'fe80::1', '2130706433', '0x7f000001',
      // D-138: the HEX form `new URL()` produces for IPv4-mapped addresses.
      '::ffff:7f00:1', '::ffff:c0a8:101', '::ffff:a9fe:1',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of [
      'cdn.example.com', 'github.com', '93.184.216.34', '8.8.8.8',
      // D-138: a public domain that merely STARTS with "fc" / "fd" is not an
      // IPv6 unique-local address.
      'fcdn.example.com', 'fdic.gov', 'fcbank.example',
      // A mapped PUBLIC address stays public.
      '::ffff:808:808',
    ]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('rejects IPv4-mapped IPv6 URLs after the URL parser normalises them (D-138)', () => {
    // `new URL('https://[::ffff:127.0.0.1]/')` reports `[::ffff:7f00:1]`, so a
    // dotted-quad string check never fires. Exercise the real parser output.
    expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    expect(isPublicHttpsUrl('https://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isPublicHttpsUrl('https://[::ffff:192.168.1.1]/')).toBe(false);
    expect(isPublicHttpsUrl('https://[::ffff:7f00:1]/')).toBe(false);
    expect(isPublicHttpsUrl('https://[::ffff:c0a8:101]/')).toBe(false);
    expect(isPublicHttpsUrl('https://[::ffff:169.254.1.1]/')).toBe(false);
    // Public mapped address and public fc/fd-prefixed domains still pass.
    expect(isPublicHttpsUrl('https://[::ffff:8.8.8.8]/')).toBe(true);
    expect(isPublicHttpsUrl('https://fcdn.example.com/image.png')).toBe(true);
    expect(isPublicHttpsUrl('https://fdic.gov/image.png')).toBe(true);
  });

  it('accepts only credential-free https URLs on public hosts', () => {
    expect(isPublicHttpsUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isPublicHttpsUrl('http://cdn.example.com/a.png')).toBe(false);
    expect(isPublicHttpsUrl('https://127.0.0.1/a.png')).toBe(false);
    expect(isPublicHttpsUrl('https://192.168.0.4/a.png')).toBe(false);
    expect(isPublicHttpsUrl('https://user:pw@cdn.example.com/a.png')).toBe(false);
    expect(isPublicHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isPublicHttpsUrl('not a url')).toBe(false);
  });
});

describe('D-137 · per-hop redirect policy (real local server)', () => {
  it('follows a legitimate chain and re-checks every hop', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from(PNG));
      }
    });
    const response = await fetchFollowingRedirects(
      `${s.url}/start`, { signal: new AbortController().signal },
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(s.requests).toEqual(['/start', '/final']);
  });

  it('rejects a hop to a disallowed origin BEFORE requesting it', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: 'https://evil.invalid/steal' });
      res.end();
    });
    await expect(fetchFollowingRedirects(
      `${s.url}/start`, { signal: new AbortController().signal },
      { allow: (raw) => raw.startsWith(s.url) },
    )).rejects.toThrow(/blocked outbound URL at hop 1/);
    // The second origin was never contacted — the check happens before fetch.
    expect(s.requests).toEqual(['/start']);
  });

  it('detects a redirect loop and caps the chain length', async () => {
    const loop = await serve((req, res) => {
      res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' });
      res.end();
    });
    await expect(fetchFollowingRedirects(
      `${loop.url}/a`, { signal: new AbortController().signal },
    )).rejects.toThrow(/redirect loop/);

    const chain = await serve((req, res) => {
      const index = Number((req.url ?? '/n/0').split('/').pop());
      res.writeHead(302, { location: `/n/${index + 1}` });
      res.end();
    });
    await expect(fetchFollowingRedirects(
      `${chain.url}/n/0`, { signal: new AbortController().signal },
    )).rejects.toThrow(/too many redirects/);
    expect(chain.requests.length).toBe(MAX_HTTP_REDIRECTS + 1);
  });
});

describe('D-137 · bounded HttpPort.getBytes (real local server)', () => {
  it('caps an endless chunked body with NO honest Content-Length', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // No content-length: the old arrayBuffer() path would buffer all of this.
      for (let i = 0; i < 64; i += 1) res.write(Buffer.alloc(16 * 1024, 7));
      res.end();
    });
    await expect(ports(scratch('big')).http.getBytes(
      `${s.url}/big`, { maxBytes: 64, timeoutMs: 3_000 },
    )).rejects.toThrow(/exceeded 64 bytes/);
  });

  it('pre-rejects a declared length above the ceiling', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.end(Buffer.alloc(1000, 1));
    });
    await expect(ports(scratch('declared')).http.getBytes(
      `${s.url}/declared`, { maxBytes: 64, timeoutMs: 3_000 },
    )).rejects.toThrow(/response too large: 1000 bytes/);
  });

  it('keeps ONE deadline across headers AND the body (slow trickle)', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(8, 1));
      const timer = setInterval(() => res.write(Buffer.alloc(8, 1)), 200);
      res.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    await expect(ports(scratch('slow')).http.getBytes(
      `${s.url}/slow`, { maxBytes: 1024, timeoutMs: 150 },
    )).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still returns a normal image byte-for-byte', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) });
      res.end(Buffer.from(PNG));
    });
    const bytes = await ports(scratch('normal')).http.getBytes(
      `${s.url}/img`, { maxBytes: 6 * 1024 * 1024, timeoutMs: 3_000 },
    );
    expect(bytes).toEqual(PNG);
  });

  it('honours a strict per-hop policy handed in by the caller', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': String(PNG.byteLength) });
      res.end(Buffer.from(PNG));
    });
    // The thumbnail cache passes exactly this predicate; a local http URL is not
    // a public https cover source, so it must never be fetched.
    await expect(ports(scratch('policy')).http.getBytes(
      `${s.url}/img`, { maxBytes: 1024, timeoutMs: 3_000, urlPolicy: isPublicHttpsUrl },
    )).rejects.toThrow(/blocked outbound URL/);
    expect(s.requests).toEqual([]);
  });
});

describe('D-137 · installer download re-checks every hop', () => {
  it('accepts a same-origin redirect and writes the verified bytes', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/asset') {
        res.writeHead(302, { location: '/final' });
        res.end();
      } else {
        res.writeHead(200, { 'content-length': '4' });
        res.end(Buffer.from([0x4d, 0x5a, 1, 2]));
      }
    });
    const dir = scratch('installer-ok');
    const target = join(dir, 'setup.exe');
    const result = await downloadToFile({
      url: `${s.url}/asset`,
      targetPath: target,
      hostPolicy: (raw) => new URL(raw).origin === s.url,
      trashPartial: async () => undefined,
    });
    expect(readFileSync(target)).toEqual(Buffer.from([0x4d, 0x5a, 1, 2]));
    expect(result.bytes).toBe(4);
    expect(s.requests).toEqual(['/asset', '/final']);
  });

  it('refuses a cross-origin redirect and leaves no installer behind', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: 'https://evil.invalid/setup.exe' });
      res.end();
    });
    const dir = scratch('installer-blocked');
    await expect(downloadToFile({
      url: `${s.url}/asset`,
      targetPath: join(dir, 'setup.exe'),
      hostPolicy: (raw) => new URL(raw).origin === s.url,
      trashPartial: async () => undefined,
    })).rejects.toThrow(/blocked outbound URL/);
    expect(readdirSync(dir)).toEqual([]);
    expect(s.requests).toEqual(['/asset']);
  });
});
