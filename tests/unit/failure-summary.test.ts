/**
 * D-109 · stable error code → one plain-language failure bucket.
 *
 * The classification must be exhaustive over the FROZEN 17-code vocabulary and
 * must never guess: `UNKNOWN`, unsupported sites, unavailable formats and local
 * component gaps all fall to `unknown`, which the UI renders as
 * 「下载失败，请查看详情」. Appending a code to `ALL_ERROR_CODES` without
 * deciding its bucket fails here on purpose (no silent generic drift).
 */
import { describe, it, expect } from 'vitest';
import { ALL_ERROR_CODES, type ErrorCode } from '@ytvdlt/shared';
import {
  classifyFailure, isFailureKind, FAILURE_KINDS, FAILURE_KIND_BY_CODE,
  type FailureKind,
} from '@ytvdlt/core';
import { failureKey, requiredKeys } from '@ytvdlt/core';

/** The full expected table — reviewed against `error-mapper/rules.ts`. */
const EXPECTED: Readonly<Record<ErrorCode, FailureKind>> = {
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

describe('D-109 · failure classifier over the frozen error vocabulary', () => {
  it('covers every one of the 17 codes exactly once (no silent generic drift)', () => {
    expect(ALL_ERROR_CODES).toHaveLength(17);
    expect(Object.keys(FAILURE_KIND_BY_CODE).sort()).toEqual([...ALL_ERROR_CODES].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_ERROR_CODES].sort());
  });

  it.each(ALL_ERROR_CODES)('%s maps to the reviewed bucket', (code) => {
    expect(classifyFailure(code)).toBe(EXPECTED[code]);
    expect(FAILURE_KINDS).toContain(EXPECTED[code]);
  });

  it('keeps network, server-side and access failures distinct', () => {
    expect(classifyFailure('NETWORK_TIMEOUT')).toBe('network');
    expect(classifyFailure('DNS_FAILURE')).toBe('network');
    expect(classifyFailure('HTTP_429')).toBe('service');
    expect(classifyFailure('HTTP_403')).toBe('forbidden');
    expect(new Set(['network', 'service', 'forbidden']).size).toBe(3);
  });

  it('sends save failures (disk / permissions) to their own bucket', () => {
    expect(classifyFailure('DISK_FULL')).toBe('save');
    expect(classifyFailure('PERMISSION_DENIED')).toBe('save');
  });

  it('never invents a cause when the code does not support one', () => {
    for (const code of [
      'UNKNOWN', 'UNSUPPORTED_SITE', 'FORMAT_UNAVAILABLE', 'ALREADY_DOWNLOADED',
      'ENGINE_MISSING', 'JS_RUNTIME_MISSING', 'FFMPEG_MISSING', 'EJS_FAILED',
      'ARTIFACT_INCOMPLETE', 'CUSTOM_COMMAND_REJECTED', 'INVALID_URL',
    ]) {
      // 「视频不可用 / Video unavailable」has NO rule in error-mapper/rules.ts:
      // yt-dlp's "Video unavailable" text arrives as UNKNOWN, so it is generic.
      expect(classifyFailure(code)).toBe('unknown');
    }
  });

  it('accepts the real transport shapes without throwing', () => {
    expect(classifyFailure(null)).toBeNull();
    expect(classifyFailure(undefined)).toBeNull();
    expect(classifyFailure('')).toBeNull();
    expect(classifyFailure('   ')).toBeNull();
    expect(classifyFailure('  http_429 ')).toBe('service');
    expect(classifyFailure('SOME_FUTURE_CODE')).toBe('unknown');
    expect(classifyFailure('https://host/?token=secret')).toBe('unknown');
  });

  it('exposes a narrowing guard for the DTO projection', () => {
    for (const kind of FAILURE_KINDS) expect(isFailureKind(kind)).toBe(true);
    for (const bad of [null, '', 'networkish', 42, {}, undefined]) expect(isFailureKind(bad)).toBe(false);
  });

  it('requires one shipped i18n key per bucket (missingKeys() enforces both locales)', () => {
    const required = requiredKeys();
    for (const kind of FAILURE_KINDS) {
      expect(failureKey(kind)).toBe(`queue.failure.${kind}`);
      expect(required).toContain(failureKey(kind));
    }
  });
});
