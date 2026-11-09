/**
 * D-104 · cached-installer integrity (the audit finding).
 *
 * A cache file that merely has the right size and an `MZ` header used to be
 * marked `ready` without recomputing its hash. These tests pin the new rules:
 * reuse requires a SHA-256 match against the published digest (or the local
 * sidecar), a mismatch isolates the file and re-downloads, and `install()`
 * re-verifies the bytes actually about to be launched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, createReadStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Logger, type IConfigStore } from '@ytvdlt/core';
import type { CorePorts, HttpPort, HashPort } from '@ytvdlt/shared';
import { createAppUpdateService } from '../../apps/desktop/src/main/app-update-service.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const INSTALLER = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, ...Array.from({ length: 60 }, () => 7)]);
const GOOD_HASH = createHash('sha256').update(INSTALLER).digest('hex');
const ASSET_NAME = 'YTVDLT-Setup-0.2.1.exe';
const REAL_HASH: HashPort = {
  async sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  },
  async sha256Bytes(data: Uint8Array): Promise<string> {
    return createHash('sha256').update(data).digest('hex');
  },
};

const originalFetch = globalThis.fetch;

function releaseJson(digest: string | null): string {
  return JSON.stringify({
    tag_name: 'v0.2.1',
    name: 'YTVDLT 0.2.1',
    body: 'release notes',
    html_url: 'https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.1',
    published_at: '2026-11-08T10:00:00Z',
    draft: false,
    prerelease: false,
    assets: [{
      name: ASSET_NAME,
      browser_download_url: 'https://github.com/yechenliao0820/YTVDLT/releases/download/v0.2.1/YTVDLT-Setup-0.2.1.exe',
      size: INSTALLER.length,
      ...(digest === null ? {} : { digest: `sha256:${digest}` }),
    }],
  });
}

interface Setup {
  readonly service: ReturnType<typeof createAppUpdateService>;
  readonly dir: string;
  readonly target: string;
  readonly opened: string[];
  readonly fetchCalls: () => number;
  writeCache(bytes: Uint8Array): void;
  writeSidecar(hex: string): void;
  isolated(prefix: string): string[];
}

function setup(digest: string | null = GOOD_HASH): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-updater-'));
  const base = createInMemoryPorts();
  const http: HttpPort = {
    getText: async () => releaseJson(digest),
    getBytes: async () => new Uint8Array(),
  };
  const ports: CorePorts = { ...base.ports, http, hash: REAL_HASH };
  const logger = new Logger({ ports, appVersion: '0.1.10' });
  const values = new Map<string, unknown>();
  const config = {
    get: (domain: string, key: string) => values.get(`${domain}.${key}`),
    setDomain: async (domain: string, patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) values.set(`${domain}.${key}`, value);
    },
  } as unknown as IConfigStore;

  let downloads = 0;
  globalThis.fetch = (async () => {
    downloads += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(INSTALLER); controller.close(); },
    });
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      body: stream,
    };
  }) as unknown as typeof fetch;

  const opened: string[] = [];
  const service = createAppUpdateService({
    ports,
    logger,
    config,
    currentVersion: '0.1.10',
    source: { owner: 'yechenliao0820', repo: 'YTVDLT' },
    updatesDir: dir,
    openExternal: async () => undefined,
    openPath: async (path: string) => { opened.push(path); return ''; },
    quit: () => undefined,
  });

  return {
    service, dir, opened,
    target: join(dir, ASSET_NAME),
    fetchCalls: () => downloads,
    writeCache: (bytes: Uint8Array) => writeFileSync(join(dir, ASSET_NAME), bytes),
    writeSidecar: (hex: string) => writeFileSync(`${join(dir, ASSET_NAME)}.sha256`, `${hex}\n`, 'utf8'),
    isolated: (prefix: string) => readdirSync(dir).filter((name) => name.includes(prefix)),
  };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe('D-104 · cached installer SHA-256 verification', () => {
  it('reuses a cache file only after recomputing its hash (zero network)', async () => {
    const h = setup(GOOD_HASH);
    h.writeCache(INSTALLER);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(ready.message).toContain('复用');
    expect(h.fetchCalls()).toBe(0);
  });

  it('isolates a mismatched cache file and downloads a fresh copy', async () => {
    const h = setup(GOOD_HASH); // published digest describes the REAL installer
    const damaged = Uint8Array.from(INSTALLER);
    damaged[damaged.length - 1] = 9; // same size, still MZ — the audit's case
    h.writeCache(damaged);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(h.fetchCalls()).toBe(1);
    expect(h.isolated('checksum-mismatch')).toHaveLength(1);
    expect(existsSync(h.target)).toBe(true);
    expect(readFileSync(`${h.target}.sha256`, 'utf8').trim()).toBe(GOOD_HASH);
  });

  it('falls back to the sidecar when GitHub supplies no digest', async () => {
    const h = setup(null);
    h.writeCache(INSTALLER);
    h.writeSidecar(GOOD_HASH);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(ready.message).toContain('复用');
    expect(h.fetchCalls()).toBe(0);
  });

  it('refuses to reuse a legacy cache with no digest and no sidecar (fail-closed)', async () => {
    const h = setup(null);
    h.writeCache(INSTALLER);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready'); // ...but only after a fresh download
    expect(h.fetchCalls()).toBe(1);
    expect(readFileSync(`${h.target}.sha256`, 'utf8').trim()).toBe(GOOD_HASH);
  });

  it('writes a sidecar after a fresh download so a later launch can reuse it', async () => {
    const h = setup(null);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(existsSync(`${h.target}.sha256`)).toBe(true);
  });
});

describe('D-104 · install-time integrity re-check', () => {
  it('refuses to launch an installer swapped after it became ready', async () => {
    const h = setup(GOOD_HASH);
    h.writeCache(INSTALLER);
    await h.service.check({ manual: true });
    expect((await h.service.download()).phase).toBe('ready');

    // Same size, still `MZ` — exactly the substitution the audit described.
    const swapped = Uint8Array.from(INSTALLER);
    swapped[swapped.length - 1] = 9;
    h.writeCache(swapped);

    const result = await h.service.install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('完整性校验失败');
    expect(h.opened).toEqual([]);
    expect(h.isolated('install-rejected')).toHaveLength(1);
    expect(result.state.phase).toBe('error');
  });

  it('still installs when nothing changed between ready and install', async () => {
    const h = setup(GOOD_HASH);
    h.writeCache(INSTALLER);
    await h.service.check({ manual: true });
    await h.service.download();
    const result = await h.service.install();
    expect(result.ok).toBe(true);
    expect(h.opened).toHaveLength(1);
    // The service builds paths with `/`; Windows accepts both separators.
    expect(h.opened[0]).toContain(ASSET_NAME);
  });
});
