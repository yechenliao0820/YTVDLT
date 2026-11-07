/**
 * TaskDetailService (M4-6) — the seven per-task operations.
 *
 *   open-file | open-folder | copy-url | copy-error-report | cancel | remove | retry
 *
 * Everything is injected (`ITaskQueue`, `IShellPort`, clipboard, report builder),
 * so the service is L0-testable and the Electron layer only wires real objects.
 * "open" refuses a missing artifact instead of asking the OS to fail: the user
 * gets a precise reason (`FILE_MISSING`).
 */
import type { CorePorts, IShellPort, TaskRecord } from '@ytvdlt/shared';
import type { ITaskQueue } from '../ports.js';
import type { ErrorReport } from '../error-report/error-report.js';
import { maskUrlSecrets } from '../error-report/error-report.js';

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
}

export interface ClipboardPort {
  writeText(text: string): Promise<void>;
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
    const target = task.artifacts[0];
    if (target === undefined) return this.result(action, false, 'NO_ARTIFACT', '任务没有产物路径');
    if (!(await this.deps.ports.fs.exists(target))) {
      return this.result(action, false, 'FILE_MISSING', `产物不存在: ${target}`);
    }
    const shell = this.deps.shell;
    if (shell === undefined) return this.result(action, false, 'SHELL_UNAVAILABLE', '当前环境未注入 shell 端口');
    try {
      if (action === 'open-file') await shell.openPath(target);
      else await shell.showItemInFolder(target);
      return this.result(action, true, 'OK', target);
    } catch (error) {
      return this.result(action, false, 'ERROR', String(error));
    }
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
      : this.result('cancel', false, 'REFUSED', `状态 ${task.state} 不可取消`);
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
