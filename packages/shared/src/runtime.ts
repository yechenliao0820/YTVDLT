import type { ErrorCode } from './errors.js';

export type RuntimeKind = 'ytdlp' | 'node' | 'ffmpeg' | 'ffprobe' | 'aria2c';
/** Exactly 4 logical groups in `check-runtime` output. */
export type RuntimeGroupKind = 'ytdlp' | 'ffmpeg' | 'node' | 'aria2c';
export type ItemStatus = 'OK' | 'MISSING' | 'HASH_MISMATCH' | 'NOT_EXECUTABLE' | 'OPTIONAL';

/** One file entry of `runtime-manifest.json`. `path` is POSIX, relative to the runtime root. */
export interface RuntimeItem {
  path: string;
  sha256: string;
  sizeBytes: number;
  version: string;
  sourceUrl: string;
  releaseTag: string;
  license: string;
  required: boolean;
  kind: RuntimeKind;
  group: RuntimeGroupKind;
}

export interface RuntimeManifest {
  schemaVersion: number;
  platform: 'win-x64';
  generatedAt: string;
  toolVersions: { node: string; npm: string; pnpm: string };
  items: RuntimeItem[];
}

export interface RuntimeFileResult {
  path: string;
  status: Exclude<ItemStatus, 'OPTIONAL'>;
  sha256Expected: string;
  sha256Actual: string | null;
  sizeBytesExpected: number;
  sizeBytesActual: number | null;
}

export interface RuntimeStatus {
  kind: RuntimeGroupKind;
  label: string;
  required: boolean;
  status: ItemStatus;
  errorCode: ErrorCode | null;
  absoluteDir: string;
  version: string;
  versionCommand: string | null;
  fileResults: RuntimeFileResult[];
  message: string;
}

/** Output of `node scripts/check-runtime.mjs --json` (§4.9). */
export interface RuntimeCheckReport {
  schemaVersion: 1;
  platform: 'win-x64';
  checkedAt: string;
  packaged: boolean;
  runtimeDir: string;
  allRequiredOk: boolean;
  summary: {
    requiredOk: number;
    requiredTotal: 3;
    optionalMissing: number;
    failed: number;
  };
  items: RuntimeStatus[];
}
