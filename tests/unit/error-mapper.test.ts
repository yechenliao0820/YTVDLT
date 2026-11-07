/**
 * A-4.5-03 (example.invalid -> UNSUPPORTED_SITE),
 * A-4.5-05 (timeout/DNS/403/429 mutually exclusive),
 * A-4.5-09 (report contains OS/appVersion/engineVersion/URL/full stderr, all redacted).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ErrorMapper, ORDERED_RULES, CODE_META, REDACTED,
} from '@ytvdlt/core';
import type { ErrorContext, ErrorCode } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const ctx = (overrides: Partial<ErrorContext> = {}): ErrorContext => ({
  url: 'https://example.org/watch?v=abc',
  stderr: '',
  engineVersion: '2026.10.26',
  appVersion: '0.1.0',
  os: 'Windows_NT 10.0.22631',
  argv: ['-J', '--dump-single-json', '--', 'https://example.org/watch?v=abc'],
  ...overrides,
});

describe('A-4.5-05 ErrorMapper · four network classes mutually exclusive', () => {
  const cases: readonly (readonly [string, ErrorCode])[] = [
    ['ERROR: unable to download webpage: HTTP Error 429: Too Many Requests', 'HTTP_429'],
    ['ERROR: unable to download webpage: HTTP Error 403: Forbidden', 'HTTP_403'],
    ['ERROR: unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>', 'DNS_FAILURE'],
    ['ERROR: unable to download video data: <urlopen error _ssl.c: The handshake operation timed out>', 'NETWORK_TIMEOUT'],
  ];

  it('maps each of the 4 stderr samples to its own distinct code', () => {
    const mapper = new ErrorMapper({ clock: createInMemoryPorts().ports.clock });
    const codes = cases.map(([stderr]) => mapper.map(stderr, ctx({ stderr })).code);
    expect(codes).toEqual(['HTTP_429', 'HTTP_403', 'DNS_FAILURE', 'NETWORK_TIMEOUT']);
    expect(new Set(codes).size).toBe(4);
  });

  it('uses an ORDERED rule table with FIRST-match semantics (priority 429>403>DNS>timeout)', () => {
    expect(ORDERED_RULES.slice(0, 4).map((r) => r.code)).toEqual([
      'HTTP_429', 'HTTP_403', 'DNS_FAILURE', 'NETWORK_TIMEOUT',
    ]);
    const mapper = new ErrorMapper();
    // A combined line must resolve to exactly the higher-priority class.
    expect(mapper.map('HTTP Error 429 Too Many Requests and timed out', ctx()).code).toBe('HTTP_429');
    expect(mapper.map('HTTP Error 403 Forbidden and timed out', ctx()).code).toBe('HTTP_403');
    expect(mapper.map('getaddrinfo failed and timed out', ctx()).code).toBe('DNS_FAILURE');
  });

  it('retryable flags match §4.7 (429/timeout/DNS true, 403 false)', () => {
    const mapper = new ErrorMapper();
    expect(mapper.map(cases[0][0], ctx()).retryable).toBe(true);
    expect(mapper.map(cases[1][0], ctx()).retryable).toBe(false);
    expect(mapper.map(cases[2][0], ctx()).retryable).toBe(true);
    expect(mapper.map(cases[3][0], ctx()).retryable).toBe(true);
  });

  it('fixture stderr-network.txt contains all four keyword families', () => {
    const text = fixture('stderr-network.txt');
    expect(text).toContain('timed out');
    expect(text).toContain('Temporary failure in name resolution');
    expect(text).toContain('HTTP Error 403');
    expect(text).toContain('HTTP Error 429');
  });
});

describe('A-4.5-03 ErrorMapper · unsupported site', () => {
  it('example.invalid stderr -> UNSUPPORTED_SITE, retryable=false, no throw', () => {
    const mapper = new ErrorMapper();
    const stderr = fixture('stderr-unsupported.txt');
    const error = mapper.map(stderr, ctx({ stderr }));
    expect(error.code).toBe('UNSUPPORTED_SITE');
    expect(error.retryable).toBe(false);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.detail).toContain('example.invalid');
  });

  it('fromCode(INVALID_URL) constructs a proactive AppError', () => {
    const mapper = new ErrorMapper();
    const error = mapper.fromCode('INVALID_URL', ctx());
    expect(error.code).toBe('INVALID_URL');
    expect(error.report).toContain('INVALID_URL');
  });

  it('falls back to UNKNOWN for unrecognised stderr and has metadata for all 17 codes', () => {
    const mapper = new ErrorMapper();
    expect(mapper.map('some completely novel failure', ctx()).code).toBe('UNKNOWN');
    expect(Object.keys(CODE_META)).toHaveLength(17);
  });
});

describe('A-4.5-09 ErrorMapper · report content + full redaction', () => {
  const sensitiveStderr = [
    'ERROR: Unsupported URL: https://example.invalid/watch?v=abc',
    'Cookie: session=SUPERSECRETCOOKIE',
    'Authorization: Bearer SUPERSECRETTOKEN',
    'proxy=http://alice:PA55WORD@proxy.local:8080',
    'password=SUPERSECRETPASSWORD',
  ].join('\n');
  const sensitiveCtx = ctx({
    url: 'https://alice:PA55WORD@example.org/watch?v=abc',
    stderr: sensitiveStderr,
    argv: ['-J', '--cookies', 'C:/secret/cookies.txt', '--proxy', 'http://alice:PA55WORD@proxy.local:8080'],
  });

  it('report contains timestamp/os/appVersion/engineVersion/code/url/stderr/argv', () => {
    const error = new ErrorMapper().map(sensitiveStderr, sensitiveCtx);
    const report = JSON.parse(error.report) as Record<string, unknown>;
    expect(report['code']).toBe('UNSUPPORTED_SITE');
    expect(report['os']).toBe('Windows_NT 10.0.22631');
    expect(report['appVersion']).toBe('0.1.0');
    expect(report['engineVersion']).toBe('2026.10.26');
    expect(typeof report['timestamp']).toBe('string');
    expect(String(report['url'])).toContain('example.org');
    expect(String(report['stderr'])).toContain('example.invalid');
    expect(Array.isArray(report['argv'])).toBe(true);
  });

  it('report masks cookies, credentials and URL userinfo (12 sensitive classes)', () => {
    const error = new ErrorMapper().map(sensitiveStderr, sensitiveCtx);
    expect(error.report).toContain(REDACTED);
    for (const secret of [
      'SUPERSECRETCOOKIE', 'SUPERSECRETTOKEN', 'SUPERSECRETPASSWORD',
      'PA55WORD', 'C:/secret/cookies.txt',
    ]) {
      expect(error.report, `${secret} must be absent`).not.toContain(secret);
      expect(error.detail, `${secret} must be absent from detail`).not.toContain(secret);
    }
  });
});
