/**
 * TaskDetailService (M4-6) — the seven per-task operations.
 *
 *   open-file | open-folder | copy-url | copy-error-report | cancel | remove | retry
 *
 * Everything is injected (`ITaskQueue`, `IShellPort`, clipboard, report builder),
 * so the service is L0-testable and the Electron layer only wires real objects.
 * "open" refuses a missing artifact instead of asking the OS to fail: the user
 * gets a precise reason (`FILE_MISSING`).
 *
 * D-204: "open" is FAIL-CLOSED — a record without a usable download request
 * is refused outright (no verdict, no open), and when the fs port provides
 * `realpath` the FINAL target is resolved through every symlink / NTFS
 * junction and containment is re-checked on the real path before anything
 * reaches the shell.
 */
import type { CorePorts, IShellPort, TaskRecord } from '@ytvdlt/shared';
import type { ITaskQueue } from '../ports.js';
import type { ErrorReport } from '../error-report/error-report.js';
import { maskUrlSecrets } from '../error-report/error-report.js';
import { primaryMediaArtifact } from '../artifact-classify/kinds.js';
import {
  canonicalContainmentRoots,
  isPathInsideRoots,
  normalizedForContainment,
  trustedArtifactRoots,
} from '../path-resolver/containment.js';

export type TaskDetailAction =
  | 'open-file'
  | 'open-folder'
  | 'copy-url'
  | 'copy-error-report'
  | 'cancel'
  | 'remove'
  | 'retry';

export const TASK_DETAIL_ACTIONS: readonly TaskDetailAction[] = [
  'open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry',
];

export type TaskDetailCode =
  | 'OK'
  | 'TASK_MISSING'
  | 'FILE_MISSING'
  | 'FOLDER_MISSING'
  | 'NO_ARTIFACT'
  | 'SHELL_UNAVAILABLE'
  | 'CLIPBOARD_UNAVAILABLE'
  | 'NO_ERROR'
  | 'REFUSED'
  | 'ERROR';

export interface TaskDetailResult {
  readonly action: TaskDetailAction;
  readonly ok: boolean;
  readonly code: TaskDetailCode;
  readonly message: string;
  readonly clipboardText?: string;
  /** D-120: `open-folder` succeeded by opening the DIRECTORY, not the file. */
  readonly fileMissing?: boolean;
}

/**
 * Pure string parent — `core` must never import `node:path` (layering gate).
 * Handles Windows drive letters, UNC and POSIX roots alike.
 */
export function parentDirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '';
  return index === 0 ? '/' : normalized.slice(0, index);
}

export interface ClipboardPort {
  writeText(text: string): Promise<void>;
}

/**
 * D-204: outcome of the realpath containment re-check (see
 * `TaskDetailService.resolveRealPath`). Module-private on purpose — it is an
 * internal verdict type, not part of the public result DTO. `real` carries
 * the resolved path so the directory branch can apply its inside-or-equal
 * rule (see `pathEqualsAnyRoot`).
 */
type RealpathVerdict =
  | { readonly kind: 'ok'; readonly real: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * D-204: true when the resolved path IS one of the trusted roots (normalized
 * equality). The strict-inside predicate excludes the root itself, which is
 * correct for FILES but would refuse the legitimate D-120 folder fallback
 * when the file lived directly in `videoDir` (then the directory to open IS
 * the root). The fallback directory may be a root; anything that resolves
 * outside every root is still refused.
 */
function pathEqualsAnyRoot(candidate: string, roots: readonly string[]): boolean {
  const normalized = normalizedForContainment(candidate);
  if (normalized === null) return false;
  return roots.some((root) => normalizedForContainment(root) === normalized);
}

export interface TaskDetailDeps {
  readonly ports: CorePorts;
  readonly queue: ITaskQueue;
  readonly shell?: IShellPort;
  readonly clipboard?: ClipboardPort;
  /** Injected so the service never hard-codes versions or a redactor. */
  readonly buildReport: (task: TaskRecord) => ErrorReport;
  readonly formatReport: (report: ErrorReport) => string;
}

export class TaskDetailService {
  private readonly deps: TaskDetailDeps;

  constructor(deps: TaskDetailDeps) {
    this.deps = deps;
  }

  async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
    const task = this.deps.queue.get(taskId);
    if (task === undefined) {
      return this.result(action, false, 'TASK_MISSING', `unknown task: ${taskId}`);
    }
    switch (action) {
      case 'open-file': return this.open(task, 'open-file');
      case 'open-folder': return this.open(task, 'open-folder');
      case 'copy-url': return this.copyUrl(task);
      case 'copy-error-report': return this.copyReport(task);
      case 'cancel': return this.cancel(task);
      case 'remove': return this.remove(task);
      case 'retry': return this.retry(task);
      default: return this.result(action, false, 'REFUSED', `unsupported action: ${String(action)}`);
    }
  }

  private result(
    action: TaskDetailAction,
    ok: boolean,
    code: TaskDetailCode,
    message: string,
    clipboardText?: string,
  ): TaskDetailResult {
    return clipboardText === undefined
      ? { action, ok, code, message }
      : { action, ok, code, message, clipboardText };
  }

  private async open(task: TaskRecord, action: 'open-file' | 'open-folder'): Promise<TaskDetailResult> {
    // Stage 4: "the file" is the media, not whatever the manifest listed first.
    // With `--write-thumbnail` / `--write-subs`, `artifacts[0]` is routinely a
    // `.jpg` or a `.srt`, and "打开文件" then launched a text editor.
    const target = primaryMediaArtifact(task.artifacts) ?? task.artifacts[0];
    if (target === undefined) return this.result(action, false, 'NO_ARTIFACT', '任务没有产物路径');
    // D-182 + D-204: a record may only open what it downloaded. The gate
    // re-derives the roots from the record's OWN request and refuses anything
    // outside them — defence in depth behind the intake gate, covering records
    // restored from a snapshot. D-204 closes the LAST fail-open: a record
    // without a usable request (request === null, a structurally damaged
    // snapshot, no decidable root) cannot be judged at all, so it is REFUSED
    // instead of opening whatever path the record happens to carry. A real
    // download never produces a request-less record; such legacy records keep
    // every other action, they only lose "open".
    const roots = trustedArtifactRoots(task.request?.paths ?? {});
    if (roots === null) {
      return this.result(action, false, 'REFUSED', '无法验证产物路径归属（任务缺少可用的下载请求信息），已拒绝打开');
    }
    if (!isPathInsideRoots(target, roots)) {
      return this.result(action, false, 'REFUSED', '产物路径超出任务输出目录，已拒绝打开');
    }
    const shell = this.deps.shell;
    if (shell === undefined) return this.result(action, false, 'SHELL_UNAVAILABLE', '当前环境未注入 shell 端口');
    const fsPort = this.deps.ports.fs;
    // D-204: the string gate above compares NAMES, and on Windows a symlink /
    // NTFS junction can make a path that sits INSIDE the trusted roots on the
    // string level resolve to anywhere (`C:/Videos/link.mp4 →
    // C:/Windows/System32`). When the fs port provides `realpath`, resolve
    // the FINAL target we are about to hand to the shell and re-run
    // containment on the REAL path. Opening is a read action that FOLLOWS the
    // user's intent, so the policy is "the resolution must still be inside
    // the trusted roots" — the link itself is opened when its target is
    // contained. That deliberately differs from the DESTRUCTIVE path's link
    // policy (deletion refuses the link itself; opening follows it and
    // verifies the destination).
    const realpath = typeof fsPort.realpath === 'function' ? fsPort.realpath.bind(fsPort) : null;
    if (realpath === null) {
      // Production node-ports 恒提供 realpath；缺席仅存在于（旧的）测试假
      // 对象，安全强度随之下降 —— 此处只按上面的字符串门放行并跳过真实路径
      // 校验（无法抵御符号链接 / junction 逃逸）。
      return this.openWithStringGateOnly(action, target, shell);
    }
    if (action === 'open-file') {
      const verdict = await this.resolveRealPath(realpath, target, roots);
      if (verdict.kind === 'refused') return this.result(action, false, 'REFUSED', verdict.message);
      // ENOENT / ENOTDIR is the artifact-missing flow, not a security refusal.
      if (verdict.kind === 'missing') {
        return this.result(action, false, 'FILE_MISSING', `产物不存在: ${target}`);
      }
      // Resolved and contained → open the user-visible path (follow intent).
      try {
        await shell.openPath(target);
        return this.result(action, true, 'OK', target);
      } catch (error) {
        return this.result(action, false, 'ERROR', String(error));
      }
    }
    // ---- open-folder ----
    // The FINAL target is the FILE while it exists (reveal) and the DIRECTORY
    // once the file is gone (D-120 fallback). Both get the realpath
    // re-check before anything reaches the shell.
    const fileVerdict = await this.resolveRealPath(realpath, target, roots);
    if (fileVerdict.kind === 'refused') return this.result(action, false, 'REFUSED', fileVerdict.message);
    if (fileVerdict.kind === 'ok') {
      // File present → reveal the FILE (unchanged D-120 behaviour).
      try {
        await shell.showItemInFolder(target);
        return this.result(action, true, 'OK', target);
      } catch (error) {
        return this.result(action, false, 'ERROR', String(error));
      }
    }
    // A download that succeeded once is still a valid record. The USER may
    // have moved/deleted the file externally; that must not stop them from
    // opening the folder it used to live in.
    const dir = parentDirOf(target);
    if (dir === '') return this.result(action, false, 'FOLDER_MISSING', `原下载目录不存在: ${dir}`);
    // The fallback directory may BE one of the trusted roots (the common
    // D-120 case: the file lived directly in `videoDir` and is now gone),
    // and the strict-inside predicate excludes the root itself — accept
    // "inside or equal", refuse only when the resolution lands outside
    // every root.
    const dirVerdict = await this.resolveRealPath(realpath, dir, roots, { allowRootItself: true });
    if (dirVerdict.kind === 'refused') return this.result(action, false, 'REFUSED', dirVerdict.message);
    if (dirVerdict.kind === 'missing') {
      return this.result(action, false, 'FOLDER_MISSING', `原下载目录不存在: ${dir}`);
    }
    try {
      await shell.openPath(dir);
      return { action, ok: true, code: 'OK', message: dir, fileMissing: true };
    } catch (error) {
      return this.result(action, false, 'ERROR', String(error));
    }
  }

  /**
   * D-204: the pre-realpath flow, kept verbatim for fs ports WITHOUT
   * `realpath`. Production node-ports 恒提供 realpath；缺席仅存在于（旧的）
   * 测试假对象，安全强度随之下降 —— this path only enforces the string gate,
   * so a symlink / junction escape (string-inside, real-outside) is NOT
   * caught here.
   */
  private async openWithStringGateOnly(
    action: 'open-file' | 'open-folder',
    target: string,
    shell: IShellPort,
  ): Promise<TaskDetailResult> {
    const present = await this.deps.ports.fs.exists(target);
    if (!present) {
      // A download that succeeded once is still a valid record. The USER may
      // have moved/deleted the file externally; that must not stop them from
      // opening the folder it used to live in. Only `open-folder` gets this
      // fallback — `open-file` has nothing to open and stays a clean refusal.
      if (action === 'open-file') return this.result(action, false, 'FILE_MISSING', `产物不存在: ${target}`);
      const dir = parentDirOf(target);
      if (dir === '' || !(await this.deps.ports.fs.exists(dir))) {
        return this.result(action, false, 'FOLDER_MISSING', `原下载目录不存在: ${dir}`);
      }
      try {
        await shell.openPath(dir);
        return { action, ok: true, code: 'OK', message: dir, fileMissing: true };
      } catch (error) {
        return this.result(action, false, 'ERROR', String(error));
      }
    }
    try {
      if (action === 'open-file') await shell.openPath(target);
      else await shell.showItemInFolder(target);
      return this.result(action, true, 'OK', target);
    } catch (error) {
      return this.result(action, false, 'ERROR', String(error));
    }
  }

  /**
   * D-204: verdict of the realpath containment re-check.
   *   - `ok`      — the real path resolved and stays inside the trusted
   *                 roots;
   *   - `missing` — ENOENT / ENOTDIR: the artifact is simply GONE. This is
   *                 NOT a security verdict and must flow into the established
   *                 artifact-missing handling (open-file → FILE_MISSING,
   *                 open-folder → directory fallback), never be swallowed as
   *                 a refusal;
   *   - `refused` — fail-closed: either the resolution landed OUTSIDE the
   *                 roots (symlink / junction escape) or it could not be
   *                 obtained at all (EACCES / EPERM / link loop / ...). A
   *                 path we cannot prove safe is a path we do not open; the
   *                 message carries the real cause.
   *
   * `allowRootItself` widens "inside" to "inside OR equal to a root" — used
   * ONLY by the D-120 folder fallback, where the directory to open may be
   * the trusted root itself (file lived directly in `videoDir`). FILES never
   * set it: a "file" that resolves onto the output root is pathological.
   */
  private async resolveRealPath(
    realpath: (path: string) => Promise<string>,
    path: string,
    roots: readonly string[],
    opts?: { readonly allowRootItself?: boolean },
  ): Promise<RealpathVerdict> {
    let real: string;
    try {
      real = await realpath(path);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      const detail = error instanceof Error ? error.message : String(error);
      const reason = code !== undefined && !detail.includes(code) ? `${code}: ${detail}` : detail;
      return {
        kind: 'refused',
        message: `无法解析产物真实路径（${reason}），无法证明路径安全，已拒绝打开`,
      };
    }
    // D-208: the verdict compares a realpath RESOLUTION against the roots —
    // include the roots' canonical (realpath) aliases so an 8.3 short-name /
    // reparse-point root form (`RUNNER~1` vs `runneradmin`) does not refuse a
    // legitimate file. The alias is the SAME trusted directory, not a
    // widening of trust.
    const verificationRoots = await canonicalContainmentRoots(roots, realpath);
    const contained = isPathInsideRoots(real, verificationRoots)
      || (opts?.allowRootItself === true && pathEqualsAnyRoot(real, verificationRoots));
    if (!contained) {
      return {
        kind: 'refused',
        message: '产物真实路径指向任务输出目录之外（符号链接/联接），已拒绝打开',
      };
    }
    return { kind: 'ok', real };
  }

  private async copyUrl(task: TaskRecord): Promise<TaskDetailResult> {
    const clipboard = this.deps.clipboard;
    if (clipboard === undefined) return this.result('copy-url', false, 'CLIPBOARD_UNAVAILABLE', '未注入剪贴板');
    const text = maskUrlSecrets(task.url);
    await clipboard.writeText(text);
    return this.result('copy-url', true, 'OK', text, text);
  }

  private async copyReport(task: TaskRecord): Promise<TaskDetailResult> {
    const clipboard = this.deps.clipboard;
    if (clipboard === undefined) return this.result('copy-error-report', false, 'CLIPBOARD_UNAVAILABLE', '未注入剪贴板');
    if (task.error === null) return this.result('copy-error-report', false, 'NO_ERROR', '任务没有错误信息');
    const text = this.deps.formatReport(this.deps.buildReport(task));
    await clipboard.writeText(text);
    return this.result('copy-error-report', true, 'OK', `${text.length} chars`, text);
  }

  private async cancel(task: TaskRecord): Promise<TaskDetailResult> {
    const canceled = await this.deps.queue.cancel(task.id);
    return canceled
      ? this.result('cancel', true, 'OK', '已取消')
      // D-142: `false` now means "the process was not confirmed terminated" —
      // the tree kill failed, or the task is mid-probe and has no handle yet.
      // It is not a state refusal, so the message must not claim one.
      : this.result('cancel', false, 'REFUSED', '取消失败：进程未终止，可稍后再次尝试取消');
  }

  private async remove(task: TaskRecord): Promise<TaskDetailResult> {
    const removed = await this.deps.queue.remove(task.id);
    return removed
      ? this.result('remove', true, 'OK', '已删除')
      : this.result('remove', false, 'REFUSED', '运行中的任务不可删除');
  }

  private async retry(task: TaskRecord): Promise<TaskDetailResult> {
    try {
      await this.deps.queue.restart(task.id);
      return this.result('retry', true, 'OK', '已重新入队');
    } catch (error) {
      return this.result('retry', false, 'REFUSED', String(error));
    }
  }
}
