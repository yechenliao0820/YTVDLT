/**
 * D-169 follow-up · start-up runtime check helpers (`apps/desktop/src/main/
 * runtime-resolver.ts`).
 *
 * Pins three things the first D-169 ship got wrong or left dead:
 *   - the packaged error dialog uses REAL newlines (it shipped literal `//n`);
 *   - the error report "Engine:" line is backfilled from the check's own
 *     `yt-dlp --version` probe instead of a dead 'unknown (…)' string;
 *   - hash verdicts are cached by (path, sizeBytes, mtimeMs): a healthy
 *     start-up re-hashes NOTHING, a changed file re-hashes alone, and a
 *     missing/corrupt cache degrades to hashing every file — the check is
 *     never skipped (fail closed).
 *
 * Levels: pure-function pins + in-memory checkRuntime() wiring (L0) + one
 * real-`node:fs` round-trip of `nodeRuntimeHashCacheIo` (L2-local, tmpdir).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRuntime } from '@ytvdlt/core';
import type {
  CorePorts, RuntimeCheckReport, RuntimeItem, RuntimeManifest, RuntimeStatus,
} from '@ytvdlt/shared';
import {
  createCachedSha256File, missingRequiredLabels, nodeRuntimeHashCacheIo,
  resolvedEngineVersion, runtimeCheckErrorMessage,
  type RuntimeHashCacheIo,
} from '../../apps/desktop/src/main/runtime-resolver.js';
import { createInMemoryPorts, sha256Of } from './helpers/in-memory-ports.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function statusItem(patch: Partial<RuntimeStatus> & Pick<RuntimeStatus, 'label'>): RuntimeStatus {
  return {
    kind: 'ytdlp', required: true, status: 'OK', errorCode: null, absoluteDir: '',
    version: '', versionCommand: '--version', fileResults: [], message: 'OK',
    ...patch,
  };
}

function report(items: RuntimeStatus[], runtimeDir = 'C:/Program Files/YTVDLT/resources/runtime'): RuntimeCheckReport {
  return {
    schemaVersion: 1,
    platform: 'win-x64',
    checkedAt: '2026-11-14T00:00:00.000Z',
    packaged: true,
    runtimeDir,
    allRequiredOk: false,
    summary: { requiredOk: 2, requiredTotal: 3, optionalMissing: 1, failed: 1 },
    items,
  };
}

/** In-memory IO fakes: cache file in `files`, per-path metadata in `stats`. */
function fakeIo(
  files: Map<string, string>,
  stats: Map<string, { sizeBytes: number; mtimeMs: number }>,
): RuntimeHashCacheIo {
  return {
    async stat(absolutePath) {
      const stat = stats.get(absolutePath);
      if (stat === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return stat;
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async writeText(path, text) { files.set(path, text); },
  };
}

/** Deterministic injected hash that records every call. */
function countingHash(calls: string[]): (absolutePath: string) => Promise<string> {
  return async (absolutePath) => {
    calls.push(absolutePath);
    return sha256Of(`hash-of:${absolutePath}`);
  };
}

const FILE = 'C:/runtime/yt-dlp.exe';
const CACHE = 'C:/data/runtime-hash-cache.json';
const KEY = 'c:/runtime/yt-dlp.exe';

// ---------------------------------------------------------------------------
// packaged error dialog text
// ---------------------------------------------------------------------------

describe('D-169 follow-up · packaged error dialog text', () => {
  it('uses real newlines and lists the missing required labels', () => {
    const failed = report([
      statusItem({ kind: 'ytdlp', label: 'yt-dlp.exe', status: 'MISSING', errorCode: 'ENGINE_MISSING', message: 'MISSING (ENGINE_MISSING)' }),
      statusItem({ kind: 'ffmpeg', label: 'ffmpeg.exe + ffprobe.exe + LGPL DLL' }),
      statusItem({ kind: 'node', label: 'node.exe (EJS JS runtime)', status: 'HASH_MISMATCH', errorCode: 'JS_RUNTIME_MISSING' }),
    ]);
    expect(runtimeCheckErrorMessage(failed)).toBe(
      'These required components are missing or damaged in:\n'
      + 'C:/Program Files/YTVDLT/resources/runtime\n'
      + '\n'
      + 'yt-dlp.exe, node.exe (EJS JS runtime)\n'
      + '\n'
      + 'Downloads will fail until the installation is repaired.',
    );
    expect(runtimeCheckErrorMessage(failed)).not.toContain('//n');
  });

  it('missingRequiredLabels ignores OK and optional items', () => {
    const healthy = report([
      statusItem({ kind: 'ytdlp', label: 'yt-dlp.exe' }),
      statusItem({ kind: 'aria2c', label: 'aria2c.exe', required: false, status: 'OPTIONAL', versionCommand: null }),
    ]);
    expect(missingRequiredLabels(healthy)).toBe('');
    expect(missingRequiredLabels(healthy)).not.toContain('aria2c');
  });
});

// ---------------------------------------------------------------------------
// engineVersion backfill
// ---------------------------------------------------------------------------

describe('D-169 follow-up · engineVersion backfill', () => {
  it('reuses the yt-dlp group version the start-up check probed', () => {
    const checked = report([
      statusItem({ kind: 'ytdlp', label: 'yt-dlp.exe', version: '2026.11.12' }),
      statusItem({ kind: 'ffmpeg', label: 'ffmpeg.exe + ffprobe.exe + LGPL DLL', version: 'n9.0' }),
    ]);
    expect(resolvedEngineVersion(checked)).toBe('2026.11.12');
  });

  it("returns 'unknown' for a failed check, a failed probe, or a non-ytdlp version", () => {
    expect(resolvedEngineVersion(null)).toBe('unknown');
    expect(resolvedEngineVersion(report([
      statusItem({ kind: 'ytdlp', label: 'yt-dlp.exe', status: 'MISSING', errorCode: 'ENGINE_MISSING' }),
      statusItem({ kind: 'ffmpeg', label: 'ffmpeg.exe + ffprobe.exe + LGPL DLL', version: 'n9.0' }),
    ]))).toBe('unknown');
    expect(resolvedEngineVersion(report([
      statusItem({ kind: 'ytdlp', label: 'yt-dlp.exe', version: '' }),
    ]))).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// hash cache — pure decorator with in-memory IO
// ---------------------------------------------------------------------------

describe('D-169 follow-up · createCachedSha256File', () => {
  it('hashes once, then serves an unchanged file from the cache', async () => {
    const calls: string[] = [];
    const files = new Map<string, string>();
    const stats = new Map([[FILE, { sizeBytes: 10, mtimeMs: 1000 }]]);
    const hash = createCachedSha256File({
      io: fakeIo(files, stats), cachePath: CACHE, sha256File: countingHash(calls),
    });

    const first = await hash(FILE);
    expect(calls).toEqual([FILE]);
    expect(first).toBe(sha256Of(`hash-of:${FILE}`));
    const persisted = JSON.parse(files.get(CACHE) ?? 'null') as { schemaVersion?: number; entries?: Record<string, unknown> };
    expect(persisted.schemaVersion).toBe(1);
    expect(Object.keys(persisted.entries ?? {})).toEqual([KEY]);

    const second = await hash(FILE);
    expect(second).toBe(first);
    expect(calls).toEqual([FILE]);
  });

  it('re-hashes exactly the file whose size or mtimeMs changed', async () => {
    const calls: string[] = [];
    const files = new Map<string, string>();
    const stats = new Map<string, { sizeBytes: number; mtimeMs: number }>([
      [FILE, { sizeBytes: 10, mtimeMs: 1000 }],
      ['C:/runtime/node.exe', { sizeBytes: 20, mtimeMs: 1000 }],
    ]);
    const hash = createCachedSha256File({
      io: fakeIo(files, stats), cachePath: CACHE, sha256File: countingHash(calls),
    });
    await hash(FILE);
    await hash('C:/runtime/node.exe');
    expect(calls).toHaveLength(2);

    // Same content, new mtime: only this file is re-hashed.
    stats.set(FILE, { sizeBytes: 10, mtimeMs: 2000 });
    await hash(FILE);
    expect(calls).toHaveLength(3);
    await hash('C:/runtime/node.exe');
    expect(calls).toHaveLength(3);

    // Same mtime, new size: only this file is re-hashed.
    stats.set(FILE, { sizeBytes: 11, mtimeMs: 2000 });
    await hash(FILE);
    expect(calls).toHaveLength(4);
  });

  it('a missing, corrupt, foreign-schema or ill-formed cache degrades to a full re-computation', async () => {
    for (const cacheContent of [
      undefined, // no cache file at all
      '{not json',
      JSON.stringify({ schemaVersion: 2, entries: { [KEY]: { sizeBytes: 10, mtimeMs: 1000, sha256: sha256Of('x') } } }),
      JSON.stringify({ schemaVersion: 1, entries: { [KEY]: { sizeBytes: 10, mtimeMs: 1000, sha256: 'not-a-digest' } } }),
      JSON.stringify({ schemaVersion: 1, entries: { [KEY]: { sizeBytes: '10', mtimeMs: 1000, sha256: sha256Of('x') } } }),
    ]) {
      const calls: string[] = [];
      const files = new Map<string, string>();
      if (cacheContent !== undefined) files.set(CACHE, cacheContent);
      const stats = new Map([[FILE, { sizeBytes: 10, mtimeMs: 1000 }]]);
      const hash = createCachedSha256File({
        io: fakeIo(files, stats), cachePath: CACHE, sha256File: countingHash(calls),
      });
      const digest = await hash(FILE);
      expect(calls).toEqual([FILE]); // re-computed, never trusted from junk
      expect(digest).toBe(sha256Of(`hash-of:${FILE}`));
      // …and the cache file is healthy again afterwards.
      expect((JSON.parse(files.get(CACHE) ?? 'null') as { schemaVersion?: number }).schemaVersion).toBe(1);
    }
  });

  it('an unwritable cache location still verifies (and re-hashes next time)', async () => {
    const calls: string[] = [];
    const stats = new Map([[FILE, { sizeBytes: 10, mtimeMs: 1000 }]]);
    const files = new Map<string, string>();
    const io = fakeIo(files, stats);
    const hash = createCachedSha256File({
      io: {
        ...io,
        writeText: async () => { throw new Error('EACCES: read-only data dir'); },
      },
      cachePath: CACHE,
      sha256File: countingHash(calls),
    });
    await expect(hash(FILE)).resolves.toBe(sha256Of(`hash-of:${FILE}`));
    expect(files.get(CACHE)).toBeUndefined();

    const nextRun = createCachedSha256File({
      io, cachePath: CACHE, sha256File: countingHash(calls),
    });
    await nextRun(FILE);
    expect(calls).toHaveLength(2); // nothing was persisted → real re-hash
  });

  it('a failed stat propagates so Core maps the file to MISSING', async () => {
    const calls: string[] = [];
    const hash = createCachedSha256File({
      io: fakeIo(new Map(), new Map()), cachePath: CACHE, sha256File: countingHash(calls),
    });
    await expect(hash(FILE)).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hash cache — real filesystem round-trip
// ---------------------------------------------------------------------------

describe('D-169 follow-up · nodeRuntimeHashCacheIo on a real file', () => {
  const cleanup: string[] = [];
  afterAll(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  it('stats real metadata, round-trips the cache file, and skips the second hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ytvdlt-runtime-hash-'));
    cleanup.push(root);
    const target = join(root, 'yt-dlp.exe');
    const cachePath = join(root, 'runtime-hash-cache.json');
    await fs.writeFile(target, 'yt-dlp-binary-content', 'utf8');

    const calls: string[] = [];
    const hash = createCachedSha256File({
      io: nodeRuntimeHashCacheIo,
      cachePath,
      sha256File: async (absolutePath) => {
        calls.push(absolutePath);
        return sha256Of(await fs.readFile(absolutePath, 'utf8'));
      },
    });

    const first = await hash(target);
    expect(calls).toHaveLength(1);
    expect(first).toBe(sha256Of('yt-dlp-binary-content'));

    const second = await hash(target);
    expect(calls).toHaveLength(1); // real stat + unchanged mtime → cache hit
    expect(second).toBe(first);

    await fs.writeFile(target, 'tampered-content', 'utf8');
    const third = await hash(target);
    expect(calls).toHaveLength(2);
    expect(third).toBe(sha256Of('tampered-content'));

    const persisted = JSON.parse(await fs.readFile(cachePath, 'utf8')) as {
      schemaVersion?: number; entries?: Record<string, unknown>;
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(Object.keys(persisted.entries ?? {}))
      .toEqual([target.replace(/\\/g, '/').toLowerCase()]);
  });
});

// ---------------------------------------------------------------------------
// cache wired into Core checkRuntime() (mirrors checkRuntimeForApp)
// ---------------------------------------------------------------------------

const RUNTIME = 'C:/runtime';
const CONTENTS: Record<string, string> = {
  'yt-dlp.exe': 'yt-dlp-binary-content',
  'node.exe': 'node-binary-content',
  'ffmpeg/ffmpeg.exe': 'ffmpeg-binary-content',
  'ffmpeg/ffprobe.exe': 'ffprobe-binary-content',
};
const KINDS: Record<string, { kind: RuntimeItem['kind']; group: RuntimeItem['group'] }> = {
  'yt-dlp.exe': { kind: 'ytdlp', group: 'ytdlp' },
  'node.exe': { kind: 'node', group: 'node' },
  'ffmpeg/ffmpeg.exe': { kind: 'ffmpeg', group: 'ffmpeg' },
  'ffmpeg/ffprobe.exe': { kind: 'ffprobe', group: 'ffmpeg' },
};

function manifestItem(path: string): RuntimeItem {
  const content = CONTENTS[path] ?? 'yt-dlp-binary-content';
  const kind = KINDS[path] ?? { kind: 'ytdlp' as const, group: 'ytdlp' as const };
  return {
    path,
    sha256: sha256Of(content),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    version: '1.0.0',
    sourceUrl: 'https://example.org/asset',
    releaseTag: 'v1',
    license: 'Unlicense',
    required: true,
    ...kind,
  };
}

function fakeManifest(): RuntimeManifest {
  return {
    schemaVersion: 1,
    platform: 'win-x64',
    generatedAt: '2026-11-14T00:00:00.000Z',
    toolVersions: { node: 'v24.21.0', npm: '10.9.7', pnpm: '9.15.9' },
    items: Object.keys(CONTENTS).map(manifestItem),
  };
}

function seededPorts() {
  const { ports, state } = createInMemoryPorts();
  for (const [path, content] of Object.entries(CONTENTS)) {
    state.files.set(`${RUNTIME}/${path}`, content);
  }
  state.spawnResults.set('yt-dlp.exe', { exitCode: 0, stdout: '2026.11.12\n', stderr: '', timedOut: false });
  state.spawnResults.set('node.exe', { exitCode: 0, stdout: 'v24.21.0\n', stderr: '', timedOut: false });
  state.spawnResults.set('ffmpeg.exe', { exitCode: 0, stdout: 'ffmpeg version n9.0\n', stderr: '', timedOut: false });
  return { ports, state };
}

/** The exact wiring `checkRuntimeForApp()` builds: same ports, cached hash. */
function cachedPorts(
  ports: CorePorts,
  files: Map<string, string>,
  mtimes: Map<string, number>,
  cachePath: string,
  calls: string[],
): CorePorts {
  const io: RuntimeHashCacheIo = {
    async stat(absolutePath) {
      const text = files.get(absolutePath);
      if (text === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return { sizeBytes: Buffer.byteLength(text, 'utf8'), mtimeMs: mtimes.get(absolutePath) ?? 0 };
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async writeText(path, text) { files.set(path, text); },
  };
  return {
    ...ports,
    hash: {
      sha256File: createCachedSha256File({
        io,
        cachePath,
        sha256File: async (absolutePath) => {
          calls.push(absolutePath);
          return ports.hash.sha256File(absolutePath);
        },
      }),
      sha256Bytes: (data: Uint8Array) => ports.hash.sha256Bytes(data),
    },
  };
}

describe('D-169 follow-up · cache wired into Core checkRuntime()', () => {
  const CACHE_PATH = 'C:/data/runtime-hash-cache.json';

  it('a second healthy start-up hashes nothing and still reports OK', async () => {
    const { ports, state } = seededPorts();
    const mtimes = new Map(Object.keys(CONTENTS).map((path) => [`${RUNTIME}/${path}`, 1000]));
    const calls: string[] = [];

    const first = await checkRuntime(cachedPorts(ports, state.files, mtimes, CACHE_PATH, calls), fakeManifest());
    expect(first.allRequiredOk).toBe(true);
    expect(calls).toHaveLength(4);

    const second = await checkRuntime(cachedPorts(ports, state.files, mtimes, CACHE_PATH, calls), fakeManifest());
    expect(second.allRequiredOk).toBe(true);
    expect(calls).toHaveLength(4); // served entirely from the (size, mtime) cache
    const persisted = JSON.parse(state.files.get(CACHE_PATH) ?? 'null') as { schemaVersion?: number };
    expect(persisted.schemaVersion).toBe(1);
  });

  it('a changed file re-hashes alone and the mismatch is still detected', async () => {
    const { ports, state } = seededPorts();
    const mtimes = new Map(Object.keys(CONTENTS).map((path) => [`${RUNTIME}/${path}`, 1000]));
    const calls: string[] = [];
    await checkRuntime(cachedPorts(ports, state.files, mtimes, CACHE_PATH, calls), fakeManifest());
    expect(calls).toHaveLength(4);

    state.files.set(`${RUNTIME}/yt-dlp.exe`, 'tampered');
    mtimes.set(`${RUNTIME}/yt-dlp.exe`, 2000);

    const second = await checkRuntime(cachedPorts(ports, state.files, mtimes, CACHE_PATH, calls), fakeManifest());
    expect(calls).toHaveLength(5); // exactly the changed file
    expect(calls).toContain(`${RUNTIME}/yt-dlp.exe`);
    expect(second.items.find((item) => item.kind === 'ytdlp')?.status).toBe('HASH_MISMATCH');
    expect(second.allRequiredOk).toBe(false);
  });

  it('a corrupt cache degrades to hashing every file, not to skipping the check', async () => {
    const { ports, state } = seededPorts();
    const mtimes = new Map(Object.keys(CONTENTS).map((path) => [`${RUNTIME}/${path}`, 1000]));
    const calls: string[] = [];
    await checkRuntime(cachedPorts(ports, state.files, mtimes, CACHE_PATH, calls), fakeManifest());
    expect(calls).toHaveLength(4);

    state.files.set(CACHE_PATH, '{corrupt');

    const second = await checkRuntime(cachedPorts(ports, state.files, mtimes, CACHE_PATH, calls), fakeManifest());
    expect(calls).toHaveLength(8); // full re-computation, fail closed
    expect(second.allRequiredOk).toBe(true);
    const persisted = JSON.parse(state.files.get(CACHE_PATH) ?? 'null') as { schemaVersion?: number };
    expect(persisted.schemaVersion).toBe(1); // rewritten healthy
  });
});
