/**
 * M2 QA P1-2 regression guard.
 *
 * `u3-verify.mjs` used to rewrite `tests/fixtures/manifest.json` with a
 * hard-coded object, dropping `expectedFormat`/`c8Golden`. That silently
 * degraded C7 (compare → record-only) and made C8 permanently SKIPPED while
 * everything still looked green. This test drives the REAL write path used by
 * u3-verify and asserts later-milestone keys survive.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeFixtureManifest, buildGeneratedFixtureManifest, writeFixtureManifest, deepMergePreserve,
} from '../../scripts/lib/fixture-manifest.mjs';

const fixture = {
  sha256: '1db5d56506d3c59d1bdd9b35822bcf0ff31c85514a6d2866574e68129e66d04b',
  sizeBytes: 308666,
  duration: 10,
  videoCodec: 'h264',
  audioCodec: 'aac',
  videoCount: 1,
  audioCount: 1,
};
const encoder = { codec: 'libopenh264', scheme: 'A' };

/** A manifest as it looks after M2 added its keys. */
const m2Manifest = () => ({
  schemaVersion: 1,
  file: 'media/fixture.mp4',
  sha256: fixture.sha256,
  sizeBytes: fixture.sizeBytes,
  durationSec: 10,
  videoCodec: 'h264',
  audioCodec: 'aac',
  videoStreams: 1,
  audioStreams: 1,
  encoder: 'libopenh264',
  scheme: 'A',
  generatedBy: 'scripts/u3-verify.mjs',
  note: 'old note',
  expectedFormat: { formatId: '0', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 320, height: 240 },
  c8Golden: 'framemd5-golden-text',
});

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ytvdlt-fixture-manifest-'));
  try { return await fn(dir); } finally {
    // Single-directory cleanup; the environment may gate bulk deletes.
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('P1-2 fixture manifest merge preserves later-milestone keys', () => {
  it('merges generated values on top while keeping unknown keys', () => {
    const generated = buildGeneratedFixtureManifest(fixture, encoder);
    const merged = mergeFixtureManifest(m2Manifest(), generated);

    expect(merged.expectedFormat).toEqual({
      formatId: '0', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 320, height: 240,
    });
    expect(merged.c8Golden).toBe('framemd5-golden-text');
    // Generated values still win for the keys this script owns.
    expect(merged.sha256).toBe(fixture.sha256);
    expect(merged.encoder).toBe('libopenh264');
    expect(merged.note).toContain('libopenh264');
  });

  it('deepMergePreserve recurses into nested objects instead of replacing them', () => {
    const base = { a: { keep: 1, override: 'old', nested: { deep: true } }, b: 'base-only' };
    const merged = deepMergePreserve(base, { a: { override: 'new' }, c: 'added' });
    expect(merged.a.keep).toBe(1);
    expect(merged.a.override).toBe('new');
    expect(merged.a.nested).toEqual({ deep: true });
    expect(merged.b).toBe('base-only');
    expect(merged.c).toBe('added');
  });

  it('handles a missing / null existing manifest (first run)', () => {
    const generated = buildGeneratedFixtureManifest(fixture, encoder);
    expect(mergeFixtureManifest(null, generated).sha256).toBe(fixture.sha256);
    expect(mergeFixtureManifest(undefined, generated).durationSec).toBe(10);
  });

  it('writeFixtureManifest (the path u3-verify uses) keeps expectedFormat + c8Golden on disk', async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(m2Manifest(), null, 2), 'utf8');

      const { manifest, preservedKeys } = await writeFixtureManifest(
        manifestPath,
        buildGeneratedFixtureManifest(fixture, encoder),
      );

      const onDisk = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(onDisk.expectedFormat).toEqual(m2Manifest().expectedFormat);
      expect(onDisk.c8Golden).toBe('framemd5-golden-text');
      expect(manifest.expectedFormat).toEqual(m2Manifest().expectedFormat);
      expect(preservedKeys).toEqual(expect.arrayContaining(['expectedFormat', 'c8Golden']));
    });
  });

  it('the repository fixture manifest still carries both M2 keys', async () => {
    const repoManifest = JSON.parse(
      await readFile(new URL('../../tests/fixtures/manifest.json', import.meta.url), 'utf8'),
    );
    expect(repoManifest.expectedFormat).toBeTruthy();
    expect(repoManifest.expectedFormat).toMatchObject({ width: 320, height: 240, vcodec: 'h264' });
    expect('c8Golden' in repoManifest).toBe(true);
  });
});
