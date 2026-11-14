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
  CorePorts, HistoryEntry, MediaInfo, ExpectedArtifactManifest, TaskSnapshot,
  SubtitleFileLink,
} from '@ytvdlt/shared';
import { isForwardStage } from '@ytvdlt/shared';
import type { ICancelHandle, IArtifactVerifier, IHistoryStore, ITaskQueue, ITaskStore } from '../ports.js';
import { detectPostprocessed } from '../download-flags.js';
import { resolveDownloadPlan } from '../decision/download-plan.js';
import { applyCopySuffix, nextCopySuffix } from '../path-resolver/copy-suffix.js';
import { artifactRootsOf, splitArtifactsByRoots } from '../path-resolver/containment.js';
import {
  buildSubtitleLinks, classifyArtifact, evaluateSubtitleOutcome,
  primaryMediaArtifact, subtitleArtifactsOf, mediaArtifactsOf,
} from '../artifact-classify/index.js';
import { assertTransition } from './state-machine.js';
import { stripCredentialUrls } from './snapshot-media.js';
import { createProbeAbort } from './probe-abort.js';

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
   */
  recycleSubtitleFiles?: (paths: readonly string[]) => Promise<readonly string[]>;
}

/** Hard ceiling: more slots than this only thrashes the network + disk. */
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 3;

/** Pure clamp used by the queue AND by the config layer (single rule). */
export function normalizeConcurrency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(numeric)));
}

const nowIso = (ports: CorePorts): string => ports.clock.nowIso();

/**
 * D-163: cheap, observable-change fingerprint of the snapshot.
 *
 * Deliberately NOT a hash of the serialised JSON: the point is to skip the
 * stringify + full-file rewrite, so the comparison must not cost one itself.
 * Every structural field the task list / detail view can display is included,
 * and nothing else — a change that is invisible to the user does not deserve a
 * disk write.
 *
 * Progress numbers (`lastPercent` / bytes / speed / ETA) are deliberately NOT
 * fingerprinted: every progress tick moves them, so including them made
 * `tasks.json` a twice-a-second full rewrite for the whole download. A crash
 * does not need fresh numbers there — `restore()` rewrites every interrupted
 * state to `Canceled` and `restart()` clears progress anyway (D-107), and the
 * resume credentials live in `<dataDir>/work/<taskId>` (D-118), never in this
 * file. Progress values ARE still serialised whenever a structural change
 * writes the file, so the snapshot stays internally consistent.
 */
function snapshotFingerprint(tasks: readonly TaskRecord[]): string {
  return tasks.map((task) => [
    task.id, task.state, task.updatedAt, task.kind,
    task.lastStage ?? '', task.error?.code ?? '', task.artifacts.length,
    task.subtitleFiles?.length ?? '', task.subtitleOutcome ?? '',
    task.mediaInfo?.id ?? '',
  ].join('|')).join('\n');
}

/** Windows path equality: case-insensitive, slash-insensitive. */
function pathKeyOf(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase();
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
    // Re-enqueueing an id must not leave a stale FIFO entry behind.
    this.dropFromPending(stored.id);
    this.records.set(stored.id, stored);
    this.pending.push(stored.id);
    this.pump();
  }

  /**
   * Enqueue N independent tasks (M4-4 batch). Each `enqueue` only parks the
   * task and lets `pump()` fill the available slots, so a 50-item batch never
   * starts 50 downloads.
   */
  async enqueueBatch(records: readonly TaskRecord[]): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const record of records) {
      await this.enqueue(record);
      ids.push(record.id);
    }
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
      });
      record.subtitleOutcome = evaluateSubtitleOutcome({
        subtitle: subtitleRequest,
        mediaInfo: record.mediaInfo,
        links: subtitleFiles,
        ...(report.attachments === undefined ? {} : { attachments: report.attachments }),
      });
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

      // --- 4) history then Completed ---
      const entry = buildHistoryEntry(record, kept.artifacts, outcome.sizes, this.deps.ports);
      const addResult = await this.deps.history.add(entry, { privateMode: record.privateMode });
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
      await this.persistSnapshot();
      // A freed slot is immediately offered to the FIFO (auto-fill, ①).
      this.pump();
    }
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

    const ownMedia = new Set(mediaArtifactsOf(artifacts));
    const candidates = links
      .filter((link) => ownMedia.has(link.mediaPath))
      .filter((link) => link.language !== '')
      .filter((link) => !this.isArtifactSharedWithOtherTasks(link.path, record.id))
      .map((link) => link.path);
    if (candidates.length === 0) return unchanged;

    let removed: readonly string[];
    try {
      removed = await recycle(candidates);
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
   * highest ` (n)` already there, and hand yt-dlp ` (n+1)`. Anything unexpected
   * (custom template without the id token, unreadable directory, template with
   * no `%(ext)s`) returns the request untouched — naming is then left exactly as
   * the user configured it, and the duplicate is handled by the history step
   * instead of by guessing a filename.
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

    let names: readonly string[];
    try {
      names = await this.deps.ports.fs.readdir(dir);
    } catch {
      // Not created yet (first download into a new folder) — nothing to collide.
      return request;
    }
    const suffix = nextCopySuffix(names, mediaId);
    if (suffix === '') return request;
    const outputTemplate = applyCopySuffix(template, suffix);
    if (outputTemplate === null) return request;
    return { ...request, paths: { ...request.paths, outputTemplate } };
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
    const { kept, rejected } = splitArtifactsByRoots(artifacts, artifactRootsOf(request.paths));
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
      await this.persistSnapshot();
      return true;
    }
    const handle = this.handles.get(taskId);
    if (handle === undefined) return false;
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
    const target: TaskState = record.mediaInfo !== null ? 'ReadyWithInfo' : 'Idle';
    this.transition(record, target);
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
    this.pending.push(record.id);
    this.pump();
  }

  /**
   * Remove a task that is neither running nor needed any more (M4-6 detail
   * "delete"). Running tasks are refused so a process is never orphaned.
   */
  async remove(taskId: string): Promise<boolean> {
    if (this.running.has(taskId)) return false;
    if (!this.records.has(taskId)) return false;
    this.dropFromPending(taskId);
    this.records.delete(taskId);
    await this.persistSnapshot();
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
      const record: TaskRecord = {
        ...raw,
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
   * T2: persist the queue snapshot; a failure is VISIBLE but never fatal.
   *
   * Semantics (unchanged): `taskStore.save()` rejections are caught so a
   * broken snapshot can never blow up the download path. What changed: the
   * failure is no longer silent. The warning goes through the EXISTING
   * `CorePorts.logSink` facility (the same port Logger / ConfigStore write
   * through, same `{ts, level, scope, event, payload?}` line shape), so it
   * lands in `logs/app-*.jsonl` via the production adapter with zero new
   * wiring. One line per failure episode (see `snapshotPersistFailed`); the
   * payload carries only the error message — never snapshot content or URLs.
   * The store also keeps the error on `TaskStore.lastSaveError` for offline
   * diagnostics.
   */
  private async persistSnapshot(): Promise<void> {
    if (this.deps.taskStore === undefined) return;
    // D-163: a no-op write is still a full-file rewrite. `run().finally` fires
    // on every task end, and the throttled progress ticks keep calling here
    // (state / stage / artifact / error changes ride on the next tick), so
    // skip the write when nothing structural moved. The fingerprint reads the
    // IN-MEMORY records: the persisted projection only strips fields the
    // fingerprint never looks at, so both produce the same string — and a
    // skipped tick no longer pays for building that projection either.
    const fingerprint = snapshotFingerprint([...this.records.values()]);
    if (fingerprint === this.lastPersistedFingerprint) return;
    // D-163: minimise before serialising — signed CDN links never touch disk.
    const tasks: TaskRecord[] = this.list().map((record) => (record.mediaInfo === null
      ? { ...record, artifacts: [...record.artifacts] }
      : {
        ...record,
        artifacts: [...record.artifacts],
        mediaInfo: stripCredentialUrls(record.mediaInfo),
      }));
    // Reserve the fingerprint BEFORE the awaited save: further progress events
    // fire while the write is still in flight, and each of them compares
    // against this field — updating it only after the save resolved would let
    // identical content queue identical full-file rewrites.
    this.lastPersistedFingerprint = fingerprint;
    try {
      await this.deps.taskStore.save({
        schemaVersion: 1,
        savedAt: nowIso(this.deps.ports),
        tasks,
      });
      this.snapshotPersistFailed = false;
    } catch (error) {
      // The write never landed: un-reserve so the next attempt retries.
      this.lastPersistedFingerprint = null;
      if (this.snapshotPersistFailed) return;
      this.snapshotPersistFailed = true;
      try {
        await this.deps.ports.logSink.appendJsonl(JSON.stringify({
          ts: nowIso(this.deps.ports),
          level: 'WARNING',
          scope: 'task-queue',
          event: 'snapshot.persist.failed',
          payload: { error: error instanceof Error ? error.message : String(error) },
        }));
      } catch { /* a dead log sink must not break the queue either */ }
    }
  }
}

function toAppError(error: unknown): AppError {
  const candidate = error as Partial<AppError>;
  if (typeof candidate?.code === 'string' && typeof candidate.message === 'string') {
    return {
      code: candidate.code,
      message: candidate.message,
      detail: candidate.detail ?? '',
      retryable: candidate.retryable ?? true,
      report: candidate.report ?? `${candidate.code}: ${candidate.message}`,
    };
  }
  return {
    code: 'UNKNOWN', message: '未知错误', detail: String(error), retryable: true,
    report: `UNKNOWN: ${String(error)}`,
  };
}

function buildHistoryEntry(
  record: TaskRecord,
  artifacts: readonly string[],
  sizes: ReadonlyMap<string, number | null>,
  ports: CorePorts,
): HistoryEntry {
  const info: MediaInfo | null = record.mediaInfo;
  // Stage 4: `artifacts[0]` is a thumbnail or a subtitle often enough that it
  // must never be the history's `videoPath` — C11 verifies that path and the UI
  // opens it. Fall back to index 0 only when no media file exists at all, so a
  // degenerate run still produces an honest (and correctly failing) record.
  const primary = primaryMediaArtifact(artifacts) ?? artifacts[0] ?? '';
  const audio = artifacts.find((path) => classifyArtifact(path) === 'audio') ?? null;
  const thumb = artifacts.find((path) => classifyArtifact(path) === 'thumbnail') ?? null;
  const subs = subtitleArtifactsOf(artifacts);
  const timestamp = ports.clock.nowIso();
  // The engine fs.stat'd every artifact when the completed event was emitted;
  // the primary media file IS the product, so its measured size is the honest
  // history value. For a merged video+audio download that file is the merged
  // output — the per-stream progress totals (`record.lastTotalBytes`) describe
  // only the LAST stream and would under-report the product. `0` stays the
  // "unknown" sentinel (engine could not stat): an unknown size is never
  // fabricated into a non-zero number (D-107 spirit).
  const reported = sizes.get(primary);
  const sizeBytes = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? reported
    : 0;
  return {
    id: record.id,
    taskId: record.id,
    url: record.url,
    title: info?.title ?? '',
    uploader: info?.uploader ?? null,
    durationSec: info?.duration ?? null,
    videoPath: primary,
    audioPath: audio,
    thumbnailPath: thumb,
    subtitlePaths: subs,
    sizeBytes,
    extractorKey: info?.extractor_key ?? '',
    downloadType: record.kind,
    formatId: record.request?.format.formatId ?? null,
    createdAt: record.createdAt,
    completedAt: timestamp,
  };
}
