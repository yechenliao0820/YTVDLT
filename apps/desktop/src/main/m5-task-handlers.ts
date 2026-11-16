/**
 * M5 task-domain IPC handlers (task 4, mechanical extraction from
 * `m5-channels.ts`): TASK_LIST / TASK_DETAIL / TASK_ACTION (the D-87/D-120/
 * D-182/D-203/D-207/D-221 delete-safety chain), command-template CRUD and the
 * D-103 thumbnail-cache management channel.
 *
 * The handler bodies are VERBATIM — the extraction only wraps them in a
 * registrar that receives the shared `{ deps }` context. Payload validation,
 * the URL-free DTO projections and the trusted-root containment gates are
 * unchanged; see `m5-contracts.ts` for the whitelist they validate against.
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { CommandTemplateInput, TaskDetailAction, TaskTab } from '@ytvdlt/core';
import { buildTaskListSnapshot, isPathInsideRoots, trustedArtifactRoots } from '@ytvdlt/core';
import {
  normalizeTrashOutcomes, samePathKey, toTaskDetail, toTaskListItem, validateM5Payload,
} from './m5-contracts.js';
import type { M5HandlerContext, M5Handler, M5HandlerMap } from './m5-channels.js';
import type { LocalFileState } from './local-file-status.js';

const TASK_ACTIONS: readonly TaskDetailAction[] = [
  'open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry',
];

const MAX_TEMPLATE_ARGS = 32;
const MAX_ARG_LENGTH = 400;

/** D-103: the only cache actions the renderer may trigger. */
const THUMBNAIL_CACHE_ACTIONS: readonly string[] = [
  'status', 'prune', 'set-auto', 'set-max-bytes',
];

function assertTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('[m5-ipc] taskId must be a non-empty string');
  }
  return value;
}

/** D-120: stable buckets -> stable codes; the renderer owns the sentence. */
const FILE_CODE_OF: Readonly<Record<string, string>> = {
  missing: 'FILE_MISSING',
  inaccessible: 'FILE_INACCESSIBLE',
  unavailable: 'FILE_UNAVAILABLE',
  invalid: 'NO_ARTIFACT',
};
const FOLDER_CODE_OF: Readonly<Record<string, string>> = {
  missing: 'FOLDER_MISSING',
  inaccessible: 'FOLDER_INACCESSIBLE',
  unavailable: 'FOLDER_UNAVAILABLE',
  invalid: 'NO_ARTIFACT',
};
/** Fallback copy for the detail page, which prints `result.message` verbatim. */
const OPEN_MESSAGE_OF: Readonly<Record<string, string>> = {
  FILE_MISSING: '无法打开文件：该视频文件已不存在于原保存位置，可能已被手动删除或移动。',
  FILE_INACCESSIBLE: '无法打开文件：没有访问权限，或文件正被其他程序占用。',
  FILE_UNAVAILABLE: '暂时无法确认文件状态，磁盘或网络位置可能不可用，请稍后重试。',
  FOLDER_MISSING: '原下载文件夹已不存在或无法访问。',
  FOLDER_INACCESSIBLE: '原下载文件夹无法访问。',
  FOLDER_UNAVAILABLE: '暂时无法确认原下载文件夹状态，请稍后重试。',
  NO_ARTIFACT: '任务记录中没有有效的本地文件路径。',
};

function assertTemplateInput(record: Record<string, unknown>): CommandTemplateInput {
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    throw new Error('[m5-ipc] template name must be 1..80 chars');
  }
  const args = record['args'];
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_TEMPLATE_ARGS) {
    throw new Error('[m5-ipc] template args must be a non-empty array');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH) {
      throw new Error('[m5-ipc] template args must be strings');
    }
  }
  return { name, args: args as readonly string[] };
}

export function createTaskHandlers(ctx: M5HandlerContext): M5HandlerMap {
  const handlers = new Map<string, M5Handler>();
  const deps = ctx.deps;


    handlers.set(IPC_CHANNELS.TASK_LIST, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_LIST, payload);
    const tab = record['tab'];
    const query = record['query'];
    if (tab !== undefined && !['all', 'downloading', 'finished', 'canceled'].includes(String(tab))) {
      throw new Error('[m5-ipc] invalid tab');
    }
    if (query !== undefined && typeof query !== 'string') throw new Error('[m5-ipc] query must be a string');
    const refresh = record['refreshFileStatus'];
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new Error('[m5-ipc] refreshFileStatus must be a boolean');
    }
    const records = deps.queue.list();
    const snapshot = buildTaskListSnapshot(records, {
      ...(tab === undefined ? {} : { tab: tab as TaskTab }),
      ...(query === undefined ? {} : { query: query as string }),
    });
    // D-120: one batch probe per list request, short-TTL cached in the port.
    // The renderer asks for a fresh stat only on load / re-entry / user action,
    // never on every repaint. Missing port => no field at all (old contract).
    const states = deps.fileStatus === undefined
      ? {}
      : await deps.fileStatus.probe(records, refresh === true);
    return {
      tab: snapshot.tab,
      counts: snapshot.counts,
      empty: snapshot.empty,
      items: snapshot.visible.map((record) => toTaskListItem(
        record,
        deps.thumbnails === undefined ? null : deps.thumbnails.pathOf(record.id),
        states[record.id],
        deps.queue.isPending?.(record.id) === true,
      )),
    };
  });

  handlers.set(IPC_CHANNELS.TASK_DETAIL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_DETAIL, payload);
    const taskId = assertTaskId(record['taskId']);
    const task = deps.queue.get(taskId);
    if (task === undefined) return { found: false, task: null };
    return { found: true, task: toTaskDetail(task, deps.queue.isPending?.(taskId) === true) };
  });

  handlers.set(IPC_CHANNELS.TASK_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_ACTION, payload);
    const taskId = assertTaskId(record['taskId']);
    const action = record['action'];
    if (typeof action !== 'string' || !TASK_ACTIONS.includes(action as TaskDetailAction)) {
      throw new Error('[m5-ipc] unknown task action');
    }
    const rawWithFiles = record['withFiles'];
    if (rawWithFiles !== undefined && typeof rawWithFiles !== 'boolean') {
      throw new Error('[m5-ipc] withFiles must be a boolean');
    }
    // ---- D-120: a fresh, honest observation before ANY open action ----------
    // The result is a stable code, never a sentence: the renderer resolves it
    // in the active locale. A transient error is never reported as "deleted".
    const isOpenAction = action === 'open-file' || action === 'open-folder';
    let observed: LocalFileState | undefined;
    if (deps.fileStatus !== undefined && isOpenAction) {
      const task = deps.queue.get(taskId);
      if (task === undefined) {
        return { action, ok: false, code: 'TASK_MISSING', message: `unknown task: ${taskId}` };
      }
      observed = await deps.fileStatus.probeTask(task);
      if (observed.status === 'invalid') {
        return { action, ok: false, code: 'NO_ARTIFACT', message: OPEN_MESSAGE_OF['NO_ARTIFACT'] as string };
      }
      if (action === 'open-folder') {
        // A missing FILE must not block the folder: the directory is what the
        // user asked to see. Only a missing/unreadable directory is a failure.
        if (observed.dirStatus !== 'present') {
          const code = FOLDER_CODE_OF[observed.dirStatus] ?? 'ERROR';
          return { action, ok: false, code, message: OPEN_MESSAGE_OF[code] ?? `原下载目录不可打开（${observed.dirStatus}）` };
        }
      } else if (observed.status !== 'present') {
        const code = FILE_CODE_OF[observed.status] ?? 'ERROR';
        return { action, ok: false, code, message: OPEN_MESSAGE_OF[code] ?? `本地文件不可打开（${observed.status}）` };
      }
    }

    // ---- D-120: local cleanup is idempotent and NEVER gates the record -----
    if (rawWithFiles === true) {
      if (action !== 'remove') throw new Error('[m5-ipc] withFiles requires action=remove');
      if (deps.trashFiles === undefined) {
        return { action: 'remove', ok: false, code: 'SHELL_UNAVAILABLE', message: '当前构建未启用回收站端口' };
      }
      // Only the paths the engine itself recorded for THIS task are eligible.
      // The renderer never sends a path, so it cannot aim this at arbitrary files.
      const target = deps.queue.get(taskId);
      const artifacts = target?.artifacts ?? [];
      // D-182: a path outside the record's own output roots never reaches the
      // recycle bin. The intake gate (task-queue) already guarantees this for
      // anything downloaded in this session; the check defends restored /
      // manipulated snapshots. The whole batch is refused (nothing is trashed,
      // the record is kept and the reason is reported) — deleting a foreign
      // file is the one error that cannot be undone.
      // D-203 (breaking change, supersedes the frozen D-120 tolerance): a
      // record without a usable request has NO trustworthy roots, and
      // `isPathInsideRoots` fails OPEN on empty roots by design — so a
      // request-less legacy record used to let ANY recorded path (e.g.
      // `C:/Windows/evil.mp4`) into the recycle bin. The gate is therefore
      // fail-closed for EVERY record: whenever `trustedArtifactRoots` returns
      // null (request === null, a request cleaned by the D-161/D-195 shape
      // guard, an undeterminable output dir, or no specific root) the whole
      // batch is refused and the record plus its history are kept intact.
      const removalRoots = trustedArtifactRoots(target?.request?.paths ?? {});
      // D-193 / D-203: null roots mean the ownership of every artifact is
      // unverifiable — both gates derive their scope from this same record,
      // so an empty scope would make "inside" mean "anywhere".
      if (removalRoots === null) {
        return {
          action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
          reason: '无法验证产物文件归属（任务缺少可用的下载请求信息），为防止误删已拒绝回收本地文件',
          message: '本地文件清理失败：无法验证产物文件归属（任务缺少可用的下载请求信息），为防止误删已拒绝回收本地文件；任务记录已保留',
          failedCount: artifacts.length,
        };
      }
      const refused = artifacts.filter((path) => !isPathInsideRoots(path, removalRoots));
      if (refused.length > 0) {
        return {
          action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
          reason: `检测到 ${refused.length} 个产物路径超出任务输出目录，为防止误删已拒绝回收`,
          message: `本地文件清理失败：检测到 ${refused.length} 个产物路径超出任务输出目录，为防止误删已拒绝回收；任务记录已保留`,
          failedCount: refused.length,
        };
      }
      // A second live record may quote the same physical file. Deleting it for
      // this record would silently destroy the other record's artifact, so the
      // shared paths are skipped (the record is still removed). In a batch the
      // last record of the group then finds no other claim and recycles it.
      const claimedElsewhere = new Set<string>();
      for (const other of deps.queue.list()) {
        if (other.id === taskId) continue;
        for (const artifact of other.artifacts) claimedElsewhere.add(samePathKey(artifact));
      }
      const eligible = artifacts.filter((path) => !claimedElsewhere.has(samePathKey(path)));
      const sharedSkipped = artifacts.length - eligible.length;
      // ---- D-207: pre-flight the WHOLE batch before anything destructive -----
      // The string gate above compares NAMES. On Windows the kernel silently
      // resolves a reparse point placed in a MIDDLE path component, so a
      // recorded `<videoDir>/link/file.mp4` can physically live anywhere while
      // every name-level check passes — the adapter's end-component lstat guard
      // cannot see it, and a dangling mid-path junction even masquerades as
      // "already missing". The pre-flight (carried by the injected trash port,
      // implemented adapter-side against the real filesystem) resolves every
      // eligible path to its FINAL real location and re-runs containment on it.
      // ONE unprovable path refuses the WHOLE batch: the recycle bin is never
      // reached, the record is kept and `taskDetail.perform('remove')` is never
      // called. This also closes the honest-count hole — a legitimate file can
      // no longer be recycled first and then abandoned in the bin behind a
      // refused result that mentions no `filesTrashed`. Provably-gone entries
      // (realpath ENOENT with a decidable, contained parent) keep the D-120
      // idempotent semantics: excluded from the trash call, counted as
      // `filesMissing`. Ports without `preflight` (legacy fakes) keep their
      // exact previous behaviour; the adapter's per-entry lstat guard stays in
      // place behind this gate as the TOCTOU second line.
      const preflight = deps.trashFiles.preflight;
      let trashTargets = eligible;
      let preflightMissing: readonly string[] = [];
      // D-221 re-audit · root binding: the canonical roots the pre-flight
      // CONFIRMED travel with the verdict (`verificationRoots`) and go into the
      // executor call unchanged. `trash()` then verifies each bound root's
      // identity before anything destructive and judges the per-entry
      // re-validation against THESE roots — a root swapped between the two
      // calls is refused wholesale instead of silently re-judged under its new
      // identity. `undefined` for ports without `preflight` (legacy fakes) or
      // verdicts without the field → previous executor behaviour.
      let boundVerificationRoots: readonly string[] | undefined;
      if (preflight !== undefined) {
        const verdict = await preflight(eligible, removalRoots);
        if (verdict.kind === 'refused') {
          return {
            action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
            reason: verdict.reason,
            message: `本地文件清理失败：${verdict.reason}；任务记录已保留`,
            failedCount: verdict.refusedCount,
          };
        }
        preflightMissing = verdict.missingPaths;
        boundVerificationRoots = verdict.verificationRoots;
        if (verdict.missingPaths.length > 0) {
          const gone = new Set(verdict.missingPaths);
          trashTargets = eligible.filter((path) => !gone.has(path));
        }
      }
      // D-207 backstop: the pre-flight-bound trusted roots go into the
      // executor call, so `trash()` re-validates every entry's realpath
      // immediately before `trashItem` (the pre-flight→trash swap-in window).
      const outcomes = normalizeTrashOutcomes(
        await deps.trashFiles.trash(trashTargets, removalRoots, boundVerificationRoots),
      );
      // A D-87 adapter replies with only the paths it handled. A short reply is
      // a partial failure and must keep the record (existing contract).
      if (outcomes.length < trashTargets.length) {
        return {
          action: 'remove', ok: false, code: 'ERROR', failureKind: 'file-cleanup',
          message: `本地文件未全部移入回收站（${outcomes.length}/${trashTargets.length}），记录已保留`,
        };
      }
      const failed = outcomes.filter((entry) => entry.status === 'error');
      if (failed.length > 0) {
        // Real filesystem failure: keep the record, report the real reason,
        // and never mark the operation as successful.
        return {
          action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
          reason: failed[0]?.reason ?? '未知错误',
          message: `本地文件清理失败：${failed[0]?.reason ?? '未知错误'}；任务记录已保留`,
          failedCount: failed.length,
        };
      }
      // D-207: `filesMissing` is honest about BOTH sources — entries the
      // pre-flight proved gone (never handed to the trash call) and entries
      // the adapter itself reported missing.
      const filesMissing = preflightMissing.length
        + outcomes.filter((entry) => entry.status === 'missing').length;
      const filesTrashed = outcomes.filter((entry) => entry.status === 'trashed').length;
      deps.fileStatus?.forget(taskId);
      const removal = await deps.taskDetail.perform(taskId, 'remove');
      if (removal.ok === true) deps.thumbnails?.forget?.(taskId);
      return { ...removal, filesMissing, filesTrashed, sharedSkipped };
    }

    const result = await deps.taskDetail.perform(taskId, action as TaskDetailAction);
    // D-103: dropping a task record drops its claim on the cover. The file is
    // NOT deleted here — the prune pass checks whether another live task shares
    // it, then moves it to the recycle bin.
    if (action === 'remove') {
      if (result.ok === true) {
        deps.thumbnails?.forget?.(taskId);
        deps.fileStatus?.forget(taskId);
      }
    } else if (isOpenAction && observed !== undefined) {
      // Let the renderer say "文件已不存在，已为你打开原保存文件夹" without
      // another IPC round trip.
      return { ...result, fileStatus: observed.status, dirStatus: observed.dirStatus };
    }
    return result;
  });

    handlers.set(IPC_CHANNELS.TEMPLATE_LIST, async (payload) => {
    validateM5Payload(IPC_CHANNELS.TEMPLATE_LIST, payload);
    await deps.templates.init();
    return { templates: deps.templates.list(), rejectedAtLoad: deps.templates.rejectedAtLoad };
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_SAVE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TEMPLATE_SAVE, payload);
    const input = assertTemplateInput(record);
    const id = record['id'];
    if (id === undefined) {
      return { created: true, template: await deps.templates.create(input) };
    }
    if (typeof id !== 'string' || id.length === 0) throw new Error('[m5-ipc] invalid template id');
    return { created: false, template: await deps.templates.update(id, input) };
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_DELETE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TEMPLATE_DELETE, payload);
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) throw new Error('[m5-ipc] invalid template id');
    return { removed: await deps.templates.remove(id) };
  });

    // D-103: cover-cache management. Every action is main-process owned; the
  // renderer cannot name a file, a directory or a deletion primitive.
  handlers.set(IPC_CHANNELS.THUMBNAIL_CACHE, async (payload): Promise<Record<string, unknown>> => {
    const record = validateM5Payload(IPC_CHANNELS.THUMBNAIL_CACHE, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !THUMBNAIL_CACHE_ACTIONS.includes(action)) {
      throw new Error('[m5-ipc] unknown thumbnail cache action');
    }
    const cache = deps.thumbnails;
    const unavailable = { ok: false, action, available: false, message: '封面缓存未启用' };
    if (cache === undefined) return unavailable;

    if (action === 'status') {
      if (cache.status === undefined) return unavailable;
      return { ok: true, action, available: true, status: await cache.status() };
    }
    if (action === 'prune') {
      if (cache.prune === undefined) return unavailable;
      // The button is an explicit user action: it works even when automatic
      // cleaning is switched off, but still never touches a live cover.
      return { ok: true, action, available: true, report: await cache.prune({ force: true }) };
    }
    if (action === 'set-auto') {
      const enabled = record['enabled'];
      if (typeof enabled !== 'boolean') throw new Error('[m5-ipc] enabled must be a boolean');
      if (cache.setAutoClean === undefined) return unavailable;
      return { ok: true, action, available: true, policy: await cache.setAutoClean(enabled) };
    }
    const maxBytes = record['maxBytes'];
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes)
      || maxBytes < 8 * 1024 * 1024 || maxBytes > 2 * 1024 * 1024 * 1024) {
      throw new Error('[m5-ipc] invalid maxBytes');
    }
    if (cache.setMaxBytes === undefined) return unavailable;
    return { ok: true, action, available: true, policy: await cache.setMaxBytes(maxBytes) };
  });

  return handlers;
}
