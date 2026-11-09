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
 *   - nothing becomes installable without a size + SHA-256 + PE header check —
 *     a truncated 220 MB exe is the classic silent failure;
 *   - D-104: a REUSED cache file gets the SAME hash check as a fresh download.
 *     The published `digest` is authoritative; when GitHub omits it, a
 *     `.sha256` sidecar written at first download is the fallback. With neither
 *     baseline the cache is refused and the installer is downloaded again;
 *   - `install()` re-verifies all three on the bytes about to be launched, so
 *     a file replaced between "ready" and "install" cannot be executed;
 *   - the installer URL must be a GitHub host (see `isTrustedReleaseHost`).
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import type {
  AppRelease, AppReleaseAsset, AppUpdateAction, AppUpdateActionResult,
  AppUpdateState, CorePorts,
} from '@ytvdlt/shared';
import type { IConfigStore, ILogger } from '@ytvdlt/core';
import { isNewerVersion } from '@ytvdlt/core';
import { fetchLatestRelease, isTrustedReleaseHost, type ReleaseSource } from './github-releases.js';
import { downloadToFile, fileSize, looksLikeExecutable } from './adapters/http-download.js';

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
 * D-104 · a locally persisted hash baseline for releases whose GitHub asset
 * has no `digest` field. Written atomically next to the installer after the
 * first verified download; a cache file without one cannot be trusted.
 */
function sidecarPath(target: string): string { return `${target}.sha256`; }

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

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  const { ports, logger, config } = deps;

  let phase: AppUpdateState['phase'] = 'idle';
  let latest: AppRelease | null = null;
  let message = '';
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  let installerPath: string | null = null;
  /** Hash actually verified on the bytes now in `installerPath` (D-104). */
  let verifiedSha256: string | null = null;
  let lastCheckedAt: string | null = null;
  let disposed = false;

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
      const http = ports.http;
      if (http === undefined) return fail('当前构建不支持网络请求');
      const release = await fetchLatestRelease(http, deps.source);
      await persistCheckTime(ports.clock.nowIso());
      if (release === null) return fail('未能读取发布信息（GitHub 无可用版本）');

      if (!isNewerVersion(release.version, deps.currentVersion)) {
        latest = null;
        installerPath = null;
        verifiedSha256 = null;
        phase = 'idle';
        message = `已是最新版本（${deps.currentVersion}）`;
        return state();
      }

      latest = release;
      installerPath = null;
      verifiedSha256 = null;
      downloadedBytes = 0;
      totalBytes = release.installer?.sizeBytes ?? null;
      phase = 'available';
      message = `发现新版本 ${release.version}`;
      await logger.info('app-update', 'new version available', {
        current: deps.currentVersion, latest: release.version,
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
   * but ONLY after recomputing its SHA-256. Size + `MZ` alone cannot detect a
   * corrupted or substituted cache file. The published `digest` wins; a local
   * sidecar (written at first download) is the fallback when GitHub omits it;
   * with neither, the cache is refused rather than silently trusted.
   */
  async function verifiedCachedFile(
    asset: AppReleaseAsset,
  ): Promise<{ path: string; sha256: string } | null> {
    const path = `${deps.updatesDir}/${safeFileName(asset.name)}`;
    const size = await fileSize(path);
    if (size <= 0) return null;
    if (asset.sizeBytes > 0 && size !== asset.sizeBytes) return null;
    if (!(await looksLikeExecutable(path).catch(() => false))) return null;

    const baseline = asset.sha256 ?? await readSidecar(path);
    if (baseline === null) return null; // fail-closed: no trustworthy baseline
    const expected = baseline.toLowerCase();
    const actual = await ports.hash.sha256File(path).catch(() => null);
    if (actual === null || actual.toLowerCase() !== expected) {
      const isolated = await isolateFile(path, 'checksum-mismatch');
      await logger.warn('app-update', 'cached installer failed SHA-256; isolated and re-downloading', {
        detail: isolated,
      });
      return null;
    }
    // Published digest is authoritative: keep the sidecar in sync for later
    // launches where the API may no longer return a digest.
    if (asset.sha256 !== null && (await readSidecar(path)) !== expected) {
      await writeSidecar(path, expected).catch(() => undefined);
    }
    return { path, sha256: expected };
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

    phase = 'downloading';
    message = `正在下载 ${asset.name}`;
    downloadedBytes = 0;
    totalBytes = asset.sizeBytes > 0 ? asset.sizeBytes : null;
    try {
      const cached = await verifiedCachedFile(asset);
      if (cached !== null) {
        installerPath = cached.path;
        verifiedSha256 = cached.sha256;
        downloadedBytes = asset.sizeBytes;
        phase = 'ready';
        message = '安装包已就绪（复用上次下载，SHA-256 已复验）';
        return state();
      }

      const target = `${deps.updatesDir}/${safeFileName(asset.name)}`;
      const result = await downloadToFile({
        url: asset.url,
        targetPath: target,
        expectedBytes: asset.sizeBytes > 0 ? asset.sizeBytes : null,
        onProgress: (progress) => {
          downloadedBytes = progress.downloadedBytes;
          if (progress.totalBytes !== null) totalBytes = progress.totalBytes;
        },
      });

      // Verification order matters: size, hash, then the PE header. A failure
      // renames the file instead of deleting it, so support can inspect it.
      const problems: string[] = [];
      if (asset.sizeBytes > 0 && result.bytes !== asset.sizeBytes) {
        problems.push(`大小不符（${result.bytes}/${asset.sizeBytes}）`);
      }
      if (asset.sha256 !== null && result.sha256 !== asset.sha256) {
        problems.push('SHA-256 不匹配');
      }
      if (!(await looksLikeExecutable(target))) problems.push('不是有效的 Windows 可执行文件');

      if (problems.length > 0) {
        const rejected = await isolateFile(target, 'rejected');
        await logger.error('app-update', 'installer verification failed', { problems });
        installerPath = null;
        verifiedSha256 = null;
        phase = 'error';
        message = `安装包校验失败：${problems.join('；')}（文件保留为 ${rejected}）`;
        return state();
      }

      // D-104: persist the hash of the bytes we just verified, so a later
      // launch can reuse this cache even when the API returns no digest.
      await writeSidecar(target, result.sha256).catch(async (error: unknown) => {
        await logger.warn('app-update', 'could not write checksum sidecar', {
          detail: error instanceof Error ? error.message : String(error),
        });
      });
      installerPath = target;
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
      const detail = messageOf(error);
      await logger.warn('app-update', 'installer download failed', { detail });
      return fail(`下载失败：${detail}`);
    }
  }

  async function install(): Promise<AppUpdateActionResult> {
    if (installerPath === null || phase !== 'ready') {
      return result(false, 'install', '安装包尚未就绪');
    }
    const executable = installerPath;
    // D-104: the file may have been swapped or damaged AFTER `ready`. Re-run
    // all three checks on the exact bytes we are about to hand to the OS.
    const asset = latest?.installer ?? null;
    const baseline = verifiedSha256 ?? asset?.sha256 ?? await readSidecar(executable);
    const expected = baseline === null || baseline === undefined ? null : baseline.toLowerCase();
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
    phase = latest === null ? 'idle' : 'available';
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
