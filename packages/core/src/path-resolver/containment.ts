/**
 * Artifact containment (D-182) — which absolute paths may count as a task's
 * artifacts. Pure string functions; ZERO node:* / electron imports.
 *
 * The artifact manifest is produced by yt-dlp (`--print-to-file
 * "after_move:%(filepath)q"`), so its lines are filesystem paths that remote
 * site content can influence (pathological titles, extractor quirks).
 * `parseArtifactManifestDetailed()` (engine-ytdlp) only guarantees that a line
 * is ABSOLUTE — it has no opinion about WHERE the path points. Every consumer
 * of `TaskRecord.artifacts` however exercises real filesystem authority:
 * recycle-bin deletion (D-120 `withFiles`, D-131 subtitle cleanup), open-file
 * / open-folder (shell), history and the file-status probe. Without a
 * containment rule, a manipulated manifest could aim those at
 * `C:\Windows\...` or any user file.
 *
 * The rule: an artifact is acceptable only when it lies INSIDE one of the
 * task's own output roots, derived from the request that actually drove the
 * download (`paths.videoDir` / `audioDir` / per-task `tempDir`):
 *   - `tempDir` is already per-task (`resolveDownloadTempDir()`), so the
 *     app-private work dir, a user temp dir and the cross-volume
 *     `<outputDir>/.ytvdlt-incomplete/<taskId>` folder are roots as-is;
 *   - media, ` (n)` copies (D-101), subtitles, thumbnails and chapter
 *     subdirectories all land inside `videoDir` / `audioDir` by construction.
 *
 * Comparison semantics match the conventions the codebase already uses
 * (the manifest de-dup key, `TaskQueue.pathKeyOf()`, `volumeKeyOf()`):
 *   - separators normalized `\` -> `/`, runs collapsed (UNC keeps `//`);
 *   - extended-length prefixes `\\?\` / `\\?\UNC\` unwrapped;
 *   - case-insensitive (Windows manifests; consistent with `pathKeyOf`);
 *   - a `..` or `.` segment is ALWAYS rejected — a real yt-dlp path never
 *     contains one, and no URL decoding happens here: a literal `%2e%2e`
 *     segment is an ordinary (legal) file-name character on Windows;
 *   - the match is segment-bound: `C:/V` does NOT contain `C:/VideosEvil`.
 *
 * `roots` empty means "cannot judge" and fails OPEN on purpose: the queue
 * hard-fails any download whose request is null before a byte moves, so no
 * record produced by a real run ever reaches the gate rootless; refusing
 * everything for a degenerate legacy record would only break the frozen
 * D-120 cleanup semantics for data that was never manifest-derived.
 *
 * D-193 narrows that tolerance: it belongs to `request === null` legacy
 * records ONLY. A stored request whose paths produce no *specific* root is a
 * damaged / restored snapshot, not a legacy record — the shape guard in
 * task-store only checks that the five request domains are objects, so
 * `paths: {}` (or `videoDir: "C:/"`) sails through while BOTH the intake and
 * the action gate derive their roots from that SAME record. Every destructive
 * consumer now uses `trustedArtifactRoots()` and fails closed in that case.
 */

export interface ArtifactRootsInput {
  readonly videoDir?: string;
  readonly audioDir?: string;
  readonly tempDir?: string;
}

export interface ContainedPathSplit {
  kept: string[];
  rejected: string[];
}

const EXTENDED_UNC_RE = /^\\\\\?\\UNC\\/i;
const EXTENDED_RE = /^\\\\\?\\/;
const DOT_SEGMENT_RE = /(?:^|\/)\.{1,2}(?=\/|$)/;

/**
 * Normalize a path for containment comparison. `null` = not a usable path
 * (never contained): non-string-ish, empty, NUL-bearing, or carrying a `..` /
 * `.` segment. The result is comparable but NOT a valid path — never feed it
 * back to the filesystem.
 */
export function normalizedForContainment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes('\u0000')) return null;
  // Extended-length prefixes, unwrapped the same way volumeKeyOf() does.
  let out = EXTENDED_UNC_RE.test(trimmed)
    ? `\\\\${trimmed.slice(8)}`
    : (EXTENDED_RE.test(trimmed) ? trimmed.slice(4) : trimmed);
  out = out.replace(/\\/g, '/');
  // Collapse separator runs, but keep the double leading slash of a UNC path.
  const unc = out.startsWith('//');
  out = (unc ? '//' : '') + (unc ? out.slice(2) : out).replace(/\/{2,}/g, '/');
  // Strip trailing separators — but never reduce the POSIX root '/' away.
  if (out.length > 1) out = out.replace(/\/+$/, '');
  if (out === '' || DOT_SEGMENT_RE.test(out)) return null;
  return out.toLowerCase();
}

/**
 * The roots a task's artifacts may live under: the request's output roots,
 * normalized, de-duplicated (videoDir === audioDir is common) and in stable
 * order. Empty output is "cannot judge" — see the module comment.
 */
export function artifactRootsOf(paths: ArtifactRootsInput | null | undefined): readonly string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const raw of [paths?.videoDir, paths?.audioDir, paths?.tempDir]) {
    const normalized = normalizedForContainment(raw);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

/**
 * True only when `candidate` is strictly INSIDE one of `roots` (segment
 * bound, so the root directory itself and any sibling name are excluded).
 * `roots` may be raw or `artifactRootsOf()` output — every entry is
 * normalized here, and unusable roots are skipped. `roots` empty fails
 * open — see the module comment.
 */
export function isPathInsideRoots(candidate: unknown, roots: readonly string[]): boolean {
  const normalized = normalizedForContainment(candidate);
  if (normalized === null) return false;
  const normalizedRoots: string[] = [];
  for (const raw of roots ?? []) {
    const root = normalizedForContainment(raw);
    if (root !== null && !normalizedRoots.includes(root)) normalizedRoots.push(root);
  }
  if (normalizedRoots.length === 0) return true;
  for (const root of normalizedRoots) {
    // The POSIX root is the one case where "inside" is not a prefix+segment:
    // everything absolute that is not itself a UNC-style `//` path.
    if (root === '/') {
      if (normalized.startsWith('/') && !normalized.startsWith('//')) return true;
      continue;
    }
    if (normalized === root) continue;
    if (normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Order-preserving split. Never throws; unusable paths are rejected.
 */
export function splitArtifactsByRoots(
  paths: readonly string[] | null | undefined,
  roots: readonly string[],
): ContainedPathSplit {
  const kept: string[] = [];
  const rejected: string[] = [];
  for (const path of paths ?? []) {
    if (isPathInsideRoots(path, roots)) kept.push(path);
    else rejected.push(path);
  }
  return { kept, rejected };
}

/**
 * D-193 · Is a stored root specific enough to be trusted?
 *
 * A volume root (`C:` after normalisation), the POSIX root (`/`) or a bare
 * UNC share (`//host/share`) would make "inside" mean "almost anywhere".
 * Real download directories always have at least one segment below the
 * volume / share root (the defaults live under the user's Videos folder), so
 * discarding these costs nothing legitimate and stops a tampered snapshot
 * from widening the scope with `videoDir: "C:/"`.
 */
export function isSpecificRoot(root: string): boolean {
  const normalized = normalizedForContainment(root);
  if (normalized === null || normalized === '/') return false;
  // Trailing separators are already stripped, so a Windows volume root is `c:`.
  if (/^[a-z]:$/.test(normalized)) return false;
  if (normalized.startsWith('//')) {
    return normalized.slice(2).split('/').filter((part) => part !== '').length > 2;
  }
  return true;
}

/**
 * D-193 · Trusted containment scope for a STORED record's request.
 *
 * `isPathInsideRoots()` fails open on empty roots — a tolerance that exists
 * for `request === null` legacy records only. A record that DOES carry a
 * request but yields no specific roots is a damaged / restored snapshot;
 * failing open there lets an arbitrary path (`C:/Windows/...`) pass BOTH
 * gates, because both derive their roots from that same record.
 *
 * Returns `null` when no trustworthy root exists. Callers keep the legacy
 * fail-open ONLY when the record has no request at all; otherwise they must
 * fail closed. `artifactRootsOf()` is intentionally left unchanged so the
 * pure function and its pinned semantics stay intact.
 */
export function trustedArtifactRoots(
  paths: ArtifactRootsInput | null | undefined,
): readonly string[] | null {
  const roots = artifactRootsOf(paths).filter(isSpecificRoot);
  return roots.length > 0 ? roots : null;
}
