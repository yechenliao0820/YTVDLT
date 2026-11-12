/**
 * D-137 (F-08) — a per-URL verdict is only valid for the network context that
 * produced it. Pure L0 key arithmetic plus a real SiteSupportService with a
 * stub engine. No network, no Electron, no bundled binary.
 */
import { describe, it, expect } from 'vitest';
import { networkContextSignature, supportCacheKey } from '@ytvdlt/shared';
import { SiteSupportService } from '../../apps/desktop/src/main/site-support-service.js';

const URL_UNDER_TEST = 'https://a.test/watch?v=1';
const ENGINE_PATH = 'C:/rt/yt-dlp.exe';
const VERSION = '2026.10.26';

function clock() {
  return { nowEpochMs: () => 1_000, nowIso: () => '2026-11-12T00:00:00.000Z' };
}

describe('D-137 · network-context signature', () => {
  it('is stable, change-sensitive, and never contains a credential', () => {
    const secret = {
      proxy: 'http://user:hunter2@proxy.internal:8080',
      cookiesFile: 'C:/Users/leolee/secret/cookies.txt',
      userAgent: 'YTVDLT/0.2.9',
    };
    const signature = networkContextSignature(secret);
    expect(signature).toMatch(/^network:[0-9a-f]{8}$/);
    expect(signature).toBe(networkContextSignature({ ...secret }));
    expect(signature).not.toContain('hunter2');
    expect(signature).not.toContain('cookies.txt');
    expect(signature).not.toContain('leolee');
    expect(signature).not.toBe(networkContextSignature({ ...secret, proxy: 'http://other' }));
    expect(signature).not.toBe(networkContextSignature({ ...secret, cookiesFile: 'D:/c.txt' }));
    expect(signature).not.toBe(networkContextSignature({ ...secret, userAgent: 'other' }));
    expect(networkContextSignature()).toBe(networkContextSignature({}));
  });

  it('keeps the LEGACY key byte-identical when no context is supplied', () => {
    expect(supportCacheKey(URL_UNDER_TEST, ENGINE_PATH, VERSION)).toBe(
      'https://a.test/watch?v=1::c:/rt/yt-dlp.exe::2026.10.26::plugins:default',
    );
  });

  it('separates verdicts produced under different configurations', () => {
    const base = supportCacheKey(URL_UNDER_TEST, ENGINE_PATH, VERSION);
    const first = supportCacheKey(
      URL_UNDER_TEST, ENGINE_PATH, VERSION, undefined, networkContextSignature({ proxy: 'A' }),
    );
    const second = supportCacheKey(
      URL_UNDER_TEST, ENGINE_PATH, VERSION, undefined, networkContextSignature({ proxy: 'B' }),
    );
    expect(first).not.toBe(base);
    expect(first).not.toBe(second);
    expect(first).toBe(supportCacheKey(
      URL_UNDER_TEST, ENGINE_PATH, VERSION, undefined, networkContextSignature({ proxy: 'A' }),
    ));
  });
});

describe('D-137 · SiteSupportService does not serve a stale verdict', () => {
  it('re-asks the engine when proxy / cookies / UA change, but caches within one context', async () => {
    const seen: string[] = [];
    let proxy = 'http://proxy-A';
    const engine = {
      async listExtractors() {
        return {
          ok: true as const,
          catalog: {
            engineVersion: VERSION, enginePath: ENGINE_PATH, extractors: [],
            siteCount: 0, subExtractorCount: 0, brokenCount: 0, empty: false,
            fetchedAt: '2026-11-12T00:00:00.000Z',
          },
          cached: false,
        };
      },
      async checkUrlSupport(url: string, opts: { proxy?: string }) {
        seen.push(opts.proxy ?? '');
        return { url, state: 'SUPPORTED' as const, extractor: 'youtube', reason: '', cached: false };
      },
      async version() { return VERSION; },
    };
    const service = new SiteSupportService({
      engine,
      enginePath: ENGINE_PATH,
      engineVersion: async () => VERSION,
      jsRuntimePath: 'C:/rt/node.exe',
      clock: clock(),
      network: () => ({ proxy }),
    });

    const first = await service.checkUrl(URL_UNDER_TEST);
    expect(first.state).toBe('SUPPORTED');
    expect(seen).toEqual(['http://proxy-A']);

    const cached = await service.checkUrl(URL_UNDER_TEST);
    expect(cached.cached).toBe(true);
    expect(seen).toEqual(['http://proxy-A']);

    proxy = 'http://proxy-B';
    const refreshed = await service.checkUrl(URL_UNDER_TEST);
    expect(refreshed.cached).toBe(false);
    expect(seen).toEqual(['http://proxy-A', 'http://proxy-B']);
  });
});
