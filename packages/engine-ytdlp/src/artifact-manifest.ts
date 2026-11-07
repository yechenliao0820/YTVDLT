/**
 * Pure artifact-manifest parser (D3, A-M2-04 / A-M2-08).
 *
 * `yt-dlp --print-to-file "after_move:%(filepath)q"` APPENDS one line per
 * artifact, and the `q` filter wraps the value in outer quotes. This parser
 * therefore strips exactly ONE layer of matching quotes and never guesses.
 */

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\/;
const POSIX_ABSOLUTE = /^\//;
const TRANSIENT_SUFFIX = /\.(part|ytdl|temp)$/i;

export interface DroppedManifestLine {
  line: string;
  reason: 'not-absolute' | 'transient-file' | 'empty-after-unquote';
}

export interface ParsedArtifactManifest {
  paths: string[];
  dropped: DroppedManifestLine[];
}

/** Strip one layer of matching outer quotes (`"..."` or `'...'`). */
export function stripOneQuoteLayer(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function isAbsoluteArtifactPath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || POSIX_ABSOLUTE.test(value);
}

/** Detailed parse: absolute, non-transient, de-duplicated (order preserved). */
export function parseArtifactManifestDetailed(text: string): ParsedArtifactManifest {
  const paths: string[] = [];
  const dropped: DroppedManifestLine[] = [];
  const seen = new Set<string>();
  if (typeof text !== 'string' || text.length === 0) return { paths, dropped };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    const unquoted = stripOneQuoteLayer(trimmed).trim();
    if (unquoted.length === 0) {
      dropped.push({ line: trimmed, reason: 'empty-after-unquote' });
      continue;
    }
    if (!isAbsoluteArtifactPath(unquoted)) {
      // Never guess a base directory; the caller logs a WARNING instead.
      dropped.push({ line: unquoted, reason: 'not-absolute' });
      continue;
    }
    if (TRANSIENT_SUFFIX.test(unquoted)) {
      dropped.push({ line: unquoted, reason: 'transient-file' });
      continue;
    }
    const key = unquoted.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(unquoted);
  }
  return { paths, dropped };
}

/** Primary API: just the usable absolute artifact paths. */
export function parseArtifactManifest(text: string): string[] {
  return parseArtifactManifestDetailed(text).paths;
}

/** Unique, per-task manifest path (append trap: the engine unlinks it first). */
export function artifactManifestPath(tempDir: string, taskId: string): string {
  const base = tempDir.replace(/[\\/]+$/, '');
  // An empty base must NOT produce a leading slash (drive-root path).
  return base === ''
    ? `ytvdlt-artifacts-${taskId}.txt`
    : `${base}/ytvdlt-artifacts-${taskId}.txt`;
}

/**
 * D-68: with the shipped default `paths.tempDir = ''`, the expression above
 * becomes `/ytvdlt-artifacts-*.txt` — the drive root on Windows — and yt-dlp
 * fails with `Permission denied` even though the media file itself is fine.
 * Resolve the manifest directory to the explicit temp dir when present, and to
 * the request's output directory otherwise. Pure, so the fallback is testable
 * without a filesystem.
 */
export function resolveArtifactManifestDir(
  tempDir: string | null | undefined,
  videoDir: string,
  audioDir: string,
  extractAudio: boolean,
): string {
  const trimmed = typeof tempDir === 'string' ? tempDir.trim() : '';
  if (trimmed !== '') return trimmed;
  const fallback = extractAudio ? audioDir : videoDir;
  return typeof fallback === 'string' && fallback.trim() !== ''
    ? fallback
    : '';
}
