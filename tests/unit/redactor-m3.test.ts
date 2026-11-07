/**
 * B1 / F036 · A-4.4-30 regression: M3's enlarged redaction surface.
 * --cookies / --proxy / --add-header / --replace-in-metadata / --ppa /
 * --downloader-args values must ALWAYS be masked, in argv, JSONL and reports.
 */
import { describe, it, expect } from 'vitest';
import {
  Logger, redact, redactArgv, redactArgvN, redactText, detectComplianceBlocked,
  REDACT_VALUE_OPTIONS, COMPLIANCE_BLOCKED_TOKENS, SENSITIVE_KEYS, REDACTED,
} from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const M3_ARGV: readonly string[] = [
  '--no-playlist',
  '--cookies', 'C:/secret/cookies.txt',
  '--proxy', 'http://user:p4ss@proxy.local:8080',
  '--add-header', 'User-Agent:SecretAgent/9.9',
  '--replace-in-metadata', 'title', '.+', 'My New Title',
  '--ppa', 'Crop=square_script',
  '--downloader-args', 'aria2c:C:/secret/aria2c.exe',
  '--', 'https://example.org/v',
];

const SECRETS: readonly string[] = [
  'C:/secret/cookies.txt', 'p4ss', 'SecretAgent/9.9',
  'My New Title', 'square_script', 'aria2c:C:/secret/aria2c.exe',
];

describe('B1 redactor · REDACT_VALUE_OPTIONS is a maskCount record', () => {
  it('declares 1 value for most options and 3 for --replace-in-metadata', () => {
    expect(REDACT_VALUE_OPTIONS['--cookies']).toBe(1);
    expect(REDACT_VALUE_OPTIONS['--proxy']).toBe(1);
    expect(REDACT_VALUE_OPTIONS['--add-header']).toBe(1);
    expect(REDACT_VALUE_OPTIONS['--ppa']).toBe(1);
    expect(REDACT_VALUE_OPTIONS['--downloader-args']).toBe(1);
    expect(REDACT_VALUE_OPTIONS['--replace-in-metadata']).toBe(3);
  });

  it('keeps the M1 sensitive-key classes and adds compliance tokens', () => {
    expect(SENSITIVE_KEYS.length).toBeGreaterThanOrEqual(12);
    expect(COMPLIANCE_BLOCKED_TOKENS).toContain('--exec');
    expect(COMPLIANCE_BLOCKED_TOKENS).toContain('--config-locations');
    expect(COMPLIANCE_BLOCKED_TOKENS).toContain('--cookies-from-browser');
  });
});

describe('B1 redactor · redactArgvN masks every M3 value', () => {
  it('masks ALL following values, preserving option names and the URL', () => {
    const out = redactArgvN(M3_ARGV);
    expect(out).toContain('--cookies');
    expect(out).toContain('--proxy');
    expect(out).toContain('--add-header');
    expect(out).toContain('--replace-in-metadata');
    expect(out).toContain('--ppa');
    expect(out).toContain('--downloader-args');
    expect(out.at(-1)).toBe('https://example.org/v');
    for (const secret of SECRETS) {
      expect(out.join(' '), `secret "${secret}" must be masked`).not.toContain(secret);
    }
    expect(out.filter((x) => x === REDACTED)).toHaveLength(8);
  });

  it('masks --opt=value forms for every M3 option', () => {
    const out = redactArgvN([
      '--cookies=abc.txt', '--proxy=http://u:p@h', '--add-header=Cookie: session=abc',
      '--ppa=Crop=evil', '--downloader-args=aria2c:secret',
    ]);
    for (const item of out) expect(item.endsWith(`=${REDACTED}`)).toBe(true);
    expect(out.join(' ')).not.toContain('abc.txt');
    expect(out.join(' ')).not.toContain('evil');
  });

  it('redactArgv is backward-compatible and delegates to redactArgvN', () => {
    expect(redactArgv(['--cookies=abc.txt'])).toEqual([`--cookies=${REDACTED}`]);
    expect(redactArgv(M3_ARGV)).toEqual(redactArgvN(M3_ARGV));
    expect(redactArgv(['--replace-in-metadata', 'title', '.+', 'New Title'])).toEqual([
      '--replace-in-metadata', REDACTED, REDACTED, REDACTED,
    ]);
  });

  it('is defensive against non-array / non-string input', () => {
    expect(redactArgvN(null as unknown as string[])).toEqual([]);
    expect(redactArgv([42 as unknown as string])).toEqual(['42']);
  });
});

describe('B1 redactor · compliance detection + nested/report redaction', () => {
  it('detects every PRD §7 forbidden token', () => {
    const found = detectComplianceBlocked([
      '--exec', '--config-locations', '--cookies-from-browser',
      '--geo-bypass-country', '--no-check-certificates', '--prefer-insecure', 'po_token=ABC',
    ]);
    for (const token of [
      '--exec', '--config-locations', '--cookies-from-browser',
      '--geo-bypass-country', '--no-check-certificates', '--prefer-insecure', 'po_token',
    ]) expect(found).toContain(token);
    expect(detectComplianceBlocked([])).toEqual([]);
    expect(detectComplianceBlocked(null as unknown as string[])).toEqual([]);
  });

  it('redact() still masks nested sensitive keys and inline secrets', () => {
    const out = redact({ token: 'abc', nested: { password: 'def', proxy: 'http://u:p@h' } }) as Record<string, unknown>;
    expect(out['token']).toBe(REDACTED);
    expect((out['nested'] as Record<string, unknown>)['password']).toBe(REDACTED);
    expect((out['nested'] as Record<string, unknown>)['proxy']).toBe(REDACTED);
    expect(redactText('https://user:p4ss@example.com/v')).not.toContain('p4ss');
  });
});

describe('B1 redactor · Logger JSONL + crash report stay fully redacted', () => {
  it('logArgv emits one JSONL line with M3 option names but no secret values', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    await logger.logArgv('engine.download', M3_ARGV);
    const line = state.logLines[0] ?? '';
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(typeof parsed['ts']).toBe('string');
    expect(typeof parsed['level']).toBe('string');
    expect(line).toContain('--replace-in-metadata');
    for (const secret of SECRETS) expect(line, `secret "${secret}" leaked into log`).not.toContain(secret);
  });

  it('writeCrashReport masks M3 argv and report fields', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const path = await logger.writeCrashReport(new Error('boom'), {
      argv: M3_ARGV, cookie: 'session=secret', proxy: 'http://u:p@h',
    });
    const body = state.files.get(path) ?? '';
    expect(body).toContain('0.1.0');
    for (const secret of SECRETS) expect(body).not.toContain(secret);
    expect(body).not.toContain('session=secret');
  });
});
