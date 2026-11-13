/**
 * Update domain types (M5-5, D-62). Pure types — zero `node:*` / `electron`.
 *
 * Two independent update paths, kept apart on purpose:
 *
 *   1. **Engine update** (`yt-dlp.exe`): a single binary fetched from a
 *      `EngineUpdateSource`, checksum-verified against `SHA2-256SUMS`, swapped
 *      with a `.new` + rename + rollback dance. Lives in `engine-ytdlp`.
 *   2. **App update** (the Electron build): delegated to `electron-updater`
 *      behind `UpdaterPort`, so Core never imports it and the whole decision
 *      path is testable offline.
 *
 * Neither path ever talks to the network itself: the source/port does. That is
 * what makes the domestic-gate (N1/N2) build verifiable without a live feed.
 */

export type UpdateChannel = 'stable' | 'nightly';

/** One `SHA2-256SUMS` line, already resolved to the file we care about. */
export interface ChecksumEntry {
  readonly sha256: string;
  readonly fileName: string;
}

/**
 * Where engine bytes come from.
 * - `local-dir` — a directory of files (acceptance / offline replay, N1).
 * - `official-release` — the published release feed (N2, domestic gate).
 */
export interface EngineUpdateSource {
  readonly kind: 'local-dir' | 'official-release';
  /** Raw `SHA2-256SUMS` text. */
  fetchChecksums(): Promise<string>;
  /** `yt-dlp.exe` bytes (possibly very large — do not log or hash twice). */
  fetchEngineBinary(): Promise<Uint8Array>;
}

/**
 * The queue's intake switch. Deliberately the narrowest possible surface:
 * `pause()` must never cancel anything, and `resume()` must always be called.
 */
export interface QueueIntakeGate {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /**
   * D-171 (optional): wait until no task occupies a slot.
   *
   * `pause()` only stops NEW work — the running transfers keep their handles and
   * keep writing bytes while the updater renames `yt-dlp.exe` underneath them.
   * On Windows a rename over a file an active child has open fails, which is how
   * "component update" used to become `swap-failed` mid-download. Returns
   * `false` on timeout; the caller must then NOT touch the file.
   */
  waitForIdle?(timeoutMs: number): Promise<boolean>;
}

/** `electron-updater` generic feed. */
export interface UpdateFeed {
  readonly provider: 'generic';
  readonly url: string;
}

export interface UpdateAvailability {
  readonly available: boolean;
  readonly version: string;
}

/** Thin port over `electron-updater`'s autoUpdater. */
export interface UpdaterPort {
  configure(feed: UpdateFeed): Promise<void>;
  checkForUpdates(): Promise<UpdateAvailability>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
}

export type AppUpdateStatus = 'up-to-date' | 'updated' | 'degraded';

/**
 * Outcome of one app-update attempt.
 * `degraded` is a first-class result, not an error: an update that cannot be
 * checked or downloaded must leave the running app untouched and silent.
 */
export interface AppUpdateOutcome {
  readonly status: AppUpdateStatus;
  readonly reason: string;
  /** True when the user was told once — never repeatedly. */
  readonly notifiedOnce: boolean;
}
