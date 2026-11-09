/**
 * D-105 · E2E browser discovery must not depend on a developer's username,
 * cache directory or hard-coded build number. All filesystem access is injected
 * so these tests run on any OS without a browser installed.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  DEFAULT_EXPECTED_VERSION, resolveBrowserExecutable, resolveVersionPolicy,
} from '../../scripts/lib/find-browser.mjs';

interface Fakes {
  readonly exists: (path: string) => boolean;
  readonly listDir: (dir: string) => string[];
}

function fakes(files: readonly string[] = [], dirs: Record<string, string[]> = {}): Fakes {
  return {
    exists: (path) => files.includes(path),
    listDir: (dir) => dirs[dir] ?? [],
  };
}

describe('browser discovery · explicit override', () => {
  it('uses YTVDLT_CHROME_EXE first, whatever the platform cache contains', () => {
    const exe = 'D:/tools/chrome-headless-shell.exe';
    const result = resolveBrowserExecutable({
      env: { YTVDLT_CHROME_EXE: exe },
      platform: 'linux',
      home: '/home/someone-else',
      ...fakes([exe, '/usr/bin/google-chrome'], {}),
    });
    expect(result.path).toBe(exe);
    expect(result.source).toBe('env:YTVDLT_CHROME_EXE');
    expect(result.guidance).toBe('');
  });

  it('reports a bad override instead of silently falling through to another browser', () => {
    const result = resolveBrowserExecutable({
      env: { YTVDLT_CHROME_EXE: 'C:/missing/chrome.exe' },
      platform: 'win32',
      home: 'C:/Users/other',
      ...fakes([], {}),
    });
    expect(result.path).toBeNull();
    expect(result.guidance).toContain('YTVDLT_CHROME_EXE');
    expect(result.guidance).toContain('npx playwright install chromium-headless-shell');
  });
});

describe('browser discovery · automatic candidates', () => {
  it('picks the newest Playwright build and skips builds without an executable', () => {
    const root = join('C:/Users/other', 'AppData/Local/ms-playwright');
    const chosen = join(root, 'chromium_headless_shell-1240', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    const result = resolveBrowserExecutable({
      env: {},
      platform: 'win32',
      home: 'C:/Users/other',
      ...fakes([chosen], {
        [root]: ['chromium_headless_shell-1234', 'chromium_headless_shell-1240', 'chromium-9999'],
      }),
    });
    expect(result.path).toBe(chosen);
    expect(result.source).toBe('playwright-cache');
  });

  it('prefers headless-shell over a full Chrome build with a higher number (baseline carrier)', () => {
    const root = join('C:/Users/other', 'AppData/Local/ms-playwright');
    const shell = join(root, 'chromium_headless_shell-1234', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    const full = join(root, 'chromium-9999', 'chrome-win64', 'chrome.exe');
    const result = resolveBrowserExecutable({
      env: {}, platform: 'win32', home: 'C:/Users/other',
      ...fakes([shell, full], { [root]: ['chromium-9999', 'chromium_headless_shell-1234'] }),
    });
    expect(result.path).toBe(shell);
  });

  it('honours PLAYWRIGHT_BROWSERS_PATH for a custom cache root', () => {
    const root = 'D:/browsers';
    const chosen = join(root, 'chromium_headless_shell-1300', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    const result = resolveBrowserExecutable({
      env: { PLAYWRIGHT_BROWSERS_PATH: root },
      platform: 'win32',
      home: 'C:/Users/other',
      ...fakes([chosen], { [root]: ['chromium_headless_shell-1300'] }),
    });
    expect(result.path).toBe(chosen);
  });

  it('falls back to a system Chrome installation', () => {
    const chrome = join('C:/Program Files', 'Google/Chrome/Application/chrome.exe');
    const result = resolveBrowserExecutable({
      env: {}, platform: 'win32', home: 'C:/Users/other',
      ...fakes([chrome], {}),
    });
    expect(result.path).toBe(chrome);
    expect(result.source).toBe('system');
  });

  it('finds a Chromium on PATH without depending on a Windows user directory', () => {
    // `join` keeps the separator consistent with the module on every host OS.
    const candidate = join('/opt/bin', 'chromium');
    const result = resolveBrowserExecutable({
      env: { PATH: '/opt/bin:/usr/bin' },
      platform: 'linux',
      home: '/home/other',
      pathDelimiter: ':',
      ...fakes([candidate], {}),
    });
    expect(result.path).toBe(candidate);
    expect(result.source).toBe('PATH');
  });

  it('prints installation guidance when nothing is available', () => {
    const result = resolveBrowserExecutable({
      env: { PATH: '' }, platform: 'linux', home: '/home/other', ...fakes([], {}),
    });
    expect(result.path).toBeNull();
    expect(result.guidance).toContain('npx playwright install chromium-headless-shell');
    expect(result.guidance).toContain('PLAYWRIGHT_BROWSERS_PATH');
    expect(result.guidance).toContain('YTVDLT_E2E_EXPECT_VERSION');
    expect(result.guidance).toContain(DEFAULT_EXPECTED_VERSION);
  });
});

describe('browser discovery · version policy', () => {
  it('keeps the baseline build as the strict default', () => {
    const policy = resolveVersionPolicy({});
    expect(policy.expected).toBe(DEFAULT_EXPECTED_VERSION);
    expect(policy.allowMismatch).toBe(false);
  });

  it('lets another machine override the expected version or explicitly opt out', () => {
    expect(resolveVersionPolicy({ YTVDLT_E2E_EXPECT_VERSION: 'Chromium 130.0.1.2' }).expected)
      .toBe('Chromium 130.0.1.2');
    expect(resolveVersionPolicy({ YTVDLT_E2E_ALLOW_VERSION_MISMATCH: '1' }).allowMismatch).toBe(true);
    expect(resolveVersionPolicy({ YTVDLT_E2E_ALLOW_VERSION_MISMATCH: '0' }).allowMismatch).toBe(false);
  });
});
