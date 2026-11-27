/**
 * PathResolver — pure Windows filesystem-boundary functions (M3-F009).
 *
 * ZERO electron / ZERO node:* imports: this module only transforms strings.
 * It is consumed by `resolveDownloadPlan()` (B1) and by `buildDownload()` (B3),
 * and is exhaustively tested by tests/unit/path-resolver.test.ts (B2).
 *
 * Fixed purification order (Q-M3-09 / D-43), never reordered:
 *   ⓪ sanitizeToken(template)   // argv safety on the raw template FIRST, the
 *                               // same call at the same point as the planner
 *                               // (download-plan.ts) — external online audit P3
 *   ① renderTemplate()          // %(title)s/%(id)s/%(ext)s/%(playlist)s/%(extractor_key)s
 *                               // (+ D-275: `%(field|default)s` defaults)
 *   ② sanitizeFileName()        // illegal chars / reserved names / trailing dot or space
 *   ③ buildOutputDir()          // ROOT ONLY — the categorized subdirectory
 *                               // layers live in the `-o` template prefix
 *                               // (categorizedTemplatePrefix, D-275): `-P`
 *                               // never carries a `%(…)` token, because the
 *                               // engine's `get_output_path()` does not
 *                               // field-expand `-P` values.
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
/** yt-dlp output-template token, e.g. `%(title)s`, `%(title).200B` or
 * `%(playlist|)s` (the `|` group is the engine's default-value syntax: a
 * missing/empty field renders the default instead of the NA placeholder —
 * D-275, used by the categorized-directory prefix). */
const TEMPLATE_RE = /%\((\w+)(?:\|([^)]*))?\)(?:\.(\d+)B)?s?/g;

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

/**
 * D-254: fail-closed companion of `expandEnvVars()`. `expandEnvVars()` keeps an
 * unresolvable token verbatim ON PURPOSE (a typo stays visible), but the RESULT
 * of that policy must never reach an argv: a directory still carrying a
 * `%NAME%` token is spawned literally (no shell, D-79) — yt-dlp creates a
 * folder named `%LOCALAPPDATA%` and the artifact containment gate (D-184/203)
 * then refuses every file. This predicate uses the SAME `%([^%]+)%` rule as
 * `expandEnvVars()`, so "true" means exactly "expandEnvVars still had a token
 * it could not resolve". It is a DIRECTORY check only — never run it on an
 * output template, where `%(title)s` is supposed to survive.
 */
export function hasUnresolvedEnvToken(value: string): boolean {
  return typeof value === 'string' && /%([^%]+)%/.test(value);
}

/**
 * Render the five supported yt-dlp output-template tokens. Unknown tokens
 * survive.
 *
 * D-275: a token carrying yt-dlp's default-value syntax (`%(field|default)s`)
 * renders the default when the field is missing / null / EMPTY — the engine
 * treats an empty value as unavailable exactly the same way (the sanitize step
 * turns `''` back into None). Without a default, behaviour is unchanged.
 */export function renderTemplate(template: string, vars: TemplateVars): string {
  if (typeof template !== 'string' || template.length === 0) return '';
  return template.replace(TEMPLATE_RE, (match, key: string, fallback: string | undefined, limit: string | undefined) => {
    const raw = key in vars ? vars[key as keyof TemplateVars] : undefined;
    const available = raw !== undefined && raw !== null && String(raw) !== '';
    if (!available && fallback !== undefined) return fallback;
    if (!(key in vars)) return match;
    const value = String(raw ?? '');
    if (limit === undefined) return value;
    const max = Number(limit);
    return Number.isFinite(max) && max > 0 ? value.slice(0, max) : value;
  });
}

/**
 * The output ROOT handed to `-P` (yt-dlp's "home" path). Strips trailing
 * separators; falls back to `paths.videoDir` when the supplied base dir is not
 * a usable string (audio mode passes `paths.audioDir`).
 *
 * D-229 (audit P1): private mode NO LONGER rewrites the root here.
 *
 * It used to return `PRIVATE_OUTPUT_DIR` — a `%LOCALAPPDATA%/…` TOKEN — for
 * every private request. `-P` is passed to a spawned process (no shell), so the
 * token reached yt-dlp verbatim and the download landed in a literal
 * `%LOCALAPPDATA%` folder (the D-79 failure mode); the recorded artifacts were
 * then outside the request's output roots and the D-184/203 containment gate
 * refused them, i.e. every private download failed. The switch was also never
 * actually on (the UI wrote `general.privateMode`, intake read
 * `paths.privateMode`), which is why nobody saw it.
 *
 * Routing now happens ONCE, at intake (`m4-host.ts::readDefaults` expands the
 * private directory and writes it into `request.paths.videoDir` / `audioDir`).
 *
 * D-275 (external audit P2): this function ALSO used to append the
 * categorized subdirectories as literal `%(extractor_key)s` / `%(playlist)s`
 * tokens when `subdirByExtractor` / `subdirByPlaylist` were on. The engine's
 * `get_output_path()` — the code path behind `-P` — only runs `expand_path()`
 * (env vars / tilde) plus `sanitize_path()` on the value; output-template
 * FIELD substitution happens in a different path (`prepare_outtmpl` →
 * `evaluate_outtmpl`, i.e. `-o`). So those tokens reached the filesystem
 * VERBATIM and every categorized download landed in directories literally
 * named `%(extractor_key)s` / `%(playlist)s`. The dynamic segments now live in
 * the `-o` template prefix built by {@link categorizedTemplatePrefix}, which
 * the engine DOES field-expand. `-P` must never carry a `%(…)` token again.
 */
export function buildOutputDir(
  paths: PathsDomain,
  baseDir: string = paths.videoDir,
): string {
  const root = (typeof baseDir === 'string' && baseDir.length > 0 ? baseDir : paths.videoDir)
    .replace(/[\\/]+$/, '');
  return root;
}

/**
 * D-275: the categorized subdirectory layers as an OUTPUT TEMPLATE prefix
 * (they belong in `-o`, never in `-P` — see {@link buildOutputDir}). Returns
 * `''` when both switches are off; otherwise
 * `%(extractor_key)s` / `%(playlist|.)s` / both joined with `/`.
 *
 * The `|` in `%(playlist|.)s` is yt-dlp's default-value syntax: a single video
 * has no playlist (the field is None) and without a default the engine would
 * render its NA placeholder — a literal `NA` directory.
 *
 * D-290: the default is `.`, NOT the empty string. With `|` empty the rendered
 * template STARTS with a separator (`/%(title)s…`) whenever the playlist layer
 * is the FIRST segment — i.e. `subdirByPlaylist` on and `subdirByExtractor`
 * off — and yt-dlp treats a template that starts with a separator as an
 * ABSOLUTE path: `-P <videoDir>` is bypassed and the media lands in the DRIVE
 * ROOT (`C:\Title.mp4`). The artifact is then rejected by the containment gate
 * (`artifact.outsideRoots`) and the task fails after a full download. A `.`
 * default renders a RELATIVE `./name` for the same case, which yt-dlp
 * normalises back into the output dir, and the playlist title is untouched
 * when the field exists. Verified against the bundled yt-dlp: single video →
 * `<out>/name`, playlist page → `<out>/<playlist>/name`.
 *
 * {@link renderTemplate} understands the same syntax and the preview drops
 * `.` segments, so the preview and the argv stay on one chain (D-270).
 */
export function categorizedTemplatePrefix(paths: PathsDomain): string {
  const segments: string[] = [];
  if (paths.subdirByExtractor === true) segments.push('%(extractor_key)s');
  if (paths.subdirByPlaylist === true) segments.push('%(playlist|.)s');
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
 *
 * external online audit P3: the preview and the real argv used to run on two
 * different template chains. `resolveDownloadPlan()` sanitizes the TEMPLATE
 * first (`sanitizeToken(rawTemplate)` in download-plan.ts — argv safety, which
 * collapses every whitespace run to `_`) and then hands it to yt-dlp, so the
 * shipped default template renders files as `Title_[id].mp4`. The preview
 * rendered the RAW template, so it announced `Title [id].mp4` for a file that
 * lands as `Title_[id].mp4`. The template now passes through the SAME
 * `sanitizeToken()` call at the SAME point (before rendering) so the preview
 * is honest. `sanitizeFileName()` and the truncation steps below are unchanged.
 *
 * Not represented here (by design): the planner's `chapter:` template prefix is
 * a yt-dlp per-chapter template SELECTOR, not filename content — it never
 * appears in an output file name, and the splitChapters decision lives in the
 * `advanced` domain which `PathsDomain` does not carry. The argv-side template
 * truncation (`truncateWindowsPath` on the template string in download-plan.ts)
 * guards the `-o` argv element, while the truncation below guards the RESOLVED
 * full path; both use the same `analyzeWindowsPath` boundary rules.
 */
export function resolveOutputPath(paths: PathsDomain, vars: TemplateVars): OutputPathResolution {
  // Same function, same point in the chain as download-plan.ts (`sanitizeToken`
  // on the raw template, before any rendering) — keep them literally identical.
  const safeTemplate = sanitizeToken(paths.outputTemplate);
  const rendered = renderTemplate(safeTemplate, vars);
  const sanitized = sanitizeFileName(rendered);
  const sanitizationApplied = sanitized !== rendered;
  const dir = buildOutputDir(paths);
  // D-275: the categorized layers are part of the TEMPLATE the engine really
  // receives (`-o` prefix), so the preview renders the same prefix through the
  // same renderer — one chain, per D-270. Each segment is sanitized like a
  // filename because yt-dlp sanitizes every field individually and a directory
  // segment IS a filename; the FILENAME portion below is still sanitized as
  // one string (registered residual difference, D-274 未覆盖).
  const prefixRendered = renderTemplate(categorizedTemplatePrefix(paths), vars);
  const prefix = prefixRendered
    .split('/')
    // D-290: `.` is the playlist layer's relative no-op default — it keeps the
    // argv template relative for a single video. The preview must not turn it
    // into a `_` directory (sanitizeFileName would strip the dot).
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeFileName(segment))
    .join('/');
  const full = prefix === '' ? `${dir}/${sanitized}` : `${dir}/${prefix}/${sanitized}`;
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
