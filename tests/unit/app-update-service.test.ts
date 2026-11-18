/**
 * AppUpdateService (0.2.1, D-93) — state machine, verification refusal, and the
 * three suppression reasons, all without a network or a real installer.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Logger } from '@ytvdlt/core';
import type { IConfigStore } from '@ytvdlt/core';
import type { CorePorts, HashPort, HttpPort } from '@ytvdlt/shared';
import {
  AUTO_CHECK_INTERVAL_MS, APP_UPDATE_CONFIG, createAppUpdateService, installBaseline,
  type AppUpdateServiceDeps,
} from '../../apps/desktop/src/main/app-update-service.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const REPO = { owner: 'yechenliao0820', repo: 'YTVDLT' };

function releaseJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tag_name: 'v0.2.1',
    name: 'YTVDLT 0.2.1',
    body: '## 更新\n\n- 支持检查更新',
    html_url: 'https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.1',
    published_at: '2026-11-08T10:00:00Z',
    draft: false,
    prerelease: false,
    assets: [{
      name: 'YTVDLT-Setup-0.2.1.exe',
      browser_download_url: 'https://github.com/yechenliao0820/YTVDLT/releases/download/v0.2.1/YTVDLT-Setup-0.2.1.exe',
      size: 1_024,
    }],
    ...over,
  });
}

interface Harness {
  service: ReturnType<typeof createAppUpdateService>;
  config: IConfigStore;
  values: Map<string, unknown>;
  opened: string[];
  quitCount: () => number;
}

function harness(options: {
  response?: () => Promise<string>;
  /** `GET /releases` — the history lookup (D-140). Defaults to `response`. */
  listResponse?: () => Promise<string>;
  currentVersion?: string;
  config?: Record<string, unknown>;
  /** D-143 downloader seam, so tests can run a full offline download. */
  downloadInstaller?: AppUpdateServiceDeps['downloadInstaller'];
  /** Real directory for tests that actually write an installer to disk. */
  updatesDir?: string;
  /** Real streaming hash for tests whose `install()` re-verifies real bytes. */
  hash?: HashPort;
} = {}): Harness {
  const base = createInMemoryPorts();
  const single = options.response ?? (async () => releaseJson());
  const list = options.listResponse ?? single;
  const http: HttpPort = {
    getText: async (url: string) => (url.includes('/releases?') ? list() : single()),
    getBytes: async () => new Uint8Array(),
  };
  const ports: CorePorts = {
    ...base.ports,
    http,
    ...(options.hash === undefined ? {} : { hash: options.hash }),
  };
  const logger = new Logger({ ports, appVersion: '0.1.10' });

  const values = new Map<string, unknown>(Object.entries(options.config ?? {}));
  const config = {
    get: (domain: string, key: string) => values.get(`${domain}.${key}`),
    setDomain: async (domain: string, patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) values.set(`${domain}.${key}`, value);
    },
  } as unknown as IConfigStore;

  const opened: string[] = [];
  let quits = 0;
  const deps: AppUpdateServiceDeps = {
    ports,
    logger,
    config,
    currentVersion: options.currentVersion ?? '0.1.10',
    source: REPO,
    updatesDir: options.updatesDir ?? 'C:/tmp/ytvdlt-updates',
    openExternal: async (url: string) => { opened.push(url); },
    openPath: async (path: string) => { opened.push(path); return ''; },
    quit: () => { quits += 1; },
    ...(options.downloadInstaller === undefined
      ? {}
      : { downloadInstaller: options.downloadInstaller }),
  };
  return { service: createAppUpdateService(deps), config, values, opened, quitCount: () => quits };
}

describe('app update service · check', () => {
  it('reports a newer release and keeps the notes', async () => {
    const h = harness();
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('available');
    expect(state.latest?.version).toBe('0.2.1');
    expect(state.canAutoInstall).toBe(true);
    expect(state.latest?.notes).toContain('支持检查更新');
    expect(h.values.get('advanced.lastAppUpdateCheckAt')).toBeTypeOf('string');
  });

  it('stays idle when the published version is the running one', async () => {
    const h = harness({ currentVersion: '0.2.1' });
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('idle');
    expect(state.latest).toBeNull();
    expect(state.message).toContain('0.2.1');
  });

  it('turns a network failure into phase=error instead of throwing', async () => {
    const h = harness({ response: async () => { throw new Error('HTTP 403'); } });
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('error');
    expect(state.message).toContain('403');
  });

  it('does not run an automatic check more often than the throttle window', async () => {
    const now = new Date().toISOString();
    const recent = harness({
      config: { 'advanced.lastAppUpdateCheckAt': now },
    });
    expect(recent.service.shouldAutoCheck()).toBe(false);

    const stale = new Date(Date.now() - AUTO_CHECK_INTERVAL_MS - 1000).toISOString();
    const old = harness({ config: { 'advanced.lastAppUpdateCheckAt': stale } });
    expect(old.service.shouldAutoCheck()).toBe(true);
  });

  it('honours the "check on startup" switch', () => {
    const h = harness({ config: { 'advanced.autoCheckAppUpdate': false } });
    expect(h.service.shouldAutoCheck()).toBe(false);
  });
});

describe('app update service · version jump history', () => {
  const payload = (version: string, body: string): Record<string, unknown> => ({
    tag_name: `v${version}`,
    name: `YTVDLT ${version}`,
    body,
    html_url: `https://github.com/yechenliao0820/YTVDLT/releases/tag/v${version}`,
    published_at: '2026-11-10T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [],
  });

  const history = (): Promise<string> => Promise.resolve(JSON.stringify([
    payload('0.3.0', '## YTVDLT 0.3.0\n\nBig release'),
    payload('0.2.9', '## Fixed\n\n- right-click menu'),
    payload('0.2.8', '## YTVDLT 0.2.8\n\n- before your build'),
  ]));

  it('lists every skipped version when the user jumps several releases', async () => {
    const h = harness({
      currentVersion: '0.2.8',
      response: async () => releaseJson({
        tag_name: 'v0.3.0', name: 'YTVDLT 0.3.0', body: '## YTVDLT 0.3.0\n\nBig release',
      }),
      listResponse: history,
    });
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('available');
    expect(state.releaseNotes.map((note) => note.version)).toEqual(['0.2.9', '0.3.0']);
    expect(state.releaseNotes[0]?.notes).toContain('right-click menu');
    expect(state.omittedReleaseNotes).toBe(0);
  });

  it('falls back to the newest body when the history lookup fails', async () => {
    const h = harness({
      currentVersion: '0.1.0',
      listResponse: async () => { throw new Error('HTTP 403'); },
    });
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('available');
    expect(state.releaseNotes.map((note) => note.version)).toEqual(['0.2.1']);
    expect(state.releaseNotes[0]?.notes).toContain('支持检查更新');
  });

  it('falls back when the list payload is not a release array', async () => {
    const h = harness({
      currentVersion: '0.2.8',
      response: async () => releaseJson({
        tag_name: 'v0.3.0', name: 'YTVDLT 0.3.0', body: 'Big release',
      }),
      listResponse: async () => releaseJson(),
    });
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('available');
    expect(state.releaseNotes.map((note) => note.version)).toEqual(['0.3.0']);
  });

  it('clears the history again once the app is up to date', async () => {
    const h = harness({ currentVersion: '0.2.1' });
    const state = await h.service.check({ manual: true });
    expect(state.phase).toBe('idle');
    expect(state.releaseNotes).toEqual([]);
  });
});

describe('app update service · install gate', () => {
  it('refuses to install before anything was downloaded', async () => {
    const h = harness();
    await h.service.check({ manual: true });
    const result = await h.service.install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('尚未就绪');
    expect(h.quitCount()).toBe(0);
  });

  it('refuses to download when the release ships no installer', async () => {
    const h = harness({ response: async () => releaseJson({ assets: [] }) });
    const checked = await h.service.check({ manual: true });
    expect(checked.canAutoInstall).toBe(false);
    const downloaded = await h.service.download();
    expect(downloaded.phase).toBe('error');
    expect(downloaded.message).toContain('安装包');
  });

  it('refuses an installer hosted off GitHub', async () => {
    const h = harness({
      response: async () => releaseJson({
        assets: [{
          name: 'YTVDLT-Setup-0.2.1.exe',
          browser_download_url: 'https://evil.example.org/setup.exe',
          size: 1024,
        }],
      }),
    });
    await h.service.check({ manual: true });
    const state = await h.service.download();
    expect(state.phase).toBe('error');
    expect(state.message).toContain('GitHub');
  });
});

describe('app update service · install gate (published digest required)', () => {
  const INSTALLER = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, ...Array.from({ length: 60 }, () => 7)]);
  const GOOD_HASH = createHash('sha256').update(INSTALLER).digest('hex');
  const ASSET_NAME = 'YTVDLT-Setup-0.2.1.exe';

  /**
   * Full offline download against a release whose asset carries no usable
   * `digest` (`undefined` = field absent; anything else = malformed, e.g. a
   * short hash, which `digestOf` also maps to `null`). The fake downloader
   * reports the bytes' own SHA-256 — exactly what the real transport computes;
   * with no published digest that self-computed value must NOT become a trust
   * baseline.
   */
  const digestGateHarness = (digest: string | undefined) => {
    const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-digest-gate-'));
    const h = harness({
      response: async () => releaseJson({
        assets: [{
          name: ASSET_NAME,
          browser_download_url: `https://github.com/yechenliao0820/YTVDLT/releases/download/v0.2.1/${ASSET_NAME}`,
          size: INSTALLER.length,
          ...(digest === undefined ? {} : { digest }),
        }],
      }),
      updatesDir: dir,
      downloadInstaller: async (request) => {
        writeFileSync(request.targetPath, INSTALLER);
        return { path: request.targetPath, bytes: INSTALLER.length, sha256: GOOD_HASH };
      },
    });
    return { ...h, dir };
  };

  const expectDigestGate = async (digest: string | undefined): Promise<void> => {
    const h = digestGateHarness(digest);
    await h.service.check({ manual: true });
    const state = await h.service.download();
    expect(state.phase).toBe('error');
    expect(state.message).toContain('缺少 SHA-256 摘要');
    // Isolated, not deleted: the rejected copy survives for support inspection.
    // D-233: the rejected file is the STAGED download (`<asset>.<uuid>.download`),
    // never the canonical entry, so the name carries the tag in the middle
    // rather than as a prefix.
    const names = readdirSync(h.dir);
    expect(names.filter((name) => name.includes('.rejected-'))).toHaveLength(1);
    expect(names.includes(ASSET_NAME)).toBe(false);
    // The self-computed hash is never persisted as a baseline (no sidecar), so
    // nothing becomes installable afterwards.
    expect(existsSync(`${h.dir}/${ASSET_NAME}.sha256`)).toBe(false);
    const attempt = await h.service.install();
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('尚未就绪');
  };

  it('refuses auto-install when the release publishes no digest field', async () => {
    await expectDigestGate(undefined);
  });

  it('refuses auto-install when the published digest is malformed (short hash)', async () => {
    await expectDigestGate(`sha256:${'a'.repeat(8)}`);
  });
});

/**
 * D-219 (tightened) · the install baseline chain.
 *
 * `install()` used to end its baseline chain with `?? readSidecar(executable)`.
 * Today that leg is unreachable (both ready paths record `verifiedSha256` in
 * the same synchronous block that sets `installerPath`), but any FUTURE ready
 * path that forgets to do so would have silently resurrected the locally
 * written `.sha256` file — a hash this app computed itself — as the trust
 * root, contradicting D-219. The leg is gone: the baseline resolves through
 * `installBaseline(verifiedSha256, asset)` — verified bytes, then the
 * PUBLISHED digest, then nothing. These tests pin both sides: no trusted
 * baseline ⇒ fail closed (isolate + phase=error), a verified baseline ⇒ the
 * normal install still runs.
 */
describe('app update service · install baseline (D-219: the sidecar is never a trust root)', () => {
  const INSTALLER = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, ...Array.from({ length: 60 }, () => 7)]);
  const GOOD_HASH = createHash('sha256').update(INSTALLER).digest('hex');
  const ASSET_NAME = 'YTVDLT-Setup-0.2.1.exe';
  const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

  // `install()` re-verifies the REAL bytes on disk, so the in-memory hash port
  // is replaced with a streaming one over the real temp file.
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

  /** Offline fresh-download run that reaches `ready` (published digest required). */
  const downloadReady = (digest: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-baseline-'));
    const h = harness({
      response: async () => releaseJson({
        assets: [{
          name: ASSET_NAME,
          browser_download_url: `https://github.com/yechenliao0820/YTVDLT/releases/download/v0.2.1/${ASSET_NAME}`,
          size: INSTALLER.length,
          ...(digest === null ? {} : { digest: `sha256:${digest}` }),
        }],
      }),
      updatesDir: dir,
      hash: REAL_HASH,
      downloadInstaller: async (request) => {
        writeFileSync(request.targetPath, INSTALLER);
        return { path: request.targetPath, bytes: INSTALLER.length, sha256: GOOD_HASH };
      },
    });
    return { ...h, dir, target: join(dir, ASSET_NAME) };
  };

  it('resolves NO baseline from a matching sidecar when verifiedSha256 is gone and no digest is published', () => {
    // The exact trap the removed `?? readSidecar(executable)` leg would take:
    // a real installer on disk whose `.sha256` sidecar agrees with its bytes
    // byte-for-byte. `installBaseline` accepts no path and no sidecar, so this
    // state resolves to null (fail closed) — and any future change that lets
    // the sidecar back into the baseline must change this signature, breaking
    // this test on sight.
    const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-baseline-trap-'));
    writeFileSync(join(dir, ASSET_NAME), INSTALLER);
    writeFileSync(`${join(dir, ASSET_NAME)}.sha256`, `${GOOD_HASH}\n`, 'utf8');

    const noDigest = {
      name: ASSET_NAME,
      url: `https://github.com/yechenliao0820/YTVDLT/releases/download/v0.2.1/${ASSET_NAME}`,
      sizeBytes: INSTALLER.length,
      sha256: null,
    };
    expect(installBaseline(null, noDigest)).toBeNull();
    // The two legitimate roots stay intact: a hash verified on the current
    // bytes wins (D-104), and the published digest covers a ready path that
    // forgot to record `verifiedSha256`.
    expect(installBaseline(GOOD_HASH, noDigest)).toBe(GOOD_HASH);
    expect(installBaseline(null, { ...noDigest, sha256: GOOD_HASH })).toBe(GOOD_HASH);
  });

  it('rejects install when the bytes only match the locally rewritten sidecar, not the trusted baseline', async () => {
    const h = downloadReady(GOOD_HASH);
    await h.service.check({ manual: true });
    expect((await h.service.download()).phase).toBe('ready');

    // The strongest local forgery available: swap the bytes in place AND
    // rewrite the sidecar so file and sidecar agree on disk. The sidecar
    // matches the actual bytes perfectly — and must still not authorize
    // anything, because the trusted baseline (verifiedSha256 / published
    // digest) no longer matches.
    const swapped = Uint8Array.from(INSTALLER);
    swapped[swapped.length - 1] = 9; // same size, still `MZ`
    writeFileSync(h.target, swapped);
    writeFileSync(`${h.target}.sha256`, `${sha256Of(swapped)}\n`, 'utf8');

    const attempt = await h.service.install();
    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('完整性校验失败');
    expect(attempt.message).toContain('缺少可信基准');
    expect(attempt.state.phase).toBe('error');
    // Nothing reached the OS, and the rejected file is isolated, not deleted.
    expect(h.opened).toEqual([]);
    expect(readdirSync(h.dir).filter((name) => name.includes('install-rejected'))).toHaveLength(1);
    expect(existsSync(h.target)).toBe(false);
  });

  it('still installs normally when the verified hash matches, sidecar present or not', async () => {
    const h = downloadReady(GOOD_HASH);
    await h.service.check({ manual: true });
    expect((await h.service.download()).phase).toBe('ready');
    // The diagnostics sidecar from the verified download sits next to the
    // installer — its presence must neither block nor redirect the decision.
    expect(existsSync(`${h.target}.sha256`)).toBe(true);
    const attempt = await h.service.install();
    expect(attempt.ok).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toContain(ASSET_NAME);
  });

  it('keeps readSidecar out of install(): the baseline chain is wired to installBaseline only', async () => {
    // Wiring pin (source gate, same style as subtitle-picker.test.ts): the
    // removed `?? readSidecar(executable)` leg must not be re-inlined into
    // install() next to the helper call — that would bypass installBaseline's
    // sidecar-free signature and revive the D-219 contradiction.
    const source = await readFile(
      new URL('../../apps/desktop/src/main/app-update-service.ts', import.meta.url), 'utf8',
    );
    const installBody = source.slice(
      source.indexOf('async function install('),
      source.indexOf('async function openPage('),
    );
    expect(installBody.length).toBeGreaterThan(200);
    expect(installBody).toContain('installBaseline(verifiedSha256, asset)');
    expect(installBody).not.toContain('readSidecar');
  });
});

describe('app update service · suppression', () => {
  it('remembers a skipped version', async () => {
    const h = harness();
    await h.service.check({ manual: true });
    const state = await h.service.skipCurrentVersion();
    expect(state.skippedVersion).toBe('0.2.1');
    expect(h.values.get(`advanced.${APP_UPDATE_CONFIG.skippedKey}`)).toBe('0.2.1');
  });

  it('keeps the dialog state available after dismiss (renderer owns the session flag)', async () => {
    const h = harness();
    await h.service.check({ manual: true });
    expect(h.service.dismiss().phase).toBe('available');
  });

  it('opens the release page only for github.com URLs', async () => {
    const h = harness();
    await h.service.check({ manual: true });
    const ok = await h.service.openPage();
    expect(ok.ok).toBe(true);
    expect(h.opened[0]).toContain('github.com');
  });

  it('rejects open-page when no release is known', async () => {
    const h = harness();
    const result = await h.service.openPage();
    expect(result.ok).toBe(false);
  });
});
