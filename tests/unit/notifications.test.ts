/**
 * M4-6 · notifications + tray + Electron adapter (four kinds, throttling, dedupe).
 */
import { describe, it, expect } from 'vitest';
import { NotificationCenter } from '@ytvdlt/core';
import type { DesktopNotification, TaskEvent } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import {
  ElectronNotificationAdapter, type NotificationLike,
} from '../../apps/desktop/src/main/notifications.js';
import {
  buildTrayMenu, trayTooltip, shouldHideToTray, canQuit,
} from '../../apps/desktop/src/main/tray.js';

const setup = () => {
  const mem = createInMemoryPorts();
  const center = new NotificationCenter({
    ports: mem.ports,
    progressStepPercent: 10,
    progressIntervalMs: 5000,
  });
  const advance = (ms: number): void => { mem.state.nowEpochMs += ms; };
  return { mem, center, advance };
};

const progress = (percent: number, taskId = 't1'): TaskEvent => ({
  type: 'progress', taskId, percent, downloadedBytes: 1, totalBytes: 2,
  speedBps: 1, etaSec: 1, rawLine: 'x',
});

describe('M4-6 · four notification kinds', () => {
  it('progress / completed / error / canceled each produce one notification', () => {
    const { center } = setup();
    expect(center.handle(progress(5))?.kind).toBe('progress');

    const done = center.handle({
      type: 'completed', taskId: 't1',
      artifacts: [{ taskId: 't1', path: 'C:/V/a.mp4', kind: 'video', sizeBytes: 1 }],
    });
    expect(done?.kind).toBe('completed');
    expect(done?.title).toBe('下载完成');
    expect(done?.urgency).toBe('normal');

    const failed = center.handle({
      type: 'failed', taskId: 't2',
      error: { code: 'HTTP_403', message: 'no', detail: '', retryable: false, report: 'x' },
    });
    expect(failed?.kind).toBe('error');
    expect(failed?.urgency).toBe('critical');
    expect(failed?.body).toContain('HTTP_403');

    const canceled = center.handle({ type: 'canceled', taskId: 't3' });
    expect(canceled?.kind).toBe('canceled');
    expect(center.history()).toHaveLength(4);
  });

  it('progress is throttled by percent step OR time window', () => {
    const { center, advance } = setup();
    expect(center.handle(progress(1))).not.toBeNull();
    expect(center.handle(progress(5))).toBeNull();       // < 10% and < 5s
    expect(center.handle(progress(11))).not.toBeNull();  // >= 10%
    expect(center.handle(progress(12))).toBeNull();
    advance(5000);
    expect(center.handle(progress(13))).not.toBeNull();  // time window elapsed
  });

  it('percent=null and state-changed events never notify', () => {
    const { center } = setup();
    expect(center.handle({ ...progress(30), percent: null } as TaskEvent)).toBeNull();
    expect(center.handle({ type: 'state-changed', taskId: 't1', from: 'Running', to: 'Completed' })).toBeNull();
  });

  it('terminal notifications are deduped per task', () => {
    const { center } = setup();
    const first = center.handle({ type: 'canceled', taskId: 't1' });
    expect(first).not.toBeNull();
    expect(center.handle({ type: 'canceled', taskId: 't1' })).toBeNull();
    // After "delete" the task id may be reused.
    center.forget('t1');
    expect(center.handle({ type: 'canceled', taskId: 't1' })).not.toBeNull();
  });

  it('keeps the history bounded', () => {
    const mem = createInMemoryPorts();
    const center = new NotificationCenter({ ports: mem.ports, historyLimit: 10, progressStepPercent: 1, progressIntervalMs: 0 });
    for (let i = 0; i < 40; i += 1) center.handle(progress(i + 1, `t${i}`));
    expect(center.history()).toHaveLength(10);
  });
});

describe('M4-6 · Electron notification adapter', () => {
  it('forwards title/body/silent/urgency and click events', () => {
    const shown: Array<{ title: string; body: string; silent: boolean; urgency: string }> = [];
    const clicks: string[] = [];
    class FakeNotification implements NotificationLike {
      private listener: (() => void) | null = null;
      constructor(private readonly options: { title: string; body: string; silent: boolean; urgency: 'low' | 'normal' | 'critical' }) {
        shown.push(options);
      }
      show(): void { this.listener?.(); }
      on(_event: 'click', listener: () => void): void { this.listener = listener; }
    }
    const adapter = new ElectronNotificationAdapter({
      Notification: FakeNotification,
      onClick: (n: DesktopNotification) => clicks.push(n.taskId),
    });
    const notification: DesktopNotification = {
      id: 'n1', kind: 'completed', taskId: 't1', title: '下载完成', body: 't1',
      titleKey: 'notification.completed.title', bodyKey: 'notification.completed.body',
      silent: false, urgency: 'normal', createdAt: 'now',
    };
    expect(adapter.show(notification)).toBe(true);
    expect(shown[0]).toMatchObject({ title: '下载完成', silent: false, urgency: 'normal' });
    expect(clicks).toEqual(['t1']);
  });

  it('is a safe no-op when Electron is absent (D-39)', () => {
    const adapter = new ElectronNotificationAdapter({ Notification: null });
    const notification: DesktopNotification = {
      id: 'n1', kind: 'error', taskId: 't1', title: 'x', body: 'y',
      titleKey: 'k', bodyKey: 'k', silent: false, urgency: 'critical', createdAt: 'now',
    };
    expect(adapter.show(notification)).toBe(false);
    expect(adapter.stats()).toEqual({ shown: 0, skipped: 1 });
  });
});

describe('M4-6 · tray model', () => {
  it('builds a menu whose cancel entry reflects the queue', () => {
    const idle = buildTrayMenu({ active: 0, pending: 0, completed: 0, failed: 0 });
    expect(idle.map((item) => item.id)).toEqual([
      'show', 'new-download', 'separator', 'cancel-all', 'open-folder', 'separator', 'quit',
    ]);
    expect(idle.find((item) => item.id === 'cancel-all')?.enabled).toBe(false);

    const busy = buildTrayMenu({ active: 2, pending: 3, completed: 5, failed: 1 });
    const cancel = busy.find((item) => item.id === 'cancel-all');
    expect(cancel?.enabled).toBe(true);
    expect(cancel?.label).toContain('5');
  });

  it('tooltip and quit policy follow the queue state', () => {
    expect(trayTooltip({ active: 0, pending: 0, completed: 1, failed: 0 })).toBe('YTVDLT · 空闲');
    expect(trayTooltip({ active: 2, pending: 3, completed: 0, failed: 0 })).toBe('YTVDLT · 运行 2 · 排队 3');
    expect(canQuit({ active: 0, pending: 4, completed: 0, failed: 0 })).toBe(true);
    expect(canQuit({ active: 1, pending: 0, completed: 0, failed: 0 })).toBe(false);
  });

  it('close/minimize hide to tray only when the setting is on', () => {
    expect(shouldHideToTray({ action: 'close', minimizeToTray: true, active: 1 })).toBe(true);
    expect(shouldHideToTray({ action: 'minimize', minimizeToTray: true, active: 0 })).toBe(true);
    expect(shouldHideToTray({ action: 'close', minimizeToTray: false, active: 1 })).toBe(false);
    expect(shouldHideToTray({ action: 'minimize', minimizeToTray: false, active: 1 })).toBe(false);
  });
});
