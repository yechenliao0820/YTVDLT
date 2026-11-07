/**
 * Command-template validation (M4-5 — a SECURITY boundary, not a UI helper).
 *
 * The whitelist is positive: every option-shaped token must appear in
 * `ALLOWED_CUSTOM_OPTIONS`, and every value is checked against a per-option
 * grammar. A blacklist alone is never enough — `--exec`, `--config-locations`
 * and friend are rejected because they are NOT in the positive list.
 */
import type { AppError } from '@ytvdlt/shared';

/** Options a user template may contain (name → value policy id). */
export const ALLOWED_CUSTOM_OPTIONS: Readonly<Record<string, string>> = {
  '--format': 'format-id',
  '-f': 'format-id',
  '--merge-output-format': 'merge-format',
  '--write-subs': 'flag',
  '--sub-langs': 'langs',
  '--embed-subs': 'flag',
  '--convert-subs': 'sub-format',
  '--write-thumbnail': 'flag',
  '--embed-thumbnail': 'flag',
  '--embed-metadata': 'flag',
  '--download-sections': 'sections',
  '--sponsorblock-remove': 'sponsorblock',
  '--rate-limit': 'rate',
  '-r': 'rate',
  '--concurrent-fragments': 'count',
  '--retries': 'count',
  '-R': 'count',
  '--socket-timeout': 'count',
  '--no-mtime': 'flag',
  '--cookies': 'abs-path',
  '--output': 'rel-template',
  '-o': 'rel-template',
};

/** Options that must NEVER appear, even as a value-looking token. */
export const DENIED_CUSTOM_OPTIONS: readonly string[] = [
  '--exec', '--config-locations', '--cookies-from-browser',
  '--geo-bypass', '--geo-bypass-country', '--geo-bypass-ip-block',
  '--no-check-certificates', '--prefer-insecure', '--extractor-args',
  '--downloader', '--downloader-args', '--ppa', '--print', '--print-to-file',
  '--progress-template', '--js-runtimes', '--no-js-runtimes', '--ffmpeg-location',
];

const FLAG_POLICY = 'flag';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHELL_META_RE = /[|&;<>`$(){}[\]!^]/;
/** Format ids legitimately contain `[`, `]`, `<>`, `=`; those are not shell risks. */
const FORMAT_META_RE = /[|&;`$(){}!^]/;
/** yt-dlp output templates legitimately contain `%(field)s` (parentheses allowed). */
const TEMPLATE_META_RE = /[|&;<>`$[\]!^]/;
const OPTION_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/;
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

const VALUE_RULES: Readonly<Record<string, { re: RegExp; label: string }>> = {
  'format-id': { re: /^[A-Za-z0-9_+.,/:~*\[\]<>=!-]{1,80}$/, label: 'format id' },
  'merge-format': { re: /^(mp4|mkv|webm)$/, label: 'mp4|mkv|webm' },
  langs: { re: /^[A-Za-z0-9.,*_\-]{1,120}$/, label: 'language expression' },
  'sub-format': { re: /^(ass|srt|vtt|lrc)$/, label: 'ass|srt|vtt|lrc' },
  sections: { re: /^\*?[0-9:.+-]{1,60}$/, label: 'time section' },
  sponsorblock: { re: /^[a-z_]+(?:,[a-z_]+)*$/, label: 'sponsorblock categories' },
  rate: { re: /^[0-9]{1,6}[KMG]?$/, label: 'rate limit' },
  count: { re: /^[0-9]{1,4}$/, label: 'integer 0..9999' },
  'abs-path': { re: /^.{1,240}$/, label: 'absolute path' },
  'rel-template': { re: /^.{1,200}$/, label: 'relative output template' },
};

const MAX_ARGS = 40;
const MAX_ARG_LENGTH = 240;

export type TemplateValidation =
  | { ok: true }
  | { ok: false; code: 'CUSTOM_COMMAND_REJECTED'; reason: string; index: number };

const reject = (reason: string, index: number): TemplateValidation =>
  ({ ok: false, code: 'CUSTOM_COMMAND_REJECTED', reason, index });

/** Check one token that is NOT option-shaped. */
function validateValue(token: string, policy: string, index: number): TemplateValidation {
  if (CONTROL_RE.test(token)) return reject('control character', index);
  const metaRe = policy === 'format-id'
    ? FORMAT_META_RE
    : policy === 'rel-template' ? TEMPLATE_META_RE : SHELL_META_RE;
  if (metaRe.test(token)) return reject('shell metacharacter', index);
  if (token.length > MAX_ARG_LENGTH) return reject('value too long', index);
  if (token.startsWith('-')) return reject('value looks like an option', index);
  if (TRAVERSAL_RE.test(token)) return reject('path traversal', index);

  if (policy === 'abs-path') {
    if (!ABS_PATH_RE.test(token)) return reject('--cookies needs an absolute path', index);
    return { ok: true };
  }
  if (policy === 'rel-template') {
    if (ABS_PATH_RE.test(token)) return reject('output template must be relative', index);
  }
  const rule = VALUE_RULES[policy];
  if (rule === undefined) return reject(`unknown value policy ${policy}`, index);
  if (!rule.re.test(token)) return reject(`invalid ${rule.label}`, index);
  return { ok: true };
}

/**
 * Validate a template's argv ARRAY. Never accepts a command STRING: the caller
 * must have split it already, and `--` / `shell:true` are impossible inside.
 */
export function validateTemplateArgs(args: readonly unknown[]): TemplateValidation {
  if (!Array.isArray(args)) return reject('args must be an array', -1);
  if (args.length === 0) return reject('args must not be empty', -1);
  if (args.length > MAX_ARGS) return reject(`too many args (max ${MAX_ARGS})`, -1);

  let pendingPolicy: string | null = null;
  let pendingIndex = -1;

  for (const [index, raw] of args.entries()) {
    if (typeof raw !== 'string' || raw.length === 0) return reject('arg must be a non-empty string', index);
    if (raw === '--') return reject('the -- separator is reserved', index);
    if (CONTROL_RE.test(raw)) return reject('control character', index);

    if (OPTION_RE.test(raw)) {
      if (pendingPolicy !== null && pendingPolicy !== FLAG_POLICY) {
        return reject(`option ${String(args[pendingIndex])} is missing its value`, index);
      }
      if (DENIED_CUSTOM_OPTIONS.includes(raw)) return reject(`denied option ${raw}`, index);
      const policy = ALLOWED_CUSTOM_OPTIONS[raw];
      if (policy === undefined) return reject(`option not in allowlist: ${raw}`, index);
      pendingPolicy = policy;
      pendingIndex = index;
      continue;
    }

    if (pendingPolicy === null) return reject('value without an option', index);
    if (pendingPolicy === FLAG_POLICY) return reject('flag option takes no value', index);
    const result = validateValue(raw, pendingPolicy, index);
    if (!result.ok) return result;
    pendingPolicy = null;
    pendingIndex = -1;
  }

  if (pendingPolicy !== null && pendingPolicy !== FLAG_POLICY) {
    return reject(`option ${String(args[pendingIndex])} is missing its value`, args.length);
  }
  return { ok: true };
}

/** Convert a rejection into the frozen 17-code AppError (17th code). */
export function customCommandRejected(reason: string): AppError {
  return {
    code: 'CUSTOM_COMMAND_REJECTED',
    message: '自定义命令被拒绝',
    detail: reason,
    retryable: false,
    report: `CUSTOM_COMMAND_REJECTED: ${reason}`,
  };
}
