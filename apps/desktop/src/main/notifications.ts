/**
 * Electron notification adapter (M4-6).
 *
 * `Notification` is injected (a constructor), never imported: this module is
 * unit-testable and safe on a host without an Electron binary (D-39). The
 * adapter only translates `DesktopNotification` into the 4-field Electron API
 * and forwards clicks; throttling/dedupe already happened in core.
 */
import type { DesktopNotification } from '@ytvdlt/core';

export interface NotificationLike {
  show(): void;
  on(event: 'click', listener: () => void): void;
}

export interface NotificationCtor {
  new (options: {
    title: string;
    body: string;
    silent: boolean;
    urgency: 'low' | 'normal' | 'critical';
  }): NotificationLike;
}

export interface NotificationAdapterOptions {
  /** `null` on hosts without Electron: every call becomes a no-op. */
  Notification: NotificationCtor | null;
  onClick?: (notification: DesktopNotification) => void;
}

export class ElectronNotificationAdapter {
  private readonly ctor: NotificationCtor | null;
  private readonly onClick: ((notification: DesktopNotification) => void) | undefined;
  private shown = 0;
  private skipped = 0;

  constructor(options: NotificationAdapterOptions) {
    this.ctor = options.Notification;
    this.onClick = options.onClick;
  }

  show(notification: DesktopNotification): boolean {
    if (this.ctor === null) {
      this.skipped += 1;
      return false;
    }
    const instance = new this.ctor({
      title: notification.title,
      body: notification.body,
      silent: notification.silent,
      urgency: notification.urgency,
    });
    if (this.onClick !== undefined) {
      const handler = this.onClick;
      instance.on('click', () => handler(notification));
    }
    instance.show();
    this.shown += 1;
    return true;
  }

  showAll(notifications: readonly DesktopNotification[]): number {
    let count = 0;
    for (const notification of notifications) if (this.show(notification)) count += 1;
    return count;
  }

  stats(): { shown: number; skipped: number } {
    return { shown: this.shown, skipped: this.skipped };
  }
}
