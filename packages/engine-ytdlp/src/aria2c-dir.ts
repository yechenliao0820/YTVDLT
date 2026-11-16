/**
 * Directory-of-path helper for the download PATH prep in `runDownload()`:
 * yt-dlp resolves the external downloader through PATH, so the directory that
 * holds a user-supplied `aria2c.exe` has to be on it (aria2c goes first — a
 * user-supplied binary must win over the bundled one).
 *
 * Extracted VERBATIM from `yt-dlp-engine.ts` (task 7, low-risk pure-logic
 * migration — the old import path stays alive through re-exports there).
 * Pure string math: no `this`, no ports, no process, no I/O, no hidden
 * globals, no closure state — and deliberately no `node:path` import
 * (layering gate, `scripts/check-layering.mjs`).
 */

/** Directory part of an absolute Windows/POSIX path, without importing `node:path`. */
export function aria2cDirOf(aria2cPath: string | null): string | null {
  if (aria2cPath === null || aria2cPath.trim() === '') return null;
  const match = /^(.*)[\\/][^\\/]+$/.exec(aria2cPath.trim());
  return match?.[1] ?? null;
}
