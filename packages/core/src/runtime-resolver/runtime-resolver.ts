/**
 * RuntimeResolver — startup self-check of the 4 runtime groups.
 * Reads the manifest → per-file SHA-256 + size → `--version` probe →
 * 4 logical groups → dedicated error codes → RuntimeCheckReport.
 *
 * ALL I/O through injected CorePorts. Zero `node:*` / `electron` imports.
 * Missing required binaries NEVER crash and NEVER silently degrade.
 */
import type {
  CorePorts, RuntimeManifest, RuntimeItem, RuntimeCheckReport,
  RuntimeStatus, RuntimeFileResult, RuntimeGroupKind, ErrorCode, AppError,
} from '@ytvdlt/shared';
import type { IRuntimeResolver, CheckRuntime } from '../ports.js';
import { validateManifest, validateManifestObject } from './manifest-loader.js';

export interface RuntimeResolverDeps {
  ports: CorePorts;
  /** Absolute path to runtime-manifest.json (used when `manifest` is absent). */
  manifestPath?: string;
  /** Pre-parsed manifest (used by L0 tests with in-memory ports). */
  manifest?: RuntimeManifest;
}

interface GroupDefinition {
  kind: RuntimeGroupKind;
  label: string;
  required: boolean;
  errorCode: ErrorCode | null;
  versionCommand: string | null;
  versionFile: string | null;
  versionArgv: readonly string[];
  absoluteSubdir: string;
}

/** Exactly 4 groups, in the fixed §4.9 output order. */
export const GROUP_DEFINITIONS: readonly GroupDefinition[] = [
  {
    kind: 'ytdlp', label: 'yt-dlp.exe', required: true, errorCode: 'ENGINE_MISSING',
    versionCommand: '--version', versionFile: 'yt-dlp.exe', versionArgv: ['--version'],
    absoluteSubdir: '',
  },
  {
    kind: 'ffmpeg', label: 'ffmpeg.exe + ffprobe.exe + LGPL DLL', required: true,
    errorCode: 'FFMPEG_MISSING', versionCommand: '-version',
    versionFile: 'ffmpeg/ffmpeg.exe', versionArgv: ['-version'], absoluteSubdir: '/ffmpeg',
  },
  {
    kind: 'node', label: 'node.exe (EJS JS runtime)', required: true,
    errorCode: 'JS_RUNTIME_MISSING', versionCommand: '--version',
    versionFile: 'node.exe', versionArgv: ['--version'], absoluteSubdir: '',
  },
  {
    kind: 'aria2c', label: 'aria2c.exe (bundled multi-connection downloader, optional)', required: false,
    errorCode: null, versionCommand: null, versionFile: null, versionArgv: [],
    absoluteSubdir: '',
  },
] as const;

function joinRuntime(runtimeDir: string, relative: string): string {
  // Preserve the platform separator used by the injected runtimeDir so the
  // reported absoluteDir is consistent (Core never imports node:path).
  const separator = runtimeDir.includes('\\') ? '\\' : '/';
  const clean = relative.replace(/^\/+/, '').replace(/\//g, separator);
  const root = runtimeDir.replace(/[\\/]+$/, '');
  return clean.length === 0 ? root : `${root}${separator}${clean}`;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return line ? line.trim() : '';
}

/** Extract a compact version token from a `--version` / `-version` stdout. */
function parseVersion(kind: RuntimeGroupKind, stdout: string): string {
  const line = firstLine(stdout);
  if (!line) return '';
  if (kind === 'ffmpeg') {
    const match = /(?:ffmpeg|ffprobe) version (\S+)/i.exec(line);
    if (match?.[1]) return match[1];
    return line.slice(0, 80);
  }
  return line.slice(0, 80);
}

export class RuntimeResolver implements IRuntimeResolver {
  private readonly ports: CorePorts;

  constructor(private readonly deps: RuntimeResolverDeps) {
    this.ports = deps.ports;
  }

  async check(): Promise<RuntimeCheckReport> {
    const manifest = await this.loadManifest();
    const runtimeDir = this.ports.env.runtimeDir();
    const items: RuntimeStatus[] = [];

    for (const definition of GROUP_DEFINITIONS) {
      items.push(await this.checkGroup(definition, manifest, runtimeDir));
    }

    const required = items.filter((item) => item.required);
    const requiredOk = required.filter((item) => item.status === 'OK').length;
    const failed = required.length - requiredOk;
    return {
      schemaVersion: 1,
      platform: 'win-x64',
      checkedAt: this.ports.clock.nowIso(),
      packaged: this.ports.env.isPackaged(),
      runtimeDir,
      allRequiredOk: failed === 0,
      summary: {
        requiredOk,
        requiredTotal: 3,
        optionalMissing: items.filter((i) => !i.required && i.status !== 'OK').length,
        failed,
      },
      items,
    };
  }

  private async loadManifest(): Promise<RuntimeManifest> {
    if (this.deps.manifest) return validateManifestObject(this.deps.manifest);
    if (!this.deps.manifestPath) {
      throw new Error('runtime-manifest path is required when no manifest object is injected');
    }
    const text = await this.ports.fs.readText(this.deps.manifestPath);
    return validateManifest(text);
  }

  private async checkGroup(
    definition: GroupDefinition,
    manifest: RuntimeManifest,
    runtimeDir: string,
  ): Promise<RuntimeStatus> {
    const absoluteDir = definition.required
      ? joinRuntime(runtimeDir, definition.absoluteSubdir)
      : '';
    const groupItems = manifest.items.filter((item) => item.group === definition.kind);

    if (!definition.required) {
      return {
        kind: definition.kind,
        label: definition.label,
        required: false,
        status: 'OPTIONAL',
        errorCode: null,
        absoluteDir,
        version: '',
        versionCommand: null,
        fileResults: [],
        message: 'OPTIONAL: 已随包；缺失不判 FAIL（下载仍走 yt-dlp 原生分段）',
      };
    }

    const fileResults: RuntimeFileResult[] = [];
    for (const item of groupItems) {
      fileResults.push(await this.checkFile(item, runtimeDir));
    }

    let status: RuntimeStatus['status'] = groupItems.length === 0 ? 'MISSING' : 'OK';
    for (const result of fileResults) {
      if (result.status === 'MISSING') { status = 'MISSING'; break; }
      if (result.status === 'HASH_MISMATCH') { status = 'HASH_MISMATCH'; break; }
      if (result.status === 'NOT_EXECUTABLE') { status = 'NOT_EXECUTABLE'; break; }
    }

    // Run the version probe only when every hash/size check passed.
    let version = '';
    if (status === 'OK' && definition.versionFile) {
      const exe = joinRuntime(runtimeDir, definition.versionFile);
      try {
        const result = await this.ports.process.spawn(exe, definition.versionArgv, {
          shell: false,
          windowsHide: true,
          timeoutMs: 30_000,
          // §12.4 铁律 5: bundled ffmpeg dir precedes system PATH.
          env: {
            PATH: `${joinRuntime(runtimeDir, 'ffmpeg')};${this.ports.env.get('PATH') ?? ''}`,
          },
        });
        if (result.exitCode !== 0 || result.timedOut) {
          status = 'NOT_EXECUTABLE';
        } else {
          version = parseVersion(definition.kind, result.stdout || result.stderr);
          if (version.length === 0) status = 'NOT_EXECUTABLE';
        }
      } catch {
        status = 'NOT_EXECUTABLE';
      }
    }

    const errorCode: ErrorCode | null = status === 'OK'
      ? null
      : (definition.errorCode ?? 'UNKNOWN');
    const message = status === 'OK'
      ? 'OK'
      : `${status}${errorCode ? ` (${errorCode})` : ''}`;

    return {
      kind: definition.kind,
      label: definition.label,
      required: true,
      status,
      errorCode,
      absoluteDir,
      version,
      versionCommand: definition.versionCommand,
      fileResults,
      message,
    };
  }

  private async checkFile(item: RuntimeItem, runtimeDir: string): Promise<RuntimeFileResult> {
    const absolute = joinRuntime(runtimeDir, item.path);
    const result: RuntimeFileResult = {
      path: item.path,
      status: 'MISSING',
      sha256Expected: item.sha256,
      sha256Actual: null,
      sizeBytesExpected: item.sizeBytes,
      sizeBytesActual: null,
    };
    try {
      const exists = await this.ports.fs.exists(absolute);
      if (!exists) return result;
      const stat = await this.ports.fs.stat(absolute);
      result.sizeBytesActual = stat.sizeBytes;
      if (!stat.isFile) { result.status = 'NOT_EXECUTABLE'; return result; }
      const hash = await this.ports.hash.sha256File(absolute);
      result.sha256Actual = hash;
      if (hash !== item.sha256 || stat.sizeBytes !== item.sizeBytes) {
        result.status = 'HASH_MISMATCH';
        return result;
      }
      result.status = 'OK';
    } catch {
      result.status = 'MISSING';
    }
    return result;
  }
}

/** Factory shared by check-runtime.mjs (file path) and Electron assembly (object). */
export const checkRuntime: CheckRuntime = async (ports, manifestOrPath) => {
  const resolver = typeof manifestOrPath === 'string'
    ? new RuntimeResolver({ ports, manifestPath: manifestOrPath })
    : new RuntimeResolver({ ports, manifest: validateManifestObject(manifestOrPath) });
  return resolver.check();
};

/** Convenience helper: build a plain AppError for a failing group (used by CLI). */
export function groupAppError(status: RuntimeStatus): AppError | null {
  if (status.status === 'OK' || status.status === 'OPTIONAL' || status.errorCode === null) return null;
  return {
    code: status.errorCode,
    message: status.message,
    detail: status.fileResults.map((f) => `${f.path}: ${f.status}`).join('\n'),
    retryable: false,
    report: `runtime group ${status.kind}: ${status.status} (${status.errorCode})`,
  };
}
