/**
 * Pure history helpers: path normalization + query matching + dedupe key.
 * Path normalization must agree across `\` vs `/` and drive-letter case (R12).
 */
import type { HistoryEntry, HistoryQuery } from '@ytvdlt/shared';

/** Canonical path: lowercase drive letter, unified separators, no trailing slash. */
export function normalizePath(input: string): string {
  let value = input.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  value = value.replace(/\/+$/, '');
  if (/^[A-Za-z]:/.test(value)) {
    value = value[0]!.toLowerCase() + value.slice(1);
  }
  return value.toLowerCase();
}

/** Dedupe key = normalized primary artifact path. */
export function dedupeKey(entry: Pick<HistoryEntry, 'videoPath'>): string {
  return normalizePath(entry.videoPath);
}

/** Case-insensitive contains match over title / uploader / videoPath. */
export function matchEntry(entry: HistoryEntry, query: HistoryQuery): boolean {
  if (query.downloadType !== undefined && entry.downloadType !== query.downloadType) return false;
  if (query.extractorKey !== undefined && entry.extractorKey !== query.extractorKey) return false;
  if (query.text === undefined) return true;
  const needle = query.text.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [entry.title, entry.uploader ?? '', entry.videoPath].join('\n').toLowerCase();
  return haystack.includes(needle);
}

/** Apply match + deterministic ordering (newest first) + pagination. */
export function applyQuery(entries: readonly HistoryEntry[], query: HistoryQuery = {}): HistoryEntry[] {
  const matched = entries
    .filter((entry) => matchEntry(entry, query))
    .slice()
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? matched.length;
  return matched.slice(offset, offset + limit);
}
