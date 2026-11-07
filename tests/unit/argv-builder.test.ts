/**
 * A-INF-05 · ArgvBuilder probe branch — EXACT frozen argv order, no shell
 * string concatenation, URL whitelist rejects file:// / UNC / drive paths.
 * Covers EVERY branch of build()/assertHttpUrl() for 100% branch coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  build, assertHttpUrl, invalidUrlError, FROZEN_PROBE_PREFIX,
} from '@ytvdlt/engine-ytdlp';
import type { ProbeRequest, ProbeOptions } from '@ytvdlt/shared';

const ENGINE = 'C:/runtime/yt-dlp.exe';
const NODE = 'C:/runtime/node.exe';

const request = (overrides: Partial<ProbeRequest> = {}, opts: Partial<ProbeOptions> = {}): ProbeRequest => ({
  url: 'https://example.org/watch?v=abc',
  opts: { jsRuntimePath: NODE, ...opts },
  enginePath: ENGINE,
  ...overrides,
});

const EXPECTED_BASE = [
  '-J', '--dump-single-json', '--no-playlist', '--no-warnings',
  '--socket-timeout', '5', '-R', '1',
  '--no-js-runtimes', '--js-runtimes', `node:${NODE}`,
];

describe('A-INF-05 ArgvBuilder · frozen argv order', () => {
  it('produces the exact element-by-element frozen array', () => {
    const argv = build(request());
    expect(argv).toEqual([...EXPECTED_BASE, '--', 'https://example.org/watch?v=abc']);
    expect(FROZEN_PROBE_PREFIX).toEqual([
      '-J', '--dump-single-json', '--no-playlist', '--no-warnings',
      '--socket-timeout', '5', '-R', '1', '--no-js-runtimes',
    ]);
  });

  it('is a pure function: identical input returns an identical NEW array', () => {
    const req = request();
    const a = build(req);
    const b = build(req);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(req.url).toBe('https://example.org/watch?v=abc');
  });

  it('never places enginePath in argv and never joins into a command string', () => {
    const argv = build(request());
    expect(argv).not.toContain(ENGINE);
    expect(argv.every((element) => typeof element === 'string')).toBe(true);
    expect(argv.some((element) => /\s/.test(element))).toBe(false);
    expect(argv.filter((e) => e === '--')).toHaveLength(1);
    expect(argv[argv.length - 1]).toBe('https://example.org/watch?v=abc');
  });

  it('URL is the ONLY token after `--`; all fixed options are before it', () => {
    const argv = build(request({}, { proxy: 'http://proxy:8080', cookiesFile: 'C:/cookies.txt', userAgent: 'YTVDLT/1.0' }));
    const separator = argv.indexOf('--');
    expect(argv.slice(separator + 1)).toEqual(['https://example.org/watch?v=abc']);
    expect(argv.slice(0, separator)).toEqual([
      ...EXPECTED_BASE,
      '--proxy', 'http://proxy:8080',
      '--cookies', 'C:/cookies.txt',
      '--add-header', 'User-Agent:YTVDLT/1.0',
    ]);
  });

  it('honours timeoutMs / retries and the noPlaylist=false branch', () => {
    expect(build(request({}, { timeoutMs: 12_000, retries: 3 }))).toEqual([
      '-J', '--dump-single-json', '--no-playlist', '--no-warnings',
      '--socket-timeout', '12', '-R', '3',
      '--no-js-runtimes', '--js-runtimes', `node:${NODE}`,
      '--', 'https://example.org/watch?v=abc',
    ]);
    const withoutNoPlaylist = build(request({}, { noPlaylist: false }));
    expect(withoutNoPlaylist).not.toContain('--no-playlist');
    expect(withoutNoPlaylist[2]).toBe('--no-warnings');
  });

  it('omits optional network options when empty / undefined', () => {
    const argv = build(request({}, { proxy: '', cookiesFile: '', userAgent: '' }));
    expect(argv).toEqual([...EXPECTED_BASE, '--', 'https://example.org/watch?v=abc']);
    expect(build(request())).toEqual([...EXPECTED_BASE, '--', 'https://example.org/watch?v=abc']);
  });

  it('clamps non-positive timeout/retries to safe values', () => {
    const argv = build(request({}, { timeoutMs: 0, retries: -5 }));
    expect(argv[5]).toBe('1');
    expect(argv[7]).toBe('0');
  });
});

describe('A-INF-05 assertHttpUrl · whitelist', () => {
  it('allows http, https and loopback (U3 needs 127.0.0.1)', () => {
    expect(() => assertHttpUrl('https://example.org/a')).not.toThrow();
    expect(() => assertHttpUrl('http://example.org/a')).not.toThrow();
    expect(() => assertHttpUrl('http://127.0.0.1:14996/fixture.mp4')).not.toThrow();
    expect(() => assertHttpUrl('http://localhost:8080/fixture.mp4')).not.toThrow();
    expect(() => assertHttpUrl('https://example.org/a?b=1&c=2#frag')).not.toThrow();
  });

  it('rejects file://, ftp://, data:, javascript: and scheme-less input', () => {
    for (const url of [
      'file:///C:/secret.mp4', 'ftp://example.org/a', 'data:text/plain,hi',
      'javascript:alert(1)', 'example.org/a', 'not a url', '',
    ]) {
      expect(() => assertHttpUrl(url), url).toThrow();
    }
  });

  it('rejects UNC, Windows drive paths and relative paths', () => {
    for (const url of [
      '\\\\server\\share\\video.mp4', 'C:\\Videos\\a.mp4', 'C:/Videos/a.mp4',
      '/usr/local/a.mp4', './local.mp4', '../local.mp4',
    ]) {
      expect(() => assertHttpUrl(url), url).toThrow();
    }
  });

  it('rejects embedded credentials and control characters', () => {
    expect(() => assertHttpUrl('https://user:pass@example.org/a')).toThrow();
    expect(() => assertHttpUrl('https://example.org@evil.org/a')).toThrow();
    expect(() => assertHttpUrl('https://example.org/a\nSet-Cookie: x')).toThrow();
    expect(() => assertHttpUrl('https://example.org/a\u0000b')).toThrow();
  });

  it('rejects invalid hosts and unsupported protocols with AppError(INVALID_URL)', () => {
    for (const url of [
      'https://', 'https:///no-host', 'gopher://example.org/a',
      'http://exa mple.org/a', 'http://[bad host]/a',
    ]) {
      try {
        assertHttpUrl(url);
        expect.unreachable(`${url} should be rejected`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('INVALID_URL');
      }
    }
  });

  it('covers the IPv6-bracket, no-path and empty-authority branches', () => {
    expect(() => assertHttpUrl('http://[::1]:8080/fixture.mp4')).not.toThrow();
    expect(() => assertHttpUrl('https://example.org')).not.toThrow();
    expect(() => assertHttpUrl('http://[]/a')).toThrow();
  });

  it('build() propagates AppError(INVALID_URL) for a rejected URL', () => {
    try {
      build(request({ url: 'file:///C:/a.mp4' }));
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_URL');
      expect((error as { retryable?: boolean }).retryable).toBe(false);
    }
  });

  it('invalidUrlError returns a plain structured-clone-friendly AppError', () => {
    const error = invalidUrlError('x', 'test');
    expect(Object.getPrototypeOf(error)).toBe(Object.prototype);
    expect(error.code).toBe('INVALID_URL');
    expect(error.report).not.toContain('\n');
  });
});
