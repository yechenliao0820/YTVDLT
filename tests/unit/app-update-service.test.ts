/**
 * AppUpdateService (0.2.1, D-93) — state machine, verification refusal, and the
 * three suppression reasons, all without a network or a real installer.
 */
import { describe, expect, it } from 'vitest';
import { Logger } from '@ytvdlt/core';
import type { IConfigStore } from '@ytvdlt/core';
import type { CorePorts, HttpPort } from '@ytvdlt/shared';
import {
  AUTO_CHECK_INTERVAL_MS, APP_UPDATE_CONFIG, createAppUpdateService,
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
  currentVersion?: string;
  config?: Record<string, unknown>;
} = {}): Harness {
  const base = createInMemoryPorts();
  const http: HttpPort = {
    getText: options.response ?? (async () => releaseJson()),
    getBytes: async () => new Uint8Array(),
  };
  const ports: CorePorts = { ...base.ports, http };
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
    updatesDir: 'C:/tmp/ytvdlt-updates',
    openExternal: async (url: string) => { opened.push(url); },
    openPath: async (path: string) => { opened.push(path); return ''; },
    quit: () => { quits += 1; },
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
