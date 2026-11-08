/**
 * Version comparison for the GitHub-release update path (0.2.1, D-93).
 *
 * Deliberately not a semver library: the project publishes `0.<minor>.<patch>`
 * with a decimal-carry rule (AI-MAINTENANCE §7), and `0.1.10` exists as a
 * documented historical exception. What has to hold is only "which of these two
 * is newer", decided segment by segment as numbers.
 */

/** `v0.2.1` → `[0,2,1]`; `0.1.10-beta` → `[0,1,10]`; garbage → `[]`. */
export function parseVersionSegments(raw: string): number[] {
  const cleaned = String(raw ?? '').trim().replace(/^v/i, '');
  const match = /^(\d+(?:\.\d+)*)/.exec(cleaned);
  if (match === null) return [];
  return (match[1] as string).split('.').map((part) => Number(part));
}

/** `1.2.3` → `1.2.3`; keeps a non-numeric tag readable instead of empty. */
export function normalizeVersion(raw: string): string {
  const segments = parseVersionSegments(raw);
  if (segments.length === 0) return String(raw ?? '').trim().replace(/^v/i, '');
  return segments.join('.');
}

/**
 * `-1` | `0` | `1`. Missing trailing segments count as `0`, so `0.2` equals
 * `0.2.0` — a tag like `v0.3` must not look older than `0.2.9` by accident.
 * An unparsable side is treated as older than any parsable version.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersionSegments(left);
  const b = parseVersionSegments(right);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return -1;
  if (b.length === 0) return 1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** True only when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
