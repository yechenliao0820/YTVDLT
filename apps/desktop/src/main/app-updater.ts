/**
 * AppUpdateCoordinator — the Electron build's own update path (M5-5, D-62).
 *
 * Wraps `electron-updater` behind `UpdaterPort` so nothing here imports it.
 * The whole point is the failure policy:
 *
 *   - no feed configured      → `degraded`, no network call at all;
 *   - nothing published       → `up-to-date`;
 *   - download/apply failed   → `degraded`, the running app is untouched;
 *   - the user is told ONCE   → `notifyOnce`, never a dialog loop.
 *
 * Updates are a background courtesy, not a feature: a broken update feed must
 * never block start-up, never throw into the IPC surface, and never show a
 * modal error box (`dialog.showErrorBox` is explicitly forbidden here).
 */
import type {
  AppUpdateOutcome, UpdateChannel, UpdateFeed, UpdaterPort,
} from '@ytvdlt/shared';
import type { IConfigStore, ILogger } from '@ytvdlt/core';

export interface AppUpdateCoordinatorDeps {
  readonly updater: UpdaterPort;
  readonly config: IConfigStore;
  readonly logger: ILogger;
  /** Non-blocking hint (tray balloon / toast). Called at most once. */
  readonly notifyOnce: (message: string) => void;
}

/** Where the update settings live. Absent or empty feed disables the check. */
export const UPDATE_CONFIG = Object.freeze({
  domain: 'advanced' as const,
  feedKey: 'updateFeedUrl',
  channelKey: 'updateChannel',
  intervalKey: 'updateInterval',
});

export type UpdateInterval = 'never' | 'daily' | 'weekly';

export interface AppUpdateSettings {
  readonly feedUrl: string;
  readonly channel: UpdateChannel;
  readonly interval: UpdateInterval;
}

const INTERVAL_MS: Readonly<Record<Exclude<UpdateInterval, 'never'>, number>> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `{channel}` in the feed URL keeps one base URL for both channels. */
export function resolveFeedUrl(template: string, channel: UpdateChannel): string {
  return template.replace(/\{channel\}/g, channel);
}

/**
 * Pure interval gate. `last === null` means "never checked" → due.
 * An unparsable timestamp is treated as due: a broken clock must not freeze
 * updates forever.
 */
export function isUpdateDue(
  interval: UpdateInterval,
  lastCheckedIso: string | null,
  nowIso: string,
): boolean {
  if (interval === 'never') return false;
  if (lastCheckedIso === null) return true;
  const last = Date.parse(lastCheckedIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(last) || Number.isNaN(now)) return true;
  return now - last >= INTERVAL_MS[interval];
}

export class AppUpdateCoordinator {
  private readonly deps: AppUpdateCoordinatorDeps;
  private notified = false;
  private lastCheckIso: string | null = null;

  constructor(deps: AppUpdateCoordinatorDeps) {
    this.deps = deps;
  }

  private notifyOnce(message: string): boolean {
    if (this.notified) return false;
    this.notified = true;
    try {
      this.deps.notifyOnce(message);
    } catch {
      // A failed notification must not turn into a failed update.
    }
    return true;
  }

  private outcome(status: AppUpdateOutcome['status'], reason: string, notifiedOnce: boolean): AppUpdateOutcome {
    return { status, reason, notifiedOnce };
  }

  /** Effective settings, resolved from ConfigStore with safe defaults. */
  settings(): AppUpdateSettings {
    const { config } = this.deps;
    const feed = config.get<string>(UPDATE_CONFIG.domain, UPDATE_CONFIG.feedKey);
    const channel = config.get<string>(UPDATE_CONFIG.domain, UPDATE_CONFIG.channelKey);
    const interval = config.get<string>(UPDATE_CONFIG.domain, UPDATE_CONFIG.intervalKey);
    return {
      feedUrl: typeof feed === 'string' ? feed.trim() : '',
      channel: channel === 'nightly' ? 'nightly' : 'stable',
      interval: interval === 'never' || interval === 'daily' ? interval : 'weekly',
    };
  }

  async checkAndApply(): Promise<AppUpdateOutcome> {
    const { updater, logger } = this.deps;
    const settings = this.settings();

    if (settings.feedUrl === '') {
      // Explicitly not an error: a build without a published feed is normal.
      await logger.info('app-update', 'no update feed configured; skipping');
      return this.outcome('degraded', '未配置更新源（advanced.updateFeedUrl 为空）', false);
    }
    if (!/^https?:\/\//i.test(settings.feedUrl)) {
      await logger.warn('app-update', 'update feed is not an http(s) URL; skipping', { url: settings.feedUrl });
      return this.outcome('degraded', `更新源不是 http(s) URL：${settings.feedUrl}`, false);
    }

    const feed: UpdateFeed = {
      provider: 'generic',
      url: resolveFeedUrl(settings.feedUrl, settings.channel),
    };

    try {
      await updater.configure(feed);
      this.lastCheckIso = new Date().toISOString();
      const availability = await updater.checkForUpdates();
      if (!availability.available) {
        await logger.info('app-update', 'already up to date', {
          version: availability.version,
          channel: settings.channel,
        });
        return this.outcome('up-to-date', `已是最新版本（${availability.version}）`, false);
      }

      await logger.info('app-update', 'update available; downloading', { version: availability.version });
      await updater.downloadUpdate();
      const notified = this.notifyOnce(`新版本 ${availability.version} 已就绪，将在退出后安装`);
      // `quitAndInstall` is the last step: everything above must succeed first.
      updater.quitAndInstall();
      return this.outcome('updated', `已下载 ${availability.version}`, notified);
    } catch (error) {
      const detail = reasonOf(error);
      await logger.warn('app-update', 'update check/download failed; staying on the current build', { detail });
      // Only tell the user if they would otherwise be waiting for an update.
      const notified = this.notifyOnce('更新检查失败，当前版本继续可用');
      return this.outcome('degraded', detail, notified);
    }
  }

  /** Last successful `configure()` timestamp, used by the interval gate. */
  lastCheckedAt(): string | null {
    return this.lastCheckIso;
  }
}
