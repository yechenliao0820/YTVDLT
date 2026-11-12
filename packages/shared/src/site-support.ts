/**
 * TASK-03 (append-only) — "supported sites" vocabulary and URL support checking.
 *
 * TWO INDEPENDENT CAPABILITIES, deliberately in one file because they share the
 * extractor-name vocabulary:
 *
 *   A · `ExtractorCatalog` — what the RUNNING engine can parse. Display data
 *       only: names, a broken flag, and the GenericIE note.
 *
 *   B · `UrlSupportResult` — whether ONE url is worth enqueueing, as a
 *       six-state model. This is an ADVISORY pre-check, never an authority:
 *       only `UNSUPPORTED` may block, because the pre-check runs the same
 *       engine with a shorter timeout and its "no" is weaker than the
 *       download's.
 *
 * THE ONE RULE THAT MATTERS: the engine is the ONLY source of truth. There is
 * deliberately no fallback list, no hard-coded domain table, no regex of known
 * hosts, and no shipped copy of `supportedsites.md`. A build that cannot read
 * its engine reports FAILURE, it does not invent a list — a stale list is
 * indistinguishable from a correct one and would silently mislead.
 *
 * LAUNDERING NOTE: nothing here may carry a media URL. `ExtractorCatalog` holds
 * extractor names, `UrlSupportResult` holds a state plus a reason string that is
 * built from a fixed vocabulary — the url the caller passed in is echoed back
 * only as the same string it already had.
 */

/** One extractor as reported by the running engine. */
export interface ExtractorInfo {
  /** Raw engine name, e.g. `youtube`, `youtubetab:playlist`, `generic`. */
  readonly name: string;
  /** Parent extractor for a sub-extractor (`youtubetab` for `youtubetab:x`); `''` otherwise. */
  readonly parent: string;
  /** The engine itself flagged this one as broken — we do not judge. */
  readonly broken: boolean;
  /**
   * True for `generic`, the fallback extractor. Kept as an explicit flag because
   * "generic is available" does NOT mean "every site works": it means the engine
   * will ATTEMPT any page and find a media file in it. The UI must say so
   * instead of letting it read as universal support.
   */
  readonly isGeneric: boolean;
}

/** Result of asking the engine what it can parse. */
export interface ExtractorCatalog {
  /** `yt-dlp --version` of the engine that produced this list. */
  readonly engineVersion: string;
  /** Absolute path of that engine — half of the cache identity. */
  readonly enginePath: string;
  readonly extractors: readonly ExtractorInfo[];
  /** Extractor count EXCLUDING `generic` (the honest "how many sites" number). */
  readonly siteCount: number;
  /** Sub-extractor count (`name:variant` entries). */
  readonly subExtractorCount: number;
  /** Names the engine marked `(CURRENTLY BROKEN)`. */
  readonly brokenCount: number;
  /** True when the engine answered but reported nothing — never faked into a list. */
  readonly empty: boolean;
  readonly fetchedAt: string;
}

/**
 * Why a catalog could not be produced. The renderer owns the sentence.
 *
 * `ENGINE_UNAVAILABLE` (D-134) is the "this build's engine object cannot answer
 * this question at all" case — a different thing from a timeout or a failed run,
 * and it must never be flattened into `ENGINE_FAILED`: a build that simply lacks
 * the capability would then look like a build whose engine crashed.
 */
export type ExtractorCatalogFailure =
  | 'ENGINE_TIMEOUT' | 'ENGINE_FAILED' | 'ENGINE_EMPTY' | 'OUTPUT_LIMIT_EXCEEDED'
  | 'ENGINE_UNAVAILABLE';

/**
 * `--list-extractors` outcome. A failure is an explicit variant so a caller can
 * never mistake "could not ask" for "nothing supported".
 *
 * `cached` lives on the SUCCESS branch only, and it is set by the layer that
 * actually knows (the catalog cache), never inferred downstream (R1-06). While
 * it was inferred in the IPC layer as "not a refresh request", the very first
 * load of a session — a genuine engine run — was labelled "（缓存）" in the UI,
 * and once the cache key was fixed it would have been labelled so every time.
 */
export type ExtractorCatalogResult =
  | {
    readonly ok: true;
    readonly catalog: ExtractorCatalog;
    /** True when this answer came from the cache instead of a fresh engine run. */
    readonly cached: boolean;
  }
  | { readonly ok: false; readonly reason: ExtractorCatalogFailure; readonly detail: string };

/**
 * TASK-03 §3.4 — the six states of a URL pre-check.
 *
 *   SUPPORTED     the engine resolved media for this url.
 *   UNSUPPORTED   the engine said, in its own words, that it has no extractor.
 *                 THE ONLY state allowed to block an enqueue.
 *   NO_MEDIA      an extractor matched but returned no downloadable format
 *                 (a live stream, a text page the GenericIE read as media-less).
 *   INDETERMINATE we could not classify it — a transient error, an auth wall, a
 *                 network failure. Treated as "let the download decide".
 *   TIMEOUT       the pre-check ran out of time. Never cached as a verdict.
 *   CANCELLED     the user moved on before it finished.
 */
export type UrlSupportState =
  | 'SUPPORTED' | 'UNSUPPORTED' | 'NO_MEDIA'
  | 'INDETERMINATE' | 'TIMEOUT' | 'CANCELLED';

/** Display-safe outcome of pre-checking one URL. */
export interface UrlSupportResult {
  readonly url: string;
  readonly state: UrlSupportState;
  /**
   * Extractor the engine attributed the URL to (`''` when it never got that far).
   * This is what makes GenericIE transparent: a `generic` here means the ENGINE
   * guessed from the page, not that a dedicated extractor matched.
   */
  readonly extractor: string;
  /** Short, fixed-vocabulary explanation. Never holds argv, stderr or a token. */
  readonly reason: string;
  /** True when the state came from a cached verdict rather than a fresh check. */
  readonly cached: boolean;
}

/** `true` only for the single state that is allowed to stop an enqueue (§3.4). */
export function blocksEnqueue(state: UrlSupportState): boolean {
  return state === 'UNSUPPORTED';
}

/**
 * §3.7 — a transient result must never be remembered as a verdict.
 *
 * Only a settled answer is cacheable: SUPPORTED / UNSUPPORTED / NO_MEDIA.
 * INDETERMINATE, TIMEOUT and CANCELLED are re-asked every time, so one flaky
 * network moment cannot condemn a URL for the rest of the session.
 */
export function isCacheableSupport(state: UrlSupportState): boolean {
  return state === 'SUPPORTED' || state === 'UNSUPPORTED' || state === 'NO_MEDIA';
}

/** `true` when this state was decided by a timeout or the user moving on. */
export function isTransientSupport(state: UrlSupportState): boolean {
  return state === 'INDETERMINATE' || state === 'TIMEOUT' || state === 'CANCELLED';
}

/**
 * §3.5 — the wire shape of the catalogue, deliberately narrower than the
 * internal one: the renderer needs counts, a version string and rows.
 *
 * `enginePath` is NOT here. It is an absolute local path with the user's
 * account name in it, and it appears in no requirement for the UI; shipping it
 * would leak a filesystem layout into a page that only needs to say
 * "engine 2026.10.26 · 1308 sites".
 */
export interface SupportedSitesDto {
  readonly ok: boolean;
  /** Stable failure code when `ok` is false; `''` otherwise. */
  readonly code: ExtractorCatalogFailure | '';
  readonly engineVersion: string;
  readonly siteCount: number;
  readonly subExtractorCount: number;
  readonly brokenCount: number;
  /** True for the GenericIE note region — the row is present in `rows` too. */
  readonly hasGeneric: boolean;
  readonly fetchedAt: string;
  readonly rows: readonly ExtractorInfo[];
  /** Whether this answer came from the cache rather than a fresh engine run. */
  readonly cached: boolean;
}

/** §3.4 wire shape of one pre-check. `reason` is fixed-vocabulary, never stderr. */
export interface UrlSupportCheckDto {
  readonly url: string;
  readonly state: UrlSupportState;
  readonly extractor: string;
  readonly reason: string;
  readonly cached: boolean;
  /** Mirrors `blocksEnqueue(state)` so the renderer never re-derives the rule. */
  readonly blocks: boolean;
  /** Stable code for the renderer's copy; `''` when nothing is wrong. */
  readonly code: string;
}

/**
 * §3.7 — cache key for a per-URL verdict.
 *
 * The engine identity is part of the key for the same reason as the catalog: a
 * verdict is a statement about what THIS engine can do with this URL, so a self
 * update must not leave old verdicts standing.
 *
 * Trailing slashes are dropped but the query string is KEPT: on many sites the
 * query is what identifies the video, so `?v=A` and `?v=B` are different items
 * and must never share a verdict. The URL is lower-cased only for the scheme and
 * host — a path can be case-sensitive — hence the split rather than one
 * `toLowerCase()` over the whole string.
 */
export function supportCacheKey(
  url: string,
  enginePath: string,
  engineVersion: string,
  plugins: string = DEFAULT_PLUGIN_SIGNATURE,
  /** D-137: omitted = byte-identical legacy key. See networkContextSignature. */
  network: string = '',
): string {
  const base = `${normalizeUrlForKey(url)}::${extractorCacheKey(enginePath, engineVersion, plugins)}`;
  return network === '' ? base : `${base}::${network}`;
}

/** The (only) network fields a real download can currently configure. */
export interface SupportNetworkContext {
  readonly proxy?: string;
  readonly cookiesFile?: string;
  readonly userAgent?: string;
}

/**
 * D-137 (F-08): a verdict is a statement about "what THIS engine can do with
 * this URL under THIS network configuration". Proxy, cookies and user agent can
 * change whether a page resolves, so a verdict cached before such a change must
 * not be served afterwards. The key must therefore see the configuration —
 * WITHOUT storing a proxy credential or a cookie-file path in a cache key that
 * ends up in memory dumps and logs.
 *
 * This is a non-cryptographic 32-bit FNV-1a digest used ONLY to detect a
 * CHANGE. It is not authentication, it is not secrecy, and collisions are
 * acceptable: the worst case is one extra engine run, which is fail-open.
 *
 * Pure JS on purpose — `shared` may never import `node:crypto` (§2 layering).
 */
export function networkContextSignature(context: SupportNetworkContext = {}): string {
  const joined = [context.proxy ?? '', context.cookiesFile ?? '', context.userAgent ?? '']
    .join('\u0000');
  let hash = 0x811c9dc5;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `network:${hash.toString(16).padStart(8, '0')}`;
}

/** Lower-case scheme+host, keep the rest verbatim. Pure and defensive. */
export function normalizeUrlForKey(url: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(url.trim());
  if (match === null) return url.trim().replace(/\/+$/, '');
  const scheme = (match[1] ?? '').toLowerCase();
  const authority = (match[2] ?? '').toLowerCase();
  // A trailing slash must be dropped even when a query or fragment follows it
  // (`/a/?v=1` and `/a?v=1` are the same request), so the path is normalised in
  // isolation and the query/fragment suffix is re-attached untouched.
  const rest = match[3] ?? '';
  const suffixAt = rest.search(/[?#]/);
  const path = suffixAt === -1 ? rest : rest.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? '' : rest.slice(suffixAt);
  return `${scheme}://${authority}${path.replace(/\/+$/, '')}${suffix}`;
}

/** Ceilings for the bounded metadata spawns this feature introduces. */
export const EXTRACTOR_LIST_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const EXTRACTOR_LIST_MAX_STDERR_BYTES = 1 * 1024 * 1024;
export const URL_PRECHECK_TIMEOUT_MS = 20_000;
/** How long a catalog stays valid. Bounded by the engine identity, not by time alone. */
export const EXTRACTOR_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * The plugin component for a build that sets no `--plugin-dirs` (today's only
 * shape). Exported so a future "load user plugins from <dataDir>/plugins"
 * change has one place to alter and one value to compare against.
 */
export const DEFAULT_PLUGIN_SIGNATURE = 'plugins:default';

/**
 * §3.2 — the cache identity of a catalog: the ENGINE, not the clock.
 *
 * The requirement is that a self-update must invalidate the list, because the
 * extractor set is a property of the binary. Including the version in the key
 * gets that for free and makes a stale catalog unreachable by construction
 * rather than by remembering to clear it: after an update the key changes, so
 * the old entry can never be served again.
 *
 * Path and version are compared case-insensitively for the path only — Windows
 * may report `C:\...` or `c:\...` for the same file, while two genuinely
 * different engine paths must NOT share a catalog even at the same version.
 *
 * `plugins` is the THIRD identity component (§3.2 "引擎路径 + 版本 + 插件环境").
 * The extractor set is not only a property of the binary: yt-dlp loads plugins
 * from its own directories, and a plugin can add or change an extractor without
 * the version string moving. This build never passes `--plugin-dirs`, so the
 * value is constant for it and a cache written by a build that DOES pass one
 * can never be served here. The component is spelled out rather than omitted so
 * that it exists before anyone needs it — the alternative is a key that claims
 * to be an engine identity while silently ignoring half of one.
 *
 * Pure, so the rule is unit-testable without spawning anything.
 */
export function extractorCacheKey(
  enginePath: string,
  engineVersion: string,
  plugins: string = DEFAULT_PLUGIN_SIGNATURE,
): string {
  return `${enginePath.replace(/\\/g, '/').toLowerCase()}::${engineVersion.trim()}::${plugins.trim()}`;
}

/**
 * Is a cached catalog still a valid answer for this engine?
 *
 * A version that cannot be read (`''`) counts as STALE: caching against an
 * unknown engine identity is exactly how a stale list survives an update.
 */
export function isCatalogFresh(
  catalog: Pick<ExtractorCatalog, 'enginePath' | 'engineVersion'>,
  enginePath: string,
  engineVersion: string,
  ageMs: number,
  ttlMs: number = EXTRACTOR_CACHE_TTL_MS,
  plugins: string = DEFAULT_PLUGIN_SIGNATURE,
): boolean {
  if (engineVersion.trim() === '') return false;
  if (extractorCacheKey(catalog.enginePath, catalog.engineVersion, plugins)
    !== extractorCacheKey(enginePath, engineVersion, plugins)) return false;
  return ageMs >= 0 && ageMs < ttlMs;
}
