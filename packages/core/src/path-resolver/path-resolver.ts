/**
 * PathResolver — pure Windows filesystem-boundary functions (M3-F009).
 *
 * ZERO electron / ZERO node:* imports: this module only transforms strings.
 * It is consumed by `resolveDownloadPlan()` (B1) and by `buildDownload()` (B3),
 * and is exhaustively tested by tests/unit/path-resolver.test.ts (B2).
 *
 * Fixed purification order (Q-M3-09 / D-43), never reordered:
 *   ① renderTemplate()          // %(title)s/%(id)s/%(ext)s/%(playlist)s/%(extractor_key)s
 *   ② sanitizeFileName()        // illegal chars / reserved names / trailing dot or space
 *   ③ buildOutputDir()          // 4 combinations <dir>[/<extractor>][/<playlist>]
 *   ④ truncateWindowsPath()     // 259/260/261 boundary + \\?\ / \\?\UNC\ prefix
 *   ⑤ sanitizeToken()           // last argv-safety net: whitespace/control -> '_'
 */
import type { PathsDomain } from '@ytvdlt/shared';

export interface TemplateVars {
  title: string;
  id: string;
  ext: string;
  playlist: string;
  extractor_key: string;
}

export interface OutputPathResolution {
  dir: string;
  template: string;
  preview: string;
  sanitizationApplied: boolean;
  truncated: boolean;
  usedLongPathPrefix: boolean;
  warnings: string[];
}

export const WINDOWS_MAX_PATH = 260;
/** MAX_PATH includes the terminating NUL, so 259 characters is the last safe length. */
export const WINDOWS_SAFE_PATH = 259;
/** Source literals below encode the two Windows extended-length prefixes. */
export const LONG_PATH_PREFIX = '\\\\?\\';
export const LONG_UNC_PREFIX = '\\\\?\\UNC\\';
/** Private directory (no history writes; absolute-path template stays literal here). */
export const PRIVATE_OUTPUT_DIR = '%LOCALAPPDATA%/YTVDLT/private';

/** Three built-in output templates (A-M3-09); a custom template is also supported. */
export const BUILTIN_OUTPUT_TEMPLATES: Readonly<Record<string, string>> = {
  default: '%(title).200B [%(id)s].%(ext)s',
  simple: '%(title)s.%(ext)s',
  playlist: '%(playlist)s/%(title)s [%(id)s].%(ext)s',
};

/** Windows-illegal filename characters (9 classes) + control characters. */
const ILLEGAL_FILENAME_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Trailing dots/spaces are stripped by Win32 even when created deliberately. */
const TRAILING_DOT_SPACE_RE = /[. ]+$/g;
/** Whitespace + C0/C1 control characters; kept as a single `_` per run. */
const TOKEN_UNSAFE_RE = /[\s\u0000-\u001f\u007f]+/g;
/** yt-dlp output-template token, e.g. `%(title)s` or `%(title).200B`. */
const TEMPLATE_RE = /%\((\w+)\)(?:\.(\d+)B)?s?/g;

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * argv safety: replace whitespace / control characters with `_` so that every
 * argv element satisfies `!/\s/.test(element)` (A-M2-25). Path separators are
 * deliberately NOT replaced here: `--proxy http://…`, `C:/Videos` and `-o`
 * templates legitimately contain `/` (see D-34). They are handled by
 * `sanitizeFileName()` when a FILENAME is built.
 */
export function sanitizeToken(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(TOKEN_UNSAFE_RE, '_');
}

/**
 * Windows filename purification:
 *  - 9 illegal character classes `< > : " / \ | ? *` + control characters,
 *  - reserved device names (case-insensitive, INCLUDING extension variants
 *    such as `CON.txt` / `con`),
 *  - trailing dots / spaces.
 */
export function sanitizeFileName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return '_';
  let out = name.replace(ILLEGAL_FILENAME_RE, '_');
  out = out.replace(TRAILING_DOT_SPACE_RE, '');
  const stem = (out.split('.')[0] ?? '').trim().toUpperCase();
  if (RESERVED_NAMES.has(stem)) out = `_${out}`;
  if (out.length === 0) out = '_';
  return out;
}

/**
 * Expand Windows-style `%NAME%` references against an injected environment map.
 *
 * D-79: the shipped default output directory is `%USERPROFILE%/Downloads/YTVDLT`.
 * Nothing expands that token for a spawned process — no shell is involved — so a
 * literal directory named `%USERPROFILE%` was created next to the executable and
 * the artifact manifest came back empty (`ARTIFACT_INCOMPLETE`) on every fresh
 * install. The environment is injected so this stays pure and testable; unknown
 * names are left verbatim so a typo stays visible instead of silently becoming
 * an empty string.
 */
export function expandEnvVars(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (typeof value !== 'string' || value.indexOf('%') === -1) return value;
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const resolved = env[name];
    return typeof resolved === 'string' && resolved !== '' ? resolved : match;
  });
}

/** Render the five supported yt-dlp output-template tokens. Unknown tokens survive. */export function renderTemplate(template: string, vars: TemplateVars): string {
  if (typeof template !== 'string' || template.length === 0) return '';
  return template.replace(TEMPLATE_RE, (match, key: string, limit: string | undefined) => {
    if (!(key in vars)) return match;
    const value = String(vars[key as keyof TemplateVars] ?? '');
    if (limit === undefined) return value;
    const max = Number(limit);
    return Number.isFinite(max) && max > 0 ? value.slice(0, max) : value;
  });
}

/**
 * 4 combinations (00 / 10 / 01 / 11) of `subdirByExtractor` x `subdirByPlaylist`.
 * An optional baseDir selects `audioDir` (audio mode); privateMode always wins.
 */
export function buildOutputDir(
  paths: PathsDomain,
  extractorKey: string,
  playlistTitle: string,
  baseDir: string = paths.videoDir,
): string {
  const chosen = paths.privateMode === true ? PRIVATE_OUTPUT_DIR : baseDir;
  const root = (typeof chosen === 'string' && chosen.length > 0 ? chosen : paths.videoDir)
    .replace(/[\\/]+$/, '');
  const segments: string[] = [root];
  if (paths.subdirByExtractor === true) {
    const token = sanitizeToken(extractorKey);
    if (token.length > 0) segments.push(token);
  }
  if (paths.subdirByPlaylist === true) {
    const token = sanitizeToken(playlistTitle);
    if (token.length > 0) segments.push(token);
  }
  return segments.join('/');
}

export interface WindowsPathAnalysis {
  path: string;
  truncated: boolean;
  usedLongPathPrefix: boolean;
}

/**
 * 259 / 260 / 261 boundary + UNC + `\\?\` / `\\?\UNC\` prefixes.
 * Never throws: overly long input is truncated after applying the extended
 * prefix, so a long title produces a usable path instead of an exception.
 */
export function analyzeWindowsPath(path: string, max: number = WINDOWS_MAX_PATH): WindowsPathAnalysis {
  if (typeof path !== 'string' || path.length === 0) {
    return { path: '', truncated: false, usedLongPathPrefix: false };
  }
  const alreadyExtended = path.startsWith(LONG_PATH_PREFIX) || path.startsWith(LONG_UNC_PREFIX);
  // An explicit smaller max (used by tests / callers with stricter limits) must
  // be honoured even for paths shorter than the Windows MAX_PATH boundary.
  const safeLimit = Math.min(WINDOWS_SAFE_PATH, max);
  if (!alreadyExtended && path.length <= safeLimit) {
    return { path, truncated: false, usedLongPathPrefix: false };
  }
  const isUnc = path.startsWith('\\\\') && !alreadyExtended;
  const prefix = alreadyExtended ? '' : (isUnc ? LONG_UNC_PREFIX : LONG_PATH_PREFIX);
  let body = alreadyExtended ? path : (isUnc ? path.slice(2) : path);
  const capacity = Math.max(1, max - prefix.length);
  let truncated = false;
  if (body.length > capacity) {
    body = body.slice(0, capacity);
    truncated = true;
  }
  return {
    path: `${prefix}${body}`,
    truncated,
    usedLongPathPrefix: alreadyExtended || prefix.length > 0,
  };
}

/** String-returning wrapper around `analyzeWindowsPath` (design signature). */
export function truncateWindowsPath(path: string, max?: number): string {
  return analyzeWindowsPath(path, max).path;
}

/**
 * Q-M3-09 fixed order: render -> sanitize filename -> build dir -> truncate /
 * extended prefix. Returns a preview plus the flags the plan needs.
 */
export function resolveOutputPath(paths: PathsDomain, vars: TemplateVars): OutputPathResolution {
  const rendered = renderTemplate(paths.outputTemplate, vars);
  const sanitized = sanitizeFileName(rendered);
  const sanitizationApplied = sanitized !== rendered;
  const dir = buildOutputDir(paths, vars.extractor_key, vars.playlist);
  const full = `${dir}/${sanitized}`;
  const analysis = analyzeWindowsPath(full);
  const warnings: string[] = [];
  if (sanitizationApplied) warnings.push('FILE_NAME_SANITIZED');
  if (analysis.truncated) warnings.push('PATH_TRUNCATED');
  if (analysis.usedLongPathPrefix) warnings.push('LONG_PATH_PREFIX_APPLIED');
  return {
    dir,
    template: sanitized,
    preview: analysis.path,
    sanitizationApplied,
    truncated: analysis.truncated,
    usedLongPathPrefix: analysis.usedLongPathPrefix,
    warnings,
  };
}
