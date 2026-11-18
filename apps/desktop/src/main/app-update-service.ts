/**
 * AppUpdateService — the app's own updater over GitHub Releases (0.2.1, D-93).
 *
 * Why not `electron-updater` (which is still wired as `app-updater.ts`): that
 * library needs `latest.yml` + `.blockmap` published next to the installer. The
 * public repository publishes only `YTVDLT-Setup-<version>.exe`, so the generic
 * feed answers 404 and the built-in updater can only ever report "degraded".
 *
 * What this service does instead, in four separate steps the user controls:
 *
 *   1. `check()`    — read `/releases/latest`, compare versions;
 *   2. `download()` — stream the installer, report bytes, verify before ready;
 *   3. `install()`  — hand the verified file to the OS and quit;
 *   4. everything else (page, skip, dismiss) — never touches the network.
 *
 * Invariants that must not be relaxed:
 *   - a failed check/download NEVER changes the running app (phase → `error`);
 *   - nothing becomes installable without a PUBLISHED SHA-256 digest — a
 *     release whose asset carries no `digest` cannot prove its installer, so
 *     the download is rejected instead of falling back to size + PE header
 *     (a self-computed hash proves nothing about the first download);
 *   - a downloaded installer must additionally pass size + SHA-256 + PE header
 *     checks — a truncated 220 MB exe is the classic silent failure;
 *   - D-104: a REUSED cache file gets the SAME hash check as a fresh download,
 *     and the ONLY baseline is the current release's published `digest`. The
 *     `.sha256` sidecar written at first download is diagnostics only — a
 *     self-computed hash is not a trust root and never authorizes reuse. With
 *     no published digest the cache is refused and the installer is
 *     downloaded again (which then fails the digest gate above);
 *   - `install()` re-verifies all three on the bytes about to be launched, so
 *     a file replaced between "ready" and "install" cannot be executed;
 *   - the installer URL must be a GitHub host (see `isTrustedReleaseHost`).
 *
 * D-140: `check()` also reads the release LIST, so a user who skipped several
 * versions gets one block per version instead of a single body that refers to a
 * version they never ran. That lookup is best-effort — failing it must never
 * turn a perfectly good "update available" into an error.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  AppRelease, AppReleaseAsset, AppReleaseNote, AppUpdateAction, AppUpdateActionResult,
  AppUpdateState, CorePorts, HttpPort,
} from '@ytvdlt/shared';
import type { IConfigStore, ILogger } from '@ytvdlt/core';
import { collectReleaseNotes, isNewerVersion } from '@ytvdlt/core';
import {
  fetchLatestRelease, fetchReleaseList, isTrustedReleaseHost, type ReleaseSource,
} from './github-releases.js';
import {
  downloadToFile, fileSize, looksLikeExecutable, PartialCleanupError,
  type DownloadRequest, type DownloadResult,
} from './adapters/http-download.js';
import { isPublicResolvedAddress } from './adapters/http-policy.js';
import { createUpdateCleanupFiles, rememberPendingUpdate } from './app-update-cleanup.js';

/** Where the update settings live (advanced domain, same place as D-67). */
export const APP_UPDATE_CONFIG = Object.freeze({
  domain: 'advanced' as const,
  autoCheckKey: 'autoCheckAppUpdate',
  skippedKey: 'skippedAppVersion',
  lastCheckKey: 'lastAppUpdateCheckAt',
});

/** At most one automatic check per this window; manual checks ignore it. */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AppUpdateServiceDeps {
  readonly ports: CorePorts;
  readonly logger: ILogger;
  readonly config: IConfigStore;
  readonly currentVersion: string;
  readonly source: ReleaseSource;
  /** `<dataDir>/updates` — created on demand. */
  readonly updatesDir: string;
  /** Electron `shell.openExternal`; injected so tests stay offline. */
  readonly openExternal: (url: string) => Promise<void>;
  /** Electron `shell.openPath`; opens the installer. */
  readonly openPath: (path: string) => Promise<string>;
  /** Quit after the installer process is launched. */
  readonly quit: () => void;
  readonly trashPartial?: (path: string) => Promise<void>;
  /**
   * D-214 (append-only, OPTIONAL): the update-only Electron/Chromium HttpPort.
   * `check()` and the D-140 release-history lookup (`notesSince`) use it, so
   * the GitHub Releases JSON is reachable under an OS proxy / TUN / Fake-IP.
   * Absent (offline unit tests) keeps `ports.http` exactly as before.
   */
  readonly updateHttp?: HttpPort;
  /**
   * D-143: the installer downloader. Defaults to the real `downloadToFile`
   * (D-137 redirect policy + D-143 DNS pinning); injected by tests so they
   * stay offline — the old global-`fetch` stub stopped working when the
   * transport moved to `node:http`/`node:https`.
   *
   * D-214: production injects `ElectronUpdateNetwork.downloadInstaller` here —
   * the SAME `downloadToFile` pipeline (`.part`, byte ceiling, SHA-256, PE
   * check, cancellation) with its `openResponse` seam swapped to
   * `net.request()`. The state machine and all verification steps are unchanged.
   */
  readonly downloadInstaller?: (request: DownloadRequest) => Promise<DownloadResult>;
  /**
   * D-243 (append-only, OPTIONAL): the rename primitive used when a verified
   * staging file is published under its release name. Defaults to
   * `node:fs/promises.rename`. Tests inject a failing implementation to pin
   * the "publish failed ⇒ NOT installable" contract without having to make the
   * real filesystem refuse a same-volume rename.
   */
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

export interface AppUpdateService {
  state(): AppUpdateState;
  /** `manual` skips the 6 h throttle and is what the settings button triggers. */
  check(options?: { manual?: boolean }): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  install(): Promise<AppUpdateActionResult>;
  openPage(): Promise<AppUpdateActionResult>;
  skipCurrentVersion(): Promise<AppUpdateState>;
  dismiss(): AppUpdateState;
  /** True when this launch should run an automatic check. */
  shouldAutoCheck(): boolean;
  perform(action: AppUpdateAction): Promise<AppUpdateActionResult>;
  /** Stop responding to anything new (called on `before-quit`). */
  dispose(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Asset names come from JSON; never let one become a path. */
function safeFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return base === '' || base === '.' || base === '..' ? 'YTVDLT-Setup.exe' : base;
}

/**
 * D-104 · a locally persisted DIAGNOSTIC record, written atomically next to
 * the installer after the first verified download. It is NOT a trust root:
 * it stores a hash this app computed itself, so it can detect later corruption
 * of the cache but can never vouch for the first download's authenticity.
 * Cache reuse (see `verifiedCachedFile`) requires the release's published
 * `digest`; the sidecar only rides along for support and inspection.
 */
function sidecarPath(target: string): string { return `${target}.sha256`; }

/**
 * Diagnostic read of the `.sha256` sidecar. D-219: this record is NOT a trust
 * baseline — not for install, not for cache reuse. The only caller re-syncs
 * the diagnostic file AFTER the published-digest check has already decided
 * (see `verifiedCachedFile`); never use it to authorize anything.
 */
async function readSidecar(target: string): Promise<string | null> {
  try {
    const raw = (await readFile(sidecarPath(target), 'utf8')).trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
  } catch { return null; }
}

async function writeSidecar(target: string, hex: string): Promise<void> {
  const sidecar = sidecarPath(target);
  const temp = `${sidecar}.tmp`;
  await writeFile(temp, `${hex.toLowerCase()}\n`, 'utf8');
  await rename(temp, sidecar);
}

/** Move a suspect installer aside (never delete): support can still inspect it. */
async function isolateFile(target: string, tag: string): Promise<string> {
  const isolated = `${target}.${tag}-${Date.now()}`;
  await rename(target, isolated).catch(() => undefined);
  return isolated;
}

/**
 * D-219 · the ONLY trust baselines `install()` may verify against, in priority
 * order:
 *  1. `verifiedSha256` — a hash verified on the exact bytes now sitting in
 *     `installerPath` (recorded by the ready paths, D-104);
 *  2. `asset.sha256` — the release's PUBLISHED digest, the root that still
 *     holds when a ready path ever fails to record `verifiedSha256`.
 *
 * There is deliberately NO third leg. `install()` used to fall back to
 * `?? readSidecar(executable)`: the moment any ready path left
 * `verifiedSha256` null, a locally written `.sha256` file — a hash THIS app
 * computed itself — would silently become the trust root, exactly the
 * contradiction D-219 removed (a self-computed hash proves nothing about the
 * first download's authenticity). The signature accepts no path and no
 * sidecar, so the baseline physically cannot reach one; `null` means "no
 * trusted baseline" and the install gate must fail closed on it.
 */
export function installBaseline(
  verifiedSha256: string | null,
  asset: AppReleaseAsset | null,
): string | null {
  return verifiedSha256 ?? asset?.sha256 ?? null;
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  const { ports, logger, config } = deps;
  /**
   * D-243: the publish hop only. Everything else in this module keeps using the
   * real `rename` — a test must be able to make the PUBLISH fail while the
   * surrounding staging / isolation / sidecar writes still work.
   */
  const renameForPublish = deps.renameFile ?? rename;

  let phase: AppUpdateState['phase'] = 'idle';
  let latest: AppRelease | null = null;
  let message = '';
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  let installerPath: string | null = null;
  /** Hash actually verified on the bytes now in `installerPath` (D-104). */
  let verifiedSha256: string | null = null;
  let lastCheckedAt: string | null = null;
  /** D-140: per-version notes for the interval the user skipped, oldest first. */
  let releaseNotes: readonly AppReleaseNote[] = [];
  let omittedReleaseNotes = 0;
  let disposed = false;
  let downloadController: AbortController | null = null;
  let downloadFinished: Promise<void> | null = null;

  const skippedVersion = (): string => {
    const value = config.get<string>(APP_UPDATE_CONFIG.domain, APP_UPDATE_CONFIG.skippedKey);
    return typeof value === 'string' ? value.trim() : '';
  };

  const canAutoInstall = (): boolean => ports.env.platform() === 'win32'
    && latest !== null && latest.installer !== null;

  function state(): AppUpdateState {
    return {
      phase,
      currentVersion: deps.currentVersion,
      latest,
      releaseNotes,
      omittedReleaseNotes,
      message,
      downloadedBytes,
      totalBytes,
      skippedVersion: skippedVersion(),
      lastCheckedAt,
      canAutoInstall: canAutoInstall(),
    };
  }

  function fail(text: string): AppUpdateState {
    phase = 'error';
    message = text;
    return state();
  }

  function result(ok: boolean, action: AppUpdateAction, text: string): AppUpdateActionResult {
    return { ok, action, message: text, state: state() };
  }

  async function persistCheckTime(iso: string): Promise<void> {
    lastCheckedAt = iso;
    try {
      await config.setDomain(APP_UPDATE_CONFIG.domain, { [APP_UPDATE_CONFIG.lastCheckKey]: iso });
    } catch (error) {
      // A read-only config must not turn a successful check into a failure.
      await logger.warn('app-update', 'could not persist last check time', { detail: messageOf(error) });
    }
  }

  /**
   * D-140: rebuild the "what changed since your build" stack.
   *
   * Best-effort by design — a failed history lookup must never turn a valid
   * "update available" into an error. When the list endpoint is unreachable
   * (offline, rate-limited, GitHub outage) the latest release's own body is
   * still better than an empty dialog, so that is the fallback.
   */
  async function notesSince(
    http: CorePorts['http'],
    release: AppRelease,
  ): Promise<{ notes: readonly AppReleaseNote[]; omitted: number }> {
    const fallback = (): { notes: readonly AppReleaseNote[]; omitted: number } => {
      const digest = collectReleaseNotes([release], deps.currentVersion, release.version);
      return { notes: digest.blocks, omitted: digest.omitted };
    };
    if (http === undefined) return fallback();
    try {
      const list = await fetchReleaseList(http, deps.source);
      if (list.length === 0) return fallback();
      const digest = collectReleaseNotes(list, deps.currentVersion, release.version);
      if (digest.blocks.length === 0) return fallback();
      const hasLatest = digest.blocks.some((block) => block.version === release.version);
      if (hasLatest) return { notes: digest.blocks, omitted: digest.omitted };
      // The list is paginated and the newest release must never be missing from
      // the dialog: append the authoritative single-release body when it is.
      const latestOnly = collectReleaseNotes([release], deps.currentVersion, release.version);
      return { notes: [...digest.blocks, ...latestOnly.blocks], omitted: digest.omitted };
    } catch (error) {
      await logger.warn('app-update', 'release history unavailable; showing the latest notes only', {
        detail: messageOf(error),
      });
      return fallback();
    }
  }

  async function check(options: { manual?: boolean } = {}): Promise<AppUpdateState> {
    if (disposed) return state();
    if (phase === 'checking' || phase === 'downloading') return state();
    const manual = options.manual === true;

    if (!manual) {
      const raw = config.get<string>(APP_UPDATE_CONFIG.domain, APP_UPDATE_CONFIG.lastCheckKey);
      if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Date.parse(raw))) {
        lastCheckedAt = raw;
      }
    }

    phase = 'checking';
    message = '';
    try {
      // D-214: both `/releases/latest` and `/releases` (notesSince) share the
      // update-only HttpPort — one proxy-aware Chromium session, same GitHub
      // URL allowlist on hop 0 and every redirect.
      const http = deps.updateHttp ?? ports.http;
      if (http === undefined) return fail('当前构建不支持网络请求');
      const release = await fetchLatestRelease(http, deps.source);
      await persistCheckTime(ports.clock.nowIso());
      if (release === null) return fail('未能读取发布信息（GitHub 无可用版本）');

      if (!isNewerVersion(release.version, deps.currentVersion)) {
        latest = null;
        installerPath = null;
        verifiedSha256 = null;
        releaseNotes = [];
        omittedReleaseNotes = 0;
        phase = 'idle';
        message = `已是最新版本（${deps.currentVersion}）`;
        return state();
      }

      latest = release;
      installerPath = null;
      verifiedSha256 = null;
      downloadedBytes = 0;
      totalBytes = release.installer?.sizeBytes ?? null;
      // D-140: the dialog explains the whole skipped interval, not just the
      // newest body. A failure here degrades to `latest.notes`, never to an error.
      const digest = await notesSince(http, release);
      releaseNotes = digest.notes;
      omittedReleaseNotes = digest.omitted;
      phase = 'available';
      message = `发现新版本 ${release.version}`;
      await logger.info('app-update', 'new version available', {
        current: deps.currentVersion,
        latest: release.version,
        notesFor: releaseNotes.length,
      });
      return state();
    } catch (error) {
      const detail = messageOf(error);
      await logger.warn('app-update', 'check failed; staying on the current build', { detail });
      return fail(`检查更新失败：${detail}`);
    }
  }

  /**
   * D-104: reuse a previously verified file instead of re-downloading 220 MB —
   * but ONLY after recomputing its SHA-256 and matching the CURRENT release's
   * published `digest`. Size + `MZ` alone cannot detect a corrupted or
   * substituted cache file.
   *
   * Tightened: the local `.sha256` sidecar no longer authorizes reuse. It
   * records a hash THIS app computed — matching it proves only that the bytes
   * did not change since this app last saw them, not that those bytes were
   * authentic in the first place (the sidecar inherits whatever trust the
   * first download had, which is exactly what is in question). When GitHub
   * publishes no digest there is no trustworthy baseline, so the cache is
   * refused and the installer is downloaded again — where the install gate
   * rejects digest-less releases outright.
   */
  async function verifiedCachedFile(
    asset: AppReleaseAsset,
  ): Promise<{ path: string; sha256: string } | null> {
    const path = `${deps.updatesDir}/${safeFileName(asset.name)}`;
    const size = await fileSize(path);
    if (size <= 0) return null;
    if (asset.sizeBytes > 0 && size !== asset.sizeBytes) return null;
    if (!(await looksLikeExecutable(path).catch(() => false))) return null;

    // Fail-closed: without the published digest there is no trustworthy
    // baseline — the sidecar (a self-computed hash) is not one.
    if (asset.sha256 === null) return null;
    const expected = asset.sha256.toLowerCase();
    const actual = await ports.hash.sha256File(path).catch(() => null);
    if (actual === null || actual.toLowerCase() !== expected) {
      const isolated = await isolateFile(path, 'checksum-mismatch');
      await logger.warn('app-update', 'cached installer failed SHA-256; isolated and re-downloading', {
        detail: isolated,
      });
      return null;
    }
    // Published digest is authoritative: keep the sidecar in sync for
    // diagnostics on later launches (it never authorizes reuse by itself).
    if ((await readSidecar(path)) !== expected) {
      await writeSidecar(path, expected).catch(() => undefined);
    }
    return { path, sha256: expected };
  }

  /**
   * D-233 (audit P3) · publish a VERIFIED staging file under the release name.
   *
   * Two invariants, both about not destroying something the user may still
   * need:
   *  1. an existing file at the canonical name is MOVED ASIDE, never deleted
   *     (`.replaced-<ts>`, same "isolate, don't delete" rule as the rejected
   *     download), so a failed upgrade leaves both copies on disk;
   *  2. if that move cannot be confirmed, the publish is ABANDONED and the
   *     verified bytes stay at the staging name — overwriting an unconfirmed
   *     destination is exactly the data loss this exists to prevent.
   *
   * D-243 (audit P2): the staging path is NOT an install path. Returning it as
   * `{path: stagedPath}` let `download()` mark the state `ready` and
   * `install()` hand `<asset>.<uuid>.download` to `shell.openPath()` — Windows
   * decides by file association what that means: nothing (an error), or some
   * unrelated program launched while the app reports "installer started" and
   * quits. The caller now treats "not at the canonical name" as a FAILURE; the
   * verified bytes are still kept (never deleted) for support, and the message
   * says where they are.
   */
  async function publishVerifiedInstaller(
    stagedPath: string,
    canonicalPath: string,
  ): Promise<{ path: string; reason: string }> {
    let movedAside: string | null = null;
    if ((await fileSize(canonicalPath)) >= 0) {
      movedAside = await isolateFile(canonicalPath, 'replaced');
      if ((await fileSize(movedAside)) < 0) {
        return { path: stagedPath, reason: `existing file could not be moved aside (${movedAside})` };
      }
      await logger.warn('app-update', 'existing installer kept aside; publishing the new one', {
        detail: movedAside,
      });
    }
    try {
      await renameForPublish(stagedPath, canonicalPath);
      return { path: canonicalPath, reason: '' };
    } catch (error) {
      // Swap failed: put the previous file back under its own name (best
      // effort) and report the staging path so the caller can name it. Neither
      // version is lost; nothing is installable.
      if (movedAside !== null && (await fileSize(canonicalPath)) < 0) {
        await rename(movedAside, canonicalPath).catch(() => undefined);
      }
      return { path: stagedPath, reason: messageOf(error) };
    }
  }

  async function download(): Promise<AppUpdateState> {
    if (disposed) return state();
    if (phase === 'downloading') return state();
    const release = latest;
    if (release === null || release.installer === null) {
      return fail('当前发布未提供安装包，请前往发布页手动下载');
    }
    const asset = release.installer;
    if (!isTrustedReleaseHost(asset.url)) {
      return fail('安装包地址不在 GitHub 域名下，已拒绝下载');
    }

    const controller = new AbortController();
    downloadController = controller;
    let finishDownload: () => void = () => {};
    downloadFinished = new Promise<void>((resolve) => { finishDownload = resolve; });
    phase = 'downloading';
    message = `正在下载 ${asset.name}`;
    downloadedBytes = 0;
    totalBytes = asset.sizeBytes > 0 ? asset.sizeBytes : null;
    /**
     * D-233: the unique staging path of THIS attempt, remembered so the abort
     * branch can discard a completed-but-unverified staging file. The old code
     * left a cancelled-after-transfer download at the canonical name (where the
     * cache could still reuse it); a staging file would just be dead weight.
     */
    let stagedPath: string | null = null;
    try {
      const cached = await verifiedCachedFile(asset);
      controller.signal.throwIfAborted();
      if (cached !== null) {
        installerPath = cached.path;
        verifiedSha256 = cached.sha256;
        downloadedBytes = asset.sizeBytes;
        phase = 'ready';
        message = '安装包已就绪（复用上次下载，SHA-256 已复验）';
        return state();
      }

      // D-233 (audit P3): download into a UNIQUE staging name, verify THAT
      // file, and only then publish it to the canonical name. The old order
      // (rename the `.part` onto the canonical path, verify afterwards) meant a
      // same-name file that had merely failed the cache check — different size,
      // broken PE header, or a release that publishes no digest, none of which
      // isolate the cache — was destroyed before anyone knew whether the new
      // download was usable. The staged name also makes the cache path
      // single-writer: `verifiedCachedFile` is the only reader of the canonical
      // name, and it never runs while a download is in flight.
      const canonical = `${deps.updatesDir}/${safeFileName(asset.name)}`;
      const target = `${deps.updatesDir}/${safeFileName(asset.name)}.${randomUUID()}.download`;
      stagedPath = target;
      const result = await (deps.downloadInstaller ?? downloadToFile)({
        url: asset.url,
        targetPath: target,
        expectedBytes: asset.sizeBytes > 0 ? asset.sizeBytes : null,
        // D-137 / D-214: the allowlist is checked again on EVERY redirect hop —
        // by `fetchFollowingRedirects` on the default transport, or by the
        // injected Electron transport's manual `redirect` event. It is NEVER
        // widened for proxy compatibility.
        hostPolicy: isTrustedReleaseHost,
        // D-143: DNS rebinding guard for the DEFAULT (node:http(s)) transport.
        // The D-214 Electron transport ignores it: Chromium resolves the target
        // through the proxy / TUN itself, so Node-level address pinning does not
        // apply to this channel. Keeping the field preserves the default path
        // and every existing offline test unchanged.
        allowResolvedAddress: isPublicResolvedAddress,
        signal: controller.signal,
        ...(deps.trashPartial === undefined ? {} : { trashPartial: deps.trashPartial }),
        onProgress: (progress) => {
          downloadedBytes = progress.downloadedBytes;
          if (progress.totalBytes !== null) totalBytes = progress.totalBytes;
        },
      });

      controller.signal.throwIfAborted();
      // Verification order matters: digest presence, size, hash, then the PE
      // header. A failure renames the file instead of deleting it, so support
      // can inspect it.
      const problems: string[] = [];
      // A release without a digest cannot prove its installer at all: matching
      // a self-computed hash would only prove we downloaded the same bytes
      // twice, so digest-less releases never become installable.
      if (asset.sha256 === null) {
        problems.push('发布数据缺少 SHA-256 摘要，无法证明安装包完整性，拒绝自动安装');
      }
      if (asset.sizeBytes > 0 && result.bytes !== asset.sizeBytes) {
        problems.push(`大小不符（${result.bytes}/${asset.sizeBytes}）`);
      }
      if (asset.sha256 !== null && result.sha256 !== asset.sha256) {
        problems.push('SHA-256 不匹配');
      }
      if (!(await looksLikeExecutable(target))) problems.push('不是有效的 Windows 可执行文件');

      controller.signal.throwIfAborted();
      if (problems.length > 0) {
        // The rejection quarantines the STAGED file; whatever sits at the
        // canonical name was never touched, so an earlier copy survives.
        const rejected = await isolateFile(target, 'rejected');
        await logger.error('app-update', 'installer verification failed', { problems });
        installerPath = null;
        verifiedSha256 = null;
        phase = 'error';
        message = `安装包校验失败：${problems.join('；')}（文件保留为 ${rejected}）`;
        return state();
      }

      // D-233: verified bytes → publish. Nothing is overwritten; an existing
      // same-name installer is moved aside (never deleted) first.
      const published = await publishVerifiedInstaller(target, canonical);
      if (published.path !== canonical) {
        // D-243 (audit P2): fail closed. The staged name is `<asset>.<uuid>.download`
        // — handing THAT to `shell.openPath()` lets Windows pick a program by
        // file association, so the old code could open the wrong thing and
        // still report "installer launched" (then quit the app). The verified
        // bytes are kept untouched for support; the state carries the reason and
        // the path, and `install()` stays unreachable (`installerPath === null`).
        await logger.warn('app-update', 'could not publish installer under its release name', {
          detail: published.reason,
        });
        installerPath = null;
        verifiedSha256 = null;
        phase = 'error';
        message = `安装包已校验，但无法发布为 ${canonical}（${published.reason}）；已停止安装。文件保留在 ${published.path}，可重试或前往发布页手动下载`;
        return state();
      }

      // D-104 (tightened): persist the verified hash as a DIAGNOSTIC sidecar.
      // Reuse requires the current release's published digest (see
      // `verifiedCachedFile`) — a self-computed hash is not a trust root, so
      // the sidecar never authorizes reuse by itself.
      await writeSidecar(published.path, result.sha256).catch(async (error: unknown) => {
        await logger.warn('app-update', 'could not write checksum sidecar', {
          detail: error instanceof Error ? error.message : String(error),
        });
      });
      controller.signal.throwIfAborted();
      installerPath = published.path;
      verifiedSha256 = result.sha256.toLowerCase();
      downloadedBytes = result.bytes;
      totalBytes = result.bytes;
      phase = 'ready';
      message = `已下载并校验 ${asset.name}`;
      await logger.info('app-update', 'installer downloaded and verified', {
        version: release.version, bytes: result.bytes,
      });
      return state();
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof PartialCleanupError)) {
        // D-233: an abort that lands between "bytes finished" and "verified"
        // leaves a complete staging file. It is not publishable and the cache
        // never looks at that name, so recycle it (never a permanent delete).
        if (stagedPath !== null && (await fileSize(stagedPath)) >= 0) {
          const trash = deps.trashPartial;
          if (trash !== undefined) {
            await trash(stagedPath).catch(async (cleanupError: unknown) => {
              await logger.warn('app-update', 'cancelled download left a staging file', {
                detail: messageOf(cleanupError),
              });
            });
          }
        }
        phase = 'available';
        message = '已取消下载，可以重新下载';
        downloadedBytes = 0;
        return state();
      }
      const detail = messageOf(error);
      await logger.warn('app-update', 'installer download failed', { detail });
      return fail(`下载失败：${detail}`);
    } finally {
      downloadController = null;
      downloadFinished = null;
      finishDownload();
    }
  }

  async function cancelDownload(): Promise<AppUpdateActionResult> {
    const pending = downloadFinished;
    if (pending === null || downloadController === null) {
      return result(false, 'cancel-download', '当前没有正在下载的更新');
    }
    downloadController.abort();
    await pending;
    return result(phase === 'available', 'cancel-download', message);
  }

  async function install(): Promise<AppUpdateActionResult> {
    if (installerPath === null || phase !== 'ready') {
      return result(false, 'install', '安装包尚未就绪');
    }
    const executable = installerPath;
    // D-243 (audit P2): a belt for the path above. Only a published `.exe` may
    // be handed to the OS: a `.download` staging file, a `.replaced-*` copy or
    // anything else would be opened by FILE ASSOCIATION — an arbitrary program,
    // with the app reporting success and then quitting. Refuse and say why.
    if (!/\.exe$/i.test(executable)) {
      installerPath = null;
      verifiedSha256 = null;
      phase = 'error';
      const refusal = `安装包文件名不是 .exe（${executable}），已拒绝启动，以免交给系统按文件关联打开其它程序`;
      message = refusal;
      return result(false, 'install', refusal);
    }
    // D-104: the file may have been swapped or damaged AFTER `ready`. Re-run
    // all three checks on the exact bytes we are about to hand to the OS.
    // D-219: the baseline is a hash verified on these bytes or the published
    // digest — the local sidecar is never consulted here.
    const asset = latest?.installer ?? null;
    const baseline = installBaseline(verifiedSha256, asset);
    const expected = baseline === null ? null : baseline.toLowerCase();
    const problems: string[] = [];
    if (!(await looksLikeExecutable(executable).catch(() => false))) problems.push('PE 文件头无效');
    const size = await fileSize(executable);
    if (asset !== null && asset.sizeBytes > 0 && size !== asset.sizeBytes) {
      problems.push(`大小不符（${size}/${asset.sizeBytes}）`);
    }
    const actual = expected === null ? null : await ports.hash.sha256File(executable).catch(() => null);
    if (expected === null || actual === null || actual.toLowerCase() !== expected) {
      problems.push('SHA-256 不匹配或缺少可信基准');
    }
    if (problems.length > 0) {
      const isolated = await isolateFile(executable, 'install-rejected');
      installerPath = null;
      verifiedSha256 = null;
      phase = 'error';
      message = `安装前完整性校验失败：${problems.join('；')}（文件已隔离为 ${isolated}，请重新下载）`;
      return result(false, 'install', message);
    }
    try {
      if (latest !== null && expected !== null) {
        await rememberPendingUpdate(
          createUpdateCleanupFiles((path) => ports.hash.sha256File(path)), deps.updatesDir,
          deps.currentVersion, latest.version, executable, expected,
        ).catch(async (error: unknown) => {
          await logger.warn('app-update', 'could not record installer cleanup', { detail: messageOf(error) });
        });
      }
      const error = await deps.openPath(executable);
      if (typeof error === 'string' && error !== '') {
        return result(false, 'install', `无法启动安装程序：${error}`);
      }
      await logger.info('app-update', 'installer launched', { path: executable });
      // Give the installer a moment to take over before the window disappears.
      setTimeout(() => {
        try { deps.quit(); } catch { /* already quitting */ }
      }, 800);
      return result(true, 'install', '安装程序已启动，应用即将退出');
    } catch (error) {
      return result(false, 'install', `无法启动安装程序：${messageOf(error)}`);
    }
  }

  async function openPage(): Promise<AppUpdateActionResult> {
    const url = latest?.pageUrl ?? '';
    if (!/^https:\/\/([a-z0-9-]+\.)*github\.com\//i.test(url)) {
      return result(false, 'open-page', '没有可用的发布页地址');
    }
    try {
      await deps.openExternal(url);
      return result(true, 'open-page', '已在浏览器打开发布页');
    } catch (error) {
      return result(false, 'open-page', messageOf(error));
    }
  }

  async function skipCurrentVersion(): Promise<AppUpdateState> {
    const version = latest?.version ?? '';
    if (version === '') return state();
    try {
      await config.setDomain(APP_UPDATE_CONFIG.domain, { [APP_UPDATE_CONFIG.skippedKey]: version });
      message = `已忽略 ${version}，下个版本发布后会再提示`;
    } catch (error) {
      message = `无法保存忽略设置：${messageOf(error)}`;
    }
    return state();
  }

  function dismiss(): AppUpdateState {
    if (phase !== 'downloading') phase = latest === null ? 'idle' : 'available';
    return state();
  }

  function shouldAutoCheck(): boolean {
    if (disposed) return false;
    const enabled = config.get<boolean>(APP_UPDATE_CONFIG.domain, APP_UPDATE_CONFIG.autoCheckKey);
    if (enabled === false) return false;
    const raw = config.get<string>(APP_UPDATE_CONFIG.domain, APP_UPDATE_CONFIG.lastCheckKey);
    if (typeof raw !== 'string' || raw.trim() === '') return true;
    const last = Date.parse(raw);
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= AUTO_CHECK_INTERVAL_MS;
  }

  async function perform(action: AppUpdateAction): Promise<AppUpdateActionResult> {
    switch (action) {
      case 'check': {
        const next = await check({ manual: true });
        return { ok: next.phase !== 'error', action, message: next.message, state: next };
      }
      case 'download': {
        const next = await download();
        return { ok: next.phase === 'ready', action, message: next.message, state: next };
      }
      case 'cancel-download':
        return cancelDownload();
      case 'install':
        return install();
      case 'open-page':
        return openPage();
      case 'skip-version': {
        const next = await skipCurrentVersion();
        return { ok: true, action, message: next.message, state: next };
      }
      case 'dismiss':
        return { ok: true, action, message: '', state: dismiss() };
      default:
        return result(false, action, '未知操作');
    }
  }

  return {
    state,
    check,
    download,
    install,
    openPage,
    skipCurrentVersion,
    dismiss,
    shouldAutoCheck,
    perform,
    dispose: () => { disposed = true; },
  };
}
