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
 *   - nothing becomes installable without a size + (when available) SHA-256
 *     match plus a PE header check — a truncated 220 MB exe is the classic
 *     silent failure;
 *   - the installer URL must be a GitHub host (see `isTrustedReleaseHost`);
 *   - `install()` is refused unless the file passed verification.
 */
import { rename } from 'node:fs/promises';
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

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  const { ports, logger, config } = deps;

  let phase: AppUpdateState['phase'] = 'idle';
  let latest: AppRelease | null = null;
  let message = '';
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  let installerPath: string | null = null;
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
        phase = 'idle';
        message = `已是最新版本（${deps.currentVersion}）`;
        return state();
      }

      latest = release;
      installerPath = null;
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

  /** Reuse a previously verified file instead of re-downloading 220 MB. */
  async function verifiedCachedFile(asset: AppReleaseAsset): Promise<string | null> {
    const path = `${deps.updatesDir}/${safeFileName(asset.name)}`;
    const size = await fileSize(path);
    if (size <= 0) return null;
    if (asset.sizeBytes > 0 && size !== asset.sizeBytes) return null;
    if (!(await looksLikeExecutable(path).catch(() => false))) return null;
    return path;
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
        installerPath = cached;
        downloadedBytes = asset.sizeBytes;
        phase = 'ready';
        message = '安装包已就绪（复用上次下载）';
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
        const rejected = `${target}.rejected`;
        await rename(target, rejected).catch(() => undefined);
        await logger.error('app-update', 'installer verification failed', { problems });
        installerPath = null;
        phase = 'error';
        message = `安装包校验失败：${problems.join('；')}（文件保留为 ${rejected}）`;
        return state();
      }

      installerPath = target;
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
    if (!(await looksLikeExecutable(executable).catch(() => false))) {
      return result(false, 'install', '安装包损坏，请重新下载');
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
