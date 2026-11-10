/**
 * App (Electron build) update contracts — 0.2.1, D-93.
 *
 * Why this exists next to `update.ts`: `update.ts` describes the
 * `electron-updater` port, which needs a `latest.yml` + blockmap published
 * beside the installer. The public GitHub repository only publishes the
 * installer asset itself, so that path can never find a feed. This file
 * describes the path that DOES work: read the GitHub Releases API, compare
 * versions, download the asset ourselves and verify it before running it.
 *
 * Pure types only — no `node:*`, no `electron`, no I/O.
 */

/** One downloadable file of a release. */
export interface AppReleaseAsset {
  readonly name: string;
  /** Browser download URL (redirects to the CDN; never a credential URL). */
  readonly url: string;
  readonly sizeBytes: number;
  /** `sha256:<hex>` from the GitHub `digest` field, when the API provides it. */
  readonly sha256: string | null;
}

/** A release as far as the app cares about it. */
export interface AppRelease {
  /** Normalised, no leading `v`: `0.2.1`. */
  readonly version: string;
  /** Tag exactly as published: `v0.2.1`. */
  readonly tag: string;
  readonly name: string;
  /** Release body, already flattened to plain text for the dialog. */
  readonly notes: string;
  /** `html_url` — where "前往发布页" goes. */
  readonly pageUrl: string;
  readonly publishedAt: string;
  /** Best candidate installer; `null` when the release ships no `.exe`. */
  readonly installer: AppReleaseAsset | null;
}

/**
 * What the update surface is doing right now.
 *
 * `ready` means "downloaded and verified, waiting for the user to click 安装";
 * the app never installs behind the user's back.
 */
export type AppUpdatePhase =
  | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface AppUpdateState {
  readonly phase: AppUpdatePhase;
  readonly currentVersion: string;
  readonly latest: AppRelease | null;
  /** Human-readable reason for `error`, or an informational line. */
  readonly message: string;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  /** Version the user asked to stop being reminded about. */
  readonly skippedVersion: string | null;
  readonly lastCheckedAt: string | null;
  /** False when the release has no installer asset (page-only update). */
  readonly canAutoInstall: boolean;
}

export type AppUpdateAction =
  | 'check' | 'download' | 'cancel-download' | 'install' | 'open-page' | 'skip-version' | 'dismiss';

/** Result of one user action; the renderer re-reads `state` afterwards. */
export interface AppUpdateActionResult {
  readonly ok: boolean;
  readonly action: AppUpdateAction;
  readonly message: string;
  readonly state: AppUpdateState;
}

/**
 * Engine (yt-dlp) remote-version lookup — deliberately separate from the app
 * update: a stale `yt-dlp.exe` breaks every download while the app itself is
 * perfectly fine, so the two surfaces never share a button (D-94).
 */
export interface ComponentVersionCheck {
  readonly id: string;
  readonly label: string;
  readonly installedVersion: string;
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  readonly error: string | null;
}

export interface ComponentVersionReport {
  readonly checkedAt: string;
  readonly results: readonly ComponentVersionCheck[];
}
