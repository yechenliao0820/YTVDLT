/**
 * Start-up self-check of the bundled runtime (D-169). Assembles Node ports,
 * then delegates to the pure-TS Core `checkRuntime()`. No window, no UI, no IPC.
 *
 * The electron surface is INJECTED (`CheckRuntimeForAppEnv`) rather than
 * imported, for the same reason `bootstrap.ts` does it: a module that
 * value-imports `electron` cannot even be imported under the unit-test runner,
 * and everything below — dialog text, hash cache, version backfill — is
 * unit-tested.
 */
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import type { HashPort, RuntimeCheckReport } from '@ytvdlt/shared';
import { checkRuntime } from '@ytvdlt/core';
import { createNodePorts } from './adapters/node-ports.js';
import { resolveRuntimeDir } from './runtime-paths.js';

/** The three `app.*` reads `checkRuntimeForApp` used to do itself. */
export interface CheckRuntimeForAppEnv {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appVersion: string;
}

export interface CheckRuntimeForAppOptions {
  /**
   * D-169 follow-up: where the (path, size, mtimeMs) -> sha256 cache lives —
   * inside the writability-probed data dir (the runtime directory itself is
   * read-only for machine installs). Absent = no cache, every file hashed.
   */
  readonly cachePath?: string;
}

export async function checkRuntimeForApp(
  env: CheckRuntimeForAppEnv,
  options: CheckRuntimeForAppOptions = {},
): Promise<RuntimeCheckReport> {
  const runtimeDir = resolveRuntimeDir({
    isPackaged: () => env.isPackaged,
    resourcesPath: () => env.resourcesPath,
  });
  const appDataDir = join(process.env['APPDATA'] ?? process.cwd(), 'YTVDLT');
  const configDir = join(appDataDir, 'config');
  const logsDir = join(appDataDir, 'logs');

  const ports = createNodePorts({
    packaged: env.isPackaged,
    resourcesPath: env.resourcesPath,
    runtimeDir,
    appDataDir,
    configDir,
    logsDir,
    appVersion: env.appVersion,
  });

  const hash: HashPort = options.cachePath === undefined
    ? ports.hash
    : {
      sha256File: createCachedSha256File({
        cachePath: options.cachePath,
        io: nodeRuntimeHashCacheIo,
        sha256File: (path: string) => ports.hash.sha256File(path),
      }),
      sha256Bytes: (data: Uint8Array) => ports.hash.sha256Bytes(data),
    };

  return checkRuntime({ ...ports, hash }, join(runtimeDir, 'runtime-manifest.json'));
}

/** Comma-joined labels of the REQUIRED items that failed the check (D-169). */
export function missingRequiredLabels(report: RuntimeCheckReport): string {
  return report.items
    .filter((item) => item.required && item.status !== 'OK')
    .map((item) => item.label)
    .join(', ');
}

/**
 * Text of the packaged-build error dialog (D-169). Real newlines: the first
 * ship of this dialog carried literal `//n` wherever a `\n` was meant, so the
 * user saw `in://nC:\...//n//n…`.
 */
export function runtimeCheckErrorMessage(report: RuntimeCheckReport): string {
  return [
    'These required components are missing or damaged in:',
    report.runtimeDir,
    '',
    missingRequiredLabels(report),
    '',
    'Downloads will fail until the installation is repaired.',
  ].join('\n');
}

/**
 * D-169 follow-up: the start-up check already probed `yt-dlp.exe --version`
 * (only when every required hash passed), so the error-report "Engine:" line
 * gets the real version instead of a dead 'unknown (resolved at runtime …)'
 * string. 'unknown' only when the check failed or the probe did not run.
 */
export function resolvedEngineVersion(report: RuntimeCheckReport | null): string {
  const version = report?.items.find((item) => item.kind === 'ytdlp')?.version ?? '';
  return version === '' ? 'unknown' : version;
}

/**
 * D-169 follow-up — start-up hash cache.
 *
 * `checkRuntime()` hashed all 12 required runtime files (292,229,632 B ≈
 * 278.7 MB: node.exe, avcodec-63.dll, avfilter-12.dll, yt-dlp.exe, …) on EVERY
 * start, before the first window appeared. Verdicts are now cached per file
 * and re-used only while `(sizeBytes, mtimeMs)` still match. This stays a
 * completeness check, never a skip: a hit is positive evidence ("this exact
 * content was verified before, and its metadata has not changed since"), a
 * missing or corrupt cache degrades to hashing every file, and a failed stat
 * propagates to Core (MISSING) — the check can only pass on real evidence.
 *
 * Threat model, unchanged by this cache: `runtime-manifest.json` holds the
 * expected hashes INSIDE the same directory it describes and is unsigned, so
 * an attacker able to rewrite a runtime file AND backdate its mtime could
 * equally have rewritten the manifest's expected sha256 — a full
 * re-computation would not have stopped them either. The cache therefore
 * defends against accidental damage (partial write, antivirus quarantine, a
 * self-update swap — each changes size or mtime and invalidates exactly one
 * entry), not against deliberate tampering with directory write access,
 * exactly like the status quo.
 */
interface RuntimeHashCacheEntry {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

interface RuntimeHashCacheFile {
  readonly schemaVersion: 1;
  readonly entries: Record<string, RuntimeHashCacheEntry>;
}

const RUNTIME_HASH_CACHE_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Injected IO — the real adapter is `nodeRuntimeHashCacheIo`; tests fake it. */
export interface RuntimeHashCacheIo {
  stat(absolutePath: string): Promise<{ sizeBytes: number; mtimeMs: number }>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

export const nodeRuntimeHashCacheIo: RuntimeHashCacheIo = {
  async stat(absolutePath: string): Promise<{ sizeBytes: number; mtimeMs: number }> {
    const info = await fs.stat(absolutePath);
    return { sizeBytes: info.size, mtimeMs: info.mtimeMs };
  },
  readText: (path: string) => fs.readFile(path, 'utf8'),
  writeText: (path: string, text: string) => fs.writeFile(path, text, 'utf8'),
};

function cacheKey(absolutePath: string): string {
  // The runtime is win-x64-only: paths are case-insensitive, so the key must
  // not depend on the letter case the runtimeDir derivation happened to use.
  return absolutePath.replace(/[\\/]+/g, '/').toLowerCase();
}

function validEntry(entry: unknown): entry is RuntimeHashCacheEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as Record<string, unknown>;
  return typeof candidate['sizeBytes'] === 'number' && Number.isFinite(candidate['sizeBytes'])
    && typeof candidate['mtimeMs'] === 'number' && Number.isFinite(candidate['mtimeMs'])
    && typeof candidate['sha256'] === 'string' && SHA256_PATTERN.test(candidate['sha256']);
}

export interface CachedSha256FileDeps {
  io: RuntimeHashCacheIo;
  cachePath: string;
  /** The real hash work; injected so unit tests can count the calls. */
  sha256File(absolutePath: string): Promise<string>;
}

/**
 * Wrap `sha256File` so repeated start-ups re-hash a file only when its
 * `(sizeBytes, mtimeMs)` fingerprint changed. Cache load is lazy and one-shot;
 * every re-computation rewrites the cache file, so a kill mid-check leaves
 * only verdicts that were really computed.
 */
export function createCachedSha256File(
  deps: CachedSha256FileDeps,
): (absolutePath: string) => Promise<string> {
  const { io, cachePath, sha256File } = deps;
  let entries: Record<string, RuntimeHashCacheEntry> = {};
  let loaded = false;

  const load = async (): Promise<void> => {
    loaded = true;
    try {
      const parsed = JSON.parse(await io.readText(cachePath)) as unknown;
      if (
        typeof parsed === 'object' && parsed !== null
        && (parsed as { schemaVersion?: unknown }).schemaVersion === RUNTIME_HASH_CACHE_SCHEMA_VERSION
      ) {
        const raw = (parsed as { entries?: unknown }).entries;
        if (typeof raw === 'object' && raw !== null) {
          for (const [key, entry] of Object.entries(raw)) {
            if (validEntry(entry)) entries[key] = entry;
          }
        }
      }
    } catch {
      // Missing, unreadable or corrupt cache: start empty, hash everything.
    }
  };

  const persist = async (): Promise<void> => {
    const file: RuntimeHashCacheFile = { schemaVersion: RUNTIME_HASH_CACHE_SCHEMA_VERSION, entries };
    try {
      await io.writeText(cachePath, JSON.stringify(file));
    } catch {
      // A read-only data dir must not fail the check; the next start simply
      // re-hashes everything.
    }
  };

  return async (absolutePath: string): Promise<string> => {
    if (!loaded) await load();
    const key = cacheKey(absolutePath);
    // Propagates when the file vanished between Core's stat and this one —
    // Core maps that to MISSING, never to a silent pass.
    const info = await io.stat(absolutePath);
    const cached = entries[key];
    if (cached !== undefined
      && cached.sizeBytes === info.sizeBytes
      && cached.mtimeMs === info.mtimeMs) {
      return cached.sha256;
    }
    const sha256 = await sha256File(absolutePath);
    entries[key] = { sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs, sha256 };
    await persist();
    return sha256;
  };
}
