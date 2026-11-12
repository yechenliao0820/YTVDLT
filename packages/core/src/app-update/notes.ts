/**
 * Cumulative release notes for a version JUMP (0.3.1, D-140).
 *
 * Why this exists: the dialog used to render `latest.notes` and nothing else.
 * A user on 0.2.8 who upgraded to 0.3.0 therefore read one body — the 0.3.0
 * body, which opens with "the first release to carry everything that landed on
 * top of 0.2.9" — and had no way to learn what 0.2.9 itself had changed. Two
 * true statements, one confusing dialog.
 *
 * The rule implemented here: the dialog explains the whole interval
 * `(currentVersion, latestVersion]`, oldest version first, one block per
 * release. Everything is pure — the HTTP call lives in the main process, so
 * ordering, filtering and truncation stay testable without a network.
 */
import type { AppRelease, AppReleaseNote } from '@ytvdlt/shared';
import { parseGitHubRelease } from './release.js';
import { compareVersions, normalizeVersion } from './version.js';

/**
 * Cap for ONE release body when several are shown together. The single-release
 * dialog keeps the larger `MAX_RELEASE_NOTES_CHARS`; a jump across four
 * versions cannot afford 4000 characters each.
 */
export const MAX_NOTES_PER_RELEASE_CHARS = 1400;

/** Cap for the whole "what changed since your build" stack. */
export const MAX_CUMULATIVE_NOTES_CHARS = 6000;

/** Hard ceiling on how many releases one dialog may list. */
export const MAX_RELEASES_PER_DIGEST = 20;

export interface ReleaseNotesDigest {
  /** Oldest first: `0.2.9` before `0.3.0`, exactly as the user lived it. */
  readonly blocks: readonly AppReleaseNote[];
  /**
   * Releases dropped from the FRONT because the total budget (or the release
   * ceiling) ran out. The newest blocks are never dropped: they describe the
   * build the user is about to install.
   */
  readonly omitted: number;
}

export const EMPTY_NOTES_DIGEST: ReleaseNotesDigest = Object.freeze({ blocks: [], omitted: 0 });

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n…`;
}

/** Words a release body may put in front of its own version number. */
const TITLE_NOISE = new Set(['ytvdlt', 'desktop', 'release', 'releases', 'version', 'ver', 'update']);

/**
 * Is this whole line just the product name and/or the version number?
 *
 * Real bodies open with `# YTVDLT 0.2.4`, `## 0.2.3`, `## YTVDLT Desktop 0.2.6`.
 * The dialog prints its own version heading above each block, so repeating it
 * inside the body is pure noise — but only an exact match is stripped:
 * "Fixed in 0.3.0" is a sentence, not a title.
 */
export function isReleaseTitleLine(line: string, version: string): boolean {
  const words = line
    .toLowerCase()
    .replace(/[·•:：|,\-–—]+\s*$/g, '')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0 || words.length > 4) return false;
  const rest = words.filter((word) => !TITLE_NOISE.has(word));
  if (rest.length !== 1) return false;
  const candidate = (rest[0] as string).replace(/^v/, '');
  return candidate !== '' && normalizeVersion(candidate) === normalizeVersion(version);
}

/** Drop a body's leading self-title (`YTVDLT 0.3.0`) plus the blank lines after it. */
export function stripReleaseTitle(notes: string, version: string): string {
  const text = String(notes ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length && (lines[index] as string).trim() === '') index += 1;
  if (index >= lines.length) return '';
  if (!isReleaseTitleLine((lines[index] as string).trim(), version)) return text.trim();
  let next = index + 1;
  while (next < lines.length && (lines[next] as string).trim() === '') next += 1;
  return lines.slice(next).join('\n').trim();
}

/**
 * `GET /repos/:owner/:repo/releases` payload → releases the dialog may show.
 *
 * Same rules as the single-release parser (draft and prerelease are skipped),
 * plus de-duplication by version: a re-tagged release must not produce two
 * identical blocks. Pagination is the caller's business; this only reads what
 * it is given.
 */
export function parseGitHubReleaseList(
  payload: unknown,
  options: { readonly maxNotesChars?: number } = {},
): AppRelease[] {
  if (!Array.isArray(payload)) return [];
  const releases: AppRelease[] = [];
  const seen = new Set<string>();
  for (const item of payload) {
    const release = parseGitHubRelease(item, options);
    if (release === null || seen.has(release.version)) continue;
    seen.add(release.version);
    releases.push(release);
  }
  return releases;
}

/**
 * Every release the user would have to read about, oldest first.
 *
 * Range is `(currentVersion, latestVersion]`: the running build already
 * contains everything up to and including itself, and a release NEWER than the
 * one being offered (a tag published between the two calls) has no business in
 * this dialog.
 */
export function collectReleaseNotes(
  releases: readonly AppRelease[],
  currentVersion: string,
  latestVersion: string,
  options: {
    readonly perReleaseChars?: number;
    readonly totalChars?: number;
    readonly maxReleases?: number;
  } = {},
): ReleaseNotesDigest {
  const perRelease = positive(options.perReleaseChars, MAX_NOTES_PER_RELEASE_CHARS);
  const totalChars = positive(options.totalChars, MAX_CUMULATIVE_NOTES_CHARS);
  const maxReleases = positive(options.maxReleases, MAX_RELEASES_PER_DIGEST);

  const inRange: AppRelease[] = [];
  const byVersion = new Map<string, number>();
  for (const release of releases) {
    if (compareVersions(release.version, currentVersion) <= 0) continue;
    if (compareVersions(release.version, latestVersion) > 0) continue;
    const existing = byVersion.get(release.version);
    if (existing !== undefined) {
      // Keep the richer body when the same version appears twice.
      if ((inRange[existing] as AppRelease).notes.length < release.notes.length) {
        inRange[existing] = release;
      }
      continue;
    }
    byVersion.set(release.version, inRange.length);
    inRange.push(release);
  }

  inRange.sort((a, b) => compareVersions(a.version, b.version));

  const blocks: AppReleaseNote[] = inRange.map((release) => ({
    version: release.version,
    publishedAt: release.publishedAt,
    notes: capText(stripReleaseTitle(release.notes, release.version), perRelease),
  }));

  // Budget is spent from the NEWEST end: dropping the version the user is
  // installing in order to keep 0.2.2 would be exactly backwards.
  let start = 0;
  let used = blocks.reduce((sum, block) => sum + block.notes.length, 0);
  while (start < blocks.length - 1 && used > totalChars) {
    used -= (blocks[start] as AppReleaseNote).notes.length;
    start += 1;
  }
  let kept = blocks.slice(start);
  let omitted = start;
  if (kept.length > maxReleases) {
    omitted += kept.length - maxReleases;
    kept = kept.slice(kept.length - maxReleases);
  }

  return { blocks: kept, omitted };
}
