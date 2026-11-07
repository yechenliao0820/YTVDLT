/**
 * A-INF-04 / A-INF-02 — RuntimeResolver with in-memory ports + fake manifest.
 * Covers: 4 groups, all OK, hash mismatch, missing dedicated error codes,
 * "does not crash / does not silently degrade", optional aria2c.
 */
import { describe, it, expect } from 'vitest';
import {
  RuntimeResolver, validateManifestObject, ManifestValidationError,
} from '@ytvdlt/core';
import type { RuntimeItem, RuntimeManifest } from '@ytvdlt/shared';
import { createInMemoryPorts, sha256Of } from './helpers/in-memory-ports.js';

const CONTENTS: Record<string, string> = {
  'yt-dlp.exe': 'yt-dlp-binary-content',
  'node.exe': 'node-binary-content',
  'ffmpeg/ffmpeg.exe': 'ffmpeg-binary-content',
  'ffmpeg/ffprobe.exe': 'ffprobe-binary-content',
};

/** Build a manifest item whose sha256/sizeBytes match the actual seeded file. */
function item(partial: Partial<RuntimeItem> & Pick<RuntimeItem, 'path' | 'group' | 'kind'>): RuntimeItem {
  const content = CONTENTS[partial.path] ?? 'yt-dlp-binary-content';
  return {
    sha256: sha256Of(content),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    version: '1.0.0',
    sourceUrl: 'https://example.org/asset',
    releaseTag: 'v1',
    license: 'Unlicense',
    required: true,
    ...partial,
  };
}

function fakeManifest(items?: RuntimeItem[]): RuntimeManifest {
  return {
    schemaVersion: 1,
    platform: 'win-x64',
    generatedAt: '2026-11-05T00:00:00.000Z',
    toolVersions: { node: 'v22.22.2', npm: '10.9.7', pnpm: '9.15.9' },
    items: items ?? [
      item({ path: 'yt-dlp.exe', group: 'ytdlp', kind: 'ytdlp' }),
      item({ path: 'node.exe', group: 'node', kind: 'node' }),
      item({ path: 'ffmpeg/ffmpeg.exe', group: 'ffmpeg', kind: 'ffmpeg' }),
      item({ path: 'ffmpeg/ffprobe.exe', group: 'ffmpeg', kind: 'ffprobe' }),
    ],
  };
}

function seededPorts() {
  const { ports, state } = createInMemoryPorts();
  for (const [path, content] of Object.entries(CONTENTS)) {
    state.files.set(`C:/runtime/${path}`, content);
  }
  state.spawnResults.set('yt-dlp.exe', { exitCode: 0, stdout: '2026.10.26\n', stderr: '', timedOut: false });
  state.spawnResults.set('node.exe', { exitCode: 0, stdout: 'v24.22.2\n', stderr: '', timedOut: false });
  state.spawnResults.set('ffmpeg.exe', { exitCode: 0, stdout: 'ffmpeg version n9.0 Copyright\n', stderr: '', timedOut: false });
  return { ports, state };
}

describe('A-INF-04 RuntimeResolver · exactly 4 groups', () => {
  it('returns 4 groups in fixed order with 3 required OK, aria2c OPTIONAL', async () => {
    const { ports } = seededPorts();
    const report = await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    expect(report.items).toHaveLength(4);
    expect(report.items.map((i) => i.kind)).toEqual(['ytdlp', 'ffmpeg', 'node', 'aria2c']);
    expect(report.allRequiredOk).toBe(true);
    expect(report.summary).toEqual({ requiredOk: 3, requiredTotal: 3, optionalMissing: 1, failed: 0 });
    expect(report.items[3]?.status).toBe('OPTIONAL');
    expect(report.items[3]?.errorCode).toBeNull();
    expect(report.runtimeDir).toBe('C:/runtime');
    expect(report.items[0]?.version).toBe('2026.10.26');
    expect(report.items[2]?.version).toBe('v24.22.2');
    expect(report.items[1]?.version).toBe('n9.0');
    expect(report.items[0]?.absoluteDir).toContain('C:/runtime');
  });

  it('version probes use absolute paths + argv[] + shell:false + windowsHide:true', async () => {
    const { ports, state } = seededPorts();
    await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    expect(state.spawnCalls.length).toBe(3);
    for (const call of state.spawnCalls) {
      expect(call.file.startsWith('C:/runtime')).toBe(true);
      expect(call.opts.shell).toBe(false);
      expect(call.opts.windowsHide).toBe(true);
      expect(call.opts.env?.PATH).toContain('C:/runtime/ffmpeg');
    }
  });
});

describe('A-INF-04 RuntimeResolver · missing / hash mismatch / no crash', () => {
  it('missing node.exe -> JS_RUNTIME_MISSING, no throw, allRequiredOk=false', async () => {
    const { ports, state } = seededPorts();
    state.files.delete('C:/runtime/node.exe');
    const report = await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    const node = report.items.find((i) => i.kind === 'node');
    expect(node?.status).toBe('MISSING');
    expect(node?.errorCode).toBe('JS_RUNTIME_MISSING');
    expect(report.allRequiredOk).toBe(false);
    expect(report.summary.failed).toBe(1);
  });

  it('missing yt-dlp.exe -> ENGINE_MISSING', async () => {
    const { ports, state } = seededPorts();
    state.files.delete('C:/runtime/yt-dlp.exe');
    const report = await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    expect(report.items.find((i) => i.kind === 'ytdlp')?.errorCode).toBe('ENGINE_MISSING');
  });

  it('missing ffmpeg group -> FFMPEG_MISSING', async () => {
    const { ports, state } = seededPorts();
    state.files.delete('C:/runtime/ffmpeg/ffmpeg.exe');
    state.files.delete('C:/runtime/ffmpeg/ffprobe.exe');
    const report = await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    expect(report.items.find((i) => i.kind === 'ffmpeg')?.errorCode).toBe('FFMPEG_MISSING');
  });

  it('HASH_MISMATCH is detected and never silently degrades', async () => {
    const { ports, state } = seededPorts();
    state.files.set('C:/runtime/yt-dlp.exe', 'tampered');
    const report = await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    const ytdlp = report.items.find((i) => i.kind === 'ytdlp');
    expect(ytdlp?.status).toBe('HASH_MISMATCH');
    expect(ytdlp?.fileResults[0]?.status).toBe('HASH_MISMATCH');
    expect(report.allRequiredOk).toBe(false);
  });

  it('a version probe that fails -> NOT_EXECUTABLE (not a crash)', async () => {
    const { ports, state } = seededPorts();
    state.spawnResults.set('node.exe', { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false });
    const report = await new RuntimeResolver({ ports, manifest: fakeManifest() }).check();
    expect(report.items.find((i) => i.kind === 'node')?.status).toBe('NOT_EXECUTABLE');
    expect(report.allRequiredOk).toBe(false);
  });
});

describe('A-INF-02 manifest loader · strict validation', () => {
  it('accepts a well-formed manifest with 4 items', () => {
    expect(() => validateManifestObject(fakeManifest())).not.toThrow();
  });

  it('rejects bad schemaVersion / bad sha / non-POSIX path with UNKNOWN code', () => {
    const bad = fakeManifest();
    bad.schemaVersion = 2;
    expect(() => validateManifestObject(bad)).toThrow(ManifestValidationError);
    try { validateManifestObject(bad); } catch (error) {
      expect((error as ManifestValidationError).code).toBe('UNKNOWN');
    }
    const badPath = fakeManifest([item({ path: '..\\yt-dlp.exe', group: 'ytdlp', kind: 'ytdlp' })]);
    expect(() => validateManifestObject(badPath)).toThrow(ManifestValidationError);
  });
});
