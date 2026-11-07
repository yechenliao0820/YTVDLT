/**
 * NotificationCenter (M4-6) — maps queue events to desktop notifications.
 *
 * Four kinds are required by the acceptance: progress / completed / error /
 * canceled. Progress is throttled twice (percent step OR time window) so a
 * 40-minute download cannot spam hundreds of toasts; terminal notifications are
 * never throttled and never dropped.
 *
 * The center is pure: it returns `DesktopNotification` values; the Electron
 * adapter (`apps/desktop/src/main/notifications.ts`) decides how to show them.
 */
import type { CorePorts, TaskEvent } from '@ytvdlt/shared';

export type NotificationKind = 'progress' | 'completed' | 'error' | 'canceled';

export interface DesktopNotification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly taskId: string;
  readonly title: string;
  readonly body: string;
  /** i18n keys (M5 resolves them; M4 ships zh text alongside). */
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly silent: boolean;
  readonly urgency: 'low' | 'normal' | 'critical';
  readonly createdAt: string;
}

export interface NotificationCenterDeps {
  ports: CorePorts;
  /** Minimum percent delta between two progress toasts. Defaults to 10. */
  progressStepPercent?: number;
  /** Minimum wall-clock gap between two progress toasts. Defaults to 5000 ms. */
  progressIntervalMs?: number;
  /** Cap on retained history. Defaults to 200. */
  historyLimit?: number;
}

interface ProgressMark {
  percent: number;
  at: number;
}

const TITLE_KEYS: Readonly<Record<NotificationKind, string>> = {
  progress: 'notification.progress.title',
  completed: 'notification.completed.title',
  error: 'notification.error.title',
  canceled: 'notification.canceled.title',
};

const BODY_KEYS: Readonly<Record<NotificationKind, string>> = {
  progress: 'notification.progress.body',
  completed: 'notification.completed.body',
  error: 'notification.error.body',
  canceled: 'notification.canceled.body',
};

export class NotificationCenter {
  private readonly ports: CorePorts;
  private readonly step: number;
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly marks = new Map<string, ProgressMark>();
  private readonly seen = new Set<string>();
  private readonly items: DesktopNotification[] = [];
  private sequence = 0;

  constructor(deps: NotificationCenterDeps) {
    this.ports = deps.ports;
    this.step = Math.max(1, deps.progressStepPercent ?? 10);
    this.intervalMs = Math.max(0, deps.progressIntervalMs ?? 5000);
    this.limit = Math.max(10, deps.historyLimit ?? 200);
  }

  /**
   * Feed one queue event. Returns the notification to show, or `null` when the
   * event is a duplicate / throttled progress tick.
   */
  handle(event: TaskEvent): DesktopNotification | null {
    if (event.type === 'progress') {
      if (event.percent === null) return null;
      return this.progress(event.taskId, event.percent);
    }
    if (event.type === 'completed') return this.terminal('completed', event.taskId, event.artifacts.length);
    if (event.type === 'failed') return this.terminal('error', event.taskId, event.error.code);
    if (event.type === 'canceled') return this.terminal('canceled', event.taskId);
    return null;
  }

  private throttled(taskId: string, percent: number, now: number): boolean {
    const mark = this.marks.get(taskId);
    if (mark === undefined) return false;
    const stepOk = percent >= 100 ? mark.percent < 100 : percent - mark.percent >= this.step;
    const timeOk = now - mark.at >= this.intervalMs;
    return !(stepOk || timeOk);
  }

  private progress(taskId: string, percent: number): DesktopNotification | null {
    const now = this.ports.clock.nowEpochMs();
    if (this.throttled(taskId, percent, now)) return null;
    this.marks.set(taskId, { percent, at: now });
    return this.push({
      kind: 'progress', taskId,
      title: `正在下载 ${Math.round(percent)}%`,
      body: taskId,
    });
  }

  /** Terminal notifications fire exactly once per (task, kind). */
  private terminal(
    kind: Exclude<NotificationKind, 'progress'>,
    taskId: string,
    detail?: number | string,
  ): DesktopNotification | null {
    const dedupeKey = `${kind}:${taskId}`;
    if (this.seen.has(dedupeKey)) return null;
    this.seen.add(dedupeKey);
    this.marks.delete(taskId);
    const body = kind === 'completed'
      ? `${taskId} · ${String(detail ?? 0)} 个产物`
      : kind === 'error' ? `${taskId} · ${String(detail ?? 'UNKNOWN')}` : taskId;
    return this.push({
      kind, taskId,
      title: kind === 'completed' ? '下载完成' : kind === 'error' ? '下载失败' : '已取消',
      body,
    });
  }

  private push(input: {
    kind: NotificationKind;
    taskId: string;
    title: string;
    body: string;
  }): DesktopNotification {
    this.sequence += 1;
    const notification: DesktopNotification = {
      id: `n-${this.ports.clock.nowEpochMs()}-${this.sequence}`,
      kind: input.kind,
      taskId: input.taskId,
      title: input.title,
      body: input.body,
      titleKey: TITLE_KEYS[input.kind],
      bodyKey: BODY_KEYS[input.kind],
      silent: input.kind === 'progress',
      urgency: input.kind === 'error' ? 'critical' : input.kind === 'progress' ? 'low' : 'normal',
      createdAt: this.ports.clock.nowIso(),
    };
    this.items.push(notification);
    while (this.items.length > this.limit) this.items.shift();
    return notification;
  }

  /** Newest-last snapshot of everything shown in this session. */
  history(): readonly DesktopNotification[] {
    return [...this.items];
  }

  /** Forget a task (called after "delete"). */
  forget(taskId: string): void {
    this.marks.delete(taskId);
    for (const kind of ['completed', 'error', 'canceled']) this.seen.delete(`${kind}:${taskId}`);
  }
}
