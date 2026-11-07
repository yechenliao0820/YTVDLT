/**
 * A-4.4-30 (JSONL + 12 sensitive-key classes all masked) and
 * A-4.5-09 (report fully redacted) — Logger/redactor exit contract.
 */
import { describe, it, expect } from 'vitest';
import {
  Logger, redact, redactArgv, redactText, detectComplianceBlocked,
  SENSITIVE_KEYS, REDACTED,
} from '@ytvdlt/core';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const SENSITIVE_SAMPLES: readonly (readonly [string, string])[] = [
  ['cookie', 'sessionid=abc123'],
  ['cookies', 'Netscape-cookie-value'],
  ['Set-Cookie', 'auth=secret-token'],
  ['authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9'],
  ['auth', 'Basic dXNlcjpwYXNz'],
  ['token', 'tok_live_123456'],
  ['po_token', 'PoToken==ABCD'],
  ['visitor_data', 'CgtQm9rZW4tRGF0YRAB'],
  ['password', 'hunter2'],
  ['passwd', 'passwd-value'],
  ['pwd', 'pwd-value'],
  ['secret', 'super-secret'],
  ['api_key', 'AIzaSyDUMMY'],
  ['apikey', 'apikey-dummy'],
  ['access_token', 'access-xyz'],
  ['refresh_token', 'refresh-xyz'],
  ['session', 'sess-xyz'],
  ['credential', 'cred-xyz'],
  ['proxy', 'http://user:pass@proxy.local:8080'],
];

describe('A-4.4-30 Logger · JSONL structure', () => {
  it('emits one parseable JSON object per line with ts/level/scope/event', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    await logger.info('engine.probe', 'spawn', { argv: ['-J'] });
    await logger.warn('config', 'config.corrupt');
    await logger.error('engine.probe', 'failed');
    expect(state.logLines).toHaveLength(3);
    for (const line of state.logLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed['ts']).toBe('string');
      expect(['INFO', 'WARNING', 'ERROR']).toContain(parsed['level']);
      expect(typeof parsed['scope']).toBe('string');
      expect(typeof parsed['event']).toBe('string');
    }
  });
});

describe('A-4.4-30 redactor · 12+ sensitive key classes', () => {
  it('covers at least 12 distinct sensitive key classes', () => {
    expect(SENSITIVE_KEYS.length).toBeGreaterThanOrEqual(12);
    expect(SENSITIVE_SAMPLES.length).toBeGreaterThanOrEqual(12);
  });

  it('masks EVERY sensitive key/value in a nested payload', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const payload: Record<string, unknown> = {
      nested: { argv: ['--cookies', 'C:/cookies.txt'], deeper: {} },
    };
    for (const [key, value] of SENSITIVE_SAMPLES) {
      (payload['nested'] as Record<string, unknown>)['deeper'] = {
        ...((payload['nested'] as Record<string, unknown>)['deeper'] as Record<string, unknown>),
        [key]: value,
      };
    }
    await logger.info('engine.probe', 'spawn', payload);
    const line = state.logLines[0] ?? '';
    expect(line).toContain(REDACTED);
    for (const [, value] of SENSITIVE_SAMPLES) {
      expect(line, `value ${value} must be masked`).not.toContain(value);
    }
  });

  it('redact() is a pure recursive function (no mutation of input)', () => {
    const input = { token: 'abc', nested: { password: 'def', safe: 1 } };
    const output = redact(input) as Record<string, unknown>;
    expect(output['token']).toBe(REDACTED);
    expect((output['nested'] as Record<string, unknown>)['password']).toBe(REDACTED);
    expect((output['nested'] as Record<string, unknown>)['safe']).toBe(1);
    expect(input.token).toBe('abc');
  });

  it('masks URL userinfo, inline secrets and Netscape cookies.txt rows', () => {
    expect(redactText('https://user:p4ss@example.com/v')).not.toContain('p4ss');
    expect(redactText('Cookie: session=abcdef')).not.toContain('abcdef');
    expect(redactText('Authorization: Bearer tok_abcdef')).not.toContain('tok_abcdef');
    expect(redactText('.example.com\tTRUE\t/\tTRUE\t0\tsession\tabcdef'))
      .toBe('# <redacted cookie line>');
  });
});

describe('A-4.4-30 logArgv · argv option values masked', () => {
  it('keeps option names but masks the following value element', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    await logger.logArgv('engine.probe', [
      '-J', '--cookies', 'C:/secret/cookies.txt',
      '--proxy', 'http://user:pass@proxy.local:8080',
      '--add-header', 'Cookie: session=secretvalue',
      '--', 'https://example.org/v',
    ]);
    const line = state.logLines[0] ?? '';
    expect(line).toContain('--cookies');
    expect(line).toContain('--proxy');
    expect(line).not.toContain('C:/secret/cookies.txt');
    expect(line).not.toContain('secretvalue');
    expect(line).not.toContain('p4ss');
    expect(line).toContain('https://example.org/v');
    expect(redactArgv(['--cookies=abc.txt'])).toEqual([`--cookies=${REDACTED}`]);
  });

  it('flags compliance-forbidden options with COMPLIANCE_BLOCKED WARNING', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    await logger.logArgv('engine.custom', ['--cookies-from-browser', 'chrome', '--geo-bypass-country', 'US']);
    const events = state.logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e['event'] === 'COMPLIANCE_BLOCKED' && e['level'] === 'WARNING')).toBe(true);
    expect(detectComplianceBlocked(['--cookies-from-browser'])).toContain('--cookies-from-browser');
  });
});

describe('A-4.5-09 Logger · crash report placeholder is versioned & redacted', () => {
  it('writeCrashReport returns a path and never logs raw credentials', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    const path = await logger.writeCrashReport(new Error('boom'), { token: 'secret-value' });
    expect(path).toContain('crash-');
    expect(state.files.has(path)).toBe(true);
    expect(state.files.get(path)).toContain('0.1.0');
    expect(state.files.get(path)).not.toContain('secret-value');
    expect(await logger.exportLogs()).toContain('crash');
  });
});

// M3 append-only (F065): A-4.4-30 redaction surface regression.
describe('M3 · A-4.4-30 redaction surface regression (append-only)', () => {
  it('masks --cookies / --proxy / --add-header / --replace-in-metadata / --ppa values', async () => {
    const { ports, state } = createInMemoryPorts();
    const logger = new Logger({ ports, appVersion: '0.1.0' });
    await logger.logArgv('engine.download', [
      '--cookies', 'C:/private/cookies.txt',
      '--proxy', 'http://alice:s3cr3t@proxy.local:8080',
      '--add-header', 'Cookie: session=abcdef',
      '--replace-in-metadata', 'title', '.+', 'Brand New Title',
      '--ppa', 'Crop=square',
      '--', 'https://example.org/v',
    ]);
    const line = state.logLines[0] ?? '';
    expect(JSON.parse(line) as Record<string, unknown>).toHaveProperty('ts');
    for (const secret of [
      'C:/private/cookies.txt', 's3cr3t', 'abcdef', 'Brand New Title', 'square',
    ]) {
      expect(line, `secret "${secret}" must be masked`).not.toContain(secret);
    }
    expect(line).toContain('--replace-in-metadata');
    expect(redactArgv(['--replace-in-metadata', 'title', '.+', 'New Title'])).toEqual([
      '--replace-in-metadata', REDACTED, REDACTED, REDACTED,
    ]);
  });

  it('flags --exec / --config-locations as compliance-blocked', () => {
    expect(detectComplianceBlocked(['--exec', 'calc.exe'])).toContain('--exec');
    expect(detectComplianceBlocked(['--config-locations', 'C:/evil'])).toContain('--config-locations');
  });
});
