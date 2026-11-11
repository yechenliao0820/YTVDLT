/**
 * TXT 清单解析 — pure logic, ZERO `node:*` / ZERO I/O.
 *
 * A TXT import is two separate decisions, and this module deliberately makes
 * only the first one:
 *   1. which lines are *transport-safe* URLs (delegated to the injected
 *      `validateUrl`, which production wires to `engine-ytdlp`'s
 *      `assertHttpUrl` — the same whitelist the download argv builder uses);
 *   2. whether a site is actually supported by yt-dlp. That question is NOT
 *      answered here and MUST NOT be answered with a site regex: yt-dlp owns
 *      its extractor list, so a link that passes step 1 is handed to the
 *      existing download engine unchanged.
 *
 * Playlist recognition is likewise structure-only (a `list=` parameter or a
 * known collection path). It produces a hint and excludes the line from the
 * batch — it never claims to know every playlist shape on every site.
 *
 * Pure: no clock, no filesystem, no random. Byte limits are enforced by the
 * main-process adapter before the text reaches this function.
 */
export const TXT_IMPORT_LIMITS = Object.freeze({
  /** Hard cap on the file the native picker will read. */
  maxFileBytes: 1024 * 1024,
  /** Hard cap on physical lines; exceeding it refuses the whole import. */
  maxLines: 2000,
  /** Hard cap on the number of tasks one confirmed import may create. */
  maxUrls: 200,
  /** A single line longer than this is reported as invalid, never parsed. */
  maxLineLength: 2048,
  /** Preview strings are truncated so a junk line cannot flood the dialog. */
  maxRenderedLength: 240,
});

/** Throws when `raw` is not a transport-safe URL. Production: assertHttpUrl. */
export type TxtImportUrlValidator = (raw: string) => void;

export type TxtImportStatus =
  | 'valid' | 'duplicate' | 'invalid' | 'playlist' | 'too-long' | 'blank';

/** Stable codes, never localized; the renderer owns the sentence. */
export type TxtImportCode =
  | 'OK' | 'EMPTY_FILE' | 'NO_VALID_URL' | 'TOO_MANY_LINES' | 'TOO_MANY_URLS';

export interface TxtImportItem {
  /** 1-based physical line number in the file (blank lines keep their number). */
  readonly line: number;
  /** Trimmed line, truncated for display only — never used as a download URL. */
  readonly text: string;
  readonly status: TxtImportStatus;
  /** Stable machine reason for this status. */
  readonly reason: string;
}

export interface TxtImportParseResult {
  readonly code: TxtImportCode;
  readonly totalLines: number;
  readonly blankCount: number;
  readonly validCount: number;
  readonly invalidCount: number;
  readonly duplicateCount: number;
  readonly playlistCount: number;
  /** De-duplicated, validated single-video URLs, in file order. NEVER truncated. */
  readonly urls: readonly string[];
  /** One row per non-blank line, in file order; this is the preview URL list. */
  readonly items: readonly TxtImportItem[];
}

export interface ParseTxtInput {
  readonly text: string;
  readonly validateUrl: TxtImportUrlValidator;
}

/**
 * Heuristic for "this looks like a collection, not one video".
 *
 * Conservative on purpose: it inspects the query string and a handful of
 * well-known collection paths, not a site registry. A playlist shape it does
 * not know is treated as a single-video URL and left to the download engine's
 * own `--no-playlist` behaviour — an honest, documented gap rather than a
 * regex that pretends to classify the whole web.
 */
export function looksLikePlaylistUrl(raw: string): boolean {
  const lower = raw.toLowerCase();
  const queryAt = lower.indexOf('?');
  const path = queryAt === -1 ? lower : lower.slice(0, queryAt);
  const query = queryAt === -1 ? '' : lower.slice(queryAt + 1);
  // YouTube: /playlist?list=…, /watch?v=…&list=…, /embed?list=…
  if (/(?:^|&)list=[^&]+/.test(query)) return true;
  if (/(?:^|&)playlist=[^&]+/.test(query)) return true;
  if (/\/playlists?(?:\/|$)/.test(path)) return true;
  // SoundCloud sets, YouTube channel / handle video tabs.
  if (/\/sets(?:\/|$)/.test(path)) return true;
  if (/\/(?:channel|user|c)\/[^/]+\/videos(?:\/|$)/.test(path)) return true;
  if (/\/[^/]*videos(?:\/|$)/.test(path) && /\/@/.test(path)) return true;
  return false;
}

/** Truncate only what the preview renders; the parsed URL stays untouched. */
function previewText(value: string): string {
  return value.length <= TXT_IMPORT_LIMITS.maxRenderedLength
    ? value
    : `${value.slice(0, TXT_IMPORT_LIMITS.maxRenderedLength)}…`;
}

/**
 * Parse a decoded UTF-8 TXT file into a preview + a clean URL list.
 *
 * Compatibility: UTF-8 BOM, CRLF / LF / CR line endings, blank lines, leading
 * and trailing whitespace. Duplicates keep the FIRST occurrence. Nothing is
 * executed, nothing is appended to a command line — the URLs returned here are
 * only ever passed as one argv element each by the existing engine.
 */
export function parseTxtUrlList(input: ParseTxtInput): TxtImportParseResult {
  let text = input.text;
  // BOM is a decoding artifact, not content. Strip exactly one leading BOM.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline is a terminator, not an extra empty line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;

  const empty = (): TxtImportParseResult => ({
    code: 'OK', totalLines, blankCount: 0, validCount: 0, invalidCount: 0,
    duplicateCount: 0, playlistCount: 0, urls: [], items: [],
  });

  if (totalLines > TXT_IMPORT_LIMITS.maxLines) {
    return {
      ...empty(),
      code: 'TOO_MANY_LINES',
      blankCount: lines.filter((line) => line.trim() === '').length,
    };
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  const items: TxtImportItem[] = [];
  let blankCount = 0;
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  let playlistCount = 0;

  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '') {
      blankCount += 1;
      return;
    }
    if (trimmed.length > TXT_IMPORT_LIMITS.maxLineLength) {
      invalidCount += 1;
      items.push({ line, text: previewText(trimmed), status: 'too-long', reason: 'LINE_TOO_LONG' });
      return;
    }
    // "One URL per line": whitespace inside a line means it is not one URL.
    // `assertHttpUrl` deliberately does not reject spaces (the engine passes
    // argv[] with shell:false, so nothing is ever executed), but a TXT list
    // with `&&`/`|`/a space is a malformed line, not a link. This is a LINE
    // rule, not a site whitelist — host support remains the engine's job.
    if (/\s/.test(trimmed)) {
      invalidCount += 1;
      items.push({ line, text: previewText(trimmed), status: 'invalid', reason: 'INVALID_URL' });
      return;
    }
    try {
      input.validateUrl(trimmed);
    } catch {
      invalidCount += 1;
      items.push({ line, text: previewText(trimmed), status: 'invalid', reason: 'INVALID_URL' });
      return;
    }
    if (looksLikePlaylistUrl(trimmed)) {
      playlistCount += 1;
      items.push({ line, text: previewText(trimmed), status: 'playlist', reason: 'PLAYLIST_URL' });
      return;
    }
    // Exact string equality on purpose: two signed URLs differing only in a
    // token are NOT the same download, so normalising them would drop a task.
    if (seen.has(trimmed)) {
      duplicateCount += 1;
      items.push({ line, text: previewText(trimmed), status: 'duplicate', reason: 'DUPLICATE_URL' });
      return;
    }
    seen.add(trimmed);
    urls.push(trimmed);
    validCount += 1;
    items.push({ line, text: previewText(trimmed), status: 'valid', reason: 'OK' });
  });

  let code: TxtImportCode = 'OK';
  if (totalLines === 0 || blankCount === totalLines) code = 'EMPTY_FILE';
  else if (validCount === 0) code = 'NO_VALID_URL';
  else if (validCount > TXT_IMPORT_LIMITS.maxUrls) code = 'TOO_MANY_URLS';

  return {
    code, totalLines, blankCount, validCount, invalidCount,
    duplicateCount, playlistCount, urls, items,
  };
}
