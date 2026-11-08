/**
 * Repeated-download naming (0.2.2, D-101).
 *
 * Problem this solves: `yt-dlp` does not overwrite an existing file — it prints
 * "has already been downloaded" and exits 0. The app then verified that old file,
 * tried to record it, found the same path already in history, and turned a
 * perfectly fine "the file is right there" into `ALREADY_DOWNLOADED` + Error.
 * From the user's side that reads as "your download failed", which is wrong.
 *
 * The fix is to give the second download its own name before it starts:
 * `Title [id].webm` → `Title [id] (1).webm` → ` (2)` and so on.
 *
 * Both functions here are pure and take plain strings, so the queue stays
 * testable without a filesystem.
 */

/**
 * `Title [abc] (2).webm` → 2, and `Title [abc] (2).en.vtt` → 2 as well.
 * Anchored at the end so a year in the title (`News (2024) [id].mp4`) is not
 * mistaken for a copy number.
 */
const NUMBERED_COPY = /[\s_]+\((\d+)\)(?=\.[^/\\]*$)/;

/**
 * Which suffix the NEXT copy needs: `''` when no file for `mediaId` exists yet,
 * otherwise ` (1)`, ` (2)`, … one above the highest number already on disk.
 *
 * Detection uses the `[<id>]` token the default template already contains. A
 * custom template without `%(id)s` cannot be matched here — callers get `''` and
 * keep their current naming, which only means the duplicate ends up being
 * reported as "already downloaded" instead of a second copy.
 */
export function nextCopySuffix(fileNames: readonly string[], mediaId: string): string {
  const id = String(mediaId ?? '').trim();
  if (id === '') return '';
  const token = `[${id}]`;
  let found = false;
  let highest = 0;
  for (const name of fileNames) {
    if (typeof name !== 'string' || !name.includes(token)) continue;
    found = true;
    const match = NUMBERED_COPY.exec(name);
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > highest) highest = value;
    }
  }
  if (!found) return '';
  // The queue sanitises the template (whitespace → `_`) before yt-dlp sees it,
  // so the on-disk separator is `_`. Emit that form directly instead of relying
  // on a later pass to rewrite it.
  return `_(${highest + 1})`;
}

/**
 * Insert the suffix into the output template, right before the extension
 * placeholder: `%(title).200B [%(id)s].%(ext)s` → `… [%(id)s] (1).%(ext)s`.
 *
 * Returns `null` when the template has no `%(ext)s` at all — the caller must
 * then leave naming alone rather than produce `Title (1)mp4`-style garbage.
 */
export function applyCopySuffix(template: string, suffix: string): string | null {
  const text = String(template ?? '');
  if (suffix === '') return text;
  const at = text.lastIndexOf('%(ext)s');
  if (at < 0) return null;
  // Insert BEFORE the dot that introduces the extension, so `X.%(ext)s` and
  // `X.%(ext)s.part` both become `X (1).%(ext)s…` rather than `X. (1)%(ext)s`.
  const cut = at > 0 && text[at - 1] === '.' ? at - 1 : at;
  return `${text.slice(0, cut)}${suffix}${text.slice(cut)}`;
}
