/**
 * D-109 · 面向普通用户的失败分类（下载列表卡片的一句话简报）。
 *
 * Why a separate module instead of reusing `error-mapper`:
 *   - `error-mapper` answers "what went wrong technically" (17 frozen codes,
 *     zh-CN message, retryable, redacted report) and is consumed by the log,
 *     the error report and the detail page;
 *   - this module answers "what should a non-technical user read on the card".
 *     It is a pure projection of the SAME stable code — it never looks at the
 *     raw yt-dlp text, never invents a cause and never produces localized copy
 *     (the UI owns the strings, so a language switch needs no re-fetch).
 *
 * Deliberate omissions (the vocabulary has no reliable signal for them):
 *   - 「视频不可用 / Video unavailable」: yt-dlp's `Video unavailable` /
 *     `Private video` strings have NO rule in `error-mapper/rules.ts`, so they
 *     arrive as `UNKNOWN`; `UNSUPPORTED_SITE` and `FORMAT_UNAVAILABLE` mean
 *     "this link / this format cannot be used", not "the video is gone".
 *     Mapping any of them onto that bucket would be a guess, so they fall to
 *     `unknown` and the user is pointed at the details.
 *
 * Pure data + pure function: no I/O, no `node:*`, no locale.
 */
import type { ErrorCode } from '@ytvdlt/shared';

/**
 * The buckets a card may show. Stable identifiers — safe to persist or send
 * over IPC; the human sentence is resolved from `queue.failure.<kind>`.
 */
export type FailureKind = 'network' | 'service' | 'forbidden' | 'save' | 'unknown';

/** Every kind, in display order (contract tests + i18n key coverage). */
export const FAILURE_KINDS: readonly FailureKind[] = [
  'network', 'service', 'forbidden', 'save', 'unknown',
] as const;

/**
 * Code → kind. Exhaustive over the 17 frozen codes on purpose: appending a code
 * to `ALL_ERROR_CODES` without deciding its bucket breaks
 * `tests/unit/failure-summary.test.ts` instead of silently shipping `unknown`.
 *
 * Justification per bucket (no keyword guessing — the code IS the signal):
 *   network   NETWORK_TIMEOUT / DNS_FAILURE — the connection itself failed.
 *   service   HTTP_429 — the server is refusing right now (rate limit); it is
 *             NOT a local network fault and NOT "content unavailable".
 *   forbidden HTTP_403 — the content cannot be accessed (auth / region / owner).
 *   save      DISK_FULL / PERMISSION_DENIED — writing the artifact failed.
 *   unknown   everything else, including local runtime gaps (engine / JS runtime
 *             / ffmpeg / EJS), verification failures, rejected custom commands,
 *             unsupported links, unavailable formats and `UNKNOWN` itself.
 *             Those are real failures the user cannot fix from a card, so the
 *             brief stays generic and points at the details.
 */
const KIND_BY_CODE: Readonly<Record<ErrorCode, FailureKind>> = {
  NETWORK_TIMEOUT: 'network',
  DNS_FAILURE: 'network',
  HTTP_429: 'service',
  HTTP_403: 'forbidden',
  DISK_FULL: 'save',
  PERMISSION_DENIED: 'save',
  INVALID_URL: 'unknown',
  UNSUPPORTED_SITE: 'unknown',
  FORMAT_UNAVAILABLE: 'unknown',
  ALREADY_DOWNLOADED: 'unknown',
  ENGINE_MISSING: 'unknown',
  JS_RUNTIME_MISSING: 'unknown',
  FFMPEG_MISSING: 'unknown',
  EJS_FAILED: 'unknown',
  ARTIFACT_INCOMPLETE: 'unknown',
  CUSTOM_COMMAND_REJECTED: 'unknown',
  UNKNOWN: 'unknown',
};

/** Test seam: the full table, so a coverage test can walk every code. */
export const FAILURE_KIND_BY_CODE: Readonly<Record<string, FailureKind>> = KIND_BY_CODE;

/**
 * Classify a stable error code.
 *
 * `null` / `''` / an unknown string means "the backend recorded no usable
 * code" — caller decides whether that is a failure at all. Everything that IS
 * a code maps to a bucket; unknown codes map to `unknown` rather than throwing,
 * so a newer main process cannot break an older renderer.
 */
export function classifyFailure(code: string | null | undefined): FailureKind | null {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  if (normalized === '') return null;
  const kind = FAILURE_KIND_BY_CODE[normalized];
  return kind === undefined ? 'unknown' : kind;
}

/** Narrowing guard used by the DTO projection / tests. */
export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value);
}
