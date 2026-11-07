/**
 * ArgvBuilder — PURE function `build(ProbeRequest): string[]` (M1: probe branch only).
 *
 * Frozen argv order (HANDOFF §6.5 step 3 / PRD §4 验收④ / A-INF-05):
 *   -J --dump-single-json --no-playlist --no-warnings --socket-timeout 5 -R 1
 *   --no-js-runtimes --js-runtimes node:<bundled node.exe abs path>
 *   [ --proxy <v> ] [ --cookies <v> ] [ --add-header <v> ]
 *   -- <url>
 *
 * HARD RULES: never concatenate a command string; never `shell:true`;
 * user-controlled tokens are placed AFTER `--`; `enginePath` never enters argv.
 */
import type { AppError, ProbeRequest } from '@ytvdlt/shared';

/** Every element of the frozen probe argv prefix (excluding optional network options). */
export const FROZEN_PROBE_PREFIX: readonly string[] = [
  '-J',
  '--dump-single-json',
  '--no-playlist',
  '--no-warnings',
  '--socket-timeout',
  '5',
  '-R',
  '1',
  '--no-js-runtimes',
] as const;

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const UNC_RE = /^\\\\/;
const CREDENTIAL_RE = /\/\/[^/@\s]+:[^/@\s]+@/;

/** Construct a plain, structured-clone-friendly AppError(INVALID_URL). */
export function invalidUrlError(raw: string, reason: string): AppError {
  const safeReason = reason.replace(CONTROL_CHAR_RE, '');
  return {
    code: 'INVALID_URL',
    message: '请输入合法的 http(s) 链接',
    detail: `rejected URL (${safeReason})`,
    retryable: false,
    report: `INVALID_URL: ${safeReason}`,
  };
}

/**
 * URL whitelist: only http(s), loopback allowed.
 * Rejects file:// / UNC / drive paths / relative paths / embedded credentials /
 * control characters. Security is enforced by argv[] + shell:false + `--`;
 * this whitelist only guards protocol + parseability + local-filesystem schemes.
 */
export function assertHttpUrl(raw: string): void {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw invalidUrlError(raw, 'empty URL');
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw invalidUrlError(raw, 'control characters');
  }
  if (UNC_RE.test(raw) || WINDOWS_DRIVE_RE.test(raw) || raw.startsWith('/') || raw.startsWith('.')) {
    throw invalidUrlError(raw, 'local filesystem path');
  }
  if (CREDENTIAL_RE.test(raw)) {
    throw invalidUrlError(raw, 'embedded credentials');
  }

  // Pure string parsing: `URL` is a DOM global and engine-ytdlp compiles with
  // lib ES2022 + `types: []`, so we must not depend on DOM/node typings.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (!scheme) {
    throw invalidUrlError(raw, 'unparseable URL');
  }
  // The regex always captures group 1 when it matches; String() avoids a
  // `?? ''` fallback branch that no input can reach (A-INF-05 100% branches).
  const protocol = String(scheme[1]).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    throw invalidUrlError(raw, `unsupported protocol ${protocol}:`);
  }
  const afterScheme = raw.slice(scheme[0].length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.length === 0) {
    throw invalidUrlError(raw, 'empty authority');
  }
  if (authority.includes('@')) {
    throw invalidUrlError(raw, 'embedded credentials');
  }
  // String() on the split head avoids unreachable `?? ''` branches; an empty
  // head naturally becomes 'undefined' and is rejected by the host check.
  const host = authority.startsWith('[')
    ? String(authority.slice(1).split(']')[0])
    : String(authority.split(':')[0]);
  if (host.length === 0 || /[^A-Za-z0-9._:\-]/.test(host)) {
    throw invalidUrlError(raw, 'invalid host');
  }
}

/** Build the probe argv. Pure: identical input always yields identical array. */
export function build(req: ProbeRequest): string[] {
  assertHttpUrl(req.url);
  const opts = req.opts;
  const argv: string[] = [
    '-J',
    '--dump-single-json',
    ...(opts.noPlaylist === false ? [] : ['--no-playlist']),
    // M4-4: only a playlist probe asks for the flat listing; the frozen probe
    // prefix (A-INF-05) is untouched for every default request.
    ...(opts.flatPlaylist === true ? ['--flat-playlist'] : []),
    '--no-warnings',
    '--socket-timeout',
    String(Math.max(1, Math.round((opts.timeoutMs ?? 5000) / 1000))),
    '-R',
    String(Math.max(0, Math.trunc(opts.retries ?? 1))),
    '--no-js-runtimes',
    '--js-runtimes',
    `node:${opts.jsRuntimePath}`,
  ];

  // Optional network options are fixed option + independent value, BEFORE `--`.
  if (opts.proxy !== undefined && opts.proxy.length > 0) {
    argv.push('--proxy', opts.proxy);
  }
  if (opts.cookiesFile !== undefined && opts.cookiesFile.length > 0) {
    argv.push('--cookies', opts.cookiesFile);
  }
  if (opts.userAgent !== undefined && opts.userAgent.length > 0) {
    argv.push('--add-header', `User-Agent:${opts.userAgent}`);
  }

  // `--` separator; the ONLY user-controllable token (URL) goes after it.
  argv.push('--', req.url);
  return argv;
}

/** Namespace re-export for callers that prefer an object. */
export const ArgvBuilder = { build, assertHttpUrl } as const;
