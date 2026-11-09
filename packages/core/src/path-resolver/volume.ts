/**
 * Where a download's intermediate files live (D-118).
 *
 * yt-dlp writes `.part`, `.part-FragN.part` and `.ytdl` next to the FINAL file
 * unless `-P temp:` says otherwise. Verified against the bundled yt-dlp
 * 2026.10.26: with `-P temp:` the partials appear only in the temp dir, a retry
 * prints `Resuming download at byte N`, and a successful run ends with
 * `[MoveFiles] Moving file ... to <output>` — i.e. the transfer is a MOVE, not
 * a second download.
 *
 * That move is a rename only while both paths are on one volume. Across
 * volumes `shutil.move` degrades to copy+unlink: the whole file is written
 * twice, the destination needs free space equal to the media size, and a
 * mid-copy failure leaves the user with neither a finished file nor a resumable
 * partial. So the rule here is deliberately conservative:
 *
 *   1. a temp dir the USER configured is honoured as-is (their call, their
 *      risk — documented, never silently overridden);
 *   2. otherwise, if the app's private work dir is on the same volume as the
 *      output, put the partials there — the media folder stays completely clean;
 *   3. otherwise fall back to a hidden subfolder INSIDE the output dir, which is
 *      the same volume by construction, so the final move is always a rename.
 *
 * Nothing in this module deletes anything, and nothing infers safety from a
 * file name or extension.
 */

/** Strip trailing separators without importing `node:path`. */
function stripTrailing(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

/**
 * The volume a path belongs to, as a comparable key.
 *
 *   `C:\a\b`            -> `c:`
 *   `c:/a`              -> `c:`
 *   `\\srv\share\x`     -> `\\srv\share`
 *   `\\?\C:\a`          -> `c:`          (long-path prefix removed)
 *   `\\?\UNC\srv\sh\a`  -> `\\srv\share`
 *   `/posix/a`          -> `/`
 *   anything relative   -> `''` (unknown)
 *
 * `''` means "cannot tell" and is NEVER treated as "same volume".
 */
export function volumeKeyOf(path: string): string {
  if (typeof path !== 'string') return '';
  let value = path.trim();
  if (value === '') return '';

  // Extended-length prefixes: \\?\C:\... and \\?\UNC\server\share\...
  if (/^\\\\\?\\UNC\\/i.test(value)) {
    value = `\\\\${value.slice(8)}`;
  } else if (/^\\\\\?\\/.test(value)) {
    value = value.slice(4);
  }

  // UNC share: the volume is the share, not the server.
  if (/^\\\\/.test(value)) {
    const parts = value.slice(2).split(/[\\/]+/).filter((part) => part !== '');
    return parts.length >= 2 ? `\\\\${parts[0]}\\${parts[1]}`.toLowerCase() : '';
  }

  // Drive letter (Windows).
  const drive = /^([A-Za-z]):/.exec(value);
  if (drive !== null && drive[1] !== undefined) return `${drive[1].toLowerCase()}:`;

  // POSIX absolute path: a single root volume.
  if (value.startsWith('/')) return '/';

  return '';
}

/** True only when both paths resolve to a KNOWN, identical volume. */
export function sameVolume(a: string, b: string): boolean {
  const left = volumeKeyOf(a);
  const right = volumeKeyOf(b);
  return left !== '' && right !== '' && left === right;
}

/** Folder inside the output directory used when no same-volume work dir exists. */
export const INCOMPLETE_DIR_NAME = '.ytvdlt-incomplete';

/**
 * A path segment that is safe to join. Task ids are generated internally today,
 * but the value also reaches a filesystem path, so anything outside the small
 * safe alphabet is replaced instead of trusted.
 */
export function sanitizeTaskSegment(taskId: string): string {
  if (typeof taskId !== 'string') return '';
  const cleaned = taskId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 64);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '' : cleaned;
}

export interface DownloadTempDirInput {
  /** Absolute output directory of THIS download (video or audio root). */
  readonly outputDir: string;
  /** `paths.tempDir` from config — a user decision when non-empty. */
  readonly configuredTempDir: string;
  /** The app-private work dir (`<dataDir>/work`). */
  readonly internalWorkDir: string;
  readonly taskId: string;
}

/**
 * Resolve where yt-dlp should park partial files.
 *
 * Returns `null` when no safe directory can be derived (no output dir, no
 * usable task id). `null` means "pass no `-P temp:` at all" — the pre-0.2.6
 * behaviour, which keeps partials next to the media but never breaks a
 * download for the sake of tidiness.
 */
export function resolveDownloadTempDir(input: DownloadTempDirInput): string | null {
  const task = sanitizeTaskSegment(input.taskId);
  if (task === '') return null;

  const configured = typeof input.configuredTempDir === 'string'
    ? input.configuredTempDir.trim() : '';
  // 1) Explicit user choice wins — including its volume. It still gets a
  //    per-task subfolder: two downloads into one shared temp dir would fight
  //    over `.part-FragN.part` and could let one task's retry adopt another
  //    task's partial bytes. A cross-volume temp dir means a copy at the end;
  //    that is the user's decision to make, not ours to override.
  if (configured !== '') return `${stripTrailing(configured)}/${task}`;

  const output = typeof input.outputDir === 'string' ? input.outputDir.trim() : '';
  if (output === '') return null;

  const work = typeof input.internalWorkDir === 'string' ? input.internalWorkDir.trim() : '';
  // 2) Same volume: use the app's private work dir. The media folder never sees
  //    a partial file, and the final move is still a rename.
  if (work !== '' && sameVolume(work, output)) return `${stripTrailing(work)}/${task}`;

  // 3) Different (or unknown) volume: stay inside the output dir. Same volume
  //    by construction, so no copy, no extra space, no cross-device failure.
  return `${stripTrailing(output)}/${INCOMPLETE_DIR_NAME}/${task}`;
}

/**
 * True when `dir` is one of the directories this module created for partials,
 * i.e. something the app may look at when deciding about leftover files.
 * Pure string test — no filesystem access, no deletion authority.
 */
export function isManagedTempDir(dir: string): boolean {
  if (typeof dir !== 'string') return false;
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === '') return false;
  return normalized.includes(`/${INCOMPLETE_DIR_NAME}/`)
    || /\/work\/[^/]+$/.test(normalized);
}
