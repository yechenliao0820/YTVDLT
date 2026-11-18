/**
 * Thumbnail cache retention policy (D-103).
 *
 * Pure decision layer — no `node:*`, no `electron`, no filesystem access and no
 * knowledge of where the files live. The main-process adapter passes a list of
 * entries it scanned from the cache directory; this module only says WHICH of
 * those entries may be recycled. Deleting bytes is always the adapter's job,
 * and it must go through the OS recycle bin.
 *
 * Four deletion reasons, all of which require the file to be UNREFERENCED:
 *   1. `purge-pending` — D-252: a private-mode close marked this cover because
 *      every task id the index recorded for it belongs to the purge. Privacy
 *      is a correctness promise, not space hygiene, so this reason fires even
 *      when `enabled` is false (the switch governs SPACE, never privacy);
 *   2. `lost-reference` — the index recorded task ids but none of them exist
 *      any more (the download task was removed);
 *   3. `expired` — never referenced (or orphaned from an older build) and its
 *      last-use time is older than `maxAgeDays`;
 *   4. `over-budget` — the whole cache exceeds `maxBytes` / `maxFiles`, so the
 *      oldest unreferenced entries go first until it fits.
 *
 * A file referenced by at least one LIVE task is never returned in `remove`,
 * even when the cache is wildly over budget. That is the "never delete a cover
 * the queue still shows" invariant the user asked for.
 */
export interface ThumbnailCacheEntry {
  /** File name inside the cache directory, e.g. `<sha1(url)>.jpg`. */
  readonly name: string;
  readonly bytes: number;
  /** Epoch milliseconds of the last time a live task used this cover. */
  readonly lastUsedAt: number;
  /** Task ids recorded in the index; empty = never attributed to a task. */
  readonly taskIds: readonly string[];
  /**
   * True for files discovered by a disk scan with no index record (caches from
   * builds predating the index). They are only removed by age / budget rules,
   * never by a plain "unreferenced" sweep, so a cold start cannot delete the
   * covers of tasks that have not been restored yet.
   */
  readonly untracked?: boolean;
  /**
   * D-252: set by the desktop adapter when a private-mode close proved this
   * cover is owned ONLY by tasks the purge just removed. Marked entries are
   * recycled regardless of the `enabled` switch and before any age/budget
   * rule — privacy must not wait for housekeeping. The live-task guard still
   * applies: a NEW task that re-ensures the same cover outranks the marker.
   */
  readonly purgePending?: boolean;
}

export interface ThumbnailCachePolicy {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxAgeDays: number;
  /** Hard ceiling per prune pass (the desktop safe-delete guard allows 50). */
  readonly pruneBatch: number;
  readonly nowMs: number;
}

export type PruneReason = 'purge-pending' | 'lost-reference' | 'expired' | 'over-budget';

export interface PruneCandidate {
  readonly name: string;
  readonly bytes: number;
  readonly reason: PruneReason;
}

export interface ThumbnailPrunePlan {
  readonly keep: readonly ThumbnailCacheEntry[];
  readonly remove: readonly PruneCandidate[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly filesBefore: number;
  readonly filesAfter: number;
  readonly removedByReason: Readonly<Record<PruneReason, number>>;
  /** True when `pruneBatch` stopped the pass; another pass is still needed. */
  readonly truncated: boolean;
  /**
   * true when auto-clean is off — the caller must not delete anything EXCEPT
   * `purge-pending` candidates, which are switch-independent by design (D-252).
   */
  readonly disabled: boolean;
}

export const DEFAULT_THUMBNAIL_CACHE_POLICY: Readonly<{
  enabled: boolean; maxBytes: number; maxFiles: number; maxAgeDays: number; pruneBatch: number;
}> = Object.freeze({
  enabled: true,
  maxBytes: 128 * 1024 * 1024,
  maxFiles: 500,
  maxAgeDays: 30,
  pruneBatch: 40,
});

/** The OS safe-delete guard refuses batches larger than this. */
export const MAX_PRUNE_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Config values are user-editable JSON; never let a bad value open a hole. */
export function normalizeThumbnailCachePolicy(raw: unknown, nowMs: number): ThumbnailCachePolicy {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const defaults = DEFAULT_THUMBNAIL_CACHE_POLICY;
  return {
    enabled: source['enabled'] === undefined ? defaults.enabled : source['enabled'] === true,
    maxBytes: finite(source['maxBytes'], defaults.maxBytes, 8 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
    maxFiles: finite(source['maxFiles'], defaults.maxFiles, 20, 10_000),
    maxAgeDays: finite(source['maxAgeDays'], defaults.maxAgeDays, 1, 365),
    pruneBatch: finite(source['pruneBatch'], defaults.pruneBatch, 1, MAX_PRUNE_BATCH),
    nowMs,
  };
}

function byOldestFirst(a: ThumbnailCacheEntry, b: ThumbnailCacheEntry): number {
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Decide what to recycle. `liveTaskIds` comes from the real task queue; the
 * policy never guesses which files a user might still need.
 */
export function planThumbnailPrune(
  entries: readonly ThumbnailCacheEntry[],
  liveTaskIds: readonly string[],
  policy: ThumbnailCachePolicy,
): ThumbnailPrunePlan {
  const live = new Set(liveTaskIds);
  const sorted = [...entries].sort(byOldestFirst);
  const bytesBefore = sorted.reduce((sum, entry) => sum + Math.max(0, entry.bytes), 0);
  const filesBefore = sorted.length;
  const removedByReason: Record<PruneReason, number> = {
    'purge-pending': 0, 'lost-reference': 0, expired: 0, 'over-budget': 0,
  };

  const remove: PruneCandidate[] = [];
  const candidates: ThumbnailCacheEntry[] = [];
  const pending: ThumbnailCacheEntry[] = [];
  const reasons = new Map<string, PruneReason>();

  for (const entry of sorted) {
    const referenced = entry.taskIds.some((id) => live.has(id));
    if (referenced) continue;

    // D-252: a private-mode close marked this cover for deterministic
    // recycling. It is scheduled SEPARATELY from the age/reference rules below
    // so its own reason survives and the switch can never hold it back.
    if (entry.purgePending === true) {
      pending.push(entry);
      continue;
    }

    // Lost reference: the index KNEW which task owned this cover and that task
    // is gone. This is the only "orphan" class safe to remove immediately.
    if (!entry.untracked && entry.taskIds.length > 0) {
      reasons.set(entry.name, 'lost-reference');
      candidates.push(entry);
      continue;
    }

    const ageMs = policy.nowMs - entry.lastUsedAt;
    if (ageMs >= policy.maxAgeDays * DAY_MS) {
      reasons.set(entry.name, 'expired');
      candidates.push(entry);
      continue;
    }
    // Untracked-but-fresh files wait for the next pass (or a budget overflow).
  }

  const disabled = policy.enabled !== true;
  const take = (entry: ThumbnailCacheEntry, reason: PruneReason): void => {
    remove.push({ name: entry.name, bytes: Math.max(0, entry.bytes), reason });
    removedByReason[reason] = (removedByReason[reason] ?? 0) + 1;
  };

  // ⓪ privacy correctness first (D-252): marked covers go regardless of the
  //    `enabled` switch and ahead of every space rule — but the live-task
  //    guard above still applies, and the batch cap still bounds one pass
  //    (leftovers are picked up by the next pass; never indefinite, never
  //    switch-gated).
  let pendingLeft = false;
  for (const entry of pending) {
    if (remove.length >= policy.pruneBatch) { pendingLeft = true; break; }
    take(entry, 'purge-pending');
  }

  if (!disabled) {
    // ① deterministic reasons first (oldest first — `candidates` is sorted).
    for (const entry of candidates) {
      if (remove.length >= policy.pruneBatch) break;
      take(entry, reasons.get(entry.name) ?? 'expired');
    }

    // ② then budget pressure: only files that are NOT live and NOT already
    //    scheduled for removal. Live covers stay even when over budget.
    let bytes = bytesBefore - remove.reduce((sum, item) => sum + item.bytes, 0);
    let files = filesBefore - remove.length;
    const scheduled = new Set(remove.map((item) => item.name));
    const freshUnreferenced = sorted.filter((entry) => {
      if (scheduled.has(entry.name)) return false;
      return !entry.taskIds.some((id) => live.has(id));
    });
    for (const entry of freshUnreferenced) {
      if (bytes <= policy.maxBytes && files <= policy.maxFiles) break;
      if (remove.length >= policy.pruneBatch) break;
      take(entry, 'over-budget');
      bytes -= Math.max(0, entry.bytes);
      files -= 1;
    }
  }

  const removedBytes = remove.reduce((sum, item) => sum + item.bytes, 0);
  const bytesAfter = Math.max(0, bytesBefore - removedBytes);
  const filesAfter = Math.max(0, filesBefore - remove.length);
  const removedNames = new Set(remove.map((item) => item.name));
  const firstPassLeft = candidates.length > removedByReason['lost-reference'] + removedByReason.expired;
  return {
    keep: sorted.filter((entry) => !removedNames.has(entry.name)),
    remove,
    bytesBefore,
    bytesAfter,
    filesBefore,
    filesAfter,
    removedByReason,
    // More work remains when deterministic candidates were left behind, a
    // batch ceiling was hit with work to do, the budget is still exceeded, or
    // purge-pending entries did not fit into this pass (D-252 leftovers).
    truncated: pendingLeft || (!disabled && (
      firstPassLeft
      || (remove.length >= policy.pruneBatch && (bytesAfter > policy.maxBytes || filesAfter > policy.maxFiles || firstPassLeft))
      || bytesAfter > policy.maxBytes
      || filesAfter > policy.maxFiles
    )),
    disabled,
  };
}
