/**
 * M5-5 follow-up · component updater (D-67).
 *
 * Covers the part that is easy to get wrong: an update round must survive one
 * component failing, must not run twice at the same time, and must say "no feed"
 * instead of throwing when the build ships without one.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@ytvdlt/core';
import type { CorePorts, HttpFetchOptions, HttpPort } from '@ytvdlt/shared';
import {
  createComponentUpdater, normalizeVersion, type ComponentSpec,
} from '../../apps/desktop/src/main/component-updater.js';
import { isTrustedReleaseHost } from '../../apps/desktop/src/main/github-releases.js';
import { createNodePorts } from '../../apps/desktop/src/main/adapters/node-ports.js';
import { MAX_HTTP_REDIRECTS } from '../../apps/desktop/src/main/adapters/http-policy.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const YTDLP_BYTES = new TextEncoder().encode('ytdlp-v2');
const ARIA_BYTES = new TextEncoder().encode('aria2-v2');

function fakeHttp(behaviour: {
  failBytesFor?: string;
  delayMs?: number;
  /** Body served for a version-API JSON lookup (`check()` entry). */
  releaseJson?: string;
  /** Body served for every `SHA2-256SUMS` lookup (defaults to wrong hashes). */
  sumsText?: string;
} = {}): HttpPort & { readonly calls: string[]; readonly opts: (HttpFetchOptions | undefined)[] } {
  const calls: string[] = [];
  const opts: (HttpFetchOptions | undefined)[] = [];
  return {
    calls,
    opts,
    async getText(url: string, fetchOpts?: HttpFetchOptions) {
      calls.push(`text:${url}`);
      opts.push(fetchOpts);
      if (url.endsWith('SHA2-256SUMS')) {
        return behaviour.sumsText
          ?? [`${'a'.repeat(64)}  yt-dlp.exe`, `${'b'.repeat(64)}  aria2c.exe`].join('\n');
      }
      if (behaviour.releaseJson !== undefined) return behaviour.releaseJson;
      throw new Error(`unexpected text url ${url}`);
    },
    async getBytes(url: string, fetchOpts?: HttpFetchOptions) {
      calls.push(`bytes:${url}`);
      opts.push(fetchOpts);
      if (behaviour.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      }
      if (behaviour.failBytesFor !== undefined && url.endsWith(behaviour.failBytesFor)) {
        throw new Error('ECONNRESET');
      }
      return url.endsWith('aria2c.exe') ? ARIA_BYTES : YTDLP_BYTES;
    },
  };
}

async function setup(behaviour: Parameters<typeof fakeHttp>[0] = {}) {
  const mem = createInMemoryPorts();

  // The feed's checksums must match the bytes we serve, otherwise every update
  // is (correctly) refused before touching the disk.
  const ytdlpHash = await mem.ports.hash.sha256Bytes(YTDLP_BYTES);
  const ariaHash = await mem.ports.hash.sha256Bytes(ARIA_BYTES);
  const http = fakeHttp({
    ...behaviour,
    sumsText: `${ytdlpHash}  yt-dlp.exe\n${ariaHash}  aria2c.exe`,
  });
  const ports: CorePorts = { ...mem.ports, http };
  const logger = new Logger({ ports, appVersion: '0.1.0' });

  mem.state.bytes.set('C:/runtime/yt-dlp.exe', new TextEncoder().encode('ytdlp-v1'));
  mem.state.bytes.set('C:/runtime/aria2c.exe', new TextEncoder().encode('aria2-v1'));
  mem.state.spawnResults.set('yt-dlp.exe', { exitCode: 0, stdout: '2026.10.26\n', stderr: '', timedOut: false });
  mem.state.spawnResults.set('aria2c.exe', { exitCode: 0, stdout: 'aria2 version 1.35.0\n', stderr: '', timedOut: false });

  const components: ComponentSpec[] = [
    { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe' },
    { id: 'aria2c', label: 'aria2c', fileName: 'aria2c.exe', path: 'C:/runtime/aria2c.exe' },
  ];
  return { mem, http, logger, ports, components };
}

describe('D-67 · normalizeVersion', () => {
  it('extracts a dotted version from either tool', () => {
    expect(normalizeVersion('2026.10.26\n')).toBe('2026.10.26');
    expect(normalizeVersion('aria2 version 1.35.0\nCopyright…')).toBe('1.35.0');
    expect(normalizeVersion('')).toBe('');
  });
});

describe('D-67 · status', () => {
  it('reports both components with their installed versions', async () => {
    const { ports, logger, components } = await setup();
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org/c/', intakeGate: null,
    });
    const status = await updater.status();
    expect(status.source).toBe('https://feed.example.org/c/');
    expect(status.updating).toBe(false);
    expect(status.components.map((item) => `${item.id}:${item.installed}:${item.version}`)).toEqual([
      'yt-dlp:true:2026.10.26',
      'aria2c:true:1.35.0',
    ]);
  });

  it('marks a missing component as not installed instead of failing', async () => {
    const { mem, ports, logger } = await setup();
    mem.state.bytes.delete('C:/runtime/aria2c.exe');
    const updater = createComponentUpdater({
      ports, logger, baseUrl: 'https://feed.example.org', intakeGate: null,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe' },
        { id: 'aria2c', label: 'aria2c', fileName: 'aria2c.exe', path: 'C:/runtime/aria2c.exe' },
      ],
    });
    const status = await updater.status();
    expect(status.components[1]).toMatchObject({ id: 'aria2c', installed: false, version: '' });
  });

  it('reports a null source when the build has no feed', async () => {
    const { ports, logger, components } = await setup();
    const updater = createComponentUpdater({ ports, logger, components, baseUrl: null, intakeGate: null });
    expect((await updater.status()).source).toBeNull();
  });
});

describe('D-67 · run', () => {
  it('refuses early when no feed is configured (no network at all)', async () => {
    const { ports, logger, components, http } = await setup();
    const updater = createComponentUpdater({ ports, logger, components, baseUrl: null, intakeGate: null });
    const result = await updater.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('未配置');
    expect(http.calls).toEqual([]);
  });

  it('updates both components in one pass', async () => {
    const { mem, ports, logger, components } = await setup();
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org/', intakeGate: null,
    });
    const result = await updater.run();
    expect(result.ok).toBe(true);
    expect(result.results.map((item) => item.changed)).toEqual([true, true]);
    expect(result.results.map((item) => `${item.label}:${item.changed}:${item.fromVersion}->${item.toVersion}`)).toEqual([
      'yt-dlp:true:2026.10.26->2026.10.26',
      'aria2c:true:1.35.0->1.35.0',
    ]);
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/yt-dlp.exe'))).toBe('ytdlp-v2');
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/aria2c.exe'))).toBe('aria2-v2');
    expect(mem.state.bytes.has('C:/runtime/yt-dlp.exe.bak')).toBe(false);
    expect(mem.state.bytes.has('C:/runtime/aria2c.exe.bak')).toBe(false);
  });

  it('keeps going when one component fails, and marks only that one', async () => {
    const { mem, ports, logger, components } = await setup({ failBytesFor: 'aria2c.exe' });
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org', intakeGate: null,
    });
    const result = await updater.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('1/2');
    expect(result.results[0]).toMatchObject({ id: 'yt-dlp', changed: true, error: null });
    // SelfUpdater refuses instead of throwing, so the failure shows up as a reason.
    expect(result.results[1]).toMatchObject({ id: 'aria2c', changed: false, reason: 'download-failed', error: null });
    // yt-dlp still got updated; aria2c kept its old bytes.
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/yt-dlp.exe'))).toBe('ytdlp-v2');
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/aria2c.exe'))).toBe('aria2-v1');
  });

  it('never runs two rounds at once', async () => {
    const { ports, logger, components } = await setup({ delayMs: 30 });
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: 'https://feed.example.org', intakeGate: null,
    });
    const first = updater.run();
    const second = await updater.run();
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('正在进行');
    expect((await first).ok).toBe(true);
  });
});

/**
 * Component-update hardening: every fetch of this chain (version query, checksum
 * manifest, binary) must carry the policy that matches its source — strict
 * GitHub allowlist for official sources, the bounded permissive port default
 * for operator mirrors. The spy asserts here cover the WIRING (options really
 * leave the updater); the real-port describe below covers the ENFORCEMENT.
 */
describe('component-update hardening · source policies reach the port layer', () => {
  const OFFICIAL_FEED = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const OFFICIAL_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
  const MIRROR_BASE = 'https://feed.example.org/mirror/';

  it('check(): the official version API is fetched under the strict GitHub host policy', async () => {
    const { ports, logger, http } = await setup({ releaseJson: '{"tag_name":"2026.11.01"}' });
    const updater = createComponentUpdater({
      ports, logger, intakeGate: null, baseUrl: null,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe', versionApiUrl: OFFICIAL_API },
      ],
    });

    const report = await updater.check();
    expect(http.calls).toEqual([`text:${OFFICIAL_API}`]);
    const policy = http.opts[0]?.urlPolicy;
    expect(policy).toBe(isTrustedReleaseHost);
    // Behavioural pin of the coverage comment on `componentSourceUrlPolicy`:
    // GitHub-family https hops pass, everything else fails (downgrade, foreign
    // host, loopback) — the same trust root as the app updater.
    expect(policy?.('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).toBe(true);
    expect(policy?.('https://objects.githubusercontent.com/asset')).toBe(true);
    expect(policy?.('https://evil.invalid/steal')).toBe(false);
    expect(policy?.('http://github.com/yt-dlp/yt-dlp')).toBe(false);
    expect(policy?.('https://127.0.0.1/feed')).toBe(false);
    // The fetch itself still worked: a newer tag is parsed out of the JSON.
    expect(report.results[0]).toMatchObject({ id: 'yt-dlp', latestVersion: '2026.11.01', updateAvailable: true });
  });

  it('check(): a non-GitHub version API stays on the bounded permissive mirror mode', async () => {
    const { ports, logger, http } = await setup({ releaseJson: '{"tag_name":"2026.11.01"}' });
    const customApi = 'https://mirror.example.org/yt-dlp/release.json';
    const updater = createComponentUpdater({
      ports, logger, intakeGate: null, baseUrl: null,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe', versionApiUrl: customApi },
      ],
    });

    const report = await updater.check();
    expect(http.calls).toEqual([`text:${customApi}`]);
    // Mirror mode is an EXPLICIT decision: no urlPolicy in the options, so the
    // port keeps its permissive default (intranet addresses allowed) and only
    // the transport-level guards apply. Asserted as an exact object so a
    // silently-added half-policy cannot hide here either.
    expect(http.opts[0]).toEqual({ timeoutMs: 15_000 });
    expect(report.results[0]).toMatchObject({ id: 'yt-dlp', latestVersion: '2026.11.01' });
  });

  it('run(): official feed manifest + binary are fetched under the strict policy', async () => {
    const { mem, ports, logger, http } = await setup();
    const updater = createComponentUpdater({
      ports, logger, intakeGate: null, baseUrl: null,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe', feedUrl: OFFICIAL_FEED },
      ],
    });

    const result = await updater.run();
    expect(result.ok).toBe(true);
    expect(http.calls).toEqual([
      `text:${OFFICIAL_FEED}/SHA2-256SUMS`,
      `bytes:${OFFICIAL_FEED}/yt-dlp.exe`,
    ]);
    expect(http.opts[0]?.urlPolicy).toBe(isTrustedReleaseHost);
    expect(http.opts[1]?.urlPolicy).toBe(isTrustedReleaseHost);
    expect(new TextDecoder().decode(mem.state.bytes.get('C:/runtime/yt-dlp.exe'))).toBe('ytdlp-v2');
  });

  it('run(): operator mirror manifest + binary carry no urlPolicy (explicit mirror mode)', async () => {
    const { ports, logger, components, http } = await setup();
    const updater = createComponentUpdater({
      ports, logger, components, baseUrl: MIRROR_BASE, intakeGate: null,
    });

    const result = await updater.run();
    expect(result.ok).toBe(true);
    expect(http.calls).toEqual([
      `text:${MIRROR_BASE}SHA2-256SUMS`,
      `bytes:${MIRROR_BASE}yt-dlp.exe`,
      `text:${MIRROR_BASE}SHA2-256SUMS`,
      `bytes:${MIRROR_BASE}aria2c.exe`,
    ]);
    for (const opts of http.opts) {
      expect(opts?.urlPolicy).toBeUndefined();
    }
  });

  it('run(): official and mirror components keep their own policies in one pass', async () => {
    const { ports, logger, http } = await setup();
    const updater = createComponentUpdater({
      ports, logger, intakeGate: null, baseUrl: MIRROR_BASE,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: 'C:/runtime/yt-dlp.exe', feedUrl: OFFICIAL_FEED },
        { id: 'aria2c', label: 'aria2c', fileName: 'aria2c.exe', path: 'C:/runtime/aria2c.exe' },
      ],
    });

    const result = await updater.run();
    expect(result.ok).toBe(true);
    expect(http.calls).toEqual([
      `text:${OFFICIAL_FEED}/SHA2-256SUMS`,
      `bytes:${OFFICIAL_FEED}/yt-dlp.exe`,
      `text:${MIRROR_BASE}SHA2-256SUMS`,
      `bytes:${MIRROR_BASE}aria2c.exe`,
    ]);
    // The official feed is never loosened by the mirror mode next to it, and
    // the mirror is never forced onto the strict GitHub allowlist.
    expect(http.opts[0]?.urlPolicy).toBe(isTrustedReleaseHost);
    expect(http.opts[1]?.urlPolicy).toBe(isTrustedReleaseHost);
    expect(http.opts[2]?.urlPolicy).toBeUndefined();
    expect(http.opts[3]?.urlPolicy).toBeUndefined();
  });
});

/**
 * Port-level half of the hardening (anti-pitfall-29): the options the updater
 * passes must be ENFORCED by the real `node-ports` HttpPort, not just shaped
 * correctly. Everything runs against a throw-away `node:http` server on
 * 127.0.0.1 — no international traffic.
 */
describe('component-update hardening · the real HttpPort enforces the passed options', () => {
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

  type Handler = (req: IncomingMessage, res: ServerResponse) => void;

  async function serve(handler: Handler): Promise<{ url: string; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.on('error', () => { /* client aborted — expected in hostile cases */ });
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

  function realPorts(): CorePorts {
    const root = mkdtempSync(join(tmpdir(), 'ytvdlt-component-policy-'));
    dirs.push(root);
    return createNodePorts({
      packaged: false,
      resourcesPath: root,
      runtimeDir: root,
      appDataDir: join(root, 'data'),
      configDir: join(root, 'data', 'config'),
      logsDir: join(root, 'data', 'logs'),
      appVersion: '0.1.0',
    });
  }

  it('the official policy really blocks a non-GitHub target at hop 0 (nothing fetched)', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '4' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    // Exactly what the official path passes: `isTrustedReleaseHost` via
    // HttpFetchOptions. A local http URL is not on the GitHub trust root, so
    // the port must refuse BEFORE contacting the server.
    await expect(realPorts().http.getText(`${s.url}/SHA2-256SUMS`, {
      timeoutMs: 3_000,
      urlPolicy: isTrustedReleaseHost,
    })).rejects.toThrow(/blocked outbound URL/);
    expect(s.requests).toEqual([]);
  });

  it('mirror mode (no urlPolicy) still reaches a loopback feed through the real port', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '4' });
      res.end(Buffer.from([9, 9, 9, 9]));
    });
    // No urlPolicy — the mirror mode. Loopback/intranet addresses are a legal
    // mirror target, so this must SUCCEED.
    const bytes = await realPorts().http.getBytes(`${s.url}/yt-dlp.exe`, { timeoutMs: 3_000 });
    expect(Array.from(bytes)).toEqual([9, 9, 9, 9]);
    expect(s.requests).toEqual(['/yt-dlp.exe']);
  });

  it('mirror mode redirects stay per-hop judged on the real port', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/SHA2-256SUMS' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': '4' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    const bytes = await realPorts().http.getBytes(`${s.url}/start`, { timeoutMs: 3_000 });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(s.requests).toEqual(['/start', '/SHA2-256SUMS']);
  });

  it('mirror mode keeps the redirect cap on the real port', async () => {
    const s = await serve((req, res) => {
      const index = Number((req.url ?? '/n/0').split('/').pop());
      res.writeHead(302, { location: `/n/${index + 1}` });
      res.end();
    });
    await expect(realPorts().http.getBytes(`${s.url}/n/0`, { timeoutMs: 5_000 }))
      .rejects.toThrow(/too many redirects/);
    expect(s.requests.length).toBe(MAX_HTTP_REDIRECTS + 1);
  });
});
