/**
 * Fixture manifest (`tests/fixtures/manifest.json`) read/merge/write helpers.
 *
 * WHY THIS EXISTS (M2 QA P1-2): `u3-verify.mjs` used to rewrite the file with a
 * hard-coded object, silently DROPPING keys added by later milestones
 * (`expectedFormat`, `c8Golden`). That degraded C7 from "compare width/height/
 * codec" to "record only" and made C8 permanently SKIPPED — a failure that still
 * looked green. Writes now merge: generated values win, unknown keys survive.
 */
import { readFile, writeFile, rename, copyFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `overrides` onto `base`, one level of nesting at a time.
 * - keys present only in `base` are preserved (forward compatibility)
 * - `overrides` wins whenever both sides are non-objects
 * - both sides plain objects → merge recursively
 */
export function deepMergePreserve(base, overrides) {
  if (!isPlainObject(base)) return overrides;
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value)
      ? deepMergePreserve(existing, value)
      : value;
  }
  return result;
}

/** Merge a freshly generated fixture manifest onto the previous one. */
export function mergeFixtureManifest(existing, generated) {
  return deepMergePreserve(isPlainObject(existing) ? existing : {}, generated);
}

/** Build the generated part of the fixture manifest (no milestone-specific keys). */
export function buildGeneratedFixtureManifest(fixture, encoder) {
  return {
    schemaVersion: 1,
    file: 'media/fixture.mp4',
    sha256: fixture.sha256,
    sizeBytes: fixture.sizeBytes,
    durationSec: fixture.duration,
    videoCodec: fixture.videoCodec,
    audioCodec: fixture.audioCodec,
    videoStreams: fixture.videoCount,
    audioStreams: fixture.audioCount,
    encoder: encoder.codec,
    scheme: encoder.scheme,
    generatedBy: 'scripts/u3-verify.mjs',
    note: 'LGPL shared build: no libx264; libopenh264 used when available (see DECISIONS.md O-02 / D-09).',
  };
}

/** Read the fixture manifest, returning null when absent/unparseable. */
export async function readFixtureManifest(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Merge-then-write the fixture manifest atomically.
 * @returns {{manifest: object, preservedKeys: string[]}}
 */
export async function writeFixtureManifest(filePath, generated) {
  const existing = await readFixtureManifest(filePath);
  const manifest = mergeFixtureManifest(existing, generated);
  const preservedKeys = isPlainObject(existing)
    ? Object.keys(existing).filter((key) => !(key in generated))
    : [];
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // Prefer a single rename (atomic on Windows via MOVEFILE_REPLACE_EXISTING); do
  // NOT pre-delete the target — a delete here counts against sandbox guards that
  // cap bulk deletions per turn (DECISIONS D-29). Fall back to copy only if the
  // platform refuses to replace.
  try {
    await rename(tmp, filePath);
  } catch {
    await copyFile(tmp, filePath);
    await unlink(tmp);
  }
  return { manifest, preservedKeys };
}
