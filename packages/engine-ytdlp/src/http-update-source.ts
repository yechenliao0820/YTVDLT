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
 */
import type { EngineUpdateSource, HttpPort } from '@ytvdlt/shared';

export interface HttpUpdateSourceOptions {
  /** Directory URL, with or without a trailing slash. */
  readonly baseUrl: string;
  /** File to download, e.g. `yt-dlp.exe`. Also the name looked up in SUMS. */
  readonly fileName: string;
  readonly http: HttpPort;
  /** Defaults to `SHA2-256SUMS`. */
  readonly checksumsName?: string;
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

  async fetchChecksums(): Promise<string> {
    const name = this.options.checksumsName ?? 'SHA2-256SUMS';
    return this.options.http.getText(joinUrl(this.options.baseUrl, name));
  }

  async fetchEngineBinary(): Promise<Uint8Array> {
    return this.options.http.getBytes(joinUrl(this.options.baseUrl, this.options.fileName));
  }
}
