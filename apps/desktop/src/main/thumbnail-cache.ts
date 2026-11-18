/**
 * ThumbnailCache — cover images for the queue cards (0.2.1 D-96, extended D-103).
 *
 * Why cache instead of pointing `<img>` at the remote URL:
 *   1. the project rule is that no media URL leaves the main process (a signed
 *      link must never end up in the DOM or a screenshot);
 *   2. a card must keep its cover after the source rotates its CDN URL;
 *   3. offline / privacy mode then simply has no cover, which is the same
 *      fallback as "this extractor has none".
 *
 * D-103 adds retention on TOP of the original mechanism (same directory, same
 * `<sha1(url)>.<ext>` names, same signature checks, same best-effort failure
 * policy). Nothing here re-implements the fetch path:
 *
 *   - `index.json` records which task owns a file and when it was last used, so
 *     deleting a task no longer leaves a permanent orphan;
 *   - `ensure()` checks the local file BEFORE the network, so a restart does
 *     not re-download covers that are already on disk;
 *   - `prune()` asks the pure Core policy what may be recycled and sends ONLY
 *     cache-image paths to the injected recycle-bin port. A failure is logged
 *     and swallowed: the download queue is never blocked by cache housekeeping.
 *
 * D-252 closes the privacy gap in that retention: `forget()` (the private-mode
 * close path) only drops the in-memory reference, which left a private task's
 * cover FILE and index entry waiting for a prune pass — one that is gated by
 * the `autoCleanThumbnailCache` SPACE switch and by future `ensure()` traffic.
 * `purgeCovers()` is the close-time counterpart: it marks the covers owned
 * ONLY by the just-removed private task ids (`purgePending` in `index.json` —
 * a boolean, no private data) and immediately recycles them through the SAME
 * guarded trash path as `prune()`. The marker makes the cleanup recoverable:
 * if the trash call fails or the process exits first, the next prune pass —
 * boot included — recycles marked entries with the switch OFF.
 *
 * Failures are never fatal: every method resolves to a value, the card keeps
 * its letter badge, and a task with a broken URL costs exactly one request.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HttpPort } from '@ytvdlt/shared';
import { isPublicHttpsUrl } from './adapters/http-policy.js';
import { upgradeThumbnailUrl } from './thumbnail-url.js';
import {
  coverNamesOwnedOnlyBy,
  normalizeThumbnailCachePolicy, planThumbnailPrune,
  type ThumbnailCacheEntry, type ThumbnailCachePolicy, type ILogger,
} from '@ytvdlt/core';

export interface ThumbnailCacheOptions {
  /** `<dataDir>/thumbs` — created on demand. */
  readonly dir: string;
  readonly http?: HttpPort;
  readonly logger: ILogger;
  /** Anything bigger is not a thumbnail; defaults to 6 MiB. */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Live task ids, from the real queue. Absent = no task is considered live. */
  readonly liveTaskIds?: () => readonly string[];
  /** Raw config values for the retention policy; read on every pass. */
  readonly policy?: () => Record<string, unknown>;
  /** Persist a policy change made by the settings page. */
  readonly setPolicy?: (patch: Record<string, unknown>) => Promise<void> | void;
  /**
   * ONLY deletion primitive. Must move the file to the OS recycle bin
   * (`shell.trashItem`). When absent, `prune()` deletes nothing and says why.
   */
  readonly trash?: (path: string) => Promise<boolean>;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
  /** How many successful `ensure()` calls between automatic prune passes. */
  readonly autoPruneEvery?: number;
}

/** What the settings page shows; all sizes are bytes on disk. */
export interface ThumbnailCacheStatus {
  readonly files: number;
  readonly bytes: number;
  readonly orphanFiles: number;
  readonly expiredFiles: number;
  readonly reclaimableBytes: number;
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxAgeDays: number;
  readonly lastPrunedAt: string | null;
  readonly recycleBinAvailable: boolean;
}

export interface ThumbnailPruneReport {
  readonly ok: boolean;
  readonly reason: string;
  readonly filesBefore: number;
  readonly bytesBefore: number;
  readonly filesAfter: number;
  readonly bytesAfter: number;
  readonly freedBytes: number;
  readonly removed: number;
  readonly failed: number;
  readonly removedByReason: Readonly<Record<'purge-pending' | 'lost-reference' | 'expired' | 'over-budget', number>>;
  readonly truncated: boolean;
  readonly lastPrunedAt: string | null;
}

/** What `purgeCovers()` reports to the caller (the close / quit path logs it). */
export interface ThumbnailCoverPurgeReport {
  /** Cover names the exclusivity rule identified for the given task ids. */
  readonly marked: number;
  /** Names actually handed to the recycle bin in this pass. */
  readonly removed: number;
  /** Names left in the index (marked `purgePending`) after a failed recycle. */
  readonly failed: number;
}

export interface ThumbnailCache {
  /** Cached absolute path for a task, or null when nothing usable exists. */
  pathOf(taskId: string): string | null;
  /** Best-effort fetch + cache; resolves to the path when it worked. */
  ensure(taskId: string, url: string | null | undefined): Promise<string | null>;
  /** Drop the task reference (the file survives until the next prune). */
  forget(taskId: string): void;
  /**
   * D-252: recycle the covers owned ONLY by the given (just-removed private)
   * task ids — switch-independent, trash-port only, never throws. Covers
   * shared with any other task, untracked files, and anything the rule cannot
   * prove exclusive are left to the regular prune rules.
   */
  purgeCovers(taskIds: readonly string[]): Promise<ThumbnailCoverPurgeReport>;
  /** Current occupancy; never throws. */
  status(): Promise<ThumbnailCacheStatus>;
  /** Recycle unreferenced / expired / over-budget covers; never throws. */
  prune(options?: { force?: boolean }): Promise<ThumbnailPruneReport>;
  /** Settings-page switches. Return the persisted policy values. */
  setAutoClean(enabled: boolean): Promise<Record<string, unknown>>;
  setMaxBytes(bytes: number): Promise<Record<string, unknown>>;
}

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
const INDEX_NAME = 'index.json';
const IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const CANDIDATE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const AUTO_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

interface IndexEntry {
  bytes: number;
  lastUsedAt: number;
  taskIds: string[];
  /** Disk scan found this file but no index record (pre-D-103 cache). */
  untracked?: boolean;
  /**
   * D-252: a private-mode close proved this entry is owned only by tasks the
   * purge removed. Pure boolean, no private data — but it makes the next prune
   * pass recycle the file even with the auto-clean switch off.
   */
  purgePending?: true;
}

interface IndexFile {
  version: 1;
  entries: Record<string, IndexEntry>;
  lastPrunedAt: string | null;
}

interface ImageSignature {
  readonly ext: string;
  readonly test: (bytes: Uint8Array) => boolean;
}

const SIGNATURES: readonly ImageSignature[] = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: 'webp',
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
];

function signatureOf(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  for (const signature of SIGNATURES) {
    if (signature.test(bytes)) return signature.ext;
  }
  return null;
}

function emptyIndex(): IndexFile {
  return { version: 1, entries: {}, lastPrunedAt: null };
}

/**
 * Only cache images inside `dir` may ever be passed to the trash port. A video
 * file, a path traversal or a sibling directory can never satisfy this test.
 */
function isSafeCacheName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === INDEX_NAME) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

function parseIndex(raw: string): IndexFile {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyIndex();
  const record = parsed as Record<string, unknown>;
  const rawEntries = record['entries'];
  const entries: Record<string, IndexEntry> = {};
  if (rawEntries !== null && typeof rawEntries === 'object' && !Array.isArray(rawEntries)) {
    for (const [name, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (!isSafeCacheName(name) || value === null || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const bytes = typeof item['bytes'] === 'number' && Number.isFinite(item['bytes']) ? item['bytes'] : 0;
      const lastUsedAt = typeof item['lastUsedAt'] === 'number' && Number.isFinite(item['lastUsedAt'])
        ? item['lastUsedAt'] : Date.now();
      const taskIds = Array.isArray(item['taskIds'])
        ? item['taskIds'].filter((id): id is string => typeof id === 'string') : [];
      entries[name] = {
        bytes: Math.max(0, bytes),
        lastUsedAt,
        taskIds,
        ...(item['untracked'] === true ? { untracked: true } : {}),
        ...(item['purgePending'] === true ? { purgePending: true } : {}),
      };
    }
  }
  return {
    version: 1,
    entries,
    lastPrunedAt: typeof record['lastPrunedAt'] === 'string' ? record['lastPrunedAt'] : null,
  };
}

function emptyReport(reason: string, lastPrunedAt: string | null): ThumbnailPruneReport {
  return {
    ok: false, reason,
    filesBefore: 0, bytesBefore: 0, filesAfter: 0, bytesAfter: 0, freedBytes: 0,
    removed: 0, failed: 0,
    removedByReason: { 'purge-pending': 0, 'lost-reference': 0, expired: 0, 'over-budget': 0 },
    truncated: false, lastPrunedAt,
  };
}

export function createThumbnailCache(options: ThumbnailCacheOptions): ThumbnailCache {
  const { dir, http, logger } = options;
  const maxBytesPerFile = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const autoPruneEvery = Math.max(1, options.autoPruneEvery ?? 25);
  const indexPath = join(dir, INDEX_NAME);
  /** taskId -> absolute file path. */
  const byTask = new Map<string, string>();
  /** taskId -> in-flight attempt, so a 1.2 s poll cannot fan out requests. */
  const inFlight = new Map<string, Promise<string | null>>();

  let index: IndexFile = emptyIndex();
  let writeChain: Promise<void> = Promise.resolve();
  let ensureCount = 0;
  // Start the clock at construction: the first `ensure()` of a session must NOT
  // fire a background prune while the boot restore is still attaching live
  // tasks. The explicit start-up prune (electron-entry) owns that first pass.
  let lastAutoPruneAt = now();

  function policy(): ThumbnailCachePolicy {
    const raw = options.policy === undefined ? {} : options.policy();
    return normalizeThumbnailCachePolicy(raw, now());
  }

  async function readIndex(): Promise<IndexFile> {
    try { return parseIndex(await readFile(indexPath, 'utf8')); }
    catch { return emptyIndex(); }
  }

  async function writeIndex(): Promise<void> {
    await mkdir(dir, { recursive: true });
    const temp = `${indexPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    await rename(temp, indexPath);
  }

  /** Serialise every index mutation so concurrent ensure/prune cannot clobber it. */
  function commit(mutate: (current: IndexFile) => void): Promise<void> {
    writeChain = writeChain.then(async () => {
      mutate(index);
      await writeIndex();
    }).catch((error: unknown) => {
      void logger.warn('thumbnail-cache', 'index write failed; in-memory state still works', {
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    return writeChain;
  }

  /** Disk is the truth for size; the index is the truth for references. */
  async function scanDisk(): Promise<Map<string, { bytes: number; mtimeMs: number }>> {
    const found = new Map<string, { bytes: number; mtimeMs: number }>();
    let names: readonly string[] = [];
    try { names = await readdir(dir); } catch { return found; }
    for (const name of names) {
      if (!isSafeCacheName(name)) continue;
      try {
        const info = await stat(join(dir, name));
        if (info.isFile()) found.set(name, { bytes: info.size, mtimeMs: info.mtimeMs });
      } catch { /* a file vanished between readdir and stat */ }
    }
    return found;
  }

  async function reconcile(): Promise<void> {
    const disk = await scanDisk();
    for (const name of Object.keys(index.entries)) {
      if (!disk.has(name)) delete index.entries[name];
    }
    for (const [name, info] of disk) {
      const existing = index.entries[name];
      if (existing === undefined) {
        // A pre-D-103 cache has no owner record. It is NOT deleted by a plain
        // orphan sweep; age/budget rules decide, after the boot restore has had
        // a chance to attach a live task to it.
        index.entries[name] = {
          bytes: info.bytes, lastUsedAt: info.mtimeMs, taskIds: [], untracked: true,
        };
      } else {
        // `lastUsedAt` is the INDEX's truth. File mtime only reflects when the
        // bytes were written (a restart must not make an old cover look fresh).
        existing.bytes = info.bytes;
      }
    }
    // A live in-memory mapping always outranks a stale index record.
    for (const [taskId, path] of byTask) {
      const name = path.slice(path.lastIndexOf(sep) + 1);
      const entry = index.entries[name];
      if (entry === undefined) continue;
      if (!entry.taskIds.includes(taskId)) entry.taskIds.push(taskId);
      delete entry.untracked;
      // A live mapping also outranks a privacy-purge marker (D-252): the task
      // re-ensured the cover after the close marked it, so it is referenced
      // again and the regular retention rules own it from here on.
      delete entry.purgePending;
    }
  }

  /** Load once at construction; every async method awaits this. */
  const indexReady = readIndex().then(async (loaded) => {
    index = loaded;
    await reconcile();
  }).catch(() => { index = emptyIndex(); });

  function attach(name: string, taskId: string, bytes: number): Promise<void> {
    byTask.set(taskId, join(dir, name));
    return commit((current) => {
      const entry = current.entries[name] ?? { bytes, lastUsedAt: now(), taskIds: [] };
      entry.bytes = bytes;
      entry.lastUsedAt = now();
      if (!entry.taskIds.includes(taskId)) entry.taskIds.push(taskId);
      delete entry.untracked;
      // Same as reconcile(): a fresh reference clears the D-252 marker — the
      // policy's live-task guard would protect the file anyway, and clearing
      // here keeps the index free of stale "pending privacy purge" flags.
      delete entry.purgePending;
      current.entries[name] = entry;
    });
  }

  /** Local hit first: no HTTP request, no duplicate download after a restart. */
  async function findLocal(hash: string): Promise<{ name: string; bytes: number } | null> {
    for (const ext of CANDIDATE_EXTENSIONS) {
      const name = `${hash}.${ext}`;
      try {
        const info = await stat(join(dir, name));
        if (info.isFile() && info.size > 0) return { name, bytes: info.size };
      } catch { /* try the next extension */ }
    }
    return null;
  }

  function maybeAutoPrune(): void {
    ensureCount += 1;
    const config = policy();
    if (!config.enabled) return;
    const dueByTime = now() - lastAutoPruneAt >= AUTO_PRUNE_INTERVAL_MS;
    if (ensureCount < autoPruneEvery && !dueByTime) return;
    lastAutoPruneAt = now();
    ensureCount = 0;
    void prune().catch(() => undefined);
  }

  /** `fetchUrl` 已经 `upgradeThumbnailUrl()` 归一（D-250），恒为 https 形式。 */
  async function fetchAndStore(taskId: string, fetchUrl: string): Promise<string | null> {
    if (http === undefined) return null;
    // D-137: the same predicate is handed to the HTTP adapter as a PER-HOP
    // policy, so a 302 to loopback/private or an http downgrade cannot slip past
    // this initial check. The adapter also enforces `maxBytes` while streaming,
    // instead of buffering the whole body and checking its length afterwards.
    if (!isPublicHttpsUrl(fetchUrl)) return null;
    try {
      const bytes = await http.getBytes(fetchUrl, {
        timeoutMs,
        maxBytes: maxBytesPerFile,
        urlPolicy: isPublicHttpsUrl,
      });
      // Still checked here: an injected HttpPort (tests, future adapters) is not
      // required to honour the ceiling itself.
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytesPerFile) return null;
      const ext = signatureOf(bytes);
      if (ext === null) return null;

      const name = `${createHash('sha1').update(fetchUrl).digest('hex')}.${ext}`;
      const target = join(dir, name);
      const existing = await stat(target).catch(() => null);
      if (existing === null || !existing.isFile() || existing.size !== bytes.byteLength) {
        await mkdir(dir, { recursive: true });
        const temp = `${target}.part`;
        await writeFile(temp, bytes);
        await rename(temp, target);
      }
      // Confirm the bytes really are on disk before advertising the path.
      const stored = await readFile(target).catch(() => null);
      if (stored === null) return null;
      await attach(name, taskId, bytes.byteLength);
      maybeAutoPrune();
      return target;
    } catch (error) {
      await logger.warn('thumbnail', 'cover fetch failed; card keeps its letter badge', {
        taskId,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function status(): Promise<ThumbnailCacheStatus> {
    return indexReady.then(async () => {
      await writeChain;
      await reconcile();
      const config = policy();
      const live = options.liveTaskIds === undefined ? [] : options.liveTaskIds();
      const disk = await scanDisk();
      let bytes = 0;
      let orphanFiles = 0;
      let expiredFiles = 0;
      const policyEntries: ThumbnailCacheEntry[] = [];
      const liveSet = new Set(live);
      for (const [name, item] of Object.entries(index.entries)) {
        const size = disk.get(name)?.bytes ?? item.bytes;
        bytes += size;
        const referenced = item.taskIds.some((id) => liveSet.has(id));
        if (!referenced) {
          if (!item.untracked && item.taskIds.length > 0) orphanFiles += 1;
          if (now() - item.lastUsedAt >= config.maxAgeDays * 24 * 60 * 60 * 1000) expiredFiles += 1;
        }
        policyEntries.push({
          name,
          bytes: size,
          lastUsedAt: item.lastUsedAt,
          taskIds: [...item.taskIds],
          ...(item.untracked === true ? { untracked: true } : {}),
          ...(item.purgePending === true ? { purgePending: true } : {}),
        });
      }
      const plan = planThumbnailPrune(policyEntries, live, config);
      return {
        files: disk.size,
        bytes,
        orphanFiles,
        expiredFiles,
        reclaimableBytes: plan.remove.reduce((sum, item) => sum + item.bytes, 0),
        enabled: config.enabled,
        maxBytes: config.maxBytes,
        maxFiles: config.maxFiles,
        maxAgeDays: config.maxAgeDays,
        lastPrunedAt: index.lastPrunedAt,
        recycleBinAvailable: options.trash !== undefined,
      };
    }).catch((error: unknown) => {
      void logger.warn('thumbnail-cache', 'status failed; reporting an empty cache', {
        detail: error instanceof Error ? error.message : String(error),
      });
      const config = policy();
      return {
        files: 0, bytes: 0, orphanFiles: 0, expiredFiles: 0, reclaimableBytes: 0,
        enabled: config.enabled, maxBytes: config.maxBytes, maxFiles: config.maxFiles,
        maxAgeDays: config.maxAgeDays, lastPrunedAt: null,
        recycleBinAvailable: options.trash !== undefined,
      };
    });
  }

  async function prune(request: { force?: boolean } = {}): Promise<ThumbnailPruneReport> {
    try {
      await indexReady;
      await writeChain;
      await reconcile();
      const config = policy();
      const effective: ThumbnailCachePolicy = request.force === true
        ? { ...config, enabled: true } : config;
      const live = options.liveTaskIds === undefined ? [] : options.liveTaskIds();
      const disk = await scanDisk();
      const policyEntries: ThumbnailCacheEntry[] = Object.entries(index.entries).map(([name, item]) => ({
        name,
        bytes: disk.get(name)?.bytes ?? item.bytes,
        lastUsedAt: item.lastUsedAt,
        taskIds: [...item.taskIds],
        ...(item.untracked === true ? { untracked: true } : {}),
        ...(item.purgePending === true ? { purgePending: true } : {}),
      }));
      const plan = planThumbnailPrune(policyEntries, live, effective);
      const beforeBytes = policyEntries.reduce((sum, item) => sum + item.bytes, 0);

      const untouched = (ok: boolean, reason: string): ThumbnailPruneReport => ({
        ok, reason,
        filesBefore: policyEntries.length, bytesBefore: beforeBytes,
        filesAfter: policyEntries.length, bytesAfter: beforeBytes,
        freedBytes: 0, removed: 0, failed: 0,
        removedByReason: plan.removedByReason,
        truncated: plan.truncated,
        lastPrunedAt: index.lastPrunedAt,
      });

      // D-252: with the switch off the policy schedules ONLY purge-pending
      // entries (privacy correctness, switch-independent). An empty plan means
      // there is genuinely nothing privacy-owed — keep the historical reason.
      if (config.enabled !== true && request.force !== true && plan.remove.length === 0) {
        return untouched(true, 'auto-clean-disabled');
      }
      if (options.trash === undefined) return untouched(false, 'recycle-bin-unavailable');

      let removed = 0;
      let failed = 0;
      let freedBytes = 0;
      const removedNames: string[] = [];
      for (const candidate of plan.remove) {
        // Defence in depth: NEVER hand a path outside the cache directory to
        // the deletion primitive, and only ever a cache image name.
        if (!isSafeCacheName(candidate.name)) { failed += 1; continue; }
        const absolute = resolve(dir, candidate.name);
        if (!absolute.startsWith(resolve(dir) + sep)) { failed += 1; continue; }
        try {
          const trashed = await options.trash(absolute);
          if (trashed !== true) { failed += 1; continue; }
          removed += 1;
          freedBytes += Math.max(0, disk.get(candidate.name)?.bytes ?? candidate.bytes);
          removedNames.push(candidate.name);
        } catch { failed += 1; /* one bad file must not abort the pass */ }
      }

      for (const name of removedNames) delete index.entries[name];
      for (const [taskId, path] of [...byTask]) {
        const name = path.slice(path.lastIndexOf(sep) + 1);
        if (removedNames.includes(name)) byTask.delete(taskId);
      }
      index.lastPrunedAt = new Date(now()).toISOString();
      await commit(() => undefined); // persist the pruned index + timestamp
      if (failed > 0) {
        void logger.warn('thumbnail-cache', 'some covers could not be recycled; kept in the index', {
          failed, removed,
        });
      }
      return {
        ok: true, reason: removed === 0 ? 'nothing-to-clean' : 'cleaned',
        filesBefore: policyEntries.length, bytesBefore: beforeBytes,
        filesAfter: Math.max(0, policyEntries.length - removed),
        bytesAfter: Math.max(0, beforeBytes - freedBytes),
        freedBytes, removed, failed,
        removedByReason: plan.removedByReason,
        truncated: plan.truncated,
        lastPrunedAt: index.lastPrunedAt,
      };
    } catch (error) {
      // Housekeeping must never bubble into the queue / task lifecycle.
      void logger.warn('thumbnail-cache', 'prune failed; download queue untouched', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return emptyReport('prune-failed', index.lastPrunedAt);
    }
  }

  async function persistPolicy(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (options.setPolicy !== undefined) await options.setPolicy(patch);
    const next = policy();
    return {
      enabled: next.enabled, maxBytes: next.maxBytes, maxFiles: next.maxFiles,
      maxAgeDays: next.maxAgeDays, pruneBatch: next.pruneBatch,
    };
  }

  /**
   * D-252: close-time counterpart of `prune()`, driven by the private-mode
   * purge. The caller passes the task ids that were JUST removed from the
   * queue; the pure Core rule (`coverNamesOwnedOnlyBy`) narrows them to the
   * covers those ids own EXCLUSIVELY — anything shared with a task outside the
   * purge, and any untracked file, stays with the regular retention rules.
   *
   * Order matters: entries are marked `purgePending` in `index.json` BEFORE
   * any byte is touched, so a failed or interrupted recycle below is picked up
   * by the next prune pass (boot included) with the auto-clean switch OFF.
   * Deletion reuses the exact prune guards (`isSafeCacheName` + directory
   * prefix + injected recycle-bin port) — no new primitive, and a failure is
   * logged and swallowed: closing the window must never block or throw.
   */
  async function purgeCovers(taskIds: readonly string[]): Promise<ThumbnailCoverPurgeReport> {
    try {
      await indexReady;
      await writeChain;
      await reconcile();
      const names = coverNamesOwnedOnlyBy(index.entries, new Set(taskIds));
      if (names.length === 0) return { marked: 0, removed: 0, failed: 0 };
      await commit((current) => {
        for (const name of names) {
          const entry = current.entries[name];
          if (entry !== undefined) current.entries[name] = { ...entry, purgePending: true };
        }
      });
      if (options.trash === undefined) {
        // Nothing can be recycled safely; the marker keeps the debt visible
        // and recoverable. No fallback deletion primitive exists by design.
        void logger.warn('thumbnail-cache', 'private cover purge deferred; recycle bin unavailable', {
          count: names.length,
        });
        return { marked: names.length, removed: 0, failed: 0 };
      }
      let removed = 0;
      let failed = 0;
      const removedNames: string[] = [];
      for (const name of names) {
        // Defence in depth: NEVER hand a path outside the cache directory to
        // the deletion primitive, and only ever a cache image name.
        if (!isSafeCacheName(name)) { failed += 1; continue; }
        const absolute = resolve(dir, name);
        if (!absolute.startsWith(resolve(dir) + sep)) { failed += 1; continue; }
        try {
          if (await options.trash(absolute) !== true) { failed += 1; continue; }
          removed += 1;
          removedNames.push(name);
        } catch { failed += 1; /* one bad file must not abort the purge */ }
      }
      if (removedNames.length > 0) {
        await commit((current) => {
          for (const name of removedNames) delete current.entries[name];
        });
        for (const [taskId, path] of [...byTask]) {
          const name = path.slice(path.lastIndexOf(sep) + 1);
          if (removedNames.includes(name)) byTask.delete(taskId);
        }
      }
      if (failed > 0) {
        void logger.warn('thumbnail-cache', 'some private covers could not be recycled; marked for the next prune pass', {
          failed, removed,
        });
      }
      return { marked: names.length, removed, failed };
    } catch (error) {
      // A privacy tidy-up must never bubble into the close / quit path (same
      // isolation as prune()); marked entries stay recoverable on the next pass.
      void logger.warn('thumbnail-cache', 'private cover purge failed; download queue untouched', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return { marked: 0, removed: 0, failed: 0 };
    }
  }

  return {
    pathOf(taskId: string): string | null {
      const path = byTask.get(taskId) ?? null;
      if (path === null) return null;
      // Best-effort "last used" refresh; a throttled disk write is enough.
      const name = path.slice(path.lastIndexOf(sep) + 1);
      const item = index.entries[name];
      if (item !== undefined && now() - item.lastUsedAt > TOUCH_INTERVAL_MS) {
        void commit((current) => {
          const currentEntry = current.entries[name];
          if (currentEntry !== undefined) currentEntry.lastUsedAt = now();
        });
      }
      return path;
    },

    ensure(taskId: string, url: string | null | undefined): Promise<string | null> {
      const cached = byTask.get(taskId);
      if (cached !== undefined) return Promise.resolve(cached);
      if (typeof url !== 'string' || url.trim() === '') return Promise.resolve(null);
      // D-250: scheme normalisation happens BEFORE any keying. 国内站点（B 站
      // hdslb.com 等）probe 给的封面是纯 `http://`，而抓取面 https-only（D-137）。
      // 若先按原样取哈希、等到 fetchAndStore 里才升级，跨重启的本地复用会永远
      // miss（两次哈希键不一致）。这里统一升级成 https 后再入缓存键；非 http(s)
      // 一律 null（无封面占位），升级失败的站点自然回落原行为。
      const fetchUrl = upgradeThumbnailUrl(url);
      if (fetchUrl === null) return Promise.resolve(null);
      const pending = inFlight.get(taskId);
      if (pending !== undefined) return pending;
      const attempt = (async () => {
        await indexReady;
        const hash = createHash('sha1').update(fetchUrl).digest('hex');
        const local = await findLocal(hash);
        if (local !== null) return attach(local.name, taskId, local.bytes).then(() => join(dir, local.name));
        return fetchAndStore(taskId, fetchUrl);
      })().finally(() => { inFlight.delete(taskId); });
      inFlight.set(taskId, attempt);
      return attempt;
    },

    forget(taskId: string): void {
      byTask.delete(taskId);
      inFlight.delete(taskId);
      // The index KEEPS the historical owner id: `planThumbnailPrune()` compares
      // it with the live task list, which is exactly what turns a removed task's
      // cover into a `lost-reference` candidate. Erasing the id here would make
      // the file look "never attributed" and postpone its cleanup by 30 days.
      // The file itself is never deleted HERE — the private-mode close decides
      // via `purgeCovers()` (D-252, exclusivity-proven ids only) and every other
      // removal waits for a prune pass, which still checks that no OTHER live
      // task shares the same cover.
    },

    status,
    purgeCovers,
    prune,
    setAutoClean: (enabled: boolean) => persistPolicy({ enabled }),
    setMaxBytes: (bytes: number) => persistPolicy({ maxBytes: bytes }),
  };
}
