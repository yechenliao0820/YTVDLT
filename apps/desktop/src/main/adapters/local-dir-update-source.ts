/**
 * `EngineUpdateSource` backed by a local directory (M5-5, C2).
 *
 * This is the source the acceptance run uses: a folder holding `yt-dlp.exe` and
 * its `SHA2-256SUMS`. It performs real file reads — the orchestration above it
 * (checksum → `.new` → rename → rollback) is then exercised end-to-end without
 * a single network call, which is the only honest way to prove the swap logic
 * before the update feed exists (N2).
 *
 * The official HTTPS source is deliberately NOT implemented here: fetching from
 * `github.com/yt-dlp/yt-dlp/releases` is 国际网 (N3), which is out of scope.
 */
import type { EngineUpdateSource } from '@ytvdlt/shared';
import type { CorePorts } from '@ytvdlt/shared';

export interface LocalDirUpdateSourceOptions {
  /** Directory that holds `yt-dlp.exe` and `SHA2-256SUMS`. */
  readonly dir: string;
  /** Injected so the source never imports `node:fs` itself. */
  readonly ports: CorePorts;
  readonly binaryName?: string;
  readonly checksumsName?: string;
}

function joinPath(dir: string, name: string): string {
  const base = dir.replace(/[\\/]+$/, '');
  return `${base}/${name}`;
}

export class LocalDirUpdateSource implements EngineUpdateSource {
  readonly kind = 'local-dir' as const;
  private readonly options: LocalDirUpdateSourceOptions;

  constructor(options: LocalDirUpdateSourceOptions) {
    this.options = options;
  }

  private binaryName(): string {
    return this.options.binaryName ?? 'yt-dlp.exe';
  }

  async fetchChecksums(): Promise<string> {
    const name = this.options.checksumsName ?? 'SHA2-256SUMS';
    return this.options.ports.fs.readText(joinPath(this.options.dir, name));
  }

  async fetchEngineBinary(): Promise<Uint8Array> {
    return this.options.ports.fs.readBytes(joinPath(this.options.dir, this.binaryName()));
  }
}
