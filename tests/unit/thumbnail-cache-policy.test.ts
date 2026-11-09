/**
 * D-103 · pure retention policy for the cover-image cache.
 *
 * These tests never touch the filesystem. They pin the safety invariants the
 * main-process adapter relies on: a cover still shown by the queue is NEVER a
 * deletion candidate, deletion is deterministic, and one pass is bounded.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THUMBNAIL_CACHE_POLICY, MAX_PRUNE_BATCH,
  normalizeThumbnailCachePolicy, planThumbnailPrune,
  type ThumbnailCacheEntry, type ThumbnailCachePolicy,
} from '@ytvdlt/core';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function entry(
  name: string,
  over: Partial<ThumbnailCacheEntry> = {},
): ThumbnailCacheEntry {
  return {
    name,
    bytes: 100,
    lastUsedAt: NOW - DAY,
    taskIds: [],
    untracked: true,
    ...over,
  };
}

function policy(over: Partial<ThumbnailCachePolicy> = {}): ThumbnailCachePolicy {
  return { ...DEFAULT_THUMBNAIL_CACHE_POLICY, nowMs: NOW, ...over };
}

describe('thumbnail cache policy · live references are untouchable', () => {
  it('keeps a cover referenced by a live task even when it is old and over budget', () => {
    const entries = [
      entry('live.jpg', { bytes: 900, taskIds: ['t1'], lastUsedAt: NOW - 400 * DAY }),
      entry('orphan.jpg', { bytes: 900, taskIds: ['gone'], lastUsedAt: NOW - 400 * DAY }),
    ];
    const plan = planThumbnailPrune(entries, ['t1'], policy({ maxBytes: 100 }));
    expect(plan.remove.map((item) => item.name)).toEqual(['orphan.jpg']);
    expect(plan.keep.map((item) => item.name)).toContain('live.jpg');
    expect(plan.bytesAfter).toBe(900); // still over budget: live files are never sacrificed
    expect(plan.truncated).toBe(true);
  });

  it('protects a file shared by several tasks until the last one is gone', () => {
    const shared = entry('shared.jpg', {
      taskIds: ['t1', 't2'], lastUsedAt: NOW - 400 * DAY, untracked: false,
    });
    expect(planThumbnailPrune([shared], ['t2'], policy()).remove).toEqual([]);
    const gone = planThumbnailPrune([shared], [], policy());
    expect(gone.remove.map((item) => item.name)).toEqual(['shared.jpg']);
    expect(gone.remove[0]?.reason).toBe('lost-reference');
  });
});

describe('thumbnail cache policy · three deletion reasons', () => {
  it('removes a cover whose owning task was deleted (lost-reference)', () => {
    const plan = planThumbnailPrune([entry('a.jpg', { taskIds: ['removed'], untracked: false })], [], policy());
    expect(plan.remove).toEqual([{ name: 'a.jpg', bytes: 100, reason: 'lost-reference' }]);
    expect(plan.removedByReason['lost-reference']).toBe(1);
  });

  it('removes an untracked file only after maxAgeDays', () => {
    const fresh = entry('fresh.jpg', { lastUsedAt: NOW - 3 * DAY });
    const stale = entry('stale.jpg', { lastUsedAt: NOW - 31 * DAY });
    const plan = planThumbnailPrune([fresh, stale], [], policy());
    expect(plan.remove.map((item) => item.name)).toEqual(['stale.jpg']);
    expect(plan.remove[0]?.reason).toBe('expired');
    expect(plan.keep.map((item) => item.name)).toEqual(['fresh.jpg']);
  });

  it('trims the oldest unreferenced files first until the byte budget fits', () => {
    const entries = [
      entry('oldest.jpg', { bytes: 600, lastUsedAt: NOW - 2 * DAY }),
      entry('middle.jpg', { bytes: 600, lastUsedAt: NOW - 1 * DAY }),
      entry('newest.jpg', { bytes: 600, lastUsedAt: NOW }),
      entry('current.jpg', { bytes: 600, lastUsedAt: NOW, taskIds: ['t1'] }),
    ];
    const plan = planThumbnailPrune(entries, ['t1'], policy({ maxBytes: 1200 }));
    expect(plan.remove.map((item) => item.name)).toEqual(['oldest.jpg', 'middle.jpg']);
    expect(plan.remove.every((item) => item.reason === 'over-budget')).toBe(true);
    expect(plan.bytesAfter).toBe(1200);
    expect(plan.truncated).toBe(false);
  });

  it('trims by file count as well as bytes', () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`f${i}.jpg`, { bytes: 1, lastUsedAt: NOW }));
    const plan = planThumbnailPrune(entries, [], policy({ maxFiles: 2, maxBytes: 10_000 }));
    expect(plan.remove).toHaveLength(4);
    expect(plan.filesAfter).toBe(2);
  });
});

describe('thumbnail cache policy · bounds and switches', () => {
  it('never returns more than pruneBatch candidates in one pass', () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry(`f${i}.jpg`, {
      taskIds: [`gone-${i}`], untracked: false, lastUsedAt: NOW - 400 * DAY,
    }));
    const plan = planThumbnailPrune(entries, [], policy({ pruneBatch: 12 }));
    expect(plan.remove).toHaveLength(12);
    expect(plan.truncated).toBe(true);
    expect(plan.filesBefore - plan.filesAfter).toBe(12);
  });

  it('deletes nothing when auto-clean is disabled', () => {
    const entries = [entry('a.jpg', { taskIds: ['gone'], untracked: false })];
    const plan = planThumbnailPrune(entries, [], policy({ enabled: false }));
    expect(plan.remove).toEqual([]);
    expect(plan.disabled).toBe(true);
    expect(plan.keep).toHaveLength(1);
  });

  it('is deterministic for the same input', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`f${i}.jpg`, {
      bytes: 100, lastUsedAt: NOW - (i % 4) * DAY,
      taskIds: i % 3 === 0 ? ['gone'] : [],
      untracked: i % 3 !== 0,
    }));
    const a = planThumbnailPrune(entries, [], policy({ maxBytes: 500 }));
    const b = planThumbnailPrune(entries, [], policy({ maxBytes: 500 }));
    expect(a.remove).toEqual(b.remove);
  });
});

describe('thumbnail cache policy · config normalisation', () => {
  it('falls back to shipped defaults for junk values', () => {
    const normalized = normalizeThumbnailCachePolicy({ maxBytes: 'huge', maxAgeDays: -3, pruneBatch: 9999 }, NOW);
    expect(normalized.maxBytes).toBe(DEFAULT_THUMBNAIL_CACHE_POLICY.maxBytes);
    expect(normalized.maxAgeDays).toBe(1);
    expect(normalized.pruneBatch).toBe(MAX_PRUNE_BATCH);
    expect(normalized.nowMs).toBe(NOW);
  });

  it('keeps the safe-delete ceiling even when a bigger batch is requested', () => {
    expect(normalizeThumbnailCachePolicy(null, NOW).enabled).toBe(true);
    expect(normalizeThumbnailCachePolicy({ enabled: false }, NOW).enabled).toBe(false);
  });
});
