/**
 * D-240 (audit P1) · which records the snapshot may contain at all.
 *
 * A private-mode download is a promise that the record leaves no trace on
 * disk. It already never reaches `history.json` (the add call is skipped), but
 * the QUEUE snapshot kept it: `tasks.json` carried every `privateMode: true`
 * row, and `TaskQueue.restore()` rebuilt it on the next launch as a `Canceled`
 * task — the exact record the user asked not to keep, resurrected by the
 * crash-recovery path. Purging on window close could never cover this: a crash
 * or a `taskkill` runs no cleanup hook at all.
 *
 * So privacy is enforced at the WRITE boundary instead of in the cleanup hook:
 *  - private rows are simply not part of any snapshot, which makes "restart
 *    cannot show them" true for every shutdown path (graceful, close-to-tray,
 *    crash, kill) without touching a running download;
 *  - `restore()` also drops such rows found in an OLDER file (written before
 *    this rule), so an upgrade does not resurrect them once either.
 *
 * Files the download produced are untouched — the media belongs to the user
 * (D-88 / D-232's "cleanup never touches the filesystem" is unchanged); only
 * the queue row stops being durable.
 */
export function persistableRecords(records: readonly TaskRecord[]): TaskRecord[] {
  return records.filter((record) => record.privateMode !== true);
}

/**
 * The persisted-snapshot projection, split out of `task-queue.ts` (task-6
 * refactor).
 *
 * Both helpers are PURE: they read the records they are handed and return a
 * value — no `this`, no I/O, no mutable queue state. `TaskQueue` keeps owning
 * every mutable piece of the write semantics (the D-163 fingerprint gate,
 * `lastPersistedFingerprint`, `snapshotWriteQueue`, `snapshotPersistFailed` —
 * none of that moved); this module only owns WHAT a write would contain and
 * WHAT its fingerprint looks at. Both bodies were moved verbatim from
 * `task-queue.ts`, so behaviour is byte-identical.
 */
import type { TaskRecord } from '@ytvdlt/shared';
import { stripCredentialUrls } from './snapshot-media.js';

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
export function snapshotFingerprint(tasks: readonly TaskRecord[]): string {
  return tasks.map((task) => [
    task.id, task.state, task.updatedAt, task.kind,
    task.lastStage ?? '', task.error?.code ?? '', task.artifacts.length,
    task.subtitleFiles?.length ?? '', task.subtitleOutcome ?? '',
    task.mediaInfo?.id ?? '',
  ].join('|')).join('\n');
}

/**
 * D-163: minimise before serialising — signed CDN links never touch disk.
 *
 * Extracted verbatim from `TaskQueue.persistSnapshot()`'s projection build
 * (`this.list().map(...)`): the caller passes the shallow record copies and
 * this returns the serialisation-ready list. Records without a cached probe
 * keep their artifact copy; records WITH one additionally get their
 * `mediaInfo` replaced by `stripCredentialUrls()`'s minimised copy (see
 * `./snapshot-media.js` for why `thumbnail` is deliberately kept).
 *
 * D-236: the request snapshot is persisted verbatim EXCEPT `network.proxy` —
 * a proxy value can carry `http://user:password@host`, and `tasks.json` is
 * the file users attach to bug reports. The in-memory record is untouched
 * (the argv still needs the proxy for THIS session); a restored task gets
 * the CURRENT config proxy re-injected through the host's
 * `repairRestoredRequest` hook (TaskQueueDeps), so a restart neither loses
 * the proxy nor revives one the user has since removed. The fingerprint
 * never reads `request`, so the D-163 write gate is unaffected.
 */
export function buildPersistProjection(
  records: readonly TaskRecord[],
): TaskRecord[] {
  return records.map((record) => {
    const request = record.request;
    // external online audit P2 · malformed request must not break
    // restore/persist (decision number pending): the old guard read
    // `request.network.proxy` after only a `request !== null` check, so ONE
    // malformed row — a non-null `request` that is not a plain object, or one
    // whose `network` domain is missing (old schema / hand-edited / damaged
    // import) — threw a TypeError HERE. The projection is on the path of every
    // structural write, so that single row made `restore()` fail the whole
    // boot and every later enqueue/restart/remove report 「快照写入失败」
    // (D-242 / D-259 / D-263 rethrow write failures honestly — the poison is
    // the projection, not the reporting). The strip now applies only when the
    // request is a real object AND its `network` domain is a real object AND
    // `proxy` is a non-empty string; every other shape passes through
    // untouched. Zero-throw contract: a malformed row can never break the
    // projection, and it can never leak a proxy either — no `network` object
    // means there is nothing to strip.
    const needsProxyStrip = request !== null
      && typeof request === 'object'
      && typeof request.network === 'object' && request.network !== null
      && typeof request.network.proxy === 'string' && request.network.proxy !== '';
    return {
      ...(needsProxyStrip
        ? {
          ...record,
          request: { ...request, network: { ...request.network, proxy: null } },
        }
        : record),
      artifacts: [...record.artifacts],
      mediaInfo: record.mediaInfo === null ? null : stripCredentialUrls(record.mediaInfo),
    };
  });
}
