/**
 * Pure redaction functions (ARCHITECTURE §4.6 / M3-F048).
 * ZERO I/O, ZERO `node:*` imports. Used by Logger AND ErrorMapper.
 * Uniform mask: `***REDACTED***`.
 *
 * M3 extends the redaction surface (A-4.4-30 regression): `--replace-in-metadata`
 * masks ALL THREE following values, and `--ppa` / `--downloader-args` mask one.
 */
export const REDACTED = '***REDACTED***';

/** 12+ sensitive key classes (case-insensitive, matched recursively). */
export const SENSITIVE_KEYS: readonly string[] = [
  'cookie', 'cookies', 'set-cookie', 'authorization', 'auth', 'token',
  'po_token', 'visitor_data', 'password', 'passwd', 'pwd', 'secret',
  'api_key', 'apikey', 'access_token', 'refresh_token', 'session',
  'credential', 'proxy',
] as const;

/**
 * argv options whose FOLLOWING N element(s) must be masked (option name kept).
 * M3: upgraded from a string[] to `Record<option, maskCount>` so that
 * `--replace-in-metadata title .+ <newTitle>` masks all three values.
 */
export const REDACT_VALUE_OPTIONS: Readonly<Record<string, number>> = {
  '--cookies': 1,
  '--add-header': 1,
  '--proxy': 1,
  '--password': 1,
  '--username': 1,
  '--twofactor': 1,
  '--video-password': 1,
  '--cookies-from-browser': 1,
  '--replace-in-metadata': 3,
  '--ppa': 1,
  '--downloader-args': 1,
};

/** Compliance-forbidden tokens (HANDOFF §6.7 / PRD-M3 §7): detected, never implemented. */
export const COMPLIANCE_BLOCKED_TOKENS: readonly string[] = [
  '--cookies-from-browser', '--geo-bypass-country', '--geo-bypass',
  '--no-check-certificates', '--prefer-insecure', 'po_token',
  // M3 additions.
  '--exec', '--config-locations',
] as const;

const KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
const VALUE_OPTION_SET = new Map(
  Object.entries(REDACT_VALUE_OPTIONS).map(([option, count]) => [option.toLowerCase(), count]),
);

const INLINE_SECRET_RE = /(cookie|set-cookie|authorization|bearer|token|po_token|api[_-]?key|secret|password|credential)\s*[:=]\s*([^\r\n]+)/gi;
const USERINFO_RE = /https?:\/\/[^/\s:@]+:[^/\s@]+@/gi;
const COOKIE_LINE_RE = /^[^\s#]+\t[^\t]*\t[^\t]*\t[^\t]*\t[^\t]*\t[^\t]+\t[^\t]+$/;

/** Redact a single string: inline secrets, URL userinfo, Netscape cookie rows. */
export function redactText(value: string): string {
  let out = value.replace(USERINFO_RE, (match) =>
    match.toLowerCase().startsWith('https') ? 'https://***:***@' : 'http://***:***@',
  );
  out = out.replace(INLINE_SECRET_RE, (_match, key: string) => `${key}: ${REDACTED}`);
  if (COOKIE_LINE_RE.test(out)) out = '# <redacted cookie line>';
  return out;
}

/** Recursively redact any nested value (objects / arrays / strings). */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = KEY_SET.has(key.toLowerCase()) ? REDACTED : redact(item);
    }
    return result;
  }
  return value;
}

/**
 * Mask the N value elements following a sensitive option in an argv[].
 * Option names are preserved; `--opt=value` forms are masked too.
 * Also redacts URL userinfo inside every argv element.
 */
export function redactArgvN(argv: readonly string[]): string[] {
  const output: string[] = [];
  let remaining = 0;
  if (!Array.isArray(argv)) return output;
  for (const raw of argv) {
    const element = redactText(typeof raw === 'string' ? raw : String(raw));
    if (remaining > 0) {
      output.push(REDACTED);
      remaining -= 1;
      continue;
    }
    const eq = element.indexOf('=');
    const optionName = (eq === -1 ? element : element.slice(0, eq)).toLowerCase();
    const maskCount = VALUE_OPTION_SET.get(optionName);
    if (maskCount !== undefined) {
      if (eq !== -1) {
        output.push(`${element.slice(0, eq + 1)}${REDACTED}`);
      } else {
        output.push(element);
        remaining = maskCount;
      }
      continue;
    }
    output.push(element);
  }
  return output;
}

/** Backward-compatible alias (M1 callers keep working). */
export function redactArgv(argv: readonly string[]): string[] {
  return redactArgvN(argv);
}

/**
 * M3 (A-4.4-30): recursively redact a LOG/REPORT payload. In addition to the
 * M1 sensitive-key rules, any all-string array is treated as an argv[] so that
 * M3 option VALUES (`--cookies`, `--proxy`, `--replace-in-metadata`, `--ppa`,
 * `--downloader-args`, ...) are masked even when they arrive nested inside a
 * crash report context object rather than through `logArgv()`.
 */
export function redactContext(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) {
      return redactArgvN(value as string[]);
    }
    return value.map((item) => redactContext(item));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = KEY_SET.has(key.toLowerCase()) ? REDACTED : redactContext(item);
    }
    return result;
  }
  return value;
}

/** Detect compliance-forbidden tokens in an argv[] (never implemented, only flagged). */
export function detectComplianceBlocked(argv: readonly string[]): string[] {
  const found: string[] = [];
  if (!Array.isArray(argv)) return found;
  for (const raw of argv) {
    const lower = String(raw).toLowerCase();
    for (const token of COMPLIANCE_BLOCKED_TOKENS) {
      if (lower.includes(token.toLowerCase())) found.push(token);
    }
  }
  return [...new Set(found)];
}
