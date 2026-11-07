/**
 * `UpdaterPort` over `electron-updater` (M5-5, C2).
 *
 * This is the ONLY file in the repository allowed to import `electron-updater` /
 * depend on its API shape. Everything else talks to `UpdaterPort`, which is why
 * the coordinator's failure policy is testable without Electron or a live feed.
 *
 * The import is dynamic on purpose: `electron-updater` touches `app` at module
 * scope, so requiring it before `app.whenReady()` would throw in a packaged
 * build. `createElectronUpdaterPort()` is called from the ready path only.
 *
 * Auto-download/auto-install are forced OFF: the coordinator decides when to
 * download and when to install, so a background "silent" update can never
 * restart the app under the user's cursor.
 */
import type { UpdateAvailability, UpdateFeed, UpdaterPort } from '@ytvdlt/shared';

/** Structural subset of electron-updater's `autoUpdater` this port needs. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  setFeedURL(options: { provider: string; url: string }): void;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface ElectronUpdaterPortOptions {
  /** Test seam; defaults to the real `electron-updater`. */
  readonly autoUpdater?: AutoUpdaterLike;
  /** Version reported when the feed says "nothing newer" (defaults to ''). */
  readonly currentVersion?: () => string;
}

export async function createElectronUpdaterPort(
  options: ElectronUpdaterPortOptions = {},
): Promise<UpdaterPort> {
  const autoUpdater = options.autoUpdater
    ?? ((await import('electron-updater')).autoUpdater as unknown as AutoUpdaterLike);

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  return {
    async configure(feed: UpdateFeed): Promise<void> {
      autoUpdater.setFeedURL({ provider: feed.provider, url: feed.url });
    },
    async checkForUpdates(): Promise<UpdateAvailability> {
      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo?.version ?? '';
      const current = options.currentVersion?.() ?? '';
      // electron-updater resolves `null` when the feed has nothing newer.
      return { available: result !== null && version !== '', version: version === '' ? current : version };
    },
    async downloadUpdate(): Promise<void> {
      await autoUpdater.downloadUpdate();
    },
    quitAndInstall(): void {
      // Silent install, relaunch afterwards: the coordinator already told the
      // user once via a non-blocking hint.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
