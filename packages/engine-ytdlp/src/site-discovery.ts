/**
 * TASK-03 (D-134) — append-only capability interfaces.
 *
 * WHY A SEPARATE INTERFACE rather than two more methods on `DownloadEngine`:
 * that interface is FROZEN at 5 methods (M1, `shared-contract.test.ts` asserts
 * the exact set). Adding to it would be a breaking change for every
 * implementation — including `FakeEngine` and every test double. The engine
 * therefore ADVERTISES the extra capability through an optional interface that
 * callers feature-detect with `supportsSiteDiscovery()`.
 *
 * WHY THIS IS NOT A BACKDOOR: both methods only READ metadata the engine
 * already exposes on its command line (`--list-extractors`, `--simulate`), both
 * go through the same injected `ProcessPort` with the same spawn 铁律
 * (`shell:false`, argv[]), and neither can start a download.
 */
import type {
  ExtractorCatalogResult, UrlSupportResult,
} from '@ytvdlt/shared';

/** Options for the URL pre-check (§3.3). Mirrors `ProbeOptions` minus the playlist flags. */
export interface UrlSupportCheckOptions {
  /** Absolute path of the bundled node.exe (EJS runtime) — required, as everywhere. */
  readonly jsRuntimePath: string;
  /** Always provided by the pre-check; kept optional so a caller may pass its own. */
  readonly timeoutMs?: number;
  readonly proxy?: string;
  readonly cookiesFile?: string;
  readonly userAgent?: string;
}

export interface SiteDiscovery {
  /**
   * Ask the RUNNING engine what it can parse (`--list-extractors`).
   *
   * Never cached here — the caller owns caching, because only the caller knows
   * the engine identity it validated against (path + version).
   */
  listExtractors(): Promise<ExtractorCatalogResult>;
  /**
   * Ask whether ONE url resolves to media, WITHOUT downloading it.
   *
   * Advisory: a `SUPPORTED` here does not guarantee the download succeeds, and
   * only `UNSUPPORTED` may block (§3.4).
   */
  checkUrlSupport(
    url: string,
    opts: UrlSupportCheckOptions,
  ): Promise<UrlSupportResult>;
}

/** Feature-detect: `'listExtractors' in engine`. */
export function supportsSiteDiscovery(engine: unknown): engine is SiteDiscovery {
  return typeof engine === 'object' && engine !== null
    && typeof (engine as SiteDiscovery).listExtractors === 'function'
    && typeof (engine as SiteDiscovery).checkUrlSupport === 'function';
}
