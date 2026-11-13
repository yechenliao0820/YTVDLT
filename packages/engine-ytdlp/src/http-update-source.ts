/**
 * `EngineUpdateSource` over plain HTTPS (M5-5, D-67).
 *
 * The update feed is a **static directory**: one `SHA2-256SUMS` plus the
 * component binaries, served by any HTTPS host — a GitHub release asset folder,
 * an object store, or an internal mirror. Nothing about the protocol is
 * proprietary, so the same code works for the official yt-dlp feed and for a
 * self-hosted one; only `baseUrl` changes.
 *
 * Networking is injected (`HttpPort`), so this class has no `node:https`/
 * `fetch` import and is fully testable offline.
 *
 * The URL policy is injected too (component-update hardening): this package
 * sits BELOW the main process, so it cannot import `isTrustedReleaseHost` —
 * the caller picks the policy for the source it assembled and hands the
 * predicate in. `component-updater.ts` passes the GitHub allowlist for
 * official feeds and deliberately nothing for operator mirrors (the port's
 * bounded permissive transport is the mirror policy; see the rationale there).
 */
import type { EngineUpdateSource, HttpFetchOptions, HttpPort } from '@ytvdlt/shared';

export interface HttpUpdateSourceOptions {
  /** Directory URL, with or without a trailing slash. */
  readonly baseUrl: string;
  /** File to download, e.g. `yt-dlp.exe`. Also the name looked up in SUMS. */
  readonly fileName: string;
  readonly http: HttpPort;
  /** Defaults to `SHA2-256SUMS`. */
  readonly checksumsName?: string;
  /**
   * Per-hop URL policy forwarded to every `getText` / `getBytes` call, so the
   * port re-checks the initial URL AND every redirect hop (and, for a caller
   * policy, also validates resolved addresses). Absent = the port's bounded
   * permissive default — an explicit mirror-mode choice, not an oversight.
   */
  readonly urlPolicy?: (rawUrl: string) => boolean;
}

function joinUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
}

export class HttpUpdateSource implements EngineUpdateSource {
  readonly kind = 'official-release' as const;
  private readonly options: HttpUpdateSourceOptions;

  constructor(options: HttpUpdateSourceOptions) {
    this.options = options;
  }

  /**
   * Options for every fetch of THIS source. A configured policy rides on each
   * call; no policy means `{}` — the port's bounded permissive transport
   * (per-hop http(s) validity, redirect cap, loop detection, socket pinning)
   * is then the whole policy, which is what the mirror mode wants.
   */
  private fetchOptions(): HttpFetchOptions {
    const policy = this.options.urlPolicy;
    return policy === undefined ? {} : { urlPolicy: policy };
  }

  async fetchChecksums(): Promise<string> {
    const name = this.options.checksumsName ?? 'SHA2-256SUMS';
    return this.options.http.getText(joinUrl(this.options.baseUrl, name), this.fetchOptions());
  }

  async fetchEngineBinary(): Promise<Uint8Array> {
    return this.options.http.getBytes(
      joinUrl(this.options.baseUrl, this.options.fileName),
      this.fetchOptions(),
    );
  }
}
