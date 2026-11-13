/**
 * SiteSupportService (D-134) — "supported sites" + per-URL pre-check, main side.
 *
 * WHAT IT OWNS
 *   - the catalog cache, keyed by ENGINE IDENTITY (path + version), so a
 *     self-update invalidates it by construction (`extractorCacheKey`);
 *   - the per-URL verdict cache, keyed by (URL, engine identity) with the
 *     "never remember a transient failure" rule from §3.7;
 *   - the concurrency gates that keep a click-storm from spawning a dozen
 *     engines at once.
 *
 * WHAT IT MUST NEVER DO
 *   - invent a list. No engine capability ⇒ `ENGINE_UNAVAILABLE`, and the
 *     renderer says so. A shipped fallback list is indistinguishable from a
 *     correct one and is the exact failure §3.1 is written against.
 *   - block on anything but a settled `UNSUPPORTED`. Every other state passes
 *     through so the download remains the authority.
 *   - let a verdict leak a media URL: `UrlSupportResult` carries the caller's
 *     own URL string back plus a fixed-vocabulary reason, nothing else.
 *
 * WHERE IT SITS: main process, next to the other services. It talks to the
 * engine through the injected `SiteDiscovery` capability (never `electron`),
 * which keeps it L0-testable with a stub.
 */
import type {
  ExtractorCatalog, ExtractorCatalogResult, SpawnAbortSignal, UrlSupportResult, UrlSupportState,
} from '@ytvdlt/shared';
import {
  DEFAULT_PLUGIN_SIGNATURE, EXTRACTOR_CACHE_TTL_MS, extractorCacheKey, isCacheableSupport,
  isCatalogFresh, networkContextSignature, supportCacheKey, URL_PRECHECK_TIMEOUT_MS,
} from '@ytvdlt/shared';
import type { SiteDiscovery, UrlSupportCheckOptions } from '@ytvdlt/engine-ytdlp';
import { supportsSiteDiscovery } from '@ytvdlt/engine-ytdlp';

export interface SiteSupportLogger {
  warn(scope: string, message: string, detail?: Record<string, unknown>): Promise<void> | void;
  error(scope: string, message: string, detail?: Record<string, unknown>): Promise<void> | void;
}

export interface SiteSupportServiceOptions {
  /** The live engine object. Feature-detected, never assumed. */
  readonly engine: unknown;
  /**
   * Absolute path of that same engine — half of the cache identity.
   *
   * Passed in rather than read off the engine object: `DownloadEngine` is FROZEN
   * at five methods and carries no path, and the bootstrap already holds the
   * resolved absolute path it handed to the factory. Reading it from a second
   * source is how the catalog and the running binary drift apart.
   */
  readonly enginePath: string;
  /**
   * `--version` of that engine — the other half of the identity.
   *
   * Owned by the CALLER (bootstrap reads it once) so an engine self-update that
   * changes the binary is visible here as a changed string. A `''` return makes
   * every cached entry stale, which is the safe direction.
   */
  readonly engineVersion?: () => Promise<string> | string;
  /** Absolute bundled node.exe path; forwarded to the pre-check. */
  readonly jsRuntimePath: string;
  readonly clock: { nowEpochMs(): number; nowIso(): string };
  readonly logger?: SiteSupportLogger;
  /** Network context, resolved lazily so a config change is picked up. */
  readonly network?: () => {
    readonly proxy?: string;
    readonly cookiesFile?: string;
    readonly userAgent?: string;
  };
  readonly catalogTtlMs?: number;
  readonly verdictTtlMs?: number;
  /** Ceiling on distinct URL verdicts held at once (oldest inserted drops first). */
  readonly maxVerdicts?: number;
  /**
   * R1-02: the third component of the engine identity (§3.2 "插件环境").
   *
   * Defaults to `DEFAULT_PLUGIN_SIGNATURE` because this build never passes
   * `--plugin-dirs`; a future build that does MUST pass its own value, which
   * makes every catalog/verdict written by the other shape unreachable instead
   * of silently reused.
   */
  readonly pluginSignature?: string;
}

/** In-memory catalog slot: at most one engine identity is ever current. */
interface CatalogSlot {
  readonly key: string;
  readonly catalog: ExtractorCatalog;
  readonly fetchedAtMs: number;
}

interface VerdictSlot {
  readonly key: string;
  readonly result: UrlSupportResult;
  readonly atMs: number;
}

/** Default verdict cache size. A session realistically checks tens of URLs. */
const DEFAULT_MAX_VERDICTS = 200;
const DEFAULT_VERDICT_TTL_MS = 10 * 60 * 1000;

/**
 * T5 — the user moved on before the check finished. A VALUE, never an
 * exception (the fail-open contract), and never cacheable (§3.7 already
 * excludes CANCELLED from `isCacheableSupport`).
 */
function cancelledVerdict(url: string): UrlSupportResult {
  return {
    url, state: 'CANCELLED', extractor: '', cached: false,
    reason: 'pre-check cancelled by the user',
  };
}

export class SiteSupportService {
  private readonly options: SiteSupportServiceOptions;
  private catalogSlot: CatalogSlot | null = null;
  /** One in-flight catalog fetch is shared; a second click must not spawn again. */
  private catalogInflight: Promise<ExtractorCatalogResult> | null = null;
  private readonly verdicts = new Map<string, VerdictSlot>();
  private readonly verdictInflight = new Map<string, Promise<UrlSupportResult>>();
  /**
   * Memoised engine version.
   *
   * `--version` is a real subprocess, so calling it on every cache lookup would
   * cost exactly what the cache exists to avoid. It is memoised for the catalog
   * TTL, which is the same window the cached list is trusted for; a self-update
   * clears it via `invalidate()`, and a successful `listExtractors()` refreshes
   * it for free from the catalog's own report.
   */
  private identitySlot: { value: string; atMs: number } | null = null;

  constructor(options: SiteSupportServiceOptions) {
    this.options = options;
  }

  /** Is the running engine able to answer these questions at all? */
  get available(): boolean {
    return supportsSiteDiscovery(this.options.engine);
  }

  private capability(): SiteDiscovery | null {
    return supportsSiteDiscovery(this.options.engine) ? this.options.engine : null;
  }

  /**
   * The extractor catalog, from cache when the ENGINE IDENTITY still matches.
   *
   * `force` bypasses the TTL but NOT the identity check — the refresh button
   * asks "ask the engine again", it can never ask "keep the old answer".
   */
  async catalog(force = false): Promise<ExtractorCatalogResult> {
    const engine = this.capability();
    if (engine === null) {
      return {
        ok: false,
        reason: 'ENGINE_UNAVAILABLE',
        detail: 'this engine cannot list extractors',
      };
    }
    const enginePath = this.options.enginePath;

    if (!force && this.catalogSlot !== null) {
      const version = await this.identity();
      const age = this.options.clock.nowEpochMs() - this.catalogSlot.fetchedAtMs;
      // R1-02: the slot was WRITTEN with the path the engine reported, so the
      // lookup must resolve the same way. Comparing the injected path against a
      // slot keyed on a different string made the cache miss 100% of the time
      // whenever those two differed — a fresh `--list-extractors` subprocess on
      // every panel open, while every unit test (same path on both sides) passed.
      const path = this.slotPath(enginePath);
      if (this.catalogSlot.key === extractorCacheKey(path, version, this.plugins())
        && isCatalogFresh(this.catalogSlot.catalog, path, version, age,
          this.options.catalogTtlMs ?? EXTRACTOR_CACHE_TTL_MS, this.plugins())) {
        // R1-06: `cached` is reported HERE, where the hit actually happened,
        // instead of being inferred by the IPC layer from "did the caller ask
        // for a refresh".
        return { ok: true, catalog: this.catalogSlot.catalog, cached: true };
      }
    }

    if (this.catalogInflight !== null) return this.catalogInflight;
    const pending = (async (): Promise<ExtractorCatalogResult> => {
      const result = await engine.listExtractors();
      if (!result.ok) {
        // A failed-but-fresh fetch DROPS the previous catalog rather than
        // serving it: once we cannot re-confirm the list, presenting the old one
        // as current would be the stale-list failure the requirement forbids.
        this.catalogSlot = null;
        await this.options.logger?.warn('sites.catalog', 'listing failed', {
          reason: result.reason,
        });
        return result;
      }
      const catalog = result.catalog;
      // Trust the engine's own reported path/version for the slot key, falling
      // back to the injected path when it did not report one. This keeps the
      // cache identity tied to WHAT RAN rather than to what we intended to run.
      const path = catalog.enginePath === '' ? enginePath : catalog.enginePath;
      this.identitySlot = { value: catalog.engineVersion, atMs: this.options.clock.nowEpochMs() };
      this.catalogSlot = {
        key: extractorCacheKey(path, catalog.engineVersion, this.plugins()),
        catalog,
        fetchedAtMs: this.options.clock.nowEpochMs(),
      };
      return { ok: true, catalog, cached: false };
    })().finally(() => { this.catalogInflight = null; });
    this.catalogInflight = pending;
    return pending;
  }

  /** The plugin component of the identity; see `pluginSignature` above. */
  private plugins(): string {
    return this.options.pluginSignature ?? DEFAULT_PLUGIN_SIGNATURE;
  }

  /**
   * The path component to COMPARE with — the exact expression the slot key was
   * built from. Split out so "write" and "read" can never drift apart again.
   */
  private slotPath(fallback: string): string {
    const reported = this.catalogSlot?.catalog.enginePath ?? '';
    return reported === '' ? fallback : reported;
  }

  /**
   * §3.3/§3.4 — pre-check ONE url, with the caches.
   *
   * T5: `signal` is the user's cancellation for THIS call. It is forwarded to
   * the engine (which kills the child and answers CANCELLED) and it disables
   * in-flight sharing — a shared promise could not be killed on one caller's
   * behalf without killing somebody else's check too.
   *
   * `previousState` is NOT accepted from the caller: a cached verdict is only
   * ever produced here, so no caller can assert "this was already checked".
   */
  async check(url: string, force = false, signal?: SpawnAbortSignal): Promise<UrlSupportResult> {
    return this.checkUrl(url, force, signal);
  }

  /**
   * The same call under its descriptive name. Both exist because the IPC port
   * (`SiteSupportPortLike`) and the pre-check gate (`PrecheckPortLike`) each
   * name the operation the way their reader expects — one adapter satisfies
   * both, and no caller has to remember which spelling belongs where.
   */
  async checkUrl(
    url: string,
    force = false,
    signal?: SpawnAbortSignal,
  ): Promise<UrlSupportResult> {
    // T5: read through a lambda — the flag can flip while we await, and a fresh
    // call per check never inherits a stale narrowing across an await.
    const signalAborted = (): boolean => signal?.aborted === true;
    // T5: a caller that already cancelled gets the CANCELLED state without
    // touching the caches — "stop" must never be answered from memory.
    if (signalAborted()) return cancelledVerdict(url);
    const engine = this.capability();
    if (engine === null) {
      return {
        url, state: 'INDETERMINATE', extractor: '', cached: false,
        reason: 'pre-check unavailable in this build',
      };
    }
    const version = await this.identity();
    const network = this.options.network?.() ?? {};
    // D-137 (F-08): the SAME lazily-resolved context that is forwarded to the
    // engine below also identifies the verdict. Changing a proxy / cookie file
    // / UA can no longer serve a verdict produced under the old one.
    const key = supportCacheKey(
      url, this.options.enginePath, version, this.plugins(), networkContextSignature(network),
    );

    if (!force) {
      const hit = this.verdicts.get(key);
      if (hit !== undefined
        && this.options.clock.nowEpochMs() - hit.atMs < (this.options.verdictTtlMs ?? DEFAULT_VERDICT_TTL_MS)) {
        return { ...hit.result, cached: true };
      }
    }

    // T5: an abortable call never SHARES an in-flight check. Sharing would mean
    // one caller's abort kills (or poisons) a concurrent caller's check, which
    // is a worse failure than one duplicate engine spawn for the same URL.
    if (signal === undefined) {
      const pending = this.verdictInflight.get(key);
      if (pending !== undefined) return pending;
    }

    const opts: UrlSupportCheckOptions = {
      jsRuntimePath: this.options.jsRuntimePath,
      timeoutMs: URL_PRECHECK_TIMEOUT_MS,
      // Reuse the SAME snapshot that produced the cache key: resolving it twice
      // would let a config change between the two reads make the key describe a
      // different argv than the one actually spawned.
      ...network,
      ...(signal === undefined ? {} : { signal }),
    };
    const task = engine.checkUrlSupport(url, opts)
      .then((result) => {
        // §3.7: only a SETTLED answer is remembered. INDETERMINATE / TIMEOUT /
        // CANCELLED are re-asked next time, so one flaky moment cannot condemn
        // a URL for the rest of the session.
        //
        // An UNKNOWN engine version also disables caching: we cannot name the
        // engine that produced the verdict, so we cannot tell later whether it
        // still applies.
        if (isCacheableSupport(result.state) && version !== '') {
          this.rememberVerdict(key, result);
        }
        return result;
      })
      .catch(async (error: unknown) => {
        // `checkUrlSupport` is documented never to throw. If an adapter still
        // does, that is OUR bug to report — and the user must not be blocked,
        // so the url stays INDETERMINATE. T5: unless the caller cancelled — a
        // cancelled check is CANCELLED, not "the site could not be classified".
        if (signalAborted()) return cancelledVerdict(url);
        await this.options.logger?.error('sites.precheck', 'pre-check threw', {
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          url, state: 'INDETERMINATE' as UrlSupportState, extractor: '', cached: false,
          reason: 'pre-check failed unexpectedly',
        };
      })
      .finally(() => { this.verdictInflight.delete(key); });
    if (signal === undefined) this.verdictInflight.set(key, task);
    return task;
  }

  /** Drop every cached verdict. Used when network settings change. */
  forgetVerdicts(): void {
    this.verdicts.clear();
  }

  /** Drop everything, including the identity: call after an engine self-update. */
  invalidate(): void {
    this.catalogSlot = null;
    this.identitySlot = null;
    this.verdicts.clear();
  }

  /** Memoised `--version` of the live engine; `''` means "cannot be read". */
  private async identity(): Promise<string> {
    const ttl = this.options.catalogTtlMs ?? EXTRACTOR_CACHE_TTL_MS;
    const now = this.options.clock.nowEpochMs();
    if (this.identitySlot !== null && now - this.identitySlot.atMs < ttl) {
      return this.identitySlot.value;
    }
    let value = '';
    try {
      const raw = await this.options.engineVersion?.();
      value = typeof raw === 'string' ? raw.trim() : '';
    } catch {
      // An unreadable version must NOT silently match a cached entry; `''`
      // makes `isCatalogFresh` treat the slot as stale and disables verdict
      // caching entirely.
      value = '';
    }
    this.identitySlot = { value, atMs: now };
    return value;
  }

  private rememberVerdict(key: string, result: UrlSupportResult): void {
    const max = Math.max(1, this.options.maxVerdicts ?? DEFAULT_MAX_VERDICTS);
    if (this.verdicts.size >= max) {
      // Map preserves insertion order; dropping the oldest keeps the cache
      // bounded without a clock dependency (and without an LRU library).
      const oldest = this.verdicts.keys().next();
      if (!oldest.done) this.verdicts.delete(oldest.value);
    }
    this.verdicts.set(key, { key, result, atMs: this.options.clock.nowEpochMs() });
  }
}
