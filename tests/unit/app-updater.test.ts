/**
 * M5-5 · app update coordinator (D-62, §4.2).
 *
 * The contract is the failure policy, not the happy path:
 *   - no feed configured → `degraded`, zero network calls;
 *   - available → configure → check → download → quitAndInstall, in that order;
 *   - anything throws → `degraded`, app untouched, user told AT MOST ONCE;
 *   - `{channel}` in the feed URL is resolved from `advanced.updateChannel`.
 */
import { describe, it, expect } from 'vitest';
import {
  AppUpdateCoordinator, isUpdateDue, resolveFeedUrl,
} from '../../apps/desktop/src/main/app-updater.js';
import type {
  AppUpdateOutcome, UpdateAvailability, UpdateFeed, UpdaterPort,
} from '@ytvdlt/shared';
import type { IConfigStore, ILogger, LogEvent } from '@ytvdlt/core';

class FakeConfig implements IConfigStore {
  readonly schemaVersion = 1;
  private readonly data = new Map<string, unknown>();
  get<T>(domain: string, key: string): T {
    return this.data.get(`${domain}.${key}`) as T;
  }
  async set<T>(domain: string, key: string, value: T): Promise<void> {
    this.data.set(`${domain}.${key}`, value);
  }
  getDomain(): Readonly<Record<string, unknown>> { return {}; }
  async setDomain(): Promise<void> { /* unused */ }
  async export(): Promise<string> { return '{}'; }
  async import(): Promise<void> { /* unused */ }
}

class FakeLogger implements ILogger {
  readonly events: LogEvent[] = [];
  async log(event: LogEvent): Promise<void> { this.events.push(event); }
  async info(scope: string, event: string, payload?: Record<string, unknown>): Promise<void> {
    this.events.push({ level: 'INFO', scope, event, ...(payload === undefined ? {} : { payload }) });
  }
  async warn(scope: string, event: string): Promise<void> {
    this.events.push({ level: 'WARNING', scope, event });
  }
  async error(scope: string, event: string): Promise<void> {
    this.events.push({ level: 'ERROR', scope, event });
  }
  async logArgv(): Promise<void> { /* unused */ }
  async writeCrashReport(): Promise<string> { return 'crash.json'; }
  async exportLogs(): Promise<string> { return ''; }
  has(needle: string): boolean {
    return this.events.some((event) => `${event.scope} ${event.event}`.includes(needle));
  }
}

interface FakeUpdater extends UpdaterPort {
  readonly calls: string[];
  readonly configured: UpdateFeed[];
}

function fakeUpdater(
  behaviour: { availability?: UpdateAvailability; failCheck?: boolean; failDownload?: boolean } = {},
): FakeUpdater {
  const calls: string[] = [];
  const configured: UpdateFeed[] = [];
  return {
    calls,
    configured,
    async configure(feed: UpdateFeed) { calls.push('configure'); configured.push(feed); },
    async checkForUpdates() {
      calls.push('check');
      if (behaviour.failCheck === true) throw new Error('ENOTFOUND update.example.org');
      return behaviour.availability ?? { available: false, version: '0.1.0' };
    },
    async downloadUpdate() {
      calls.push('download');
      if (behaviour.failDownload === true) throw new Error('ECONNRESET');
    },
    quitAndInstall() { calls.push('install'); },
  };
}

function build(behaviour: Parameters<typeof fakeUpdater>[0] = {}, config: Record<string, unknown> = {}) {
  const store = new FakeConfig();
  for (const [key, value] of Object.entries(config)) {
    void store.set('advanced', key, value);
  }
  const logger = new FakeLogger();
  const updater = fakeUpdater(behaviour);
  const notifications: string[] = [];
  const coordinator = new AppUpdateCoordinator({
    updater,
    config: store,
    logger,
    notifyOnce: (message: string) => { notifications.push(message); },
  });
  return { coordinator, updater, logger, notifications };
}

describe('M5-5 · app update · feed configuration', () => {
  it('skips entirely when no feed is configured (no network call at all)', async () => {
    const { coordinator, updater, notifications } = build();
    const outcome = await coordinator.checkAndApply();
    expect(outcome.status).toBe('degraded');
    expect(outcome.notifiedOnce).toBe(false);
    expect(updater.calls).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it('rejects a non-http feed instead of handing it to electron-updater', async () => {
    const { coordinator, updater } = build({}, { updateFeedUrl: 'file:///C:/updates' });
    const outcome = await coordinator.checkAndApply();
    expect(outcome.status).toBe('degraded');
    expect(updater.calls).toEqual([]);
  });

  it('substitutes {channel} and defaults to the stable channel', async () => {
    const { coordinator, updater } = build({}, { updateFeedUrl: 'https://upd.example.org/{channel}' });
    await coordinator.checkAndApply();
    expect(updater.configured[0]).toEqual({ provider: 'generic', url: 'https://upd.example.org/stable' });
  });

  it('honours advanced.updateChannel = nightly', async () => {
    const { coordinator, updater } = build({}, {
      updateFeedUrl: 'https://upd.example.org/{channel}',
      updateChannel: 'nightly',
    });
    await coordinator.checkAndApply();
    expect(updater.configured[0]?.url).toBe('https://upd.example.org/nightly');
  });
});

describe('M5-5 · app update · outcomes', () => {
  it('reports up-to-date without downloading', async () => {
    const { coordinator, updater } = build({}, { updateFeedUrl: 'https://upd.example.org/feed' });
    const outcome = await coordinator.checkAndApply();
    expect(outcome.status).toBe('up-to-date');
    expect(updater.calls).toEqual(['configure', 'check']);
  });

  it('downloads and installs in order when an update exists', async () => {
    const { coordinator, updater, notifications } = build(
      { availability: { available: true, version: '0.2.0' } },
      { updateFeedUrl: 'https://upd.example.org/feed' },
    );
    const outcome = await coordinator.checkAndApply();
    expect(outcome).toMatchObject({ status: 'updated', notifiedOnce: true });
    expect(updater.calls).toEqual(['configure', 'check', 'download', 'install']);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('0.2.0');
  });
});

describe('M5-5 · app update · silent degradation', () => {
  it('stays on the current build when the check throws', async () => {
    const { coordinator, updater, logger } = build(
      { failCheck: true },
      { updateFeedUrl: 'https://upd.example.org/feed' },
    );
    const outcome = await coordinator.checkAndApply();
    expect(outcome.status).toBe('degraded');
    expect(outcome.reason).toContain('ENOTFOUND');
    expect(updater.calls).not.toContain('install');
    expect(logger.has('app-update')).toBe(true);
  });

  it('never installs when the download fails', async () => {
    const { coordinator, updater } = build(
      { availability: { available: true, version: '0.2.0' }, failDownload: true },
      { updateFeedUrl: 'https://upd.example.org/feed' },
    );
    const outcome = await coordinator.checkAndApply();
    expect(outcome.status).toBe('degraded');
    expect(updater.calls).not.toContain('install');
  });

  it('tells the user at most once, even across repeated failures', async () => {
    const { coordinator, notifications } = build(
      { failCheck: true },
      { updateFeedUrl: 'https://upd.example.org/feed' },
    );
    const first: AppUpdateOutcome = await coordinator.checkAndApply();
    const second = await coordinator.checkAndApply();
    expect(notifications).toHaveLength(1);
    expect(first.notifiedOnce).toBe(true);
    expect(second.notifiedOnce).toBe(false);
  });
});

describe('M5-5 · update interval (pure)', () => {
  it('is due when never checked, and never due when disabled', () => {
    expect(isUpdateDue('weekly', null, '2026-11-06T00:00:00.000Z')).toBe(true);
    expect(isUpdateDue('never', null, '2026-11-06T00:00:00.000Z')).toBe(false);
  });

  it('respects daily and weekly windows', () => {
    const now = '2026-11-06T00:00:00.000Z';
    expect(isUpdateDue('daily', '2026-11-05T00:00:00.000Z', now)).toBe(true);
    expect(isUpdateDue('daily', '2026-11-05T12:00:00.000Z', now)).toBe(false);
    expect(isUpdateDue('weekly', '2026-10-29T00:00:00.000Z', now)).toBe(true);
    expect(isUpdateDue('weekly', '2026-11-04T00:00:00.000Z', now)).toBe(false);
  });

  it('treats an unparsable timestamp as due (a broken clock must not freeze updates)', () => {
    expect(isUpdateDue('weekly', 'not-a-date', '2026-11-06T00:00:00.000Z')).toBe(true);
  });

  it('resolveFeedUrl only rewrites the placeholder', () => {
    expect(resolveFeedUrl('https://a.example/{channel}/x', 'nightly')).toBe('https://a.example/nightly/x');
    expect(resolveFeedUrl('https://a.example/feed', 'stable')).toBe('https://a.example/feed');
  });
});
