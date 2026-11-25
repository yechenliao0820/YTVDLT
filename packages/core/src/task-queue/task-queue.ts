/**
 * TaskQueue — concurrent execution with a bounded number of slots.
 *
 * M2 shipped a strictly serial queue; M4-2 (A-4.4-09 / 原始验收 ①) generalises
 * it: `concurrency` slots (default 3, clamped 1..8), FIFO auto-fill, and
 * `concurrency: 1` reproduces the M2 serial behaviour exactly.
 *
 * CD-12 ordering iron rule is unchanged: `history.add()` and `Completed` happen
 * ONLY after `verify().ok === true`. Cancel/failure/failed-verification never
 * write history.
 */
import type {
  DownloadEngine, EngineEvent, EngineStage, TaskRecord, TaskEvent, TaskState, AppError,
  CorePorts, ExpectedArtifactManifest, TaskSnapshot,
  SubtitleFileLink, DownloadRequest,
} from '@ytvdlt/shared';
import { isForwardStage } from '@ytvdlt/shared';
import type { ICancelHandle, IArtifactVerifier, IHistoryStore, ITaskQueue, ITaskStore } from '../ports.js';
import { detectPostprocessed } from '../download-flags.js';
import { resolveDownloadPlan } from '../decision/download-plan.js';
import { applyCopySuffix, nextCopySuffix } from '../path-resolver/copy-suffix.js';
import { splitArtifactsByRoots, trustedArtifactRoots } from '../path-resolver/containment.js';
import {
  buildSubtitleLinks, evaluateSubtitleOutcome, mediaArtifactsOf,
} from '../artifact-classify/index.js';
import { assertTransition } from './state-machine.js';
import { createProbeAbort } from './probe-abort.js';
import { normalizeConcurrency, DEFAULT_CONCURRENCY } from './concurrency.js';
import {
  snapshotFingerprint, buildPersistProjection, persistableRecords,
} from './snapshot-projection.js';
import { buildHistoryEntry } from './history-entry.js';
import { toAppError } from './app-error.js';

// Task-6 split compat: the concurrency rule moved verbatim to
// `./concurrency.js` — these re-exports keep every old import path working
// (deep `task-queue.js` importers and the `@ytvdlt/core` barrel alike).
export { MAX_CONCURRENCY, DEFAULT_CONCURRENCY, normalizeConcurrency } from './concurrency.js';

export interface TaskQueueDeps {
  ports: CorePorts;
  engine: DownloadEngine;
  verifier: IArtifactVerifier;
  history: IHistoryStore;
  taskStore?: ITaskStore;
  /** Absolute path of the bundled node.exe. */
  jsRuntimePath: string;
  /** Optional per-task expectation manifest (L2 fixture). */
  expectedManifestFor?: (record: TaskRecord) => ExpectedArtifactManifest | null;
  /**
   * Max simultaneous tasks (probe + download). Defaults to 3 (config
   * `general.concurrency`). Clamped to 1..MAX_CONCURRENCY.
   */
  concurrency?: number;
  /**
   * Throttle for mid-download snapshot persist ATTEMPTS (M4-3). Defaults to
   * 500 ms; a value <= 0 attempts on every progress event (L0 tests use 0).
   * D-163: an attempt only becomes a full-file rewrite when something
   * structural changed since the last write.
   */
  persistIntervalMs?: number;
  /**
   * D-131 (append-only): move the standalone subtitle files that were created
   * ONLY to feed `--embed-subs` into the OS recycle bin when the user chose
   * `keepSubtitleFile=false`. Receives the exact paths this task's own yt-dlp
   * process reported and MUST return the paths it actually removed; anything
   * it could not remove stays in the task's artifact list. Absent = the
   * pre-D-131 behaviour (no cleanup), which keeps core/L0 tests side-effect
   * free and lets a build without a recycle-bin adapter degrade safely.
   *
   * Never a permanent unlink: projects' §0 rule sends every deletion through
   * the recycle bin so a file that turns out to be pre-existing is recoverable.
   *
   * D-209 (append-only): `roots` are the task's own trusted output roots
   * (`trustedArtifactRoots()` of the request that drove THIS run). The
   * adapter needs them to run the SAME D-207 realpath pre-flight the
   * `withFiles` deletion branch runs — the intake gate is a STRING gate, and
   * on Windows a junction in a middle path component lets
   * `<videoDir>/link/clip.en.srt` resolve outside the output directory while
   * every name-level check passes. A recycler that ignores the argument keeps
   * the pre-D-209 behaviour (end-component lstat guard only).
   */
  recycleSubtitleFiles?: (
    paths: readonly string[],
    roots: readonly string[],
  ) => Promise<readonly string[]>;
  /**
   * D-236 (append-only): re-inject the CURRENT config network settings into a
   * request that just came back from `tasks.json`. The persisted projection
   * blanks `network.proxy` (a proxy value can carry `http://user:pass@host`,
   * and the snapshot is the file users attach to bug reports — the same
   * "never touch disk" principle as D-163's signed CDN links), so a restored
   * task would otherwise restart WITHOUT its proxy. The host supplies a hook
   * that re-reads the live config; current config wins, which also means a
   * proxy the user has since removed is not revived from the old snapshot.
   * Absent = restored requests are used verbatim (pre-D-236 behaviour, which
   * keeps core tests side-effect free and a build without config access safe).
   */
  repairRestoredRequest?: (request: DownloadRequest) => DownloadRequest;
}

const nowIso = (ports: CorePorts): string => ports.clock.nowIso();

/** Windows path equality: case-insensitive, slash-insensitive. */
function pathKeyOf(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase();
}

/**
 * external online audit P3 · bounds for the copy-suffix scan when the output
 * template carries a path separator (`%(extractor)s/%(title)s [%(id)s].%(ext)s`
 * writes into `<videoDir>/<subdir>/`, which the flat readdir never saw — so
 * `nextCopySuffix` returned `''`, yt-dlp printed "has already been downloaded"
 * and exited 0 reusing the OLD file (坑 11 / D-101), and the user got a
 * Completed card without a new file).
 *
 * The scan descends at most `COPY_SUFFIX_SCAN_MAX_DEPTH` directory levels
 * below the output root and reads at most `COPY_SUFFIX_SCAN_MAX_DIRS`
 * directories. external online audit follow-up (D-273 leftover): only a
 * target that actually READS as a directory consumes the budget — a file
 * (readdir throws ENOTDIR) or an unreadable entry costs nothing. Counting
 * every attempt starved real subdirectories: 200+ files whose names sort
 * before the target subdirectory (the NTFS alphabetical norm) used up the
 * whole bound before the subdirectory was ever dequeued, its old copy was
 * never seen and yt-dlp silently reused the file. Past the bound the scan
 * stops HONESTLY: names already collected stay candidates, the walk just
 * ends, and one WARNING line goes to the log sink so the truncation is
 * visible instead of silent — the warning now truthfully means "read 200
 * real directories". The bound exists so a pathological tree can never turn
 * a name lookup into a whole-library walk; a flat template (no path
 * separator) never enters this path and keeps the exact pre-existing flat
 * readdir.
 */
const COPY_SUFFIX_SCAN_MAX_DEPTH = 3;
const COPY_SUFFIX_SCAN_MAX_DIRS = 200;
/**
 * D-278 (external audit P3, 2026-11-22 round): the walk ALSO stops after this
 * many file-system ENTRIES (names collected from successful readdirs). The
 * per-directory budget above bounds how many DIRECTORIES are read, but a
 * single directory whose readdir returns hundreds of thousands of names would
 * still push every one of them into the candidate list and the pending queue —
 * hundreds of thousands of guaranteed-ENOTDIR readdir attempts on the files
 * among them. One bounded number for total entries closes that: past the
 * bound the walk stops, the truncation WARNING reports both counters, and the
 * unseen remainder falls back to the documented D-101 behaviour (an unseen old
 * copy means yt-dlp may reuse it — never data corruption).
 */
const COPY_SUFFIX_SCAN_MAX_ENTRIES = 10_000;

/**
 * external online audit P2 · malformed request must not break restore/persist
 * (D-268): is a restored `request` structurally usable?
 *
 * `request === null` is the long-standing shape (a legacy request-less
 * record); what this guard adds is the DAMAGED shape — a non-null `request`
 * that is not a plain object, or whose consumed domains are missing / not
 * objects. Such a value can never drive a run (`run()` and every downstream
 * reader consume the `paths` / `format` / `subtitle` / `advanced` domains
 * directly) and used to poison `buildPersistProjection()` into throwing on
 * every snapshot write. Restore normalizes it to `null` — the D-203
 * semantics for a request-less record: the row is kept, every run / action on
 * it is refused, nothing is silently dropped. A request whose `network`
 * domain is missing stays usable ON PURPOSE: the host's
 * `repairRestoredRequest` hook rebuilds `network` from live config (spreading
 * `undefined` is safe), so both the projection's proxy strip and the run
 * itself still get a real domain to work with.
 *
 * external online audit follow-up (D-268 leftover): the guard checks ALL FOUR
 * consumed domains (`paths` + `format` + `subtitle` + `advanced`), aligned
 * with TaskStore's D-161 domain-level sanitize but WITHOUT clearing
 * `artifacts` and without touching the D-203 semantics. The original
 * paths-only check let a `{paths:{…}}` snapshot through restore and into
 * `run()`, where `detectPostprocessed()` reads the `format` / `advanced` /
 * `subtitle` domains and threw a TypeError — which landed in the same
 * stuck-card shape the `restart()` door-refusal now closes. A domain missing
 * here is normalized to `null` at the restore layer, before any reader.
 */
function restoredRequestIsUsable(
  value: DownloadRequest | null | undefined,
): value is DownloadRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const domains = value as unknown as Record<string, unknown>;
  for (const key of ['paths', 'format', 'subtitle', 'advanced'] as const) {
    const domain: unknown = domains[key];
    if (typeof domain !== 'object' || domain === null || Array.isArray(domain)) return false;
  }
  return true;
}

export class TaskQueue implements ITaskQueue {
  private readonly deps: TaskQueueDeps;
  private readonly records = new Map<string, TaskRecord>();
  private readonly handles = new Map<string, ICancelHandle>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  /** FIFO of record ids waiting for a free slot. Never contains duplicates. */
  private readonly pending: string[] = [];
  /** Ids currently occupying a slot (probe or transfer in flight). */
  private readonly running = new Set<string>();
  /**
   * D-200: ids whose cancel arrived while NO handle existed — the window
   * between the probe's `finally` (probe handle removed) and `executeDownload`'s
   * engine handle registration. `cancel()` records the request here and
   * transitions the record to `Canceled` itself; the run consumes the id right
   * before it would start the transfer, so a download the user killed is never
   * spawned. `restart()` / `remove()` / `enqueue()` clear stale entries so a
   * recorded request can never kill a later run of the same id.
   */
  private readonly cancelRequested = new Set<string>();
  private limit: number;
  /** M5: intake switch; only `pump()` reads it. */
  private intakePausedFlag = false;
  private readonly persistIntervalMs: number;
  private lastPersistAt = 0;
  /**
   * D-163: fingerprint of the last snapshot that actually reached disk.
   * `null` (not `''`) is the initial value on purpose: an empty queue's
   * fingerprint IS `''`, and starting from `''` made the very first
   * `restoreTasks()` write a no-op — which broke the D-159 guarantee that a
   * damaged `tasks.json` is only replaced AFTER the backup is verified.
   * Reserved BEFORE the awaited save (so identical progress bursts cannot
   * queue identical rewrites) and rolled back to `null` on failure (so the
   * next attempt retries instead of skipping a lost write).
   */
  private lastPersistedFingerprint: string | null = null;
  /**
   * T2: true while the latest persist attempt failed. Snapshot persistence
   * failures used to be swallowed silently; they are now logged — but only
   * ONCE per failure episode (reset by the next successful save), because a
   * persistently broken disk would otherwise emit one warning per progress
   * tick (persistIntervalMs can be 0).
   */
  private snapshotPersistFailed = false;
  /**
   * D-242: the reason behind the most recent failed write, cleared by the next
   * successful one. `persistSnapshot()` reports only a boolean; the mutations
   * that must surface a failure (`persistOrThrow`, `remove`) read the detail
   * from here so the message the user sees is the real error (EACCES, ENOSPC,
   * EBUSY…) instead of a generic sentence.
   */
  private lastPersistError: string | null = null;
  /**
   * Task-2 audit follow-up (checklist §14「同一序列化边界」): the snapshot
   * write itself. Every `persistSnapshot()` call snapshots the records and
   * computes its fingerprint SYNCHRONOUSLY, so each snapshot is a consistent
   * view — but two overlapping calls (a throttled `void` progress persist
   * racing another task's awaited `finally` persist) could previously complete
   * OUT OF ORDER, leaving the OLDER full snapshot as the last bytes on disk
   * until the next structural change. Writes are now chained through this
   * queue, so the NEWEST snapshot is always the last one written. The
   * fingerprint gate above is unchanged (identical content still never queues
   * a rewrite), a failed write still un-reserves the fingerprint, and a
   * rejected save must not poison later writes — the same chain shape as the
   * HistoryStore write queue (D-222).
   */
  private snapshotWriteQueue: Promise<void> = Promise.resolve();
  /**
   * D-231 (audit P2): nesting counter for `enqueueBatch()`. A batch member that
   * parks in the FIFO would otherwise trigger one full rewrite each (a 200-line
   * TXT import = 200 serialised snapshots); inside a batch the write is deferred
   * and issued ONCE at the end, while a standalone `enqueue()` still writes
   * before it returns.
   */
  private batchDepth = 0;
  /**
   * D-237 (audit P2): copy-suffix reservations for RUNNING tasks, keyed by
   * task id. `withCopySuffix` detects duplicates by scanning the OUTPUT
   * directory, but a concurrent twin's partials live in its own `tempDir`
   * (D-118) — invisible to that scan until the final move. With default
   * concurrency 3, queuing the same video twice sent two processes at the
   * SAME final file name (one file under two `Completed` cards, or a bogus
   * verification failure). A claim is registered the moment a suffix is
   * computed and released in `run()`'s `finally` — by then the artifact
   * either sits in the output directory (readdir takes over) or the attempt
   * produced nothing for a name to collide with. In-memory only: single-
   * instance (D-60) rules out cross-process twins, and a restored record
   * re-claims when the user restarts it.
   */
  private readonly copySuffixClaims = new Map<
    string, { dir: string; mediaId: string; suffix: string }
  >();

  constructor(deps: TaskQueueDeps) {
    this.deps = deps;
    this.limit = normalizeConcurrency(deps.concurrency ?? DEFAULT_CONCURRENCY);
    this.persistIntervalMs = deps.persistIntervalMs ?? 500;
  }

  /** Current slot limit (1..8). */
  get concurrency(): number {
    return this.limit;
  }

  /** Ids occupying a slot right now. */
  get activeTaskIds(): readonly string[] {
    return [...this.running];
  }

  /** How many tasks are waiting for a slot. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * D-164: true while the record is parked in the FIFO and has not started.
   *
   * The UI needs this to know that the card can be cancelled *before* a slot
   * frees up. It cannot be derived from `state`: a parked record is `Idle`,
   * which is also what a restored-but-never-run task looks like.
   */
  isPending(taskId: string): boolean {
    return this.pending.includes(taskId);
  }

  /**
   * Change the slot limit at runtime. Raising it starts parked tasks
   * immediately; lowering it never kills a running task — it just stops
   * starting new ones until the active count drops below the new limit.
   */
  setConcurrency(value: number): number {
    this.limit = normalizeConcurrency(value);
    this.pump();
    return this.limit;
  }

  /**
   * M5 append-only (D-62): intake switch for the engine self-updater.
   *
   * Pausing only stops `pump()` from pulling NEW work out of the FIFO. Running
   * tasks keep their slots and finish normally; nothing is canceled, no record
   * is removed, no state is written. That is the whole point — an update must
   * never look like a user-initiated cancellation.
   */
  get intakePaused(): boolean {
    return this.intakePausedFlag;
  }

  pauseIntake(): void {
    this.intakePausedFlag = true;
  }

  resumeIntake(): void {
    if (!this.intakePausedFlag) return;
    this.intakePausedFlag = false;
    this.pump();
  }

  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: TaskEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* a bad listener must not break the queue */ }
    }
  }

  /** Apply a validated transition and emit `state-changed`. */
  private transition(record: TaskRecord, to: TaskState): void {
    const from = record.state;
    assertTransition(from, to);
    record.state = to;
    record.updatedAt = nowIso(this.deps.ports);
    this.emit({ type: 'state-changed', taskId: record.id, from, to });
  }

  get(taskId: string): TaskRecord | undefined {
    const record = this.records.get(taskId);
    return record === undefined ? undefined : { ...record };
  }

  list(): readonly TaskRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async enqueue(record: TaskRecord): Promise<void> {
    const stored: TaskRecord = {
      ...record,
      state: 'Idle',
      createdAt: record.createdAt || nowIso(this.deps.ports),
      updatedAt: nowIso(this.deps.ports),
      artifacts: [...record.artifacts],
      lastPercent: record.lastPercent ?? null,
      error: null,
    };
    // Re-enqueueing an id must not leave a stale FIFO entry behind — nor a
    // stale cancel request that would abort the fresh run (D-200). Both old
    // values are captured first so a failed write below can restore the EXACT
    // pre-enqueue state (D-259).
    const pendingIndex = this.pending.indexOf(stored.id);
    this.dropFromPending(stored.id);
    this.cancelRequested.delete(stored.id);
    const previous = this.records.get(stored.id);
    this.records.set(stored.id, stored);
    // D-231 (audit P2) + D-242 (audit P2) + D-259 (audit P3): EVERY standalone
    // enqueue is written before it returns — and, since D-259, BEFORE the task
    // can start. The previous order (pending → pump() → persist) let a free
    // slot spawn the download first, so a failed write threw "未能加入队列"
    // about a download that was already running: the caller could trust
    // neither the error nor the queue. Now the write GATES the start — failure
    // rolls the intake back (memory matches the unchanged disk again) and the
    // error is thrown before pump(); success lets pump() fill the slots as
    // before. The D-163 write-count contract is untouched: still exactly one
    // structural write per standalone enqueue, only taken while the record is
    // `Idle` instead of just-after-pump.
    //
    // Two deliberate exemptions keep audited contracts intact:
    //   * D-231 batch members (`batchDepth > 0`): park + pump per member, ONE
    //     write at batch end whose failure is reported for members that
    //     legitimately already started. That ordering IS the audited D-231
    //     contract, not this defect.
    //   * no `taskStore` (core/L0 degradation, side-effect free): nothing to
    //     await, so the fully synchronous pump the M4-2 pins describe is kept.
    if (this.batchDepth === 0 && this.deps.taskStore !== undefined) {
      try {
        await this.persistOrThrow('任务未能加入队列：队列快照未能写入磁盘');
      } catch (error) {
        // Roll the intake back to the exact pre-enqueue state: the record the
        // disk still holds (or none), and — for a re-enqueue — the old FIFO
        // slot. The task never entered the FIFO while the write was in flight,
        // so nothing could have started it.
        if (previous === undefined) this.records.delete(stored.id);
        else this.records.set(stored.id, previous);
        if (previous !== undefined && pendingIndex !== -1) {
          this.pending.splice(pendingIndex, 0, stored.id);
        }
        this.cancelRequested.delete(stored.id);
        throw error;
      }
    }
    // Durable (or inside a D-231 batch / no store): now it may compete for a
    // slot. `pump()` stays synchronous; the bounded-starts invariant lives in
    // pump()/run() and is unchanged.
    this.pending.push(stored.id);
    this.pump();
  }

  /**
   * Enqueue N independent tasks (M4-4 batch). Each `enqueue` only parks the
   * task and lets `pump()` fill the available slots, so a 50-item batch never
   * starts 50 downloads.
   *
   * D-231: the parked members were previously invisible on disk until some
   * OTHER task emitted a progress tick — the exact window the audit hit
   * ("already enqueued, killed before the next snapshot"). One write covers
   * the whole batch; the D-163 fingerprint gate makes it a no-op when every
   * member started and already persisted itself.
   */
  async enqueueBatch(records: readonly TaskRecord[]): Promise<readonly string[]> {
    const ids: string[] = [];
    this.batchDepth += 1;
    // D-242: a failed final write must reach the caller, but it must never
    // MASK an earlier per-record failure — a `throw` inside `finally` would
    // replace the original reason. The first error wins and is re-thrown after
    // the batch write has been attempted (so the already-parked members still
    // land on disk, which is why the write lives in `finally`).
    let failure: unknown = null;
    try {
      for (const record of records) {
        await this.enqueue(record);
        ids.push(record.id);
      }
    } catch (error) {
      failure = error;
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        const persisted = await this.persistSnapshot();
        if (failure === null && !persisted) {
          failure = new Error(`批量任务已入队，但队列快照未能写入磁盘（${this.lastPersistError ?? '写入失败'}），重启后可能丢失`);
        }
      }
    }
    if (failure !== null) throw failure;
    return ids;
  }

  /**
   * Kick tasks from the FIFO into free slots. Synchronous on purpose: `run()`
   * registers the slot before its first `await`, so the loop can never start
   * more than `limit` tasks.
   */
  private pump(): void {
    if (this.intakePausedFlag) return;
    while (this.running.size < this.limit) {
      const nextId = this.pending.shift();
      if (nextId === undefined) return;
      const next = this.records.get(nextId);
      if (next === undefined) continue;
      if (next.state !== 'Idle' && next.state !== 'ReadyWithInfo') continue;
      // D-142 invariant: a task that already occupies a slot must never be
      // started a second time. A FIFO entry for a running id can only be
      // stale; drop it — the task is executing and needs no slot.
      if (this.running.has(nextId)) continue;
      void this.runSafely(next);
    }
  }

  private dropFromPending(taskId: string): void {
    const index = this.pending.indexOf(taskId);
    if (index !== -1) this.pending.splice(index, 1);
  }

  /** Start a run without letting an unexpected throw become an unhandled rejection. */
  private async runSafely(record: TaskRecord): Promise<void> {
    try {
      await this.run(record);
    } catch (error) {
      record.error = toAppError(error);
      if (record.state !== 'Error' && record.state !== 'Completed') {
        try { this.transition(record, 'Error'); } catch { /* already terminal */ }
      }
      // Audit fix ("错误设置发生在快照之后"): `run()`'s `finally` persists the
      // snapshot BEFORE the exception reaches this catch, so the persisted
      // tasks.json still showed the pre-error record (state Running, no error)
      // and the pinned error detail was lost on restart. `transition()` only
      // mutates + emits — it never persists — so re-persist here, AFTER the
      // error and terminal state are final, to get them into tasks.json. The
      // D-163 fingerprint covers `error.code` and `updatedAt`, so this second
      // attempt really writes instead of being skipped as a no-op. Best
      // effort: a failing snapshot write must not mask the original error.
      try { await this.persistSnapshot(); } catch { /* best effort */ }
    }
  }

  /** Execute one task to a terminal state. */
  private async run(record: TaskRecord): Promise<void> {
    this.running.add(record.id);
    try {
      // --- 1) probe (unless mediaInfo was already cached by restart) ---
      if (record.mediaInfo === null) {
        this.transition(record, 'FetchingInfo');
        // D-162: a probe used to be the one phase the user could not cancel —
        // `cancel()` returned `false` because no handle existed yet. Register a
        // cooperative handle BEFORE awaiting: the signal kills the child (same
        // adapter path as the 30 s timeout), and the catch below treats an
        // aborted probe as "already cancelled" instead of inventing an error.
        const probeControl = createProbeAbort();
        this.handles.set(record.id, {
          pid: null,
          cancel: async (): Promise<boolean> => {
            probeControl.abort();
            return true;
          },
        });
        try {
          record.mediaInfo = await this.deps.engine.probe(record.url, {
            jsRuntimePath: this.deps.jsRuntimePath,
          }, { signal: probeControl.signal });
        } catch (error) {
          if (probeControl.signal.aborted) return;
          record.error = toAppError(error);
          this.transition(record, 'Error');
          return;
        } finally {
          this.handles.delete(record.id);
        }
        // The kill is only observable asynchronously: a cancel that landed
        // while the last stdout chunk was in flight leaves the record in
        // `Canceled`, and `Canceled -> ReadyWithInfo` is a legal but WRONG edge
        // here (it would resurrect a cancelled task).
        if (probeControl.signal.aborted || record.state !== 'FetchingInfo') return;
        this.transition(record, 'ReadyWithInfo');
      } else if (record.state === 'Idle') {
        // Stage 3: a per-task `MediaInfo` can now arrive already probed (a spent
        // subtitle-preview ticket). `enqueue()` always stores `Idle`, and the
        // machine has no `Idle -> Running` (nor `Idle -> ReadyWithInfo`) edge, so
        // walk the two legal edges the probe path would have walked — without the
        // probe. Without this the first transition threw and the task sat in
        // `Idle` forever.
        this.transition(record, 'FetchingInfo');
        this.transition(record, 'ReadyWithInfo');
      }

      // --- 2) download ---
      const request = record.request;
      if (request === null) {
        record.error = {
          code: 'UNKNOWN', message: '任务缺少 DownloadRequest', detail: 'request is null',
          retryable: false, report: 'UNKNOWN: missing DownloadRequest',
        };
        this.transition(record, 'Error');
        return;
      }
      record.postprocessed = detectPostprocessed(request);
      // D-101: yt-dlp refuses to overwrite an existing file and exits 0, so a
      // second download of the same video used to end as ALREADY_DOWNLOADED.
      // Give this attempt its own ` (n)` name first — the user asked for another
      // copy, not for an error.
      const effectiveRequest = await this.withCopySuffix(record, request);
      // D-200: consume a cancel that landed while no handle existed (the probe
      // → engine-handle window). The record is already `Canceled`; spawning the
      // download now would run what the user killed. Do NOT re-transition to
      // `Running` and do not pin an error — the same clean-cancel contract as
      // the D-142 / D-162 windows.
      if (this.cancelRequested.delete(record.id)) return;
      this.transition(record, 'Running');
      // D-115: every run starts by moving bytes. `merging` / `postprocess` can
      // only arrive later, from a marker the engine actually printed.
      record.lastStage = 'downloading';

      const outcome = await this.executeDownload(record, effectiveRequest);
      if (outcome.kind === 'canceled') {
        // D-142: `cancel()` may already have transitioned the record while the
        // engine's close event was still pending (the kill is confirmed before
        // `executeDownload` settles). `Canceled -> Canceled` has no self-loop
        // edge, so re-transitioning here would throw and let `runSafely` pin a
        // junk UNKNOWN error on a cleanly canceled task.
        if (record.state === 'Running') this.transition(record, 'Canceled');
        return;
      }
      if (outcome.kind === 'failed') {
        record.error = outcome.error;
        this.transition(record, 'Error');
        return;
      }

      // --- 2b) D-182: containment — the manifest must not aim outside the
      // task's own output roots. Only accepted paths enter the record, so
      // every downstream consumer (subtitle links, verifier, history, D-131
      // cleanup, recycle bin, open, file status) sees the filtered list.
      const accepted = await this.acceptContainedArtifacts(record, effectiveRequest, outcome.artifacts);
      if (accepted === null) return;
      // --- 3) verify BEFORE completion (C12) ---
      record.artifacts = [...accepted];
      // Stage 4: link every subtitle file to its media and reconcile the list
      // against what the request asked for. Both are pure and evidence-based:
      // ownership comes from this run's own manifest, never from a folder scan.
      const subtitlePlan = resolveDownloadPlan(effectiveRequest);
      const subtitleRequest = {
        ...effectiveRequest.subtitle,
        enabled: subtitlePlan.writeSubs,
        embed: subtitlePlan.embedSubs,
      };
      const subtitleFiles = buildSubtitleLinks({
        artifacts: accepted,
        mediaInfo: record.mediaInfo,
        subtitle: subtitleRequest,
      });
      record.subtitleFiles = subtitleFiles;
      record.subtitleOutcome = evaluateSubtitleOutcome({
        subtitle: subtitleRequest,
        mediaInfo: record.mediaInfo,
        links: subtitleFiles,
      });
      // D-115: the engine exited 0 and every stream is on disk, but the record
      // is NOT `Completed` yet — verification still runs. Without this the card
      // sat at "100.0% · 下载中" for the whole verification, which is the exact
      // "looks stuck" complaint. The stage is set before the await so the very
      // next poll already reports it; a failed verification turns the task into
      // `Error` and the stage stops mattering.
      record.lastStage = 'verifying';
      this.emit({ type: 'stage', taskId: record.id, stage: 'verifying' });
      const report = await this.deps.verifier.verify({
        taskId: record.id,
        artifacts: accepted,
        expected: record.mediaInfo,
        postprocessed: record.postprocessed,
        expectedManifest: this.deps.expectedManifestFor?.(record) ?? null,
        // M3 C11 (D-28 / D-42): backfill the real history entry so C11 no
        // longer SKIPs in the production chain. C12 ordering is preserved:
        // history.add() still happens ONLY after verify().ok === true.
        historyEntry: buildHistoryEntry(record, accepted, outcome.sizes, this.deps.ports),
        kind: record.kind,
        // Stage 4 / D-127: advisory only — drives the embedded-subtitle probe,
        // never a verdict.
        subtitleRequest,
        // external online audit P3: the three segmentation keys all make the
        // on-disk artifacts' durations differ from the probed full video
        // (per-chapter files / cut sections), so C5 SKIPs instead of failing a
        // good download. `request` is non-null here (guarded above); the keys
        // are the frozen shared Request `advanced` domain — never rewritten by
        // withCopySuffix, so the original and effective request agree.
        segmented: request.advanced.splitChapters === true
          || (typeof request.advanced.downloadSections === 'string' && request.advanced.downloadSections.trim() !== '')
          || (typeof request.advanced.sponsorblockRemove === 'string' && request.advanced.sponsorblockRemove.trim() !== ''),
      });
      record.subtitleOutcome = evaluateSubtitleOutcome({
        subtitle: subtitleRequest,
        mediaInfo: record.mediaInfo,
        links: subtitleFiles,
        ...(report.attachments === undefined ? {} : { attachments: report.attachments }),
      });
      // D-209: a cancel that landed DURING verification WINS. The transfer is
      // over but the engine handle is still registered, so `cancel()` finds a
      // live handle, answers `true` (nothing is alive to kill) and moves the
      // record to `Canceled`. Everything below used to run anyway: history was
      // written for a canceled task, the failed-verification branch then tried
      // `Canceled -> Error` and the success branch `Canceled -> Completed` —
      // neither edge exists, so `runSafely` caught the throw and pinned a bogus
      // UNKNOWN error on a task whose cancel had succeeded ("file is on disk
      // but the card says canceled/failed"). Returning here is the same
      // "cancel is final" contract D-162 / D-200 already implement for the
      // probe and pre-spawn windows: no history row, no Completed, no error.
      if (this.canceledMeanwhile(record)) return;
      if (!report.ok) {
        record.error = {
          code: report.failureCode ?? 'ARTIFACT_INCOMPLETE',
          message: '产物校验未通过',
          detail: report.criteria.filter((c) => c.status === 'FAIL').map((c) => `${c.id}: ${c.detail}`).join('\n'),
          retryable: true,
          report: `ARTIFACT_INCOMPLETE: ${report.criteria.filter((c) => c.status === 'FAIL').map((c) => c.id).join(',')}`,
        };
        this.transition(record, 'Error');
        return;
      }

      // --- 3b) D-131: honour keepSubtitleFile=false AFTER verification -------
      // `--embed-subs` needs the standalone subtitle file while ffmpeg runs and
      // the bundled yt-dlp (2026.10.26 --help) has no "delete after embedding"
      // switch. Before D-131 the flag only decided whether to ADD `--write-subs`,
      // so the checkbox never affected the files left on disk. The attachment
      // probes above need the real bytes, hence cleanup runs only now.
      // `subtitleOutcome` is deliberately NOT recomputed: it answers "did this
      // run deliver what was requested", not "which files survive the user's
      // cleanup preference".
      const kept = await this.discardEmbeddedSubtitleArtifacts(
        record, accepted, subtitleFiles, subtitlePlan,
      );
      record.artifacts = [...kept.artifacts];
      record.subtitleFiles = kept.links;
      // D-209 (取消即终态、不写历史): a cancel that landed during the subtitle
      // cleanup await must win too. Cleanup is the last await before the
      // history write; without this guard the run went on to buildHistoryEntry
      // + history.add() and left a successful history row behind a Canceled
      // record. Same clean-cancel contract as the verification window above:
      // no history row, no Completed, no error.
      if (this.canceledMeanwhile(record)) return;

      // --- 4) history then Completed ---
      const entry = buildHistoryEntry(record, kept.artifacts, outcome.sizes, this.deps.ports);
      const addResult = await this.deps.history.add(entry, { privateMode: record.privateMode });
      // D-209: the same "cancel wins" rule for the two writes above (subtitle
      // cleanup + history). A cancel that lands while either awaits must not
      // be flushed by a terminal transition the machine does not even allow
      // (`Canceled -> Completed`), which is what produced the UNKNOWN error.
      if (this.canceledMeanwhile(record)) {
        // D-209 (取消即终态、不写历史): a cancel that landed while history.add()
        // was awaiting may already have PERSISTED the row — add() persists the
        // would-be state first and commits memory only after the write
        // succeeds, so by the time `added === true` the row is on disk AND in
        // memory. Leaving it behind turns the canceled task into a successful
        // history entry, so compensate by removing exactly this row WITHOUT
        // `deleteFile` (the media files belong to the user; a cancel never
        // deletes them). A duplicate (added === false) wrote nothing and needs
        // no compensation.
        // The removal failure is deliberately NOT swallowed: a leftover row is
        // the real state, so the error must surface via runSafely (which pins
        // the reason on the record; the state stays Canceled because the
        // machine has no Canceled -> Error edge) instead of lying by silence.
        if (addResult.added === true) {
          try {
            await this.deps.history.remove(entry.id);
          } catch (cause) {
            throw new Error(
              `D-209 cancel compensation failed: the history row of canceled task ${entry.id} is still in the history store: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              { cause },
            );
          }
        }
        return;
      }
      if (addResult.added === false && addResult.reason === 'duplicate') {
        // D-101: the artifact passed every verification criterion and exists on
        // disk — failing the task here told the user "download failed" when the
        // file was right in front of them. Completing without a new history row
        // is the honest outcome; `avoidOverwritingExisting()` prevents this path
        // in the normal case by giving the copy its own name.
        this.transition(record, 'Completed');
        return;
      }
      this.transition(record, 'Completed');
    } finally {
      this.handles.delete(record.id);
      this.running.delete(record.id);
      // D-237: the copy-suffix reservation dies with the run — by now the
      // artifact either sits in the output directory (readdir sees it) or
      // this attempt produced nothing for a name to collide with.
      this.copySuffixClaims.delete(record.id);
      await this.persistSnapshot();
      // A freed slot is immediately offered to the FIFO (auto-fill, ①).
      this.pump();
    }
  }

  /**
   * D-209 · "Did a cancel land while the awaited step was still running?"
   *
   * A method, not an inline comparison, on purpose: `TaskQueue.cancel()` can
   * mutate `record.state` at any await boundary, but TypeScript's control-flow
   * narrowing keeps treating the record as non-`Canceled` for the rest of the
   * block after the first guard — an inline second comparison is reported as
   * "no overlap" even though it is exactly what has to be checked. Keeping the
   * read inside a call also documents that the state may have moved.
   */
  private canceledMeanwhile(record: TaskRecord): boolean {
    return record.state === 'Canceled';
  }

  /**
   * D-131: remove the throw-away standalone subtitle files produced for an
   * embedded-subtitle download when the user unchecked "keep standalone files".
   *
   * Safety rules (each one exists to prevent deleting something that is not
   * ours):
   *  1. ONLY `embedSubs && !keepSubtitleFile`. An external subtitle IS the
   *     requested product of a non-embedded download and is never recycled.
   *  2. ONLY paths this task's own yt-dlp process printed (`subtitleFiles`).
   *     No directory scan, no glob, no guessed basename.
   *  3. ONLY links attached to one of THIS task's media files, AND with a
   *     proven `<media>.<lang>.<ext>` name. A stale file from an earlier run
   *     (different ` (n)` copy suffix) cannot prove ownership and is spared.
   *  4. ONLY paths not referenced by another live task record.
   *  5. The caller-side adapter moves to the OS recycle bin, never unlinks.
   *     `error` outcomes keep the file AND the record; a cleanup failure can
   *     never fail a download that already passed verification.
   *  6. D-209: the same D-207 realpath pre-flight as the `withFiles` chain.
   *     Rules 1–4 are all NAME-level (and the artifact intake gate is too), so
   *     a mid-path junction inside `videoDir` could make a subtitle path that
   *     looks contained resolve outside the output roots. The adapter gets the
   *     task's trusted roots and refuses the WHOLE batch when it cannot prove
   *     ownership; `null` roots mean "unprovable" and skip cleanup entirely
   *     (nothing is deleted, the artifact list is untouched).
   */
  private async discardEmbeddedSubtitleArtifacts(
    record: TaskRecord,
    artifacts: readonly string[],
    links: readonly SubtitleFileLink[],
    plan: ReturnType<typeof resolveDownloadPlan>,
  ): Promise<{ artifacts: readonly string[]; links: readonly SubtitleFileLink[] }> {
    const unchanged = { artifacts, links };
    const recycle = this.deps.recycleSubtitleFiles;
    if (recycle === undefined || !plan.embedSubs || plan.keepSubtitleFile) return unchanged;
    if (links.length === 0) return unchanged;
    // D-209: fail closed when the record's own roots are unprovable. The
    // recycler must be able to re-check every path against them for real.
    const roots = trustedArtifactRoots(record.request?.paths ?? {});
    if (roots === null) return unchanged;

    const ownMedia = new Set(mediaArtifactsOf(artifacts));
    const candidates = links
      .filter((link) => ownMedia.has(link.mediaPath))
      .filter((link) => link.language !== '')
      .filter((link) => !this.isArtifactSharedWithOtherTasks(link.path, record.id))
      .map((link) => link.path);
    if (candidates.length === 0) return unchanged;

    let removed: readonly string[];
    try {
      removed = await recycle(candidates, roots);
    } catch {
      // Cleanup is cosmetic; the verified media is already on disk.
      return unchanged;
    }
    const removedKeys = new Set(removed.map(pathKeyOf));
    if (removedKeys.size === 0) return unchanged;
    return {
      artifacts: artifacts.filter((path) => !removedKeys.has(pathKeyOf(path))),
      links: links.filter((link) => !removedKeys.has(pathKeyOf(link.path))),
    };
  }

  /** D-131: a second task may legitimately reference the same physical file. */
  private isArtifactSharedWithOtherTasks(path: string, ownId: string): boolean {
    const key = pathKeyOf(path);
    for (const [id, other] of this.records) {
      if (id === ownId) continue;
      if ((other.artifacts ?? []).some((candidate) => pathKeyOf(candidate) === key)) return true;
    }
    return false;
  }

  /**
   * D-101: return a request whose output template avoids an existing file.
   *
   * The default template carries `[%(id)s]`, which is what makes detection
   * possible: scan the output directory for names containing `[<id>]`, take the
   * highest ` (n)` already there, and hand yt-dlp ` (n+1)`. D-237: the scan
   * also includes RUNNING twins' claims — their partials sit in their own
   * tempDir and are invisible to readdir, which let two concurrent downloads
   * of the same video pick the same final name. external online audit P3: a
   * template containing a path separator (`/` or `\`) writes into a
   * subdirectory of the output root (`%(extractor)s/…`, a static `Sub/…`), so
   * the scan follows the tree down —
   * bounded (`COPY_SUFFIX_SCAN_*`) — instead of only looking at the root; a
   * flat template keeps the exact flat readdir it always was. Anything
   * unexpected (custom template without the id token, unreadable directory,
   * template with no `%(ext)s`) returns the request untouched — naming is then
   * left exactly as the user configured it, and the duplicate is handled by the
   * history step instead of by guessing a filename.
   */
  private async withCopySuffix(
    record: TaskRecord,
    request: NonNullable<TaskRecord['request']>,
  ): Promise<NonNullable<TaskRecord['request']>> {
    const mediaId = record.mediaInfo?.id ?? '';
    const template = request.paths.outputTemplate;
    if (mediaId === '' || typeof template !== 'string' || !template.includes('%(id)s')) {
      return request;
    }
    const dir = request.format.extractAudio ? request.paths.audioDir : request.paths.videoDir;
    if (typeof dir !== 'string' || dir.trim() === '') return request;

    // Flat templates keep the byte-identical fast path; a template carrying a
    // path separator descends into the subdirectories it will actually write
    // into. external online audit follow-up (D-273 leftover): the check is
    // separator-CLASS based (`/` OR `\`) — the request sanitizer never
    // rewrites `\`, so a hand-edited `Sub\%(title)s…` config template used to
    // take the flat readdir while its files land in `<dir>\Sub\` and the old
    // copy was never seen.
    // D-275: the categorized-directory switches ALSO descend now. Their
    // subdirectory layers ride the `-o` template PREFIX built inside the plan
    // (`categorizedTemplatePrefix`), so the REQUEST template itself can stay
    // flat — the separator test alone would take the flat readdir while the
    // real files land in `<dir>/<extractor>[/<playlist>]\` and the old copy
    // was never seen.
    const names: readonly string[] = (/[\\/]/.test(template)
      || request.paths.subdirByExtractor === true
      || request.paths.subdirByPlaylist === true)
      ? await this.scanOutputTreeForCopySuffix(dir)
      : await this.readOutputDirForCopySuffix(dir);
    // D-237: a concurrent twin is invisible to readdir (its partials live in
    // its own tempDir), so its claim joins the scan before the suffix is chosen.
    const effectiveNames = [...names, ...this.syntheticCopySuffixNames(dir, mediaId, record.id)];
    const suffix = nextCopySuffix(effectiveNames, mediaId);
    const applied = suffix === '' ? template : applyCopySuffix(template, suffix);
    // D-237: claim BEFORE spawning — the reservation must exist by the time
    // the next duplicate's withCopySuffix runs, not only once our file lands.
    // A template that cannot carry the suffix (no `%(ext)s` — applyCopySuffix
    // null) renders the BASE name, so the honest claim is `''`.
    this.copySuffixClaims.set(record.id, {
      dir, mediaId, suffix: applied === null ? '' : suffix,
    });
    if (applied === null || applied === template) return request;
    return { ...request, paths: { ...request.paths, outputTemplate: applied } };
  }

  /**
   * D-101 flat readdir, verbatim: names of the output root, `[]` when it
   * cannot be read — not created yet (first download into a new folder) means
   * nothing on disk to collide with; the in-flight twin scan still applies.
   */
  private async readOutputDirForCopySuffix(dir: string): Promise<readonly string[]> {
    try {
      return await this.deps.ports.fs.readdir(dir);
    } catch {
      return [];
    }
  }

  /**
   * external online audit P3: bounded scan of the output tree for copy-suffix
   * candidates when the template writes into subdirectories.
   *
   * Breadth-first from the output root, collecting the readdir names of every
   * directory reachable within `COPY_SUFFIX_SCAN_MAX_DEPTH` levels. Only a
   * target that actually READS as a directory counts toward
   * `COPY_SUFFIX_SCAN_MAX_DIRS`; a file (readdir throws ENOTDIR) or an
   * unreadable entry costs nothing — the catch-and-skip is the same style the
   * flat scan has always used, and a failed attempt no longer eats the budget
   * that a later target subdirectory still needs (external online audit
   * follow-up: per-attempt budgeting let 200 files sorted ahead of the target
   * subdirectory starve it past the bound). Candidates are BARE names:
   * `nextCopySuffix` matches the `[<id>]` token in the NAME, not the path, so
   * names from different levels collapse into one candidate list. Past the
   * bound the walk stops with the names already collected and logs one
   * `copySuffix.scanTruncated` WARNING through the existing logSink facility
   * (same line shape as the persist-failure and containment warnings) — the
   * truncation is reported, never silent.
   *
   * D-278 (external audit P3, second round): the walk additionally stops at
   * `COPY_SUFFIX_SCAN_MAX_ENTRIES` total entries (see the constant), and the
   * pending queue is drained with an index CURSOR instead of `shift()` — one
   * readdir of a huge directory pushes every name into the queue, and shift()
   * would make each dequeue O(n) for a quadratic total. Nothing is removed
   * from the array; the cursor simply walks it forward, so visit order is
   * byte-identical to the shift() version.
   */
  private async scanOutputTreeForCopySuffix(root: string): Promise<readonly string[]> {
    const names: string[] = [];
    const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let visited = 0;
    let encountered = 0;
    let cursor = 0;
    let truncated = false;
    while (cursor < pending.length) {
      if (visited >= COPY_SUFFIX_SCAN_MAX_DIRS || encountered >= COPY_SUFFIX_SCAN_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const next = pending[cursor];
      cursor += 1;
      let entries: readonly string[];
      try {
        entries = await this.deps.ports.fs.readdir(next.dir);
      } catch {
        // A file (ENOTDIR) or an unreadable directory: no names here and no
        // descent — the flat scan's catch style, extended to the tree walk.
        // This attempt does NOT consume the budget: only directories that
        // actually read do, so files (or unreadable entries) sorted ahead of
        // a target subdirectory can never starve it past the bound.
        continue;
      }
      visited += 1;
      const parent = `${next.dir.replace(/[\\/]+$/, '')}/`;
      for (const entry of entries) {
        if (typeof entry !== 'string' || entry === '') continue;
        // Total-entry bound (D-278): stop BEFORE the pending queue and the
        // candidate list can grow without limit on a huge directory.
        if (encountered >= COPY_SUFFIX_SCAN_MAX_ENTRIES) break;
        encountered += 1;
        names.push(entry);
        if (next.depth < COPY_SUFFIX_SCAN_MAX_DEPTH) {
          pending.push({ dir: `${parent}${entry}`, depth: next.depth + 1 });
        }
      }
    }
    if (truncated) {
      try {
        await this.deps.ports.logSink.appendJsonl(JSON.stringify({
          ts: nowIso(this.deps.ports),
          level: 'WARNING',
          scope: 'task-queue',
          event: 'copySuffix.scanTruncated',
          payload: {
            visited,
            limit: COPY_SUFFIX_SCAN_MAX_DIRS,
            depth: COPY_SUFFIX_SCAN_MAX_DEPTH,
            collected: names.length,
            encountered,
            entryLimit: COPY_SUFFIX_SCAN_MAX_ENTRIES,
          },
        }));
      } catch { /* a dead log sink must not break the run */ }
    }
    return names;
  }

  /**
   * D-237: the file names readdir alone cannot see — each RUNNING twin's
   * claimed suffix encoded as a synthetic name. `nextCopySuffix` only looks
   * for the `[<id>]` token plus an optional trailing `(n)`, so
   * `[<id>]` / `[<id>]_(1)` reproduce exactly what the real files will look
   * like without touching the disk.
   */
  private syntheticCopySuffixNames(dir: string, mediaId: string, selfId: string): string[] {
    const names: string[] = [];
    for (const [taskId, claim] of this.copySuffixClaims) {
      if (taskId === selfId || claim.dir !== dir || claim.mediaId !== mediaId) continue;
      names.push(`[${mediaId}]${claim.suffix === '' ? '' : claim.suffix}.mp4`);
    }
    return names;
  }

  /** Wrap the engine's callback API into a single awaited outcome. */
  private executeDownload(
    record: TaskRecord,
    request: NonNullable<TaskRecord['request']>,
  ): Promise<
    | {
      kind: 'completed';
      artifacts: string[];
      /** Per-artifact on-disk size the engine measured when handing over. */
      sizes: ReadonlyMap<string, number | null>;
    }
    | { kind: 'failed'; error: AppError }
    | { kind: 'canceled' }
  > {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: Parameters<typeof resolve>[0]): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const handle = this.deps.engine.download(request, (event: EngineEvent) => {
        this.emit(event);
        if (event.type === 'progress') {
          record.lastPercent = event.percent ?? record.lastPercent;
          // 0.2.1 (D-95): keep the raw transfer numbers too — the queue card
          // needs size/speed/ETA, and recomputing them from percent is guessing.
          if (event.downloadedBytes !== null && event.downloadedBytes !== undefined) {
            record.lastDownloadedBytes = event.downloadedBytes;
          }
          if (event.totalBytes !== null && event.totalBytes !== undefined) {
            record.lastTotalBytes = event.totalBytes;
          }
          if (event.speedBps !== null && event.speedBps !== undefined) {
            record.lastSpeedBps = event.speedBps;
          }
          if (event.etaSec !== null && event.etaSec !== undefined) {
            record.lastEtaSec = event.etaSec;
          }
          // M4-3: a hard kill mid-download must leave a usable snapshot, so a
          // persist is ATTEMPTED here (throttled by time, not by percentage).
          // D-163: the fingerprint decides whether bytes are actually written —
          // a structural change (state / stage / artifacts / error) lands with
          // the next tick; pure progress jitter never rewrites the file.
          const now = this.deps.ports.clock.nowEpochMs();
          if (now - this.lastPersistAt >= this.persistIntervalMs) {
            this.lastPersistAt = now;
            void this.persistSnapshot();
          }
          return;
        }
        if (event.type === 'stage') {
          // D-115: monotonic. A second stream restarting at 0% is still
          // `downloading`; a marker that arrives late must not un-set `merging`
          // (never mind `verifying`, which is set below by the queue itself).
          if (event.stage !== record.lastStage && isForwardStage(record.lastStage ?? null, event.stage)) {
            record.lastStage = event.stage as EngineStage;
          }
          return;
        }
        if (event.type === 'completed') {
          settle({
            kind: 'completed',
            artifacts: event.artifacts.map((a) => a.path),
            sizes: new Map(event.artifacts.map((a) => [a.path, a.sizeBytes])),
          });
          return;
        }
        if (event.type === 'failed') {
          settle({ kind: 'failed', error: event.error });
          return;
        }
        if (event.type === 'canceled') settle({ kind: 'canceled' });
      });
      this.handles.set(record.id, handle);
    });
  }

  /**
   * D-182: keep only artifact paths INSIDE the task's own output roots.
   *
   * The manifest is written by the engine's own `--print-to-file` call, but its
   * LINES come from remote site content (`%(filepath)` of a manipulated title /
   * extractor quirk can make yt-dlp report a path anywhere). `isAbsoluteArtifactPath()`
   * guarantees "absolute", nothing more — and `TaskRecord.artifacts` is the
   * authority every destructive consumer trusts: the D-120 recycle-bin cleanup,
   * the D-131 subtitle cleanup, open-file / open-folder and history. One bad
   * line entering the record is one bad line the recycle bin may later receive,
   * so the gate sits HERE, at intake, before anything is persisted or verified.
   *
   * Roots are `paths.videoDir` / `audioDir` / per-task `tempDir` of the request
   * that actually drove THIS run, so ` (n)` copies (D-101), same-directory
   * subtitles, extractor / playlist subdirs and the cross-volume
   * `.ytvdlt-incomplete` folder are inside by construction — a legitimate
   * artifact is never dropped.
   *
   * Rejected paths are dropped from the list and logged (never silent, never a
   * crash); the record itself stays. If NOTHING is acceptable the run is a
   * failure: the record is transitioned to `Error` with a precise reason and
   * `null` returned (the caller stops before verify / history).
   */
  private async acceptContainedArtifacts(
    record: TaskRecord,
    request: NonNullable<TaskRecord['request']>,
    artifacts: readonly string[],
  ): Promise<string[] | null> {
    // D-193: a LIVE request must yield at least one specific root. `paths: {}`
    // or a volume root means the request is malformed; accepting anything under
    // empty roots would put the whole manifest into the record (the action gate
    // afterwards derives its roots from that SAME record). Fail closed here.
    const trustedRoots = trustedArtifactRoots(request.paths);
    const { kept, rejected } = trustedRoots === null
      ? { kept: [] as string[], rejected: [...artifacts] }
      : splitArtifactsByRoots(artifacts, trustedRoots);
    if (rejected.length === 0) return kept;
    // Diagnostic parity with `manifest.droppedLines`: the WARNING carries the
    // paths themselves (capped) so logs/app-*.jsonl alone explains the loss.
    const capped = rejected.slice(0, 10);
    try {
      await this.deps.ports.logSink.appendJsonl(JSON.stringify({
        ts: nowIso(this.deps.ports),
        level: 'WARNING',
        scope: 'task-queue',
        event: 'artifact.outsideRoots',
        payload: {
          taskId: record.id,
          rejected: rejected.length,
          ...(rejected.length > capped.length ? { capped: capped.length } : {}),
          paths: capped,
        },
      }));
    } catch { /* a dead log sink must not break the run */ }
    if (kept.length === 0) {
      record.error = {
        code: 'ARTIFACT_INCOMPLETE',
        message: '产物路径超出任务输出目录，已拒绝入库',
        detail: `all ${rejected.length} manifest path(s) outside the task output roots; first: ${capped[0] ?? ''}`,
        retryable: true,
        report: `ARTIFACT_OUTSIDE_ROOTS: ${rejected.length} path(s) rejected (containment)`,
      };
      this.transition(record, 'Error');
      return null;
    }
    return kept;
  }

  async cancel(taskId: string): Promise<boolean> {
    const record = this.records.get(taskId);
    if (record === undefined) return false;
    // Queued but not started → drop it from the FIFO and from the queue. No
    // state transition is emitted: `Idle -> Canceled` is NOT one of the 13
    // legal edges (A-M2-01), so pretending otherwise would break the matrix.
    const pendingIndex = this.pending.indexOf(taskId);
    if (pendingIndex !== -1) {
      this.pending.splice(pendingIndex, 1);
      this.records.delete(taskId);
      // D-242, same rule as `remove()`: "cancelled" must not mean "gone from
      // memory, still queued on disk". A failed write puts the record back in
      // its exact FIFO position and reports the reason.
      const persisted = await this.persistSnapshot();
      if (!persisted) {
        this.records.set(taskId, record);
        this.pending.splice(pendingIndex, 0, taskId);
        throw new Error(`任务取消未能写入队列快照（${this.lastPersistError ?? '写入失败'}），任务仍在队列中`);
      }
      return true;
    }
    const handle = this.handles.get(taskId);
    if (handle === undefined) {
      // D-200: between the probe handle's removal and the engine handle's
      // registration the run passes through awaited steps (`withCopySuffix`),
      // so a cancel used to find no handle, return `false`, and the download
      // went on. Both states observable here have a legal edge to `Canceled`;
      // the run picks the recorded request up before it spawns the engine.
      if (record.state === 'ReadyWithInfo' || record.state === 'Running') {
        this.cancelRequested.add(taskId);
        this.transition(record, 'Canceled');
        // A run is not guaranteed to be in flight to persist for us (a restored
        // record sits here without a slot) — mirror the pending-branch behaviour.
        //
        // D-259 (audit P3): "mirror" must include the WRITE CHECK. The result
        // used to be ignored, so this branch answered a confirmed `true` while
        // tasks.json still held the pre-cancel value — shutdown-cancel's
        // per-task report (D-248) then classified the task as `confirmed`
        // instead of `persist-failed`. Unlike the pending branch there is
        // nothing to roll back: the transition above has been emitted and
        // `Canceled` has no legal edge back to `ReadyWithInfo` / `Running`.
        // The window and its alignment, spelled out once:
        //   * memory = `Canceled` (and `cancelRequested` holds the id, so an
        //     in-flight run still refuses to spawn the download), disk = the
        //     pre-cancel value;
        //   * MEMORY is the single source of truth for every LATER write:
        //     `persistSnapshot()` always serialises the in-memory records and
        //     the failed attempt un-reserved the fingerprint, so the next
        //     trigger (another task's tick / run end / any mutation) writes
        //     `Canceled` to disk;
        //   * if the process dies before that next write, `restore()` reads
        //     the old value and the existing boot rules decide: a persisted
        //     `Running` is defensively rewritten to `Canceled` (D-209), a
        //     persisted `ReadyWithInfo` comes back restartable-but-never-
        //     auto-started (M4-3). No path resumes the download by itself.
        const persisted = await this.persistSnapshot();
        if (!persisted) {
          throw new Error(
            `任务取消已受理，但队列快照未能写入磁盘（${this.lastPersistError ?? '写入失败'}），重启后该任务可能按取消前状态恢复`,
          );
        }
        return true;
      }
      return false;
    }
    const killed = await handle.cancel();
    if (!killed) {
      // D-142: the process tree SURVIVED taskkill. The task is still genuinely
      // running (the old process keeps writing bytes), so the record must not
      // claim the retryable terminal `Error` state: that used to let
      // `restart()` start a SECOND process for the same task id while the
      // first one was still alive — both writing the same temp dir, manifest
      // and output file, each overwriting the other's handle. Leave the record
      // in its current non-terminal state: the slot stays occupied, the user
      // may retry the cancel, and the queue self-heals when the process
      // eventually exits (the engine has already latched `canceled`, so the
      // run settles as `Canceled` no matter how the process dies).
      return false;
    }
    // D-162: `FetchingInfo -> Canceled` is a legal edge (§4.5) and the probe now
    // owns a handle, so a task cancelled mid-probe must land in `Canceled`
    // rather than silently flipping to `Error` when the child dies.
    if (record.state === 'Running' || record.state === 'FetchingInfo') {
      this.transition(record, 'Canceled');
    }
    return true;
  }

  async restart(taskId: string): Promise<void> {
    const record = this.records.get(taskId);
    if (record === undefined) throw new Error(`unknown task: ${taskId}`);
    // external online audit follow-up (D-268 leftover): a record whose
    // `request` is `null` (a legacy request-less row, or a damaged one the
    // D-268 restore guard normalized) used to restart "successfully" — the
    // transitions and field resets all ran and the toast said 已重新入队 —
    // and then its run hit the request gate in `run()`, which pins the error
    // and calls `transition(record, 'Error')`. From `ReadyWithInfo` that edge
    // does not exist, so the gate's own refusal threw
    // `IllegalTaskTransitionError`, `runSafely` caught it, OVERWROTE the gate
    // error with the migration error and swallowed the second transition too:
    // the row settled in `ReadyWithInfo` forever with a junk error, and every
    // retry fake-succeeded. Refuse at the door instead — BEFORE `before` is
    // captured, before any transition or field reset, so there is nothing to
    // roll back: the record keeps its exact pre-restart state and error, no
    // run is spawned, and the throw is honest. The message mirrors the D-263
    // 「任务未能重试：…」 style; `task-detail`'s retry converts the throw into
    // the REFUSED result the card shows (same path the D-263 write failure
    // takes). Records with a real request are untouched: the Canceled / Error
    // / Idle restart paths below behave exactly as before.
    if (record.request === null) {
      throw new Error('任务未能重试：下载请求缺失或损坏，无法安全重启');
    }
    // D-142: a record may still occupy a slot while its STATE looks settled —
    // the window between a successful cancel and the engine's close event, or
    // a cancel whose kill failed (the record then stays in its non-terminal
    // state, but the same guard covers every other path to this window).
    // Starting a second run for the same id would hand the fresh process the
    // old run's temp dir / manifest / output name and let the two closures
    // overwrite each other's handle and transitions. Refuse until the old
    // process is confirmed exited and the slot is released.
    if (this.running.has(taskId)) {
      throw new Error(`task still running, retry refused: ${taskId}`);
    }
    // D-263: everything below mutates the LIVE record in place (transitions +
    // the D-107/D-115 field resets). A failed snapshot write must restore the
    // EXACT pre-restart object, so capture it — and the FIFO slot, if the
    // record was parked — before the first mutation.
    const pendingIndex = this.pending.indexOf(taskId);
    const before: TaskRecord = {
      ...record,
      artifacts: [...record.artifacts],
      // Key-shape fidelity: `subtitleFiles` may legitimately be absent on a
      // settled record; materialising `[]` would change the restored object's
      // shape (first thing a `toEqual` pin notices).
      ...(record.subtitleFiles === undefined ? {} : { subtitleFiles: [...record.subtitleFiles] }),
    };
    const target: TaskState = record.mediaInfo !== null ? 'ReadyWithInfo' : 'Idle';
    // D-199: a restored `Idle` / `ReadyWithInfo` record already sits ON the
    // target state and the machine has no self-loop edges, so the unconditional
    // transition threw `IllegalTaskTransitionError` and made a queued-but-
    // never-started task unrestartable (the UI gate only covers Error/Canceled;
    // the IPC `TASK_ACTION restart` path reaches this directly). A restored
    // `Idle` record means "queued, not started" — restarting it simply starts
    // the download. Skip the transition when it would be a self-loop; the field
    // resets below are no-ops for a fresh record, and the re-queue + pump()
    // start it as usual.
    if (record.state !== target) {
      if (record.state === 'Idle' && target === 'ReadyWithInfo') {
        // A never-started task can also carry a pre-probed mediaInfo; the
        // machine has no `Idle -> ReadyWithInfo` edge, so walk the same two
        // legal edges `run()` walks for that case.
        this.transition(record, 'FetchingInfo');
        this.transition(record, 'ReadyWithInfo');
      } else {
        this.transition(record, target);
      }
    }
    record.error = null;
    record.artifacts = [];
    // Stage 4: a retry is a NEW run. Keeping the previous attempt's subtitle
    // links would make the card claim files this run never produced.
    record.subtitleFiles = [];
    delete record.subtitleOutcome;
    // D-107: a retry is a NEW run. Keeping the previous run's percent made the
    // card claim "37.0%" while the fresh process was still starting up — a
    // number from the last attempt presented as this attempt's progress. The
    // `.part` file on disk (yt-dlp resume) is untouched: the first real
    // progress event of the new run reports whatever is actually on disk.
    record.lastPercent = null;
    record.lastDownloadedBytes = null;
    record.lastTotalBytes = null;
    record.lastSpeedBps = null;
    record.lastEtaSec = null;
    // D-115: a retry starts at the transfer again; keeping "verifying" would
    // make the fresh attempt claim it is already finishing.
    record.lastStage = null;
    this.dropFromPending(taskId);
    // D-200: a cancel recorded for the OLD run must not kill the fresh one.
    this.cancelRequested.delete(taskId);
    // D-263 (audit follow-up; same defect shape as D-259's enqueue): the write
    // now GATES the start. The old order (pending → pump() → persist) let a
    // free slot spawn the retry first, so a failed write reported failure
    // about a download that was already running — and, unlike enqueue,
    // restart had ALSO mutated the record in place (transitions + resets),
    // leaving memory and disk disagreeing. Now the write happens before the
    // task can compete for a slot; failure rolls the record back to the exact
    // pre-restart state (memory matches the unchanged disk) and the thrown
    // error is literally true: the retry did not happen. Success lets pump()
    // start it as before. The D-163 write-count contract is untouched: still
    // exactly one structural write per restart. Exemptions mirror enqueue
    // (D-259): D-231 batch members (`batchDepth > 0`) follow the batch-end
    // write rules; no `taskStore` (core/L0) keeps the fully synchronous pump
    // the M4-2 pins describe. Transitions emitted before a failure are bounded
    // to that failure path; the poll-based list self-corrects on the next
    // TASK_LIST read.
    if (this.batchDepth === 0 && this.deps.taskStore !== undefined) {
      try {
        await this.persistOrThrow('任务未能重试：队列快照未能写入磁盘');
      } catch (error) {
        this.records.set(taskId, before);
        if (pendingIndex !== -1) this.pending.splice(pendingIndex, 0, taskId);
        throw error;
      }
    }
    this.pending.push(record.id);
    this.pump();
  }

  /**
   * Remove a task that is neither running nor needed any more (M4-6 detail
   * "delete"). Running tasks are refused so a process is never orphaned.
   *
   * D-242 (audit P2): a snapshot write that fails must NOT look like a
   * successful removal. The old code deleted the row from memory first and
   * awaited a `persistSnapshot()` that swallowed its own error, so this method
   * returned `true` while `tasks.json` still held the row — the caller
   * (`purgePrivateRecords` among others) then reported a cleanup that did not
   * happen, and the next launch restored the record. Now the write is checked:
   * on failure the in-memory row is put back (memory must agree with disk) and
   * the rejection carries the reason.
   *
   * D-259 (audit P3): "put back" must include the FIFO. `remove()` also runs
   * for QUEUED tasks (that is how a user cancels-and-deletes a parked row), and
   * the old failure path restored only `records` — leaving a record in the map
   * with NO pending entry: a ghost that `pump()` can never reach (never starts,
   * never auto-fills) and whose card the UI can neither run nor cancel. The
   * exact pre-remove position is captured BEFORE the drop and restored on the
   * failure path, the same shape the `cancel()` pending branch has used since
   * D-242.
   */
  async remove(taskId: string): Promise<boolean> {
    if (this.running.has(taskId)) return false;
    const record = this.records.get(taskId);
    if (record === undefined) return false;
    // D-259: capture the FIFO position first — `dropFromPending` erases it.
    const pendingIndex = this.pending.indexOf(taskId);
    this.dropFromPending(taskId);
    // D-200: the id leaves the queue; drop any cancel recorded for it. (A
    // recorded request only ever targets an id that occupies a slot, which
    // `remove()` refuses above — a leftover entry here is stale, so it stays
    // deleted even on the failure path below.)
    this.cancelRequested.delete(taskId);
    this.records.delete(taskId);
    const persisted = await this.persistSnapshot();
    if (!persisted) {
      // D-242 + D-259: memory must agree with the (unchanged) disk again —
      // the record AND its FIFO position.
      this.records.set(taskId, record);
      if (pendingIndex !== -1) this.pending.splice(pendingIndex, 0, taskId);
      throw new Error(`任务记录未能从队列快照中删除（${this.lastPersistError ?? '写入失败'}），记录已保留`);
    }
    return true;
  }

  /**
   * Rehydrate the queue from a recovered snapshot (M4-3).
   *
   * Restored tasks occupy NO slot and are NOT started: a boot must never
   * surprise the user with downloads they did not ask for in this session.
   * `Running` / `FetchingInfo` are defensively rewritten to `Canceled` even if
   * the caller forgot `TaskStore.recover()`.
   */
  async restore(snapshot: TaskSnapshot): Promise<number> {
    let restored = 0;
    for (const raw of snapshot.tasks) {
      if (this.records.has(raw.id)) continue;
      // D-240 (audit P1): a private-mode row must never come back. New writes
      // already exclude them (`persistableRecords`), but a file written by an
      // OLDER build still carries them — restoring it would resurrect exactly
      // the record the user asked not to keep. Dropping it here is also what
      // cleans the file: the snapshot rewrite at the end of this method
      // persists the remaining rows only.
      if (raw.privateMode === true) continue;
      // D-236: the persisted copy carries no proxy (see buildPersistProjection);
      // the host hook re-injects the CURRENT config value so a restart neither
      // loses the proxy nor revives a removed one.
      //
      // external online audit P2 · malformed request must not break
      // restore/persist (D-268): a row whose `request` is non-null but
      // UNUSABLE — not a plain object, or any of the four consumed domains
      // (`paths` / `format` / `subtitle` / `advanced`) missing / not an
      // object — is normalized to `null` here, BEFORE the host hook or any
      // later reader ever sees it. This is exactly the D-203 semantics for a
      // request-less record: the row itself is kept (never silently dropped),
      // every run / TASK_ACTION on it refuses, the UI shows 「无法验证归属」.
      // The normalization also closes the failure chain where ONE malformed
      // row made this method's final `persistSnapshot()` (D-242 / D-259 /
      // D-263 rethrow write failures) blow up the whole boot and then report
      // 「快照写入失败」 for every later structural write. `network` missing
      // with the four consumed domains intact is deliberately NOT normalized:
      // the host's `repairRestoredRequest` hook rebuilds that domain from live
      // config, so the row stays fully usable.
      const request = restoredRequestIsUsable(raw.request)
        ? (this.deps.repairRestoredRequest === undefined
          ? raw.request
          : this.deps.repairRestoredRequest(raw.request))
        : null;
      const record: TaskRecord = {
        ...raw,
        request,
        state: raw.state === 'Running' || raw.state === 'FetchingInfo' ? 'Canceled' : raw.state,
        artifacts: [...(raw.artifacts ?? [])],
        lastPercent: raw.lastPercent ?? null,
        // D-115: older snapshots have no stage; `null` keeps the card on its
        // pre-0.2.6 presentation instead of inventing a phase.
        lastStage: raw.lastStage ?? null,
      };
      this.records.set(record.id, record);
      restored += 1;
    }
    await this.persistSnapshot();
    return restored;
  }

  /**
   * T2: persist the queue snapshot; a failure is VISIBLE but never fatal to a
   * background write.
   *
   * Semantics (unchanged for fire-and-forget callers): `taskStore.save()`
   * rejections are caught so a broken snapshot can never blow up the download
   * path. The warning goes through the EXISTING `CorePorts.logSink` facility
   * (the same port Logger / ConfigStore write through, same
   * `{ts, level, scope, event, payload?}` line shape), so it lands in
   * `logs/app-*.jsonl` via the production adapter with zero new wiring. One
   * line per failure episode (see `snapshotPersistFailed`); the payload
   * carries only the error message — never snapshot content or URLs. The store
   * also keeps the error on `TaskStore.lastSaveError` for offline diagnostics.
   *
   * D-242 (audit P2): the outcome is RETURNED (`true` = the disk state matches
   * what the caller asked for, `false` = the write failed). The callers that
   * REPORT something to the user as done — `enqueue()` / `enqueueBatch()` /
   * `restart()` / `remove()` — must check it; that is what stops "removed"
   * from meaning "gone from memory, still on disk". `lastPersistError` carries
   * the reason for those messages. Everything else (progress ticks, the final
   * write of a run) keeps ignoring the result: a broken disk must never turn
   * a finished download into a failed one.
   */
  private async persistSnapshot(): Promise<boolean> {
    if (this.deps.taskStore === undefined) return true;
    // D-240 (audit P1): private-mode rows are memory-only — they are excluded
    // BEFORE the fingerprint is taken, so "a private task changed" is not a
    // reason to rewrite the file, and the persisted set can never contain one.
    const persistable = persistableRecords([...this.records.values()]);
    // D-163: a no-op write is still a full-file rewrite. `run().finally` fires
    // on every task end, and the throttled progress ticks keep calling here
    // (state / stage / artifact / error changes ride on the next tick), so
    // skip the write when nothing structural moved. The fingerprint reads the
    // IN-MEMORY records: the persisted projection only strips fields the
    // fingerprint never looks at, so both produce the same string — and a
    // skipped tick no longer pays for building that projection either.
    const fingerprint = snapshotFingerprint(persistable);
    if (fingerprint === this.lastPersistedFingerprint) return true;
    // D-163: minimise before serialising — signed CDN links never touch disk.
    // (Task-6 split: the projection build moved verbatim to
    // `./snapshot-projection.js`; the fingerprint gate, the write queue and the
    // failure semantics stay HERE — this class remains the only state owner.)
    const tasks = buildPersistProjection(persistable);
    // Reserve the fingerprint BEFORE the awaited save: further progress events
    // fire while the write is still in flight, and each of them compares
    // against this field — updating it only after the save resolved would let
    // identical content queue identical full-file rewrites.
    this.lastPersistedFingerprint = fingerprint;
    const store = this.deps.taskStore;
    // Task-2 audit follow-up: the save is chained through `snapshotWriteQueue`
    // so overlapping persists land in submission order (newest last); see the
    // field comment. The task itself never rejects — a failed write is logged
    // (once per episode), un-reserves the fingerprint for the next attempt, and
    // is reported to THIS caller as `false` (D-242).
    const write = this.snapshotWriteQueue.then(async (): Promise<boolean> => {
      try {
        await store.save({
          schemaVersion: 1,
          savedAt: nowIso(this.deps.ports),
          tasks,
        });
        this.snapshotPersistFailed = false;
        this.lastPersistError = null;
        return true;
      } catch (error) {
        // The write never landed: un-reserve so the next attempt retries.
        this.lastPersistedFingerprint = null;
        this.lastPersistError = error instanceof Error ? error.message : String(error);
        if (this.snapshotPersistFailed) return false;
        this.snapshotPersistFailed = true;
        try {
          await this.deps.ports.logSink.appendJsonl(JSON.stringify({
            ts: nowIso(this.deps.ports),
            level: 'WARNING',
            scope: 'task-queue',
            event: 'snapshot.persist.failed',
            payload: { error: this.lastPersistError },
          }));
        } catch { /* a dead log sink must not break the queue either */ }
        return false;
      }
    });
    this.snapshotWriteQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  /**
   * D-242: the "I reported success" wrapper. Used by every mutation whose
   * contract is "this is now true on disk" (`enqueue` / `restart` / `remove`).
   * Callers that are only refreshing an already-running task must keep using
   * `persistSnapshot()` and ignore the result.
   */
  private async persistOrThrow(whatFailed: string): Promise<void> {
    const persisted = await this.persistSnapshot();
    if (persisted) return;
    throw new Error(`${whatFailed}（${this.lastPersistError ?? '写入失败'}）`);
  }
}
