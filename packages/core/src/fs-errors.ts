/**
 * D-241 · one place that answers "is this error merely a missing file?".
 *
 * Two stores read a JSON file before they may replace it — `TaskStore`
 * (D-159) and `HistoryStore` (D-241). Both must separate "there is no file
 * yet" from "the file is there but I cannot read it": treating the second as
 * the first is how a transient `EACCES` / `EBUSY` / shared-lock failure turns
 * into an EMPTY baseline, which the next write then persists over data this
 * process never saw.
 *
 * The production port throws a Node `ErrnoException` carrying `code`; the
 * in-memory test port throws a plain `Error('ENOENT: <path>')`. Both must be
 * recognised. `ENOTDIR` joins them because "a path component is not a
 * directory" means exactly that no file exists at that path either.
 * Everything else (`EACCES`, `EPERM`, `EIO`, `EBUSY`, …) is a READ FAILURE and
 * must reach the caller, not be flattened into "absent".
 *
 * Pure string/field inspection on purpose: core must not import `node:*`.
 */
export function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^ENOENT\b/.test(message);
}
