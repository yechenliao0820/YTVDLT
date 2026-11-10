/**
 * electron-entry — the ONLY runtime file that imports `electron` and builds the
 * production dependency graph (M5-0).
 *
 * Status: typechecked, NOT executed. `node_modules/electron/dist` has no binary
 * in this environment (B1/D-39), so this is the seam that the packaging block
 * (M5-4, needs N1) runs for the first time. Everything it composes — ports,
 * logger, error mapper, verifier, engine, host, window, tray — is already tested
 * individually, and `bootstrap()` is tested with fakes.
 *
 * Known gap carried over from M3 (D-31): the fixture-driven PROBE channel is
 * still the renderer's probe path; replacing it with `engine.probe()` belongs to
 * the same N1 block.
 */
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell, Tray } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CorePorts, EngineUpdateSource } from '@ytvdlt/shared';
import { ArtifactVerifier, ErrorMapper, Logger, expandEnvVars, type IConfigStore } from '@ytvdlt/core';
import { createEngine } from '@ytvdlt/engine-ytdlp';
import { createNodePorts } from './adapters/node-ports.js';
import { createElectronShellPort } from './adapters/electron-shell-port.js';
import { createPathPicker } from './adapters/path-picker.js';
import { createLocalFileStatusPort, createTrashFilesPort } from './adapters/local-file-status-port.js';
import { resolveFixtureDir, resolveRuntimeDir } from './runtime-paths.js';
import { createNodeProbePort, resolveDataDir } from './data-dir.js';
import { createQueueIntakeGate } from './adapters/queue-intake-gate.js';
import { LocalDirUpdateSource } from './adapters/local-dir-update-source.js';
import { createAppUpdateService, type AppUpdateService } from './app-update-service.js';
import { createThumbnailCache, type ThumbnailCache } from './thumbnail-cache.js';
import {
  createComponentUpdater, type ComponentUpdatePort,
} from './component-updater.js';
import { createM5Host, type M5Host } from './m5-host.js';
import { bootstrap, type BootstrapHandle, type ElectronLike } from './bootstrap.js';
import type { AppUpdatePortLike } from './m5-channels.js';

/** The public repository the updater reads (D-93). */
export const UPDATE_REPO = Object.freeze({ owner: 'yechenliao0820', repo: 'YTVDLT' });

/** yt-dlp publishes `yt-dlp.exe` + `SHA2-256SUMS` at this stable redirect. */
export const YTDLP_COMPONENT_FEED = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
export const YTDLP_VERSION_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

export interface StartOptions {
  /** Defaults to `process.argv`. */
  readonly argv?: readonly string[];
  /** Absolute path of `pages/queue/index.html` inside the installed app. */
  readonly pageUrl: string;
  readonly preloadPath: string;
  readonly trayIconPath: string;
  /** `resources/runtime/win-x64/runtime-manifest.json` (dev) or `resources/runtime/...`. */
  readonly manifestPath?: string;
}

/** Assemble the Electron surface as a plain object (also the test seam). */
export function electronSurface(): ElectronLike {
  return {
    app: app as unknown as ElectronLike['app'],
    ipcMain: ipcMain as unknown as ElectronLike['ipcMain'],
    BrowserWindow: BrowserWindow as unknown as ElectronLike['BrowserWindow'],
    nativeTheme: nativeTheme as unknown as ElectronLike['nativeTheme'],
    Tray: Tray as unknown as ElectronLike['Tray'],
    Menu: Menu as unknown as ElectronLike['Menu'],
    clipboard: clipboard as unknown as ElectronLike['clipboard'],
  };
}

export async function startApplication(options: StartOptions): Promise<BootstrapHandle | null> {
  const packaged = app.isPackaged;
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
  const runtimeDir = resolveRuntimeDir({
    isPackaged: () => packaged,
    resourcesPath: () => resourcesPath,
  });
  // Executable directory; the portable target runs from a temp unpack dir, so
  // `PORTABLE_EXECUTABLE_DIR` (set by electron-builder) wins when present —
  // that is the folder the user actually sees.
  const exeDir = process.env['PORTABLE_EXECUTABLE_DIR']
    ?? (packaged ? dirname(app.getPath('exe')) : process.cwd());
  const dataDir = await resolveDataDir(
    { exeDir, fallbackDir: join(app.getPath('appData'), 'YTVDLT'), isPackaged: packaged },
    createNodeProbePort(),
  );
  const appDataDir = dataDir.dataDir;
  const configDir = dataDir.configDir;
  const logsDir = dataDir.logsDir;
  const fixtureDir = resolveFixtureDir(
    { isPackaged: () => packaged, resourcesPath: () => resourcesPath },
    process.cwd(),
  );
  const appVersion = app.getVersion();
  /**
   * D-117: the real Windows "Videos" library — `app.getPath('videos')` follows
   * the known-folder redirect (OneDrive, a moved library, a non-ASCII profile)
   * where `%USERPROFILE%\Videos` would silently point at the wrong place. It is
   * handed to the `%VAR%` expander as an extra key rather than written into
   * `process.env`: the latter would leak into every child process and could be
   * shadowed by a real variable of the same name.
   */
  const videosDir = app.getPath('videos');
  const pathEnv: Record<string, string | undefined> = { ...process.env, USERVIDEOS: videosDir };

  // D-88: shared by the private-mode cleanup hooks and the queue intake gate.
  // It is assigned inside createHost(), which bootstrap() awaits before the
  // first window close can happen.
  let hostRef: M5Host | null = null;
  // D-103: the cache is assembled inside createHost(), but the private-mode
  // cleanup and the boot auto-prune live in this scope. Mutable holders keep
  // the dependency direction one-way (same pattern as `hostRef`).
  let configRef: IConfigStore | null = null;
  let thumbnailsRef: ThumbnailCache | null = null;

  /** Clear history only when `general.privateMode` is on; never touches files. */
  const clearPrivateHistory = async (): Promise<void> => {
    const host = hostRef;
    if (host === null) return;
    try {
      if (host.m4.task.config.get('general', 'privateMode') !== true) return;
      for (const record of host.m4.task.queue.list()) {
        if (record.state === 'Running' || record.state === 'FetchingInfo') continue;
        await host.m4.task.queue.remove(record.id);
        // D-103: drop the cover reference too; the file is recycled by a later
        // prune pass, never here (shutdown must not touch the filesystem).
        thumbnailsRef?.forget(record.id);
      }
    } catch {
      // Best effort: a failed snapshot write must never block shutdown.
    }
  };

  // Give the async snapshot write a chance to finish before the process exits.
  // `preventDefault` is used exactly once; the second quit passes through.
  let cleanupStarted = false;
  app.on('before-quit', (event) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    event.preventDefault();
    void Promise.race([
      clearPrivateHistory(),
      new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
    ]).finally(() => { app.quit(); });
  });

  const createHost = async () => {
    const ports = createNodePorts({
      packaged,
      resourcesPath,
      runtimeDir,
      appDataDir,
      configDir,
      logsDir,
      appVersion,
      shell: createElectronShellPort(shell),
    });
    const logger = new Logger({ ports, appVersion });
    const mapper = new ErrorMapper();
    const verifier = new ArtifactVerifier({ ports });
    const enginePath = join(runtimeDir, 'yt-dlp.exe');
    const aria2cPath = join(runtimeDir, 'aria2c.exe');

    // The engine exists before the host, the queue exists inside the host:
    // a lazy gate is what breaks that cycle (§3.4).
    const intakeGate = createQueueIntakeGate(() => hostRef?.m4.task.queue);
    const updateSource = resolveEngineUpdateSource(ports, runtimeDir);

    const engine = createEngine('ytdlp', {
      ports,
      logger,
      mapper,
      enginePath,
      jsRuntimePath: join(runtimeDir, 'node.exe'),
      fixturesDir: fixtureDir,
      appVersion,
      ...(updateSource === null ? {} : { updateSource }),
      intakeGate,
    });

    // D-67: the updater needs the host's ConfigStore, the host needs the
    // updater for its IPC surface — a mutable holder breaks the cycle, exactly
    // like the queue intake gate above.
    let componentUpdater: ComponentUpdatePort | null = null;
    const componentUpdateProxy = {
      status: async () => componentUpdater === null
        ? { components: [], source: null, updating: false }
        : componentUpdater.status(),
      check: async () => componentUpdater === null
        ? { checkedAt: '', results: [] }
        : componentUpdater.check(),
      run: async () => componentUpdater === null
        ? { ok: false, source: null, reason: '组件更新尚未就绪', results: [] }
        : componentUpdater.run(),
    };

    // 0.2.1 (D-93): same mutable-holder trick for the app updater.
    let appUpdater: AppUpdateService | null = null;
    const appUpdateProxy: AppUpdatePortLike = {
      state: () => appUpdater === null
        ? {
          phase: 'idle', currentVersion: appVersion, latest: null, message: '更新器尚未就绪',
          downloadedBytes: 0, totalBytes: null, skippedVersion: null,
          lastCheckedAt: null, canAutoInstall: false,
        }
        : appUpdater.state(),
      perform: async (action) => appUpdater === null
        ? {
          ok: false, action, message: '更新器尚未就绪',
          state: {
            phase: 'idle', currentVersion: appVersion, latest: null, message: '',
            downloadedBytes: 0, totalBytes: null, skippedVersion: null,
            lastCheckedAt: null, canAutoInstall: false,
          },
        }
        : appUpdater.perform(action),
    };

    // 0.2.1 (D-96): covers are cached next to the config, never hot-linked.
    // D-103: the same cache now owns its own retention. All policy values come
    // from `advanced.*` in config.json, so the Settings page and a manual edit
    // of the config file are the same source of truth.
    const numeric = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const thumbnails = createThumbnailCache({
      dir: join(dataDir.dataDir, 'thumbs'),
      ...(ports.http === undefined ? {} : { http: ports.http }),
      logger,
      liveTaskIds: () => (hostRef?.m4.task.queue.list().map((item) => item.id) ?? []),
      policy: () => ({
        enabled: configRef?.get('advanced', 'autoCleanThumbnailCache') !== false,
        maxBytes: numeric(configRef?.get('advanced', 'thumbnailCacheMaxBytes'), 128 * 1024 * 1024),
        maxFiles: numeric(configRef?.get('advanced', 'thumbnailCacheMaxFiles'), 500),
        maxAgeDays: numeric(configRef?.get('advanced', 'thumbnailCacheMaxAgeDays'), 30),
      }),
      setPolicy: async (patch) => {
        const config = configRef;
        if (config === null) return;
        const next: Record<string, unknown> = {};
        if (patch['enabled'] !== undefined) next['autoCleanThumbnailCache'] = patch['enabled'];
        if (patch['maxBytes'] !== undefined) next['thumbnailCacheMaxBytes'] = patch['maxBytes'];
        if (Object.keys(next).length > 0) await config.setDomain('advanced', next);
      },
      // §0.1 of the maintenance handbook: the ONLY deletion primitive is the
      // OS recycle bin. Nothing in the cache adapter can permanently unlink.
      trash: async (path) => {
        try { await shell.trashItem(path); return true; }
        catch { return false; }
      },
    });
    thumbnailsRef = thumbnails;

    const host = await createM5Host({
      ports,
      engine,
      verifier,
      jsRuntimePath: join(runtimeDir, 'node.exe'),
      videoFixturePath: join(fixtureDir, 'info-video.json'),
      playlistFixturePath: join(fixtureDir, 'info-flat-playlist.json'),
      appVersion,
      engineVersion: 'unknown (resolved at runtime by check-runtime)',
      dataDir: dataDir.dataDir,
      dataDirReason: dataDir.reason,
      ...(existsSync(aria2cPath) ? { bundledAria2cPath: aria2cPath } : {}),
      componentUpdate: componentUpdateProxy,
      appUpdate: appUpdateProxy,
      thumbnails,
      // 0.2.1 (D-98): the output root is user-selectable. Expansion happens here
      // (main owns `process.env`); the channel layer only persists/validates.
      // D-117: `%USERVIDEOS%` is NOT a Windows variable — `app.getPath('videos')`
      // is the only API that follows a OneDrive / folder redirect, so it is
      // injected into the expansion map instead of being read from the process.
      expandPath: (raw: string) => expandEnvVars(raw, pathEnv),
      // D-117: manifests and child-process temp files live under `<dataDir>/work`,
      // never in the folder the user browses for their videos.
      internalWorkDir: join(dataDir.dataDir, 'work'),
      pathPicker: createPathPicker(),
      clipboard: { writeText: async (text: string) => { clipboard.writeText(text); } },
      systemAppearance: {
        prefersDark: () => nativeTheme.shouldUseDarkColors,
        // Reduced motion is a CSS media query; the renderer owns it (theme.js).
        prefersReducedMotion: () => false,
        accent: () => null,
      },
      // D-87 / D-120: `shell.trashItem` is STILL the only deletion primitive
      // (Windows Recycle Bin, never a permanent unlink). The adapter now returns
      // one outcome per path so ENOENT counts as "already clean" while a real
      // OS error keeps the record and reports its actual reason. See
      // `adapters/local-file-status-port.ts`.
      trashFiles: createTrashFilesPort((path) => shell.trashItem(path)),
      // D-120: on-demand `stat` of recorded artifact paths only. No directory
      // scan, no renderer filesystem access; short TTL + forced re-checks.
      fileStatus: createLocalFileStatusPort(),
    });
    hostRef = host;
    configRef = host.m4.task.config;

    componentUpdater = createComponentUpdater({
      ports,
      logger,
      components: [
        {
          id: 'yt-dlp',
          label: 'yt-dlp',
          fileName: 'yt-dlp.exe',
          path: enginePath,
          feedUrl: YTDLP_COMPONENT_FEED,
          versionApiUrl: YTDLP_VERSION_API,
        },
        {
          id: 'aria2c',
          label: 'aria2c',
          fileName: 'aria2c.exe',
          path: aria2cPath,
          // aria2c publishes no SHA2-256SUMS at a stable URL: it follows the
          // operator mirror only, and stays hidden as "updatable" otherwise.
          feedUrl: null,
          versionApiUrl: null,
        },
      ],
      baseUrl: resolveComponentFeed(host.m4.task.config),
      intakeGate,
    });

    // 0.2.1 (D-94): the engine gets its own startup check, throttled to once a
    // day. It stays silent (a log line only) — a stale yt-dlp is worth telling
    // the user about in Settings, not worth interrupting start-up with a modal.
    const engineAuto = host.m4.task.config.get<boolean>('advanced', 'autoCheckEngineUpdate') !== false;
    const lastEngineRaw = host.m4.task.config.get<string>('advanced', 'lastEngineUpdateCheckAt');
    const lastEngineMs = typeof lastEngineRaw === 'string' && lastEngineRaw.trim() !== ''
      ? Date.parse(lastEngineRaw)
      : Number.NaN;
    const engineDue = Number.isNaN(lastEngineMs) || Date.now() - lastEngineMs >= 24 * 60 * 60 * 1000;
    if (engineAuto && engineDue) {
      void componentUpdater.check().then(async (report) => {
        await host.m4.task.config.setDomain('advanced', {
          lastEngineUpdateCheckAt: ports.clock.nowIso(),
        });
        const updatable = report.results.filter((item) => item.updateAvailable);
        if (updatable.length > 0) {
          await logger.info('component-check', 'engine update available', {
            components: updatable.map((item) => `${item.id}:${item.installedVersion}->${item.latestVersion}`),
          });
        }
      }).catch(() => undefined);
    }

    // 0.2.1 (D-93): the app updater, now on GitHub Releases rather than the
    // electron-updater generic feed (which needs `latest.yml` we do not publish).
    appUpdater = createAppUpdateService({
      ports,
      logger,
      config: host.m4.task.config,
      currentVersion: appVersion,
      source: UPDATE_REPO,
      updatesDir: join(dataDir.dataDir, 'updates'),
      openExternal: async (url: string) => { await shell.openExternal(url); },
      openPath: async (path: string) => shell.openPath(path),
      quit: () => { app.quit(); },
    });

    // Covers: one attempt per task, triggered the moment the probe result is
    // known (first progress event) and once at boot for restored tasks.
    // D-103: `ensure()` now hits the local file first, so the boot restore is
    // also what rebuilds the task -> cover references before the first prune.
    const ensureCover = (taskId: string): Promise<string | null> => {
      const record = host.m4.task.queue.get(taskId);
      const url = record?.mediaInfo?.thumbnail ?? null;
      return url === null ? Promise.resolve(null) : thumbnails.ensure(taskId, url);
    };
    host.m4.task.queue.onEvent((event) => {
      if (event.type === 'progress') { void ensureCover(event.taskId); return; }
      if (event.type === 'state-changed' && event.to === 'Running') void ensureCover(event.taskId);
    });
    let bootCovers = 0;
    const bootCoverAttempts: Promise<string | null>[] = [];
    for (const record of host.m4.task.queue.list()) {
      if (bootCovers >= 20) break;
      if (record.mediaInfo?.thumbnail) { bootCoverAttempts.push(ensureCover(record.id)); bootCovers += 1; }
    }
    // Never delay the first frame, and never prune before the references above
    // have been attached. A failed/slow fetch cannot block housekeeping.
    void Promise.allSettled(bootCoverAttempts).then(async () => {
      if (configRef?.get('advanced', 'autoCleanThumbnailCache') === false) return;
      await thumbnails.prune();
    }).catch(() => undefined);

    // Never awaited: a slow network must not delay the first frame.
    if (appUpdater.shouldAutoCheck()) void appUpdater.check();
    await logger.info('data-dir', 'resolved', {
      mode: dataDir.mode, dataDir: dataDir.dataDir, reason: dataDir.reason,
    });

    return host;
  };

  return bootstrap(electronSurface(), {
    pageUrl: options.pageUrl,
    preloadPath: options.preloadPath,
    trayIconPath: options.trayIconPath,
    argv: options.argv ?? process.argv,
    createHost,
    onSystemAppearanceChanged: () => { /* renderer re-reads SETTINGS_GET on focus */ },
    onWindowClose: clearPrivateHistory,
    platform: process.platform,
  });
}

/**
 * Where engine bytes come from (M5-5).
 *
 * The official HTTPS release feed is 国际网 (N3) and therefore out of scope for
 * this round. What IS supported is an operator-supplied directory — an intranet
 * share or a USB stick holding `yt-dlp.exe` + `SHA2-256SUMS` — which is exactly
 * how a domestic/offline deployment would ship an engine update:
 *
 *     YTVDLT_ENGINE_SOURCE_DIR=D:/updates/yt-dlp
 *
 * Without the variable there is no source, and `selfUpdate()` reports
 * "nothing changed" instead of pretending.
 */
function resolveEngineUpdateSource(ports: CorePorts, _runtimeDir: string): EngineUpdateSource | null {
  const dir = (process.env['YTVDLT_ENGINE_SOURCE_DIR'] ?? '').trim();
  if (dir === '') return null;
  return new LocalDirUpdateSource({ dir, ports });
}

/**
 * One background app-update attempt. Never awaited by the window path: a slow
 * or broken feed must not delay start-up by a single frame.
 *
 * The updater module is imported lazily AND only when a feed is configured, so
 * a build without `electron-updater` in the asar still starts cleanly.
 */
/**
 * Where the component feed lives (D-67). Empty = feature disabled, and the
 * settings button explains why instead of failing silently.
 *
 * Precedence: `YTVDLT_COMPONENT_FEED` (deployment override) →
 * `advanced.componentFeedUrl` (user setting). Only http(s) is accepted.
 *
 * 0.2.1 (D-94): yt-dlp no longer depends on this — it carries its own official
 * feed. This value now only feeds components that have no feed of their own
 * (aria2c), which is the domestic-mirror case.
 */
function resolveComponentFeed(config: M5Host['m4']['task']['config']): string | null {
  const fromEnv = (process.env['YTVDLT_COMPONENT_FEED'] ?? '').trim();
  const raw = fromEnv !== ''
    ? fromEnv
    : String(config.get<string>('advanced', 'componentFeedUrl') ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : null;
}

/**
 * The `electron-updater` path (`app-updater.ts`) is deliberately no longer
 * called from start-up: the public releases ship no `latest.yml`, so the
 * generic feed can only answer 404. `app-update-service.ts` replaces it with a
 * GitHub-Releases check that verifies the installer itself before running it.
 * `app-updater.ts` stays compiled because its coordinator/interval rules are
 * still the reference for a future self-hosted feed (D-93).
 */
