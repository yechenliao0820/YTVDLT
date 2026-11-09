/**
 * D-103 · ThumbnailCache adapter (main process, real filesystem in an OS temp
 * directory, no network, no Electron).
 *
 * The fake "recycle bin" RENAMES the file instead of deleting it: the test
 * suite must never permanently delete anything either (§0.1 of the maintenance
 * handbook). Every path handed to it is asserted to stay inside the cache dir
 * and to be a cache image — never a user video.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createThumbnailCache, type ThumbnailCacheOptions } from '../../apps/desktop/src/main/thumbnail-cache.js';
import type { ILogger } from '@ytvdlt/core';
import type { HttpPort } from '@ytvdlt/shared';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const DAY = 24 * 60 * 60 * 1000;

function logger(): ILogger {
  const noop = async (): Promise<void> => undefined;
  return {
    log: noop, info: noop, warn: noop, error: noop, logArgv: noop,
    writeCrashReport: async () => '', exportLogs: async () => '',
  };
}

interface Harness {
  readonly dir: string;
  readonly policyValues: Record<string, unknown>;
  readonly trashed: string[];
  readonly requests: string[];
  create(options?: Partial<ThumbnailCacheOptions> & { noTrash?: boolean }): ReturnType<typeof createThumbnailCache>;
}

function harness(over: { now?: () => number; httpBytes?: () => Promise<Uint8Array> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-thumb-'));
  const policyValues: Record<string, unknown> = {
    enabled: true, maxBytes: 1_000_000, maxFiles: 50, maxAgeDays: 30, pruneBatch: 40,
  };
  const trashed: string[] = [];
  const requests: string[] = [];
  const http: HttpPort = {
    getText: async () => '',
    getBytes: async (url) => {
      requests.push(url);
      return over.httpBytes === undefined ? PNG : over.httpBytes();
    },
  };
  const h: Harness = {
    dir, policyValues, trashed, requests,
    create(options = {}) {
      const { noTrash, ...rest } = options;
      return createThumbnailCache({
        dir,
        logger: logger(),
        http,
        ...(over.now === undefined ? {} : { now: over.now }),
        liveTaskIds: () => [],
        policy: () => ({ ...policyValues }),
        setPolicy: async (patch) => { Object.assign(policyValues, patch); },
        // Simulate the OS recycle bin without deleting anything.
        ...(noTrash === true ? {} : {
          trash: async (path: string) => {
            trashed.push(path);
            renameSync(path, `${path}.trashed`);
            return true;
          },
        }),
        ...rest,
      });
    },
  };
  return h;
}

function hash(url: string): string {
  return createHash('sha1').update(url).digest('hex');
}

describe('thumbnail cache · no duplicate downloads', () => {
  it('reuses the local file across tasks and across a restart (zero extra HTTP)', async () => {
    const h = harness();
    const url = 'https://cdn.example/cover.png';
    const first = h.create({ liveTaskIds: () => ['t1'] });
    const path = await first.ensure('t1', url);
    expect(path).not.toBeNull();
    expect(h.requests).toEqual([url]);
    expect(existsSync(join(h.dir, `${hash(url)}.png`))).toBe(true);

    // A different task pointing at the same cover must not hit the network.
    const secondPath = await first.ensure('t2', url);
    expect(secondPath).toBe(path);
    expect(h.requests).toEqual([url]);

    // Cold start: in-memory map is gone, index.json is on disk.
    const restarted = h.create({ liveTaskIds: () => ['t1', 't2'] });
    expect(await restarted.ensure('t1', url)).toBe(path);
    expect(await restarted.ensure('t2', url)).toBe(path);
    expect(h.requests).toEqual([url]);
  });

  it('keeps the original fetch path and degrades to the letter badge on bad bytes', async () => {
    const h = harness({ httpBytes: async () => new Uint8Array([1, 2, 3]) });
    const cache = h.create();
    expect(await cache.ensure('t1', 'https://cdn.example/broken.png')).toBeNull();
    expect(cache.pathOf('t1')).toBeNull();
  });
});

describe('thumbnail cache · reference-safe cleanup', () => {
  it('never recycles a cover still referenced by a live task', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => ['t1'] });
    h.policyValues['maxBytes'] = 1; // deliberately far over budget
    h.policyValues['maxAgeDays'] = 1;
    await cache.ensure('t1', 'https://cdn.example/live.png');
    const report = await cache.prune();
    expect(report.removed).toBe(0);
    expect(report.bytesAfter).toBe(report.bytesBefore);
    expect(h.trashed).toEqual([]);
  });

  it('recycles a cover after its task is removed, and reports the space change', async () => {
    const h = harness();
    let live = ['t1'];
    const cache = h.create({ liveTaskIds: () => live });
    const path = await cache.ensure('t1', 'https://cdn.example/gone.png');
    expect(path).not.toBeNull();
    cache.forget('t1');
    live = [];

    const before = await cache.status();
    expect(before.files).toBe(1);
    expect(before.orphanFiles).toBe(1);
    const report = await cache.prune();
    expect(report.ok).toBe(true);
    expect(report.removed).toBe(1);
    expect(report.freedBytes).toBe(PNG.byteLength);
    expect(report.bytesAfter).toBe(report.bytesBefore - report.freedBytes);
    expect(report.removedByReason['lost-reference']).toBe(1);
    expect(h.trashed).toHaveLength(1);
    expect(existsSync(`${path}.trashed`)).toBe(true);
  });

  it('keeps a shared cover while one of its tasks is still alive', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => ['t2'] });
    await cache.ensure('t1', 'https://cdn.example/shared.png');
    await cache.ensure('t2', 'https://cdn.example/shared.png');
    cache.forget('t1');
    expect((await cache.prune()).removed).toBe(0);
    expect(h.trashed).toEqual([]);
  });

  it('removes expired, never-attributed files by last-used time', async () => {
    const now = () => 1_800_000_000_000;
    const h = harness({ now });
    // Seed a pre-D-103 cache: real file on disk, no index.json.
    const staleName = `${hash('https://cdn.example/stale.png')}.png`;
    writeFileSync(join(h.dir, staleName), PNG);
    // Seed a pre-D-103 index record with a genuinely old last-use timestamp.
    writeFileSync(join(h.dir, 'index.json'), JSON.stringify({
      version: 1,
      entries: { [staleName]: { bytes: PNG.byteLength, lastUsedAt: now() - 90 * DAY, taskIds: [], untracked: true } },
      lastPrunedAt: null,
    }));
    const fresh = h.create();
    const report = await fresh.prune();
    expect(report.removed).toBe(1);
    expect(report.removedByReason.expired).toBe(1);
  });

  it('trims the oldest unreferenced files until the configured capacity fits', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => [] });
    h.policyValues['maxBytes'] = 2 * PNG.byteLength + 1;
    for (let i = 0; i < 4; i += 1) await cache.ensure(`t${i}`, `https://cdn.example/c${i}.png`);
    // All four tasks are gone from the live list → lost-reference candidates.
    const report = await cache.prune();
    expect(report.removed).toBeGreaterThan(0);
    expect(report.bytesAfter).toBeLessThanOrEqual(2 * PNG.byteLength + 1);
  });
});

describe('thumbnail cache · safety and failure isolation', () => {
  it('never hands a user video or a path outside the cache dir to the trash port', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => [] });
    await cache.ensure('t1', 'https://cdn.example/cover.png');
    // A video sitting next to the cache must be invisible to housekeeping.
    writeFileSync(join(h.dir, 'holiday.mp4'), Buffer.alloc(4096, 7));
    const report = await cache.prune();
    expect(report.removed).toBe(1);
    for (const path of h.trashed) {
      expect(path.startsWith(h.dir)).toBe(true);
      expect(path.endsWith('.png')).toBe(true);
      expect(path).not.toContain('holiday.mp4');
    }
    expect(existsSync(join(h.dir, 'holiday.mp4'))).toBe(true);
  });

  it('deletes nothing when the recycle-bin port is unavailable', async () => {
    const h = harness();
    const cache = h.create({ noTrash: true, liveTaskIds: () => [] });
    await cache.ensure('t1', 'https://cdn.example/cover.png');
    const report = await cache.prune();
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('recycle-bin-unavailable');
    expect(report.removed).toBe(0);
    expect(h.trashed).toEqual([]);
  });

  it('honours the auto-clean switch, with force overriding it for the manual button', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => [] });
    await cache.ensure('t1', 'https://cdn.example/cover.png');
    h.policyValues['enabled'] = false;
    expect((await cache.prune()).reason).toBe('auto-clean-disabled');
    expect((await cache.prune({ force: true })).removed).toBe(1);
  });

  it('persists the settings-page switches through the policy port', async () => {
    const h = harness();
    const cache = h.create();
    await cache.setAutoClean(false);
    expect(h.policyValues['enabled']).toBe(false);
    await cache.setMaxBytes(64 * 1024 * 1024);
    expect(h.policyValues['maxBytes']).toBe(64 * 1024 * 1024);
  });

  it('counts a failed recycle as a failure, keeps the entry and never throws', async () => {
    const h = harness();
    const cache = h.create({
      liveTaskIds: () => [],
      trash: async () => false,
    });
    await cache.ensure('t1', 'https://cdn.example/cover.png');
    const report = await cache.prune();
    expect(report.ok).toBe(true);
    expect(report.removed).toBe(0);
    expect(report.failed).toBe(1);
    expect((await cache.status()).files).toBe(1);
  });

  it('does not corrupt the index when a corrupt index.json is present', async () => {
    const h = harness();
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(join(h.dir, 'index.json'), '{ this is not json');
    const cache = h.create();
    const path = await cache.ensure('t1', 'https://cdn.example/cover.png');
    expect(path).not.toBeNull();
    expect(JSON.parse(readFileSync(join(h.dir, 'index.json'), 'utf8')).version).toBe(1);
  });
});
