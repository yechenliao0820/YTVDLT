/**
 * D-104 · cached-installer integrity (the audit finding).
 *
 * A cache file that merely has the right size and an `MZ` header used to be
 * marked `ready` without recomputing its hash. These tests pin the rules:
 * reuse requires recomputing the SHA-256 and matching the CURRENT release's
 * published digest — a mismatch isolates the file and re-downloads. The local
 * `.sha256` sidecar (a self-computed hash) is diagnostics only and NEVER
 * authorizes reuse on its own, and `install()` re-verifies the bytes actually
 * about to be launched. A release that publishes no digest cannot install at
 * all: the cache is refused and the fresh download fails the install gate.
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
import type { DownloadRequest, DownloadResult } from '../../apps/desktop/src/main/adapters/http-download.js';
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
  readonly downloadCalls: () => number;
  /** The `DownloadRequest`s the service handed to the injected downloader. */
  readonly downloadRequests: () => DownloadRequest[];
  writeCache(bytes: Uint8Array): void;
  writeSidecar(hex: string): void;
  isolated(prefix: string): string[];
}

function setup(
  digest: string | null = GOOD_HASH,
  /** D-233: override what the "network" delivers (default: the real installer). */
  respond?: (request: DownloadRequest) => Promise<DownloadResult>,
  /** D-243: override the publish hop (the rename onto the release name). */
  overrides: { renameFile?: (from: string, to: string) => Promise<void> } = {},
): Setup {
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

  // D-143: the transport behind `downloadToFile` moved from global `fetch` to
  // `node:http`/`node:https`, so the old `globalThis.fetch` stub cannot
  // intercept anything any more. The service now takes the downloader as an
  // injected dependency (like `openExternal`); the fake below mimics the real
  // contract: write the bytes, report size + SHA-256.
  const requests: DownloadRequest[] = [];
  let downloads = 0;
  const downloadInstaller = async (request: DownloadRequest): Promise<DownloadResult> => {
    downloads += 1;
    requests.push(request);
    if (respond !== undefined) return respond(request);
    writeFileSync(request.targetPath, INSTALLER);
    return { path: request.targetPath, bytes: INSTALLER.length, sha256: GOOD_HASH };
  };

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
    downloadInstaller,
    ...(overrides.renameFile === undefined ? {} : { renameFile: overrides.renameFile }),
  });

  return {
    service, dir, opened,
    target: join(dir, ASSET_NAME),
    downloadCalls: () => downloads,
    downloadRequests: () => requests,
    writeCache: (bytes: Uint8Array) => writeFileSync(join(dir, ASSET_NAME), bytes),
    writeSidecar: (hex: string) => writeFileSync(`${join(dir, ASSET_NAME)}.sha256`, `${hex}\n`, 'utf8'),
    isolated: (prefix: string) => readdirSync(dir).filter((name) => name.includes(prefix)),
  };
}

describe('update download cancellation', () => {
  it('cancels during cache inspection and allows a new download', async () => {
    const h = setup();
    await h.service.check({ manual: true });
    const downloading = h.service.perform('download');
    const cancellation = await h.service.perform('cancel-download');
    expect(cancellation.ok).toBe(true);
    expect(cancellation.state.phase).toBe('available');
    expect((await downloading).state.phase).toBe('available');
    expect(h.downloadCalls()).toBe(0);
    expect((await h.service.perform('download')).state.phase).toBe('ready');
  });
});

describe('D-104 · cached installer SHA-256 verification', () => {
  it('reuses a cache file only after recomputing its hash (zero network)', async () => {
    const h = setup(GOOD_HASH);
    h.writeCache(INSTALLER);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(ready.message).toContain('复用');
    expect(h.downloadCalls()).toBe(0);
  });

  it('isolates a mismatched cache file and downloads a fresh copy', async () => {
    const h = setup(GOOD_HASH); // published digest describes the REAL installer
    const damaged = Uint8Array.from(INSTALLER);
    damaged[damaged.length - 1] = 9; // same size, still MZ — the audit's case
    h.writeCache(damaged);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(h.downloadCalls()).toBe(1);
    expect(h.isolated('checksum-mismatch')).toHaveLength(1);
    expect(existsSync(h.target)).toBe(true);
    expect(readFileSync(`${h.target}.sha256`, 'utf8').trim()).toBe(GOOD_HASH);
  });

  it('no longer reuses a cache on sidecar alone when GitHub supplies no digest', async () => {
    const h = setup(null);
    h.writeCache(INSTALLER);
    h.writeSidecar(GOOD_HASH);
    await h.service.check({ manual: true });
    const state = await h.service.download();
    // Tightened D-104: the sidecar stores a hash this app computed itself —
    // not a trust root — so it alone must never authorize reuse.
    expect(state.message).not.toContain('复用');
    expect(h.downloadCalls()).toBe(1);
    // The fresh download then hits the install gate: no digest, no install.
    expect(state.phase).toBe('error');
    expect(state.message).toContain('缺少 SHA-256 摘要');
    expect(h.isolated('rejected')).toHaveLength(1);
  });

  it('refuses to reuse a legacy cache with no digest and no sidecar (fail-closed)', async () => {
    const h = setup(null);
    h.writeCache(INSTALLER);
    await h.service.check({ manual: true });
    const state = await h.service.download();
    // No reuse: the installer is downloaded again, and the fresh download
    // fails the digest gate (the old semantics made this download succeed).
    expect(h.downloadCalls()).toBe(1);
    expect(state.phase).toBe('error');
    expect(state.message).toContain('缺少 SHA-256 摘要');
    // The self-computed hash is never persisted as a trust baseline.
    expect(existsSync(`${h.target}.sha256`)).toBe(false);
  });

  it('still writes a sidecar after a fresh download (diagnostics only; reuse requires the digest)', async () => {
    const h = setup(GOOD_HASH);
    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    expect(existsSync(`${h.target}.sha256`)).toBe(true);
    expect(readFileSync(`${h.target}.sha256`, 'utf8').trim()).toBe(GOOD_HASH);
    // D-137 / D-143 wiring: every download request carries the GitHub allowlist
    // AND the resolved-address guard, whichever downloader ends up running it.
    expect(h.downloadRequests()).toHaveLength(1);
    expect(h.downloadRequests()[0]?.hostPolicy).toBeTypeOf('function');
    expect(h.downloadRequests()[0]?.allowResolvedAddress).toBeTypeOf('function');
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
    expect(JSON.parse(readFileSync(join(h.dir, 'pending-update-cleanup.json'), 'utf8'))).toEqual({
      fromVersion: '0.1.10', targetVersion: '0.2.1', fileName: ASSET_NAME, sha256: GOOD_HASH,
    });
  });
});

/**
 * D-233 (audit P3) · 先校验独立临时文件，再以不覆盖的方式发布。
 *
 * The old order renamed the `.part` straight onto `<asset name>` and verified
 * afterwards. A same-name file that had merely failed the cache check — a
 * different size or a broken PE header, neither of which isolates the cache —
 * was therefore destroyed BEFORE anyone knew whether the new download was
 * usable, and a failed verification left nothing to fall back to.
 *
 * Now the download lands at `<asset name>.<uuid>.download`, is verified THERE,
 * and only a verified file is published: an existing entry is moved aside
 * (`.replaced-<ts>`, never deleted), and if it cannot be moved the publish is
 * abandoned so the old file keeps its name.
 */
describe('D-233 · publish only verified bytes, never overwrite the old copy', () => {
  const damaged = (): Uint8Array => {
    const bytes = Uint8Array.from(INSTALLER);
    bytes[bytes.length - 1] = 9; // same size, still `MZ`: the "rejected" case
    return bytes;
  };
  const legacy = (): Uint8Array => {
    // Different size on purpose: the cache check rejects it WITHOUT isolating it.
    const bytes = new Uint8Array(INSTALLER.length + 5).fill(3);
    bytes[0] = 0x4d;
    bytes[1] = 0x5a;
    return bytes;
  };

  it('keeps the existing same-name file when the fresh download fails verification', async () => {
    const bad = damaged();
    const badHash = createHash('sha256').update(bad).digest('hex');
    const h = setup(GOOD_HASH, async (request) => {
      writeFileSync(request.targetPath, bad);
      return { path: request.targetPath, bytes: bad.length, sha256: badHash };
    });
    const previous = legacy();
    h.writeCache(previous);

    await h.service.check({ manual: true });
    const state = await h.service.download();
    expect(state.phase).toBe('error');
    expect(state.message).toContain('SHA-256 不匹配');
    // The whole point: the file that was already there is untouched...
    expect(readFileSync(h.target).equals(Buffer.from(previous))).toBe(true);
    // ...and the rejected bytes are quarantined under their staging name.
    // (The old code had already replaced `target` with them by this point.)
    expect(h.isolated('.rejected-')).toHaveLength(1);
  });

  it('moves the existing same-name file aside (never deletes it) before publishing', async () => {
    const h = setup();
    const previous = legacy();
    h.writeCache(previous);

    await h.service.check({ manual: true });
    const ready = await h.service.download();
    expect(ready.phase).toBe('ready');
    // The canonical name now holds the verified bytes, with a matching sidecar.
    expect(readFileSync(h.target).equals(Buffer.from(INSTALLER))).toBe(true);
    expect(readFileSync(`${h.target}.sha256`, 'utf8').trim()).toBe(GOOD_HASH);
    // The previous file survives under `.replaced-`, byte for byte.
    const replaced = h.isolated('.replaced-');
    expect(replaced).toHaveLength(1);
    expect(readFileSync(join(h.dir, replaced[0] as string)).equals(Buffer.from(previous))).toBe(true);
    // And install launches that published path (the service builds paths with
    // `/`; Windows accepts both separators).
    const attempt = await h.service.install();
    expect(attempt.ok).toBe(true);
    expect(h.opened[0]).toContain(ASSET_NAME);
    expect(h.opened[0]).not.toContain('.download');
    expect(h.opened[0]).not.toContain('.replaced-');
  });
});

/**
 * D-243 (audit P2) · a failed publish is not an installable installer.
 *
 * D-233 deliberately kept the verified bytes when the rename onto the release
 * name failed, and handed the STAGING path back as "the installer". That was
 * wrong one layer up: the staging name is `<asset>.<uuid>.download`, so
 * `download()` marked it `ready` and `install()` passed a `.download` file to
 * `shell.openPath()`. Windows resolves that by FILE ASSOCIATION — either
 * nothing happens (the old code reported a launch error) or some other program
 * opens while the app says "installer started" and quits. A verified file that
 * cannot be published is a FAILED UPDATE, and must say so.
 */
describe('D-243 · publish 失败 ⇒ 不可安装（不把 .download 交给系统）', () => {
  it('rename 发布失败时状态为 error、install 被拒、没有任何路径被打开', async () => {
    const h = setup(GOOD_HASH, undefined, {
      renameFile: async () => { throw new Error('EPERM: operation not permitted'); },
    });
    // A same-name copy is already there, so the isolate/restore path runs too.
    const previous = Uint8Array.from([0x4d, 0x5a, 1, 2, 3, 4, 5, 6]);
    h.writeCache(previous);

    await h.service.check({ manual: true });
    const state = await h.service.download();

    expect(state.phase).toBe('error');
    expect(state.message).toContain('无法发布');
    expect(state.message).toContain('.download');
    // The verified bytes survive under their staging name (never deleted)...
    const staged = readdirSync(h.dir).filter((name) => name.endsWith('.download'));
    expect(staged).toHaveLength(1);
    expect(readFileSync(join(h.dir, staged[0] as string)).equals(Buffer.from(INSTALLER))).toBe(true);
    // ...and the previous copy was restored, not lost.
    expect(readFileSync(h.target).equals(Buffer.from(previous))).toBe(true);

    const attempt = await h.service.install();
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('尚未就绪');
    // The decisive assertion: nothing (in particular no `.download`) reached
    // the shell, so no unrelated program can be launched on its behalf.
    expect(h.opened).toHaveLength(0);
  });
});
