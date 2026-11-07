/**
 * HANDOFF §6.7 error-code enumeration — EXACTLY 17 codes, frozen for M1.
 * IDs are stable: later milestones may append, never renumber.
 * Pure data only: no `node:*` / `electron` imports.
 */

export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SITE'
  | 'FORMAT_UNAVAILABLE'
  | 'NETWORK_TIMEOUT'
  | 'DNS_FAILURE'
  | 'HTTP_403'
  | 'HTTP_429'
  | 'ALREADY_DOWNLOADED'
  | 'DISK_FULL'
  | 'PERMISSION_DENIED'
  | 'ENGINE_MISSING'
  | 'JS_RUNTIME_MISSING'
  | 'FFMPEG_MISSING'
  | 'EJS_FAILED'
  | 'ARTIFACT_INCOMPLETE'
  | 'CUSTOM_COMMAND_REJECTED'
  | 'UNKNOWN';

/** Runtime-missing codes: the "jump to self-check page" grouping (§6.7 / §12.4 铁律 3). */
export const RUNTIME_MISSING_CODES: readonly ErrorCode[] = [
  'ENGINE_MISSING',
  'JS_RUNTIME_MISSING',
  'FFMPEG_MISSING',
  'EJS_FAILED',
] as const;

/** All 17 codes as a runtime tuple — single source of truth for contract tests. */
export const ALL_ERROR_CODES: readonly ErrorCode[] = [
  'INVALID_URL',
  'UNSUPPORTED_SITE',
  'FORMAT_UNAVAILABLE',
  'NETWORK_TIMEOUT',
  'DNS_FAILURE',
  'HTTP_403',
  'HTTP_429',
  'ALREADY_DOWNLOADED',
  'DISK_FULL',
  'PERMISSION_DENIED',
  'ENGINE_MISSING',
  'JS_RUNTIME_MISSING',
  'FFMPEG_MISSING',
  'EJS_FAILED',
  'ARTIFACT_INCOMPLETE',
  'CUSTOM_COMMAND_REJECTED',
  'UNKNOWN',
] as const;

/**
 * Cross-IPC / structured-clone transport object. Deliberately a plain object
 * (an `Error` instance cannot be structured-cloned across contextBridge).
 * `report` contains OS / app version / engine version / URL / full stderr,
 * all redacted by the Logger redactor before it is produced.
 */
export interface AppError {
  code: ErrorCode;
  message: string;
  detail: string;
  retryable: boolean;
  report: string;
}

/** Context required to build a redacted `AppError.report`, supplied by EnvPort. */
export interface ErrorContext {
  url: string;
  stderr: string;
  engineVersion: string;
  appVersion: string;
  os: string;
  argv?: readonly string[];
}
