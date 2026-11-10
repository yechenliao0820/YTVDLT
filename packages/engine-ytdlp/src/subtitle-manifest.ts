const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\/;
const POSIX_ABSOLUTE = /^\//;

export const SUBTITLE_MOVES_PREFIX = 'YTVDLT_SUBTITLE_MOVES:';
export const SUBTITLE_PATHS_PREFIX = 'YTVDLT_SUBTITLE_PATHS:';

function isAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || POSIX_ABSOLUTE.test(value);
}

function pathKey(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function decodeEscape(char: string): string {
  switch (char) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    default: return char;
  }
}

export function quotedLiterals(text: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "'" && char !== '"') {
      index += 1;
      continue;
    }
    const quote = char;
    let value = '';
    let closed = false;
    index += 1;
    while (index < text.length) {
      const current = text[index] as string;
      if (current === '\\' && index + 1 < text.length) {
        value += decodeEscape(text[index + 1] as string);
        index += 2;
        continue;
      }
      if (current === quote) {
        index += 1;
        closed = true;
        break;
      }
      value += current;
      index += 1;
    }
    if (!closed) return [];
    out.push(value);
  }
  return out;
}

export function subtitleFinalCandidates(
  reportedPath: string,
  moves: Readonly<Record<string, unknown>> = {},
): string[] {
  if (!isAbsolutePath(reportedPath)) return [];
  const matching = Object.entries(moves).filter(([source]) => pathKey(source) === pathKey(reportedPath));
  if (matching.length === 0) return [reportedPath];
  if (matching.length !== 1) return [];
  const target = matching[0]?.[1];
  return typeof target === 'string' && isAbsolutePath(target) ? [target] : [];
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export function parseSubtitlePathList(text: string): string[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  let moves: Readonly<Record<string, unknown>> | null = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith(SUBTITLE_MOVES_PREFIX)) {
      const parsed = parseJson(line.slice(SUBTITLE_MOVES_PREFIX.length));
      moves = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
      continue;
    }
    let reported: unknown;
    let currentMoves = moves;
    if (line.startsWith(SUBTITLE_PATHS_PREFIX)) {
      reported = parseJson(line.slice(SUBTITLE_PATHS_PREFIX.length));
      moves = {};
    } else {
      if (!line.startsWith('[') || !line.endsWith(']')) continue;
      reported = parseJson(line) ?? quotedLiterals(line);
      currentMoves = {};
      moves = {};
    }
    if (!Array.isArray(reported) || currentMoves === null) continue;
    for (const value of reported) {
      if (typeof value !== 'string') continue;
      for (const path of subtitleFinalCandidates(value, currentMoves)) {
        const key = pathKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        paths.push(path);
      }
    }
  }
  return paths;
}
