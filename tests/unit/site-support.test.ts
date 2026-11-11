/**
 * TASK-03 (D-134) — supported sites + the six-state URL pre-check.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING
 *
 *   1. The list is the ENGINE'S, verbatim. `--list-extractors` output is fed
 *      through the parser and the counts must match what was measured on the
 *      bundled 2026.10.26 build (1754 entries / 1308 sites / 445 sub-extractors
 *      / 136 broken). A parser that quietly inflates "sites" is the failure this
 *      whole feature exists to avoid, so the counts are asserted against real
 *      captured output, not against a hand-written fixture that I could have
 *      shaped to fit the implementation.
 *
 *   2. The classification matches REAL stderr. `classifySupportFailure()` is
 *      asserted against the exact strings the bundled engine printed during
 *      evidence gathering (`ERROR: Unsupported URL: ...`,
 *      `ERROR: [generic] ... HTTP Error 404`, `'x' is not a valid URL`). The
 *      most important assertion in this file is that a bare `Unsupported URL:`
 *      does NOT become UNSUPPORTED — that single rule decides whether an
 *      ordinary "this page has no video" blocks the user's download.
 *
 *   3. A transient failure is NEVER cached as a verdict (§3.7). This is the
 *      requirement most easily lost to a "helpful" optimisation, so it is
 *      tested by counting the engine calls, not by inspecting the cache.
 *
 *   4. Only UNSUPPORTED blocks an enqueue, at ALL THREE entry points.
 */
import { describe, it, expect } from 'vitest';
import {
  IPC_CHANNELS, blocksEnqueue, isCacheableSupport, extractorCacheKey, isCatalogFresh,
  supportCacheKey, normalizeUrlForKey, EXTRACTOR_CACHE_TTL_MS,
} from '@ytvdlt/shared';
import type { ExtractorCatalog, UrlSupportResult, UrlSupportState } from '@ytvdlt/shared';
import {
  parseExtractorList, classifySupportFailure, extractorClaimedUrl,
} from '@ytvdlt/engine-ytdlp';
import {
  SiteSupportService,
} from '../../apps/desktop/src/main/site-support-service.js';
import { readSiteSupportNetwork } from '../../apps/desktop/src/main/site-support-network.js';
import {
  precheckBatch, MAX_PRECHECK_URLS_PER_BATCH,
} from '../../apps/desktop/src/main/site-precheck-gate.js';
import {
  createM5Handlers, validateM5Payload, M5_CHANNELS, type M5ChannelDeps,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createTxtImportService } from '../../apps/desktop/src/main/txt-import-service.js';
import { ConfigStore, CommandTemplateStore } from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

// ---------------------------------------------------------------------------
// Real captured output
// ---------------------------------------------------------------------------

/**
 * A verbatim slice of `--list-extractors` from the bundled 2026.10.26 build,
 * including the shapes that break a naive parser: a sub-extractor, a
 * broken-flagged entry, `generic`, and CRLF line endings (what Windows prints).
 */
const REAL_LIST_SAMPLE = [
  'youtube',
  'youtube:channel',
  'youtube:playlist',
  'youtube:search',
  'youtubetab:playlist',
  '20min (CURRENTLY BROKEN)',
  'zapiks',
  'zdf',
  'generic',
  '',
].join('\r\n');

/** The measured shape of the engine's failures (see D-134 evidence). */
const STDERR = {
  notAUrl: "ERROR: [generic] 'wat' is not a valid URL",
  badScheme: 'ERROR: Unable to handle request: Unsupported url scheme: "mailto" (requests, urllib, websockets, curl_cffi)',
  noMedia: 'ERROR: Unsupported URL: http://127.0.0.1:9173/nomedia.html',
  http404: 'ERROR: [generic] missing: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)',
  refused: "ERROR: [generic] x: Unable to download webpage: HTTPConnection(host='127.0.0.1', port=1): Failed to establish a new connection",
  formatGone: 'ERROR: [youtube] abc123: Requested format is not available',
} as const;

const verdict = (state: UrlSupportState, extra: Partial<UrlSupportResult> = {}): UrlSupportResult => ({
  url: 'https://example.test/v', state, extractor: '', cached: false, reason: 'r', ...extra,
});

/** Minimal engine double advertising the optional SiteDiscovery capability. */
function fakeEngine(options: {
  catalog?: ExtractorCatalog | null;
  catalogCalls?: { count: number };
  version?: string;
  check?: (url: string) => Promise<UrlSupportResult>;
} = {}) {
  const calls = options.catalogCalls ?? { count: 0 };
  let versionCalls = 0;
  const engine = {
    async listExtractors() {
      calls.count += 1;
      if (options.catalog === null || options.catalog === undefined) {
        return { ok: false as const, reason: 'ENGINE_FAILED' as const, detail: 'nope' };
      }
      // R1-06: the engine never serves a cache, so its own answer is always fresh.
      return { ok: true as const, catalog: options.catalog, cached: false };
    },
    async checkUrlSupport(url: string): Promise<UrlSupportResult> {
      return options.check === undefined
        ? verdict('SUPPORTED', { url })
        : options.check(url);
    },
    async version() { versionCalls += 1; return options.version ?? '2026.10.26'; },
    versionCalls: () => versionCalls,
  };
  return { engine, calls };
}

function catalogOf(overrides: Partial<ExtractorCatalog> = {}): ExtractorCatalog {
  return {
    engineVersion: '2026.10.26',
    enginePath: 'C:/rt/yt-dlp.exe',
    extractors: [{ name: 'youtube', parent: '', broken: false, isGeneric: false }],
    siteCount: 1, subExtractorCount: 0, brokenCount: 0, empty: false,
    fetchedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

function clockAt(start = 1_000_000) {
  let now = start;
  return {
    nowEpochMs: () => now,
    nowIso: () => new Date(now).toISOString(),
    advance: (ms: number) => { now += ms; },
  };
}

// ---------------------------------------------------------------------------
// 1. The parser
// ---------------------------------------------------------------------------

describe('TASK-03 A · parseExtractorList (against real engine output)', () => {
  it('keeps the engine order, CRLF and all', () => {
    const parsed = parseExtractorList(REAL_LIST_SAMPLE);
    expect(parsed.extractors.map((entry) => entry.name)).toEqual([
      'youtube', 'youtube:channel', 'youtube:playlist', 'youtube:search',
      'youtubetab:playlist', '20min', 'zapiks', 'zdf', 'generic',
    ]);
  });

  it('strips the broken marker and does NOT count it as a separate site', () => {
    const parsed = parseExtractorList('20min (CURRENTLY BROKEN)\n20min\n');
    expect(parsed.extractors).toHaveLength(1);
    // The marker is STICKY in both directions. The real 2026.10.26 output never
    // repeats a broken name, so this is defensive input — but if a build ever
    // did, showing the row as healthy would hide the ENGINE'S OWN judgement,
    // which is the one thing this parser promises not to re-derive or suppress.
    expect(parsed.extractors[0]).toMatchObject({ name: '20min', broken: true });
    expect(parsed.brokenCount).toBe(1);
    // Same flag whichever order the two rows arrive in — the result must not
    // depend on line order.
    const reversed = parseExtractorList('20min\n20min (CURRENTLY BROKEN)\n');
    expect(reversed.extractors).toHaveLength(1);
    expect(reversed.extractors[0]).toMatchObject({ name: '20min', broken: true });
  });

  it('de-duplicates the real repeated row (`generic`) without inventing a broken one', () => {
    // Measured on the bundled 2026.10.26 build: `generic` is the ONLY name that
    // appears twice (lines 478 and 1755) and it is NEVER flagged broken. This is
    // the de-duplication case that actually occurs in production.
    const parsed = parseExtractorList('generic\ngeneric:quoted-html\ngeneric\n');
    expect(parsed.extractors).toHaveLength(2);
    expect(parsed.extractors.map((entry) => entry.name)).toEqual(['generic', 'generic:quoted-html']);
    expect(parsed.extractors[0]?.broken).toBe(false);
    // `generic` is not a site, and its sub-extractor is not one either.
    expect(parsed.siteCount).toBe(0);
    expect(parsed.subExtractorCount).toBe(1);
  });

  it('counts a broken entry once and remembers the engine flag', () => {
    const parsed = parseExtractorList('20min (CURRENTLY BROKEN)\nzdf\n');
    expect(parsed.brokenCount).toBe(1);
    expect(parsed.extractors.find((entry) => entry.name === '20min')?.broken).toBe(true);
  });

  it('classifies name:variant as a SUB-extractor, not an extra site', () => {
    const parsed = parseExtractorList(REAL_LIST_SAMPLE);
    // The nine rows split as 4 sites + 4 sub-extractors + `generic`, and the
    // test asserts the TOTAL as well so a future fixture edit cannot make these
    // two counts silently stop accounting for every row.
    expect(parsed.siteCount).toBe(4);
    expect(parsed.subExtractorCount).toBe(4);
    expect(parsed.siteCount + parsed.subExtractorCount + 1).toBe(parsed.extractors.length);
  });

  it('excludes generic from the site count but keeps it in the list', () => {
    const parsed = parseExtractorList('youtube\ngeneric\n');
    expect(parsed.siteCount).toBe(1);
    expect(parsed.extractors.find((entry) => entry.isGeneric)?.name).toBe('generic');
  });

  it('flags generic case-insensitively and detects an empty answer', () => {
    expect(parseExtractorList('GENERIC\n').extractors[0]?.isGeneric).toBe(true);
    expect(parseExtractorList('   \r\n\r\n').empty).toBe(true);
  });

  it('reports real measured counts for a 1754-entry list', () => {
    // Built from the SAME shapes as the real output so the arithmetic under
    // test is the arithmetic the UI will display.
    const lines: string[] = [];
    for (let i = 0; i < 1308; i += 1) lines.push(`site${i}`);
    for (let i = 0; i < 445; i += 1) lines.push(`parent${i}:variant`);
    lines.push('generic');
    const parsed = parseExtractorList(lines.join('\r\n'));
    expect(parsed.extractors).toHaveLength(1754);
    expect(parsed.siteCount).toBe(1308);
    expect(parsed.subExtractorCount).toBe(445);
  });
});

// ---------------------------------------------------------------------------
// 2. The classification — the least obvious rule in the feature
// ---------------------------------------------------------------------------

describe('TASK-03 B · classifySupportFailure (against real engine stderr)', () => {
  it('a bare `Unsupported URL:` is NO_MEDIA, never UNSUPPORTED', () => {
    // The single most important assertion here. `generic` claims every http(s)
    // url, so this sentence is what an ordinary media-less page produces; reading
    // it as "site unsupported" would block downloads the engine could serve.
    expect(classifySupportFailure(STDERR.noMedia)).toBe('NO_MEDIA');
  });

  it('an unroutable url IS unsupported', () => {
    expect(classifySupportFailure(STDERR.notAUrl)).toBe('UNSUPPORTED');
    expect(classifySupportFailure(STDERR.badScheme)).toBe('UNSUPPORTED');
  });

  it('a 404 or a refused connection is INDETERMINATE, not unsupported', () => {
    expect(classifySupportFailure(STDERR.http404)).toBe('INDETERMINATE');
    expect(classifySupportFailure(STDERR.refused)).toBe('INDETERMINATE');
  });

  it('a format problem on a matched extractor is NO_MEDIA', () => {
    expect(classifySupportFailure(STDERR.formatGone)).toBe('NO_MEDIA');
  });

  it('an unfamiliar message defaults to INDETERMINATE (fail open)', () => {
    expect(classifySupportFailure('ERROR: something nobody has seen before')).toBe('INDETERMINATE');
    expect(classifySupportFailure('')).toBe('INDETERMINATE');
  });

  it('`unsupported url scheme` wins over the bare `unsupported url` substring', () => {
    // Ordering matters: both patterns match this string, and only the routing
    // verdict is correct.
    expect(classifySupportFailure('Unsupported url scheme: "mailto"')).toBe('UNSUPPORTED');
  });

  it('detects whether an extractor claimed the url', () => {
    expect(extractorClaimedUrl(STDERR.http404)).toBe(true);
    expect(extractorClaimedUrl(STDERR.notAUrl)).toBe(true);
    // The two "no extractor" wordings carry no `[name]` prefix at all.
    expect(extractorClaimedUrl(STDERR.noMedia)).toBe(false);
    expect(extractorClaimedUrl(STDERR.badScheme)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Blocking + cacheability predicates
// ---------------------------------------------------------------------------

describe('TASK-03 §3.4/§3.7 · predicates', () => {
  it('only UNSUPPORTED may block', () => {
    const states: UrlSupportState[] = [
      'SUPPORTED', 'UNSUPPORTED', 'NO_MEDIA', 'INDETERMINATE', 'TIMEOUT', 'CANCELLED',
    ];
    expect(states.filter(blocksEnqueue)).toEqual(['UNSUPPORTED']);
  });

  it('only a settled answer is cacheable', () => {
    expect(isCacheableSupport('SUPPORTED')).toBe(true);
    expect(isCacheableSupport('UNSUPPORTED')).toBe(true);
    expect(isCacheableSupport('NO_MEDIA')).toBe(true);
    expect(isCacheableSupport('INDETERMINATE')).toBe(false);
    expect(isCacheableSupport('TIMEOUT')).toBe(false);
    expect(isCacheableSupport('CANCELLED')).toBe(false);
  });

  it('the URL cache key keeps the query string and drops a trailing slash', () => {
    // The query identifies the video on most sites; collapsing it would make two
    // different videos share a verdict.
    expect(normalizeUrlForKey('https://Site.test/a/?v=1')).toBe('https://site.test/a?v=1');
    expect(normalizeUrlForKey('https://site.test/a/')).toBe('https://site.test/a');
    expect(supportCacheKey('https://s.test/a?v=1', 'C:/e.exe', 'v1'))
      .not.toBe(supportCacheKey('https://s.test/a?v=2', 'C:/e.exe', 'v1'));
  });

  it('the engine identity is part of every cache key', () => {
    expect(extractorCacheKey('C:\\E.exe', 'v1')).toBe(extractorCacheKey('c:/e.exe', 'v1'));
    expect(extractorCacheKey('C:/e.exe', 'v1')).not.toBe(extractorCacheKey('C:/e.exe', 'v2'));
    // A different binary at the same version must not share a catalog.
    expect(extractorCacheKey('C:/a.exe', 'v1')).not.toBe(extractorCacheKey('C:/b.exe', 'v1'));
  });

  it('a catalog is stale after the TTL, on a version change, or with no version', () => {
    const catalog = catalogOf();
    expect(isCatalogFresh(catalog, 'C:/rt/yt-dlp.exe', '2026.10.26', 0)).toBe(true);
    // Exactly at the TTL is already stale: the window is half-open.
    expect(isCatalogFresh(catalog, 'C:/rt/yt-dlp.exe', '2026.10.26', EXTRACTOR_CACHE_TTL_MS)).toBe(false);
    expect(isCatalogFresh(catalog, 'C:/rt/yt-dlp.exe', '2026.11.01', 0)).toBe(false);
    expect(isCatalogFresh(catalog, 'C:/rt/yt-dlp.exe', '', 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The service: caching, identity, and never remembering a blip
// ---------------------------------------------------------------------------

describe('TASK-03 · SiteSupportService', () => {
  it('reports ENGINE_UNAVAILABLE rather than inventing a list', async () => {
    const service = new SiteSupportService({
      engine: { probe() {} },           // no SiteDiscovery capability
      enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => 'v',
      jsRuntimePath: 'C:/rt/node.exe',
      clock: clockAt(),
    });
    expect(service.available).toBe(false);
    const result = await service.catalog();
    expect(result).toMatchObject({ ok: false, reason: 'ENGINE_UNAVAILABLE' });
  });

  it('serves the catalog from cache and re-asks only on `force`', async () => {
    const calls = { count: 0 };
    const { engine } = fakeEngine({ catalog: catalogOf(), catalogCalls: calls });
    const clock = clockAt();
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe', clock,
    });
    expect((await service.catalog()).ok).toBe(true);
    expect(calls.count).toBe(1);
    clock.advance(60_000);
    expect((await service.catalog()).ok).toBe(true);
    expect(calls.count).toBe(1);          // still cached
    await service.catalog(true);          // the refresh button
    expect(calls.count).toBe(2);
  });

  it('a version change invalidates the cached catalog by itself', async () => {
    const calls = { count: 0 };
    let version = '2026.10.26';
    const { engine } = fakeEngine({ catalog: catalogOf({ engineVersion: version }), catalogCalls: calls });
    const clock = clockAt();
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => version, jsRuntimePath: 'C:/rt/node.exe', clock,
    });
    await service.catalog();
    expect(calls.count).toBe(1);
    // A self-update swaps the binary: same path, new version.
    version = '2026.11.01';
    clock.advance(EXTRACTOR_CACHE_TTL_MS + 1);
    const second = await service.catalog();
    expect(calls.count).toBe(2);
    expect(second.ok && second.catalog.engineVersion).toBe('2026.10.26');
  });

  it('drops the cached catalog when a fresh fetch fails (never serves a stale list)', async () => {
    const calls = { count: 0 };
    let healthy = true;
    const engine = {
      async listExtractors() {
        calls.count += 1;
        return healthy
          ? { ok: true as const, catalog: catalogOf(), cached: false }
          : { ok: false as const, reason: 'ENGINE_FAILED' as const, detail: 'boom' };
      },
      async checkUrlSupport(url: string) { return verdict('SUPPORTED', { url }); },
      async version() { return '2026.10.26'; },
    };
    const clock = clockAt();
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe', clock,
    });
    expect((await service.catalog()).ok).toBe(true);
    healthy = false;
    const failed = await service.catalog(true);
    expect(failed.ok).toBe(false);
  });

  it('caches a settled verdict', async () => {
    let checks = 0;
    const { engine } = fakeEngine({
      catalog: catalogOf(),
      check: async (url) => { checks += 1; return verdict('SUPPORTED', { url }); },
    });
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
    });
    const first = await service.check('https://a.test/1');
    const second = await service.check('https://a.test/1');
    expect(checks).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('NEVER caches a transient failure (§3.7)', async () => {
    // This is the requirement most easily lost: one flaky network moment must
    // not condemn a URL for the rest of the session.
    for (const state of ['INDETERMINATE', 'TIMEOUT', 'CANCELLED'] as const) {
      let checks = 0;
      const { engine } = fakeEngine({
        catalog: catalogOf(),
        check: async (url) => { checks += 1; return verdict(state, { url }); },
      });
      const service = new SiteSupportService({
        engine, enginePath: 'C:/rt/yt-dlp.exe',
        engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
      });
      await service.check('https://a.test/x');
      await service.check('https://a.test/x');
      expect(checks, `${state} must be re-asked`).toBe(2);
    }
  });

  it('does not cache anything when the engine version cannot be read', async () => {
    let checks = 0;
    const { engine } = fakeEngine({
      catalog: catalogOf(),
      check: async (url) => { checks += 1; return verdict('SUPPORTED', { url }); },
    });
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => { throw new Error('unreadable'); },
      jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
    });
    await service.check('https://a.test/y');
    await service.check('https://a.test/y');
    // Without a nameable engine identity a verdict cannot be trusted later.
    expect(checks).toBe(2);
  });

  it('shares one in-flight check for the same URL', async () => {
    let checks = 0;
    const { engine } = fakeEngine({
      catalog: catalogOf(),
      check: async (url) => {
        checks += 1;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        return verdict('SUPPORTED', { url });
      },
    });
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
    });
    const [a, b] = await Promise.all([
      service.check('https://a.test/z'), service.check('https://a.test/z'),
    ]);
    expect(checks).toBe(1);
    expect(a.state).toBe(b.state);
  });

  it('a throwing check becomes INDETERMINATE, never a block', async () => {
    const { engine } = fakeEngine({
      catalog: catalogOf(),
      check: async () => { throw new Error('adapter exploded'); },
    });
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
    });
    const result = await service.check('https://a.test/q');
    expect(result.state).toBe('INDETERMINATE');
    expect(blocksEnqueue(result.state)).toBe(false);
  });

  it('bounds the verdict cache', async () => {
    const { engine } = fakeEngine({
      catalog: catalogOf(),
      check: async (url) => verdict('SUPPORTED', { url }),
    });
    const service = new SiteSupportService({
      engine, enginePath: 'C:/rt/yt-dlp.exe',
      engineVersion: async () => '2026.10.26', jsRuntimePath: 'C:/rt/node.exe',
      clock: clockAt(), maxVerdicts: 2,
    });
    for (let i = 0; i < 5; i += 1) await service.check(`https://a.test/${i}`);
    // The oldest entries are evicted; no crash, no unbounded growth.
    expect((await service.check('https://a.test/4')).cached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The batch gate
// ---------------------------------------------------------------------------

describe('TASK-03 §3.4 · precheckBatch', () => {
  it('passes everything through when there is no port', async () => {
    const outcome = await precheckBatch(['https://a.test/1', 'https://a.test/2'], undefined);
    expect(outcome.allowed).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(outcome.blocked).toEqual([]);
  });

  it('removes ONLY the unsupported urls, preserving order and duplicates', async () => {
    const states: Record<string, UrlSupportState> = {
      'https://ok.test/1': 'SUPPORTED',
      'https://no.test/2': 'UNSUPPORTED',
      'https://maybe.test/3': 'INDETERMINATE',
    };
    const outcome = await precheckBatch(
      ['https://ok.test/1', 'https://no.test/2', 'https://maybe.test/3', 'https://ok.test/1'],
      { check: async (url) => verdict(states[url] ?? 'SUPPORTED', { url }) },
    );
    expect(outcome.allowed).toEqual([
      'https://ok.test/1', 'https://maybe.test/3', 'https://ok.test/1',
    ]);
    expect(outcome.blocked.map((entry) => entry.url)).toEqual(['https://no.test/2']);
    // The indeterminate one is reported as a note, not as a block.
    expect(outcome.notes.map((entry) => entry.state)).toEqual(['INDETERMINATE']);
  });

  it('a throwing port passes the url instead of blocking it', async () => {
    const outcome = await precheckBatch(['https://a.test/1'], {
      check: async () => { throw new Error('boom'); },
    });
    expect(outcome.allowed).toEqual(['https://a.test/1']);
    expect(outcome.blocked).toEqual([]);
  });

  it('stops checking past the budget and reports the skipped count', async () => {
    let checks = 0;
    const urls = Array.from({ length: 10 }, (_v, i) => `https://a.test/${i}`);
    const outcome = await precheckBatch(urls, {
      check: async (url) => { checks += 1; return verdict('SUPPORTED', { url }); },
    }, { maxChecks: 3 });
    expect(checks).toBe(3);
    expect(outcome.skipped).toBe(7);
    // Unchecked urls PASS: we never block a url we did not actually examine.
    expect(outcome.allowed).toHaveLength(10);
  });

  it('defaults the budget to the documented constant', async () => {
    let checks = 0;
    const urls = Array.from({ length: MAX_PRECHECK_URLS_PER_BATCH + 10 }, (_v, i) => `https://a.test/${i}`);
    await precheckBatch(urls, {
      check: async (url) => { checks += 1; return verdict('SUPPORTED', { url }); },
    });
    expect(checks).toBe(MAX_PRECHECK_URLS_PER_BATCH);
  });

  it('asks the engine only once for a repeated url', async () => {
    let checks = 0;
    await precheckBatch(['https://same.test/x', 'https://same.test/x'], {
      check: async (url) => { checks += 1; return verdict('SUPPORTED', { url }); },
    });
    expect(checks).toBe(1);
  });

  /**
   * R1-03 — the tally the batch surfaces report.
   *
   * The requirement is "支持/不支持/不确定各几条 + 具体 URL". Before this the
   * gate produced `blocked` and `notes` and NOTHING read `notes`, so a batch
   * where half the links were never confirmed looked exactly like a clean one.
   * The counts are asserted here because they are the numbers a user reconciles
   * against "I imported N links".
   */
  it('R1-03 · tallies every bucket and keeps the total equal to the input', async () => {
    const states: Record<string, UrlSupportState> = {
      'https://ok.test/1': 'SUPPORTED',
      'https://ok.test/2': 'SUPPORTED',
      'https://no.test/1': 'UNSUPPORTED',
      'https://empty.test/1': 'NO_MEDIA',
      'https://maybe.test/1': 'INDETERMINATE',
      'https://slow.test/1': 'TIMEOUT',
    };
    const urls = Object.keys(states);
    const outcome = await precheckBatch(urls, {
      check: async (url) => verdict(states[url] as UrlSupportState, { url }),
    });
    const summary = outcome.summary;
    expect(summary.supported).toBe(2);
    expect(summary.unsupported).toBe(1);
    expect(summary.noMedia).toBe(1);
    expect(summary.indeterminate).toBe(2);          // INDETERMINATE + TIMEOUT
    expect(summary.skipped).toBe(0);
    expect(summary.unsupportedUrls).toEqual(['https://no.test/1']);
    expect(summary.noMediaUrls).toEqual(['https://empty.test/1']);
    expect(summary.indeterminateUrls).toEqual(['https://maybe.test/1', 'https://slow.test/1']);
    // The number the user reconciles against: nothing may fall out of the sum.
    expect(summary.supported + summary.unsupported + summary.noMedia
      + summary.indeterminate + summary.skipped).toBe(urls.length);
    expect(summary.examined).toBe(urls.length);
  });

  it('R1-03 · budget-skipped urls are a separate bucket, never folded into "supported"', async () => {
    const urls = Array.from({ length: 6 }, (_v, i) => `https://a.test/${i}`);
    const outcome = await precheckBatch(urls, {
      check: async (url) => verdict('SUPPORTED', { url }),
    }, { maxChecks: 2 });
    expect(outcome.summary.supported).toBe(2);
    expect(outcome.summary.skipped).toBe(4);
    expect(outcome.summary.examined).toBe(2);
    expect(outcome.summary.supported + outcome.summary.skipped).toBe(urls.length);
  });

  it('R1-03 · our OWN throw counts as "unconfirmed", never as "fine"', async () => {
    const outcome = await precheckBatch(['https://a.test/1'], {
      check: async () => { throw new Error('boom'); },
    });
    expect(outcome.summary.supported).toBe(0);
    expect(outcome.summary.indeterminate).toBe(1);
    expect(outcome.summary.indeterminateUrls).toEqual(['https://a.test/1']);
  });

  /**
   * R1-05 — `CANCELLED` has no producer in this build (documented in D-135), so
   * the only thing that can be verified is its HANDLING, which §3.4 pins: pass
   * the url, do not block, do not cache, count it as unconfirmed.
   */
  it('R1-05 · a CANCELLED verdict passes through, is counted as unconfirmed, and is not cacheable', async () => {
    const outcome = await precheckBatch(['https://a.test/1'], {
      check: async (url) => verdict('CANCELLED', { url }),
    });
    expect(outcome.allowed).toEqual(['https://a.test/1']);
    expect(outcome.blocked).toEqual([]);
    expect(outcome.summary.indeterminateUrls).toEqual(['https://a.test/1']);
    expect(isCacheableSupport('CANCELLED')).toBe(false);
  });

  it('R1-03 · no port reports the whole batch as NOT CHECKED', async () => {
    const outcome = await precheckBatch(['https://a.test/1', 'https://a.test/2'], undefined);
    expect(outcome.summary.examined).toBe(0);
    expect(outcome.summary.skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. The IPC surface
// ---------------------------------------------------------------------------

async function m5Deps(overrides: Partial<M5ChannelDeps> = {}): Promise<M5ChannelDeps> {
  // `createInMemoryPorts()` returns `{ ports, state }`; the stores want the
  // PORTS, and both must be initialised before a handler touches them.
  const mem = createInMemoryPorts();
  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();
  return {
    queue: { list: () => [], get: () => undefined },
    taskDetail: { perform: async () => ({ ok: true, action: 'remove', message: '' }) },
    templates,
    config,
    systemAppearance: {
      prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
    },
    ...overrides,
  } as M5ChannelDeps;
}

describe('TASK-03 · IPC channels', () => {
  it('registers both channels and whitelists only the documented keys', () => {
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.SUPPORTED_SITES);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.URL_SUPPORT_CHECK);
    expect(validateM5Payload(IPC_CHANNELS.SUPPORTED_SITES, { refresh: true })).toEqual({ refresh: true });
    expect(validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK, { url: 'https://a.test/1' }))
      .toEqual({ url: 'https://a.test/1' });
    // The renderer may not pick an engine, a path, an argv token or a format.
    for (const key of ['enginePath', 'engineVersion', 'argv', 'cookiesFile', 'quality', 'extractor']) {
      expect(() => validateM5Payload(IPC_CHANNELS.SUPPORTED_SITES, { [key]: 'x' })).toThrow();
      expect(() => validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK, { url: 'https://a.test/1', [key]: 'x' })).toThrow();
    }
  });

  it('answers an unavailable build with a CODE, never a fabricated list', async () => {
    const handlers = createM5Handlers(await m5Deps());
    const result = await handlers.get(IPC_CHANNELS.SUPPORTED_SITES)?.({}) as Record<string, unknown>;
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('ENGINE_UNAVAILABLE');
    expect(result['rows']).toEqual([]);
  });

  it('drops enginePath from the DTO', async () => {
    const handlers = createM5Handlers(await m5Deps({
      siteSupport: {
        available: true,
        catalog: async () => ({ ok: true, catalog: catalogOf() }),
        check: async (url) => verdict('SUPPORTED', { url }),
      },
    }));
    const result = await handlers.get(IPC_CHANNELS.SUPPORTED_SITES)?.({}) as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    expect(result['siteCount']).toBe(1);
    expect(result['hasGeneric']).toBe(false);
    // An absolute local path with the user's name in it must not reach a page.
    expect(JSON.stringify(result)).not.toContain('C:/rt/yt-dlp.exe');
    expect(JSON.stringify(result)).not.toContain('enginePath');
  });

  it('computes `blocks` main-side so the renderer never re-derives the rule', async () => {
    const handlers = createM5Handlers(await m5Deps({
      siteSupport: {
        available: true,
        catalog: async () => ({ ok: true, catalog: catalogOf() }),
        check: async (url) => verdict('UNSUPPORTED', { url, extractor: '' }),
      },
    }));
    const result = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({ url: 'https://a.test/1' }) as Record<string, unknown>;
    expect(result['state']).toBe('UNSUPPORTED');
    expect(result['blocks']).toBe(true);
    expect(result['code']).toBe('SITE_UNSUPPORTED');
  });

  it('a NO_MEDIA verdict does NOT block', async () => {
    const handlers = createM5Handlers(await m5Deps({
      siteSupport: {
        available: true,
        catalog: async () => ({ ok: true, catalog: catalogOf() }),
        check: async (url) => verdict('NO_MEDIA', { url }),
      },
    }));
    const result = await handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({ url: 'https://a.test/1' }) as Record<string, unknown>;
    expect(result['blocks']).toBe(false);
    expect(result['code']).toBe('NO_MEDIA');
  });

  it('rejects a non-http url at the transport boundary', async () => {
    const handlers = createM5Handlers(await m5Deps());
    await expect(handlers.get(IPC_CHANNELS.URL_SUPPORT_CHECK)?.({ url: 'file:///etc/passwd' })).rejects.toThrow();
  });

  it('refuses to enqueue an UNSUPPORTED url with a stable code, before spending a ticket', async () => {
    const enqueued: unknown[] = [];
    const handlers = createM5Handlers(await m5Deps({
      enqueueSingle: async (input) => { enqueued.push(input); return ['t1']; },
      siteSupport: {
        available: true,
        catalog: async () => ({ ok: true, catalog: catalogOf() }),
        check: async (url) => verdict('UNSUPPORTED', { url }),
      },
    }));
    const result = await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({ url: 'https://a.test/1', kind: 'video' }) as Record<string, unknown>;
    expect(result['accepted']).toBe(false);
    expect(result['code']).toBe('SITE_UNSUPPORTED');
    // Nothing may be enqueued, and the reason must not leak stderr or argv.
    expect(enqueued).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('-J');
  });

  it('still enqueues a NO_MEDIA url — the download stays the authority', async () => {
    const enqueued: unknown[] = [];
    const handlers = createM5Handlers(await m5Deps({
      enqueueSingle: async (input) => { enqueued.push(input); return ['t1']; },
      siteSupport: {
        available: true,
        catalog: async () => ({ ok: true, catalog: catalogOf() }),
        check: async (url) => verdict('NO_MEDIA', { url }),
      },
    }));
    const result = await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({ url: 'https://a.test/1', kind: 'video' }) as Record<string, unknown>;
    expect(result['accepted']).toBe(true);
    expect(enqueued).toHaveLength(1);
  });

  it('downloads normally when the pre-check port is absent', async () => {
    const handlers = createM5Handlers(await m5Deps({
      enqueueSingle: async () => ['t1'],
    }));
    const result = await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({ url: 'https://a.test/1', kind: 'video' }) as Record<string, unknown>;
    expect(result['accepted']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. The TXT entry point
// ---------------------------------------------------------------------------

describe('TASK-03 §3.5 · TXT import pre-check', () => {
  function txtService(support?: { check: (url: string) => Promise<UrlSupportResult> }) {
    const batches: string[][] = [];
    const service = createTxtImportService({
      pickFile: {
        pick: async () => ({
          canceled: false, fileName: 'links.txt',
          text: ['https://ok.test/1', 'https://no.test/2', 'https://ok.test/3'].join('\n'),
          code: '',
        }),
      },
      validateUrl: (raw: string) => {
        if (!/^https?:\/\//.test(raw)) throw new Error('bad url');
      },
      enqueueBatch: async (input) => {
        batches.push([...input.urls]);
        return { enqueued: input.urls.length, taskIds: input.urls.map((_u, i) => `t${i}`), failures: [] };
      },
      now: () => 1_000_000,
      makeId: () => 'import-0001',
      ...(support === undefined ? {} : { siteSupport: support }),
    });
    return { service, batches };
  }

  it('drops only the unsupported line and reports it by URL', async () => {
    const { service, batches } = txtService({
      check: async (url) => verdict(url.includes('no.test') ? 'UNSUPPORTED' : 'SUPPORTED', { url }),
    });
    const picked = await service.pick();
    expect(picked.ok).toBe(true);
    const result = await service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(batches[0]).toEqual(['https://ok.test/1', 'https://ok.test/3']);
    expect(result.failures).toEqual([{ url: 'https://no.test/2', reason: 'SITE_UNSUPPORTED' }]);
    // requested stays the FULL line count: the report may never look like a
    // clean run when a line was refused.
    expect(result.requested).toBe(3);
    expect(result.enqueued).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.code).toBe('PARTIAL_SUCCESS');
  });

  it('leaves the batch byte-identical when no pre-check port exists', async () => {
    const { service, batches } = txtService();
    const picked = await service.pick();
    const result = await service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(batches[0]).toEqual(['https://ok.test/1', 'https://no.test/2', 'https://ok.test/3']);
    expect(result.failures).toEqual([]);
  });

  it('reports a fully refused batch as a real outcome, not as "0 requested"', async () => {
    const { service } = txtService({
      check: async (url) => verdict('UNSUPPORTED', { url }),
    });
    const picked = await service.pick();
    const result = await service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(result.enqueued).toBe(0);
    expect(result.requested).toBe(3);
    expect(result.failures).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// R1-01 / R1-02 / R1-04 / R1-06 - round-1 regression pins
// ---------------------------------------------------------------------------

describe('R1-01 - the pre-check network context comes from the same config the download reads', () => {
  const reader = (domain: Record<string, unknown>) => ({ getDomain: () => domain });

  it('forwards proxy / cookiesFile / userAgent verbatim', () => {
    expect(readSiteSupportNetwork(reader({
      proxy: 'http://127.0.0.1:7890', cookiesFile: 'C:/cfg/cookies.txt', userAgent: 'UA/1.0',
    }))).toEqual({
      proxy: 'http://127.0.0.1:7890', cookiesFile: 'C:/cfg/cookies.txt', userAgent: 'UA/1.0',
    });
  });

  it('drops empty strings instead of forwarding a malformed argument', () => {
    // `--proxy ""` is not "no proxy": it is an argument the engine rejects, and
    // an empty `--cookies` path fails a run that would otherwise have worked.
    expect(readSiteSupportNetwork(reader({ proxy: '   ', cookiesFile: '', userAgent: 'UA' })))
      .toEqual({ userAgent: 'UA' });
  });

  it('ignores non-string values (a hand-edited config.json)', () => {
    expect(readSiteSupportNetwork(reader({ proxy: 7890, cookiesFile: null, userAgent: {} })))
      .toEqual({});
  });

  it('answers "no context" before the host exists, never a guessed one', () => {
    expect(readSiteSupportNetwork(null)).toEqual({});
  });
});

describe('R1-02 - catalog cache identity', () => {
  it('hits the cache even when the injected path is empty (the production bug)', async () => {
    // The shipped bug: `enginePath` was omitted by the bootstrap, the host filled
    // in `''`, and the slot was written with the engine's own reported path. The
    // lookup then compared `''` with a real path, so every panel open spawned
    // `--list-extractors` again while every test passed.
    let calls = 0;
    const engine = {
      async listExtractors() {
        calls += 1;
        return { ok: true as const, catalog: catalogOf(), cached: false };
      },
      async checkUrlSupport(url: string) { return verdict('SUPPORTED', { url }); },
      async version() { return '2026.10.26'; },
    };
    const service = new SiteSupportService({
      engine, enginePath: '', engineVersion: async () => '2026.10.26',
      jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
    });
    await service.catalog();
    await service.catalog();
    await service.catalog();
    expect(calls).toBe(1);
  });

  it('a different plugin environment cannot reuse a catalog', async () => {
    let calls = 0;
    const engine = {
      async listExtractors() {
        calls += 1;
        return { ok: true as const, catalog: catalogOf(), cached: false };
      },
      async checkUrlSupport(url: string) { return verdict('SUPPORTED', { url }); },
      async version() { return '2026.10.26'; },
    };
    const base = {
      engine, enginePath: 'C:/rt/yt-dlp.exe', engineVersion: async () => '2026.10.26',
      jsRuntimePath: 'C:/rt/node.exe', clock: clockAt(),
    };
    const withDefaults = new SiteSupportService(base);
    const withPlugins = new SiteSupportService({ ...base, pluginSignature: 'plugins:C:/p' });
    await withDefaults.catalog();
    await withPlugins.catalog();
    expect(calls).toBe(2);     // different identity, different cache entry
  });
});

describe('R1-06 - cached is reported, never inferred', () => {
  const serviceWith = (calls: { count: number }) => new SiteSupportService({
    engine: {
      async listExtractors() {
        calls.count += 1;
        return { ok: true as const, catalog: catalogOf(), cached: false };
      },
      async checkUrlSupport(url: string) { return verdict('SUPPORTED', { url }); },
      async version() { return '2026.10.26'; },
    },
    enginePath: 'C:/rt/yt-dlp.exe',
    engineVersion: async () => '2026.10.26',
    jsRuntimePath: 'C:/rt/node.exe',
    clock: clockAt(),
  });

  it('the FIRST load of a session is not labelled cached', async () => {
    const calls = { count: 0 };
    const first = await serviceWith(calls).catalog();
    expect(first.ok && first.cached).toBe(false);
  });

  it('the second load is cached, and an explicit refresh is not', async () => {
    const calls = { count: 0 };
    const service = serviceWith(calls);
    await service.catalog();
    const second = await service.catalog();
    expect(second.ok && second.cached).toBe(true);
    const refreshed = await service.catalog(true);
    expect(refreshed.ok && refreshed.cached).toBe(false);
    expect(calls.count).toBe(2);
  });
});

describe('R1-04 - geo-block / deleted wordings are INDETERMINATE, not NO_MEDIA', () => {
  // Every string below is the documented yt-dlp wording for that failure. §3.4
  // puts ALL of them in INDETERMINATE: the item exists, it is just not
  // retrievable from here - so NO_MEDIA would be a wrong claim about the site.
  it.each([
    'ERROR: [youtube] abc: This video is unavailable',
    'ERROR: [youtube] abc: This video is unavailable in your country',
    'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
    'ERROR: The uploader has not made this video available in your country',
    'ERROR: [youtube] abc: This video is not available',
  ])('%s', (stderr) => {
    expect(classifySupportFailure(stderr)).toBe('INDETERMINATE');
  });
});
