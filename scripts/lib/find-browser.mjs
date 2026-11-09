#!/usr/bin/env node
/**
 * find-browser.mjs — resolve the headless Chromium used by `run-e2e.mjs`.
 *
 * D-105: the old script hard-coded one developer's absolute path
 * (`C:\Users\leolee\AppData\Local\ms-playwright\chromium_headless_shell-1234\...`),
 * so the test suite could not run on any other machine. Discovery order:
 *
 *   1. explicit env override (YTVDLT_CHROME_EXE / CHROME_HEADLESS_SHELL / CHROME_PATH);
 *   2. PLAYWRIGHT_BROWSERS_PATH, else the OS default ms-playwright cache —
 *      newest `chromium_headless_shell-*` / `chromium-*` build wins;
 *   3. a system Chrome/Chromium installation;
 *   4. executables on PATH.
 *
 * When nothing is found the caller prints `guidance` (install command + env
 * override + version policy) instead of crashing with ENOENT. No new npm
 * dependency: only `node:fs` / `node:path` / `node:os`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const ENV_OVERRIDES = ['YTVDLT_CHROME_EXE', 'CHROME_HEADLESS_SHELL', 'CHROME_PATH'];
export const DEFAULT_EXPECTED_VERSION = 'Google Chrome for Testing 151.0.7922.34';

/** Relative paths inside one Playwright browser build, most specific first. */
function buildSubpaths(platform) {
  if (platform === 'win32') {
    return [
      'chrome-headless-shell-win64/chrome-headless-shell.exe',
      'chrome-win/headless_shell.exe',
      'chrome-win64/chrome.exe',
      'chrome-win/chrome.exe',
    ];
  }
  if (platform === 'darwin') {
    return [
      'chrome-headless-shell-mac64/chrome-headless-shell',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return [
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-linux/headless_shell',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
  ];
}

function systemCandidates(platform, env, home) {
  if (platform === 'win32') {
    const programFiles = env['PROGRAMFILES'] ?? 'C:/Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)';
    const localAppData = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return [
      join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      join(localAppData, 'Google/Chrome/Application/chrome.exe'),
      join(programFiles, 'Chromium/Application/chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome', '/snap/bin/chromium',
  ];
}

function defaultCacheRoot(platform, env, home) {
  if (platform === 'win32') return env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'ms-playwright') : join(home, 'AppData/Local/ms-playwright');
  if (platform === 'darwin') return join(home, 'Library/Caches/ms-playwright');
  return join(home, '.cache/ms-playwright');
}

/** Numeric directory sort: chromium_headless_shell-1240 beats -1234. */
function versionOf(name) {
  const match = /-(\d+)/.exec(name);
  return match === null ? -1 : Number(match[1]);
}

function newestFirst(names) {
  return names
    .filter((name) => /^(chromium_headless_shell|chromium)-\d+/.test(name))
    .sort((a, b) => versionOf(b) - versionOf(a));
}

export function browserGuidance(reason = '', expectedVersion = DEFAULT_EXPECTED_VERSION) {
  return [
    '[e2e] 未找到可执行的 Chromium / Chrome（截图基线依赖无头浏览器）。',
    ...(reason === '' ? [] : [`原因：${reason}`]),
    '解决方式（任选其一）：',
    '  1. 安装缓存浏览器：npx playwright install chromium-headless-shell',
    '  2. 指定已有浏览器绝对路径：YTVDLT_CHROME_EXE=<绝对路径>',
    '     Windows PowerShell: $env:YTVDLT_CHROME_EXE = "C:\\path\\to\\chrome-headless-shell.exe"',
    '     Linux / macOS:      export YTVDLT_CHROME_EXE=/path/to/chrome-headless-shell',
    '  3. 浏览器在自定义缓存目录：PLAYWRIGHT_BROWSERS_PATH=<缓存根目录>',
    `版本提示：PNG 基线由「${expectedVersion}」生成。使用其它版本时请设置`,
    '  YTVDLT_E2E_EXPECT_VERSION="<该浏览器 --version 的输出>"，或',
    '  YTVDLT_E2E_ALLOW_VERSION_MISMATCH=1（跳过版本门槛，但像素基线可能整体不匹配，需按 case 重建）。',
  ].join('\n');
}

/**
 * @returns {{path: string|null, source: string|null, guidance: string}}
 * `guidance` is empty on success. All I/O is injectable for the unit tests.
 */
export function resolveBrowserExecutable(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const listDir = options.listDir ?? ((dir) => {
    try { return readdirSync(dir); } catch { return []; }
  });
  const home = options.home ?? homedir();
  const expectedVersion = options.expectedVersion ?? DEFAULT_EXPECTED_VERSION;
  const pathDelimiter = options.pathDelimiter ?? delimiter;

  // ① Explicit override wins — and an invalid override is an error, not a
  //    silent fall-through that would render with a different browser.
  for (const key of ENV_OVERRIDES) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value === '') continue;
    if (exists(value)) return { path: value, source: `env:${key}`, guidance: '' };
    return {
      path: null, source: null,
      guidance: browserGuidance(`${key} 指向的文件不存在：${value}`, expectedVersion),
    };
  }

  // ② Playwright cache (custom root first, then the OS default).
  const roots = [];
  const custom = typeof env['PLAYWRIGHT_BROWSERS_PATH'] === 'string'
    ? env['PLAYWRIGHT_BROWSERS_PATH'].trim() : '';
  if (custom !== '') roots.push(custom);
  roots.push(defaultCacheRoot(platform, env, home));
  const subpaths = buildSubpaths(platform);
  for (const root of roots) {
    const names = listDir(root);
    // The frozen PNG baselines were captured with `chrome-headless-shell`.
    // A full Chrome build renders differently (scrollbars / font raster), so
    // headless-shell builds ALWAYS win even when a full build has a higher
    // number. Only fall back to full Chromium when no shell is installed.
    const builds = [
      ...newestFirst(names.filter((name) => name.startsWith('chromium_headless_shell-'))),
      ...newestFirst(names.filter((name) => /^chromium-\d+/.test(name))),
    ];
    for (const build of builds) {
      for (const relative of subpaths) {
        const candidate = join(root, build, relative);
        if (exists(candidate)) return { path: candidate, source: 'playwright-cache', guidance: '' };
      }
    }
  }

  // ③ A system installation.
  for (const candidate of systemCandidates(platform, env, home)) {
    if (exists(candidate)) return { path: candidate, source: 'system', guidance: '' };
  }

  // ④ Anything on PATH.
  const names = platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'chrome-headless-shell.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'chrome-headless-shell'];
  const pathValue = typeof env['PATH'] === 'string' ? env['PATH'] : '';
  for (const directory of pathValue.split(pathDelimiter)) {
    if (directory.trim() === '') continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (exists(candidate)) return { path: candidate, source: 'PATH', guidance: '' };
    }
  }

  return { path: null, source: null, guidance: browserGuidance('自动发现未命中任何候选路径', expectedVersion) };
}

/**
 * Baseline PNGs were captured with one Chrome build. Keep that gate strict by
 * default, but let a different machine opt in WITHOUT loosening assertions.
 */
export function resolveVersionPolicy(env = process.env) {
  const custom = typeof env['YTVDLT_E2E_EXPECT_VERSION'] === 'string'
    ? env['YTVDLT_E2E_EXPECT_VERSION'].trim() : '';
  return {
    expected: custom === '' ? DEFAULT_EXPECTED_VERSION : custom,
    allowMismatch: env['YTVDLT_E2E_ALLOW_VERSION_MISMATCH'] === '1',
  };
}
