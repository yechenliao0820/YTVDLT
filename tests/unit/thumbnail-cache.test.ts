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

describe('D-250 · 封面 URL scheme 升级（http:// → https://）', () => {
  it('bilibili 式纯 http URL：先升级为 https 再抓取，缓存键用升级后的 URL', async () => {
    const h = harness();
    const cache = h.create();
    const upgraded = 'https://i0.hdslb.com/bfs/archive/a017dabc198aeaa22efc2622abe52ee4ff1bbf1c.jpg';
    const path = await cache.ensure('t1', 'http://i0.hdslb.com/bfs/archive/a017dabc198aeaa22efc2622abe52ee4ff1bbf1c.jpg');
    expect(h.requests).toEqual([upgraded]);
    expect(path).not.toBeNull();
    expect(existsSync(join(h.dir, `${hash(upgraded)}.png`))).toBe(true);
    // 冷启动（新实例）按升级后的 URL 命中本地缓存，零额外 HTTP
    const restarted = h.create();
    expect(await restarted.ensure('t2', 'http://i0.hdslb.com/bfs/archive/a017dabc198aeaa22efc2622abe52ee4ff1bbf1c.jpg')).toBe(path);
    expect(h.requests).toEqual([upgraded]);
  });

  it('https URL 原样通过（缓存键不变）；非 http(s) / 空串不发起抓取', async () => {
    const h = harness();
    const cache = h.create();
    await cache.ensure('t1', 'https://i.ytimg.com/vi/x/hqdefault.jpg');
    expect(h.requests).toEqual(['https://i.ytimg.com/vi/x/hqdefault.jpg']);
    // 这些在旧行为里也被 isPublicHttpsUrl 拒绝；D-250 后在更早处拦截，结果一致
    expect(await cache.ensure('t2', 'ftp://cdn.example/cover.png')).toBeNull();
    expect(await cache.ensure('t3', 'data:image/png;base64,AAAA')).toBeNull();
    expect(await cache.ensure('t4', 'not a url')).toBeNull();
    expect(await cache.ensure('t5', '   ')).toBeNull();
    expect(h.requests).toHaveLength(1);
  });
});

/**
 * D-252 · 无痕关窗的封面定向回收（purgeCovers）。
 *
 * 隐私承诺必须兑现到缓存层：关窗后仅被已移除无痕任务独占的封面当场走
 * 回收站端口（与 prune 同一套 isSafeCacheName + 目录前缀 + trash 守卫），
 * 绝不依赖 autoCleanThumbnailCache 空间开关；共享封面、未归属文件、其他
 * 任务的封面一律不动；回收失败先落 purgePending 标记，由下一次 prune
 * （含启动那次）无视开关兜底回收。
 */
describe('D-252 · 无痕关窗的封面定向回收', () => {
  it('recycles an exclusively owned cover at close time with the auto-clean switch OFF', async () => {
    const h = harness();
    h.policyValues['enabled'] = false; // privacy must not depend on the space switch
    const cache = h.create({ liveTaskIds: () => ['keep1'] });
    const privatePath = await cache.ensure('p1', 'https://cdn.example/private.png');
    await cache.ensure('keep1', 'https://cdn.example/keep.png');
    cache.forget('p1'); // the close purge dropped the reference first

    const report = await cache.purgeCovers(['p1']);
    expect(report).toEqual({ marked: 1, removed: 1, failed: 0 });
    // Fake recycle bin: renamed, never permanently deleted (§0.1).
    expect(h.trashed).toEqual([privatePath]);
    expect(h.trashed[0]?.startsWith(h.dir)).toBe(true);
    expect(existsSync(privatePath)).toBe(false);
    expect(existsSync(`${privatePath}.trashed`)).toBe(true);
    // The cover of the surviving task is untouched.
    const after = await cache.status();
    expect(after.files).toBe(1);
  });

  it('keeps a cover shared with a task outside the purge', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => ['n1'] });
    const sharedPath = await cache.ensure('n1', 'https://cdn.example/shared.png');
    await cache.ensure('p1', 'https://cdn.example/shared.png');
    cache.forget('p1');

    expect(await cache.purgeCovers(['p1'])).toEqual({ marked: 0, removed: 0, failed: 0 });
    expect(h.trashed).toEqual([]);
    expect(existsSync(sharedPath)).toBe(true);
  });

  it('keeps a cover whose index record still names an id the purge cannot account for', async () => {
    const h = harness();
    // A crashed session left 'ghost' in the index next to the purged 'p1':
    // the close cannot prove exclusivity, so the file waits for the regular
    // prune rules instead of being guessed at.
    const ghosted = `${hash('https://cdn.example/ghosted.png')}.png`;
    writeFileSync(join(h.dir, ghosted), PNG);
    writeFileSync(join(h.dir, 'index.json'), JSON.stringify({
      version: 1,
      entries: { [ghosted]: { bytes: PNG.byteLength, lastUsedAt: Date.now(), taskIds: ['p1', 'ghost'] } },
      lastPrunedAt: null,
    }));
    const cache = h.create({ liveTaskIds: () => [] });

    expect(await cache.purgeCovers(['p1'])).toEqual({ marked: 0, removed: 0, failed: 0 });
    expect(h.trashed).toEqual([]);
    expect(existsSync(join(h.dir, ghosted))).toBe(true);
  });

  it('is a no-op for ids the index has never heard of', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => [] });
    await cache.ensure('t1', 'https://cdn.example/cover.png');
    expect(await cache.purgeCovers(['never-existed'])).toEqual({ marked: 0, removed: 0, failed: 0 });
    expect(h.trashed).toEqual([]);
  });

  it('deferred purge: no recycle bin marks the entry, and the next boot prune recovers it switch-off', async () => {
    const h = harness();
    h.policyValues['enabled'] = false;
    const cache = h.create({ noTrash: true, liveTaskIds: () => [] });
    const path = await cache.ensure('p1', 'https://cdn.example/deferred.png');
    cache.forget('p1');

    expect(await cache.purgeCovers(['p1'])).toEqual({ marked: 1, removed: 0, failed: 0 });
    expect(existsSync(path)).toBe(true);
    // The boolean marker (no private data) is persisted in index.json.
    const raw = JSON.parse(readFileSync(join(h.dir, 'index.json'), 'utf8'));
    expect(raw.entries[`${hash('https://cdn.example/deferred.png')}.png`].purgePending).toBe(true);

    // Next session's boot prune runs with the switch STILL off and recovers
    // exactly the marked entry.
    const restarted = h.create({ liveTaskIds: () => [] });
    const boot = await restarted.prune();
    expect(boot.ok).toBe(true);
    expect(boot.removed).toBe(1);
    expect(boot.removedByReason['purge-pending']).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('with the switch off, a plain lost-reference still waits (only purge-pending bypasses)', async () => {
    const h = harness();
    h.policyValues['enabled'] = false;
    const cache = h.create({ noTrash: true, liveTaskIds: () => [] });
    const privatePath = await cache.ensure('p1', 'https://cdn.example/priv.png');
    const normalPath = await cache.ensure('n1', 'https://cdn.example/norm.png');
    cache.forget('p1');
    cache.forget('n1');
    await cache.purgeCovers(['p1']); // deferred: marked only

    const restarted = h.create({ liveTaskIds: () => [] });
    const boot = await restarted.prune();
    expect(boot.removed).toBe(1);
    expect(existsSync(privatePath)).toBe(false);
    // Regular space hygiene stays gated by the switch.
    expect(existsSync(normalPath)).toBe(true);
  });

  it('a live re-attach clears the marker: the queue showing the cover outranks the purge', async () => {
    const h = harness();
    h.policyValues['enabled'] = false;
    const cache = h.create({ noTrash: true, liveTaskIds: () => ['p1'] });
    const path = await cache.ensure('p1', 'https://cdn.example/comeback.png');
    cache.forget('p1');
    await cache.purgeCovers(['p1']); // deferred → marked

    // The task (or a new one with the same cover) ensures again after restart.
    expect(await cache.ensure('p1', 'https://cdn.example/comeback.png')).toBe(path);
    const raw = JSON.parse(readFileSync(join(h.dir, 'index.json'), 'utf8'));
    expect(raw.entries[`${hash('https://cdn.example/comeback.png')}.png`].purgePending).toBeUndefined();

    const restarted = h.create({ liveTaskIds: () => ['p1'] });
    expect((await restarted.prune()).removed).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('counts a failed recycle as failed, keeps the entry marked and never throws', async () => {
    const h = harness();
    const cache = h.create({ liveTaskIds: () => [], trash: async () => false });
    const path = await cache.ensure('p1', 'https://cdn.example/stuck.png');
    cache.forget('p1');

    expect(await cache.purgeCovers(['p1'])).toEqual({ marked: 1, removed: 0, failed: 1 });
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(join(h.dir, 'index.json'), 'utf8'));
    expect(raw.entries[`${hash('https://cdn.example/stuck.png')}.png`].purgePending).toBe(true);
  });

  it('survives a rejecting trash port and a closed cache dir without throwing', async () => {
    const h = harness();
    const cache = h.create({
      liveTaskIds: () => [],
      trash: async () => { throw new Error('recycle bin wedged'); },
    });
    const path = await cache.ensure('p1', 'https://cdn.example/wedged.png');
    cache.forget('p1');
    expect(await cache.purgeCovers(['p1'])).toEqual({ marked: 1, removed: 0, failed: 1 });
    expect(existsSync(path)).toBe(true);
  });
});
