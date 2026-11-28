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
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, session, shell, Tray,
} from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { CorePorts, EngineUpdateSource } from '@ytvdlt/shared';
import {
  ArtifactVerifier, ErrorMapper, Logger, expandEnvVars, hasUnresolvedEnvToken,
  purgePrivateRecords, PRIVATE_OUTPUT_DIR,
  type IConfigStore,
} from '@ytvdlt/core';
import { createEngine } from '@ytvdlt/engine-ytdlp';
import { createNodePorts } from './adapters/node-ports.js';
import {
  createElectronUpdateNetwork, type UpdateNetworkSurface,
} from './adapters/electron-update-network.js';
import { createElectronShellPort } from './adapters/electron-shell-port.js';
import { createPathPicker } from './adapters/path-picker.js';
import { createLocalFileStatusPort, createTrashFilesPort } from './adapters/local-file-status-port.js';
import { createTempDirIo } from './adapters/temp-dir-io.js';
import { realInstallerWaiter } from './installer-waiter.js';
import { discardTaskTempDir, sweepEmptyTempDirs, tempDirOf } from './task-temp-cleanup.js';
import { createWinStartup } from './adapters/win-startup.js';
import { resolveFixtureDir, resolveRuntimeDir } from './runtime-paths.js';
import {
  checkRuntimeForApp, missingRequiredLabels, resolvedEngineVersion, runtimeCheckErrorMessage,
} from './runtime-resolver.js';
import { createNodeProbePort, resolveDataDir } from './data-dir.js';
import { createQueueIntakeGate } from './adapters/queue-intake-gate.js';
import { LocalDirUpdateSource } from './adapters/local-dir-update-source.js';
import { createAppUpdateService, type AppUpdateService } from './app-update-service.js';
import { cleanupCompletedUpdate, createUpdateCleanupFiles, sweepLegacyInstallers } from './app-update-cleanup.js';
import { createThumbnailCache, type ThumbnailCache } from './thumbnail-cache.js';
import {
  createComponentUpdater, allowedComponentFeed, type ComponentUpdatePort,
} from './component-updater.js';
import { createM5Host, type M5Host } from './m5-host.js';
import { readSiteSupportNetwork } from './site-support-network.js';
import { createTxtFilePicker } from './adapters/txt-file-picker.js';
import { createSubtitlePreviewService, type SubtitlePreviewService } from './subtitle-preview-service.js';
import { bootstrap, type BootstrapHandle, type ElectronLike } from './bootstrap.js';
import {
  SHUTDOWN_CANCEL_BUDGET_MS, cancelRunningTasksForShutdown,
} from './shutdown-cancel.js';
import { installShutdownQuitGate } from './shutdown-quit-gate.js';
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
    // D-198: the ACTUAL wiring point of the D-170 permission gate. Without this
    // key, `electron.session?.defaultSession` in bootstrap() short-circuits and
    // the deny-all handlers are never installed in a real Electron run. Only
    // unit-test fakes that omit `session` keep the silently-skipped behaviour.
    session: session as unknown as NonNullable<ElectronLike['session']>,
  };
}

/**
 * D-214: the ONLY production injection point of Electron's Chromium network
 * stack for the UPDATE channel. `net.request()` (never `node:http(s)`) gives
 * both updaters OS proxy / PAC / WPAD / TUN routing, while the application's
 * default session — and therefore ordinary page, thumbnail and pre-check
 * traffic — is left exactly as it was. The structural cast is the same seam
 * `electronSurface()` uses: offline unit tests inject a fake surface instead
 * of loading the Electron binary (B1/D-39).
 */
export function electronUpdateNetworkSurface(): UpdateNetworkSurface {
  return { net, session } as unknown as UpdateNetworkSurface;
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
  /**
   * Subtitle preview (stage 2): holds probe results keyed by an opaque ticket,
   * so a user who never opens the subtitle picker never triggers a probe. The
   * tickets die with the process — `before-quit` clears them explicitly.
   */
  let subtitlePreviewRef: SubtitlePreviewService | null = null;
  /**
   * Delivery report 五-1: bootstrap's tray-creation fallback logs through the
   * real Logger so a packaged failure lands in the JSONL log under <dataDir>/logs
   * (a bare console fallback would be invisible in a windowed packaged build).
   * The Logger is constructed INSIDE createHost() — it needs the ports object
   * that is only assembled there — so this holder (same mutable-ref pattern as
   * `hostRef`/`configRef` above) is filled the moment it exists. bootstrap()
   * awaits createHost() BEFORE it reaches the tray step, so the ref is always
   * set by the time the tray logger can fire; before that it degrades to
   * console via `forwardLog` below.
   */
  let loggerRef: Logger | null = null;

  /**
   * D-232 (audit P2): purge the records THIS user mark as private, and nothing
   * else. The old hook cleared every non-running row whenever the switch was on,
   * which destroyed ordinary downloads the user had kept for days — see
   * `core/src/task-queue/private-cleanup.ts` for the two rules (record flag,
   * never a running slot). The switch position is deliberately NOT consulted:
   * the flag was captured at enqueue time and is what the download actually did,
   * so flipping the toggle off before closing cannot leave a "private" row
   * behind. Files are never touched — only the queue row.
   *
   * D-240 (audit P1): the snapshot part of that sentence is obsolete. Private
   * rows are excluded from `tasks.json` at the write boundary and dropped by
   * `restore()`, so a crash / kill (which runs no close hook) cannot resurrect
   * them either. This purge is now the in-memory tidy-up: it keeps the list
   * clean for the rest of the session and stops settled rows from reappearing
   * when the window is reopened from the tray. A running download is still
   * skipped, never killed.
   *
   * D-242: `queue.remove()` now REJECTS when the snapshot write fails instead
   * of reporting a removal that never reached disk; the catch below still
   * swallows it because shutdown must not be blocked by a broken disk, but the
   * failure is no longer silent to the queue's own logging.
   *
   * D-252: the purge now also settles the COVER cache layer. `forget()` only
   * dropped the in-memory reference, so a private task's cover file and its
   * `index.json` entry waited for a prune pass — one gated by the
   * `autoCleanThumbnailCache` SPACE-hygiene switch and by future `ensure()`
   * traffic, which let the jpg sit in `<dataDir>/thumbs/` indefinitely. After
   * the rows are removed, `purgeCovers(report.removed)` recycles the covers
   * those ids own EXCLUSIVELY through the cache's regular guarded trash path
   * (isSafeCacheName + directory prefix + shell.trashItem — the same primitive
   * the settings-page button and every prune pass already use during a live
   * session; the cover cache is application-internal bytes, NOT the user media
   * D-232 protects). A close-to-tray keeps the app alive, so touching the cache
   * there is ordinary housekeeping; on the real-quit path the call already runs
   * inside the 3 s budget race below and `purgeCovers` never throws. Before any
   * byte is touched the entries are marked `purgePending` in `index.json` (a
   * boolean, no private data), so a trash failure or an exit mid-delete is
   * recovered by the NEXT boot's prune pass — switch-independent, never
   * indefinite. Shared covers (any other task id in the entry) and files of
   * tasks that are still running are left alone, exactly like `prune()`.
   */
  const clearPrivateHistory = async (): Promise<void> => {
    const host = hostRef;
    if (host === null) return;
    try {
      const tempDirIo = createTempDirIo();
      const report = await purgePrivateRecords(
        {
          list: () => host.m4.task.queue.list(),
          remove: (taskId) => host.m4.task.queue.remove(taskId),
        },
        // D-103: drop the cover reference too. The FILE decision now happens
        // right below (D-252) — exclusivity-proven covers go to the recycle
        // bin, everything else waits for a prune pass as before.
        (taskId) => thumbnailsRef?.forget(taskId),
        // D-292: the record is gone, so its per-task temp dir can never be
        // resumed — without this hook a cancelled private download left a
        // title-bearing `.part` under `<private>/work/<taskId>/` forever (the
        // boot sweep only removes EMPTY managed dirs). Same guarded path the
        // manual-delete wiring uses; best effort, a temp-dir hiccup must never
        // stop the remaining rows from being purged.
        (record) => {
          void discardTaskTempDir(tempDirIo, tempDirOf(record), record.id).catch(() => undefined);
        },
      );
      if (report.removed.length > 0) await thumbnailsRef?.purgeCovers(report.removed);
    } catch {
      // Best effort: a failed snapshot write must never block shutdown.
    }
  };

  // Give the async snapshot write a chance to finish before the process
  // exits: the race below stays bounded by 3 s, and the first quit is
  // prevented exactly once while the cleanup runs.
  //
  // D-247: the first (real) quit now ALSO stops in-flight downloads. Until this
  // fix the quit path ended the process while `yt-dlp` children kept running —
  // orphans consuming bandwidth, writing `.part` files and desynchronising task
  // state across restarts. Cancellation goes through the queue's EXISTING
  // public API (`TaskQueue.cancel()` -> engine handle -> `killTree()` with a
  // bounded exit-evidence wait, D-142/D-156/坑 21/坑 27); the wait for the
  // slots to drain is bounded by SHUTDOWN_CANCEL_BUDGET_MS and a budget
  // expiry only degrades to a WARNING — a hung taskkill must not wedge the
  // quit. D-255: the same budget now also covers every cancel PROMISE (a
  // queued task settles via the D-242 snapshot write) and the report's
  // per-task outcomes are logged below — a silent write failure can no longer
  // read as a clean cancel. Cancelled tasks settle as `Canceled` and are
  // retried BY HAND after a restart (D-209: startup never auto-resumes).
  //
  // D-257 (external audit P2): the old `cleanupStarted` latch let EVERY second
  // `before-quit` pass unconditionally — correct only when that second quit is
  // the cleanup's own `app.quit()`, but a USER quit inside the cleanup window
  // takes the same path (menu 「退出」 sets `quitting = true` -> Alt+F4 / 点 X
  // closes the window, which the close→tray policy deliberately does not
  // intercept while quitting -> window destroyed -> `window-all-closed` ->
  // `app.quit()`), killing the process mid-cleanup and cutting the 5 s cancel
  // budget, D-255's snapshot-write wait and the 3 s private purge (purgeCovers
  // included) short. `installShutdownQuitGate` prevents and suspends every
  // re-entry while the cleanup promise below is in flight and resumes
  // `app.quit()` the moment it settles; the cleanup's own final quit passes
  // through the gate's `cleanupSettled` latch (set before it calls quit, so
  // no quit loop). The close→tray policy (D-60/D-197) and bootstrap's
  // `quitting` flag are untouched — hiding to the tray never reaches this
  // handler, and the window-close purge still runs via `onWindowClose`.
  installShutdownQuitGate(app, async () => {
    try {
      const queue = hostRef?.m4.task.queue ?? null;
      if (queue !== null) {
        const report = await cancelRunningTasksForShutdown(queue);
        // D-255: per-task cancel evidence. `persist-failed` (D-242: the record
        // was put back and is still on disk — it revives after a restart),
        // `kill-unconfirmed` (D-142) and `unsettled` (pending at budget
        // expiry) must no longer read as a clean cancel in this log.
        const failed = report.tasks.filter((task) => task.outcome !== 'confirmed');
        const failedNote = failed
          .map((task) => `${task.taskId}=${task.outcome}${task.reason === undefined ? '' : ` (${task.reason})`}`)
          .join(', ');
        if (!report.drained) {
          forwardLog('warn', 'shutdown', 'quit proceeded while downloads were still stopping', {
            requested: report.requested,
            stillActive: report.stillActive.join(', '),
            budgetMs: SHUTDOWN_CANCEL_BUDGET_MS,
            ...(failedNote === '' ? {} : { cancelFailures: failedNote }),
          });
        } else if (failedNote !== '') {
          forwardLog('warn', 'shutdown', 'quit proceeded with unconfirmed cancel results', {
            requested: report.requested,
            cancelFailures: failedNote,
          });
        } else if (report.requested > 0) {
          forwardLog('info', 'shutdown', 'in-flight downloads cancelled before quit', {
            requested: report.requested,
          });
        }
      }
      // Subtitle preview (stage 2): tickets are pure main-process memory; drop
      // them synchronously so an expired/abandoned id can never survive a quit.
      subtitlePreviewRef?.dispose();
      // Playlist preview tickets hold full PlaylistInfo (entry URLs included);
      // they are main-process memory only and must not survive a quit.
      hostRef?.playlistPreview.clear();
    } finally {
      // Give the async snapshot write a chance to finish before the process
      // exits. The 3 s race is the SAME bound as before D-257 (a hung purge
      // must not wedge the quit); the gate resumes the exit the moment this
      // settles, so the budget semantics are byte-for-byte unchanged.
      await Promise.race([
        clearPrivateHistory(),
        new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
      ]);
    }
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
    /**
     * D-214: ONE update-only network object shared by BOTH update chains.
     * `readProxy` is LAZY — the ConfigStore does not exist yet at this point,
     * and reading `network.proxy` at the start of each request means a settings
     * change applies to the NEXT request without re-routing a download already
     * in flight. `''` means "use the OS proxy" (never force DIRECT).
     */
    const updateNetwork = createElectronUpdateNetwork({
      surface: electronUpdateNetworkSurface(),
      readProxy: () => {
        if (configRef === null) return '';
        const raw = configRef.getDomain('network')['proxy'];
        if (raw === undefined || raw === null) return '';
        // A malformed non-string value must surface as an INVALID proxy error
        // in parseUpdateProxy(), never silently degrade into "no proxy".
        return typeof raw === 'string' ? raw : String(raw);
      },
    });
    /**
     * Update modules get their OWN ports object: even a stray `ports.http`
     * read inside an updater lands on the update transport. Thumbnails, URL
     * pre-checks and the rest of the host keep the original D-143-pinned ports.
     */
    const updatePorts: CorePorts = { ...ports, http: updateNetwork.httpPort };
    const logger = new Logger({ ports, appVersion });
    loggerRef = logger;
    // D-169: the runtime was never checked at start-up. `checkRuntimeForApp()`
    // existed since M1 and had ZERO callers, so a build shipped without
    // `yt-dlp.exe` / `node.exe` / `ffmpeg` opened a perfectly normal window and
    // failed on the first download with a confusing spawn error. Check once, log
    // the full report, and tell the user in their own words when a REQUIRED
    // component is missing. Deliberately non-fatal: the queue, history, settings
    // and cover cache still work, and refusing to start would be worse.
    const runtimeReport = await checkRuntimeForApp(
      { isPackaged: packaged, resourcesPath, appVersion },
      // D-169 follow-up: hash verdicts for the ~279 MB of required files are
      // cached by (path, size, mtimeMs) in the data dir, so a healthy install
      // re-hashes nothing before the first window; a corrupt cache degrades to
      // hashing everything (fail closed).
      { cachePath: join(dataDir.dataDir, 'runtime-hash-cache.json') },
    ).catch((error: unknown) => {
      void logger.warn('runtime', 'start-up check threw', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (runtimeReport !== null && runtimeReport.allRequiredOk) {
      await logger.info('runtime', 'start-up check ok', {
        runtimeDir: runtimeReport.runtimeDir,
        requiredOk: runtimeReport.summary.requiredOk,
        optionalMissing: runtimeReport.summary.optionalMissing,
      });
    } else if (runtimeReport !== null) {
      const missing = missingRequiredLabels(runtimeReport);
      await logger.error('runtime', 'start-up check failed', {
        runtimeDir: runtimeReport.runtimeDir,
        missing,
        failed: runtimeReport.summary.failed,
      });
      if (packaged) {
        dialog.showErrorBox('YTVDLT - runtime incomplete', runtimeCheckErrorMessage(runtimeReport));
      }
    }
    // D-169 follow-up: the check above already probed `yt-dlp.exe --version`;
    // backfill it into the error report (and the engine's own error context)
    // instead of keeping a dead 'unknown (resolved at runtime …)' string.
    const engineVersion = resolvedEngineVersion(runtimeReport);

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
      // The version probed at start-up feeds the engine's own error context
      // (previously a hardcoded fallback); omitted when the check failed.
      ...(engineVersion === 'unknown' ? {} : { engineVersion }),
      ...(updateSource === null ? {} : { updateSource }),
      intakeGate,
    });

    /**
     * Subtitle preview (stage 2).
     *
     * Constructing this service costs nothing: no probe runs until the renderer
     * explicitly asks for one, so a user who never opens the picker pays no
     * extra network call. It reuses `engine.probe` (the frozen five-method
     * contract stays five methods) and keeps the resulting `MediaInfo` in the
     * ticket cache, which is what lets the enqueue path skip the queue's own
     * probe later.
     */
    const subtitlePreview = createSubtitlePreviewService({
      probe: (url: string) => engine.probe(url, {
        jsRuntimePath: join(runtimeDir, 'node.exe'),
        noPlaylist: true,
      }),
      clock: ports.clock,
      newId: () => randomUUID(),
      logger,
    });
    subtitlePreviewRef = subtitlePreview;

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
          releaseNotes: [], omittedReleaseNotes: 0,
          downloadedBytes: 0, totalBytes: null, skippedVersion: null,
          lastCheckedAt: null, canAutoInstall: false,
        }
        : appUpdater.state(),
      perform: async (action) => appUpdater === null
        ? {
          ok: false, action, message: '更新器尚未就绪',
          state: {
            phase: 'idle', currentVersion: appVersion, latest: null, message: '',
            releaseNotes: [], omittedReleaseNotes: 0,
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
      // D-288: when the pinned cover fetch is refused because the system proxy
      // handed back a Fake-IP (198.18.0.0/15), retry the same https URL through
      // Chromium's stack — the transport D-214 already gave the update channel.
      // Its default policy is `isPublicHttpsUrl`; the bytes still have to pass
      // the image-signature + size checks in the cache.
      fetchViaProxy: (url, limits) => updateNetwork.httpPort.getBytes(url, {
        timeoutMs: limits.timeoutMs,
        maxBytes: limits.maxBytes,
      }),
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
      // D-135 (R1-01/R1-02): the pre-check needs the SAME engine identity and
      // the SAME network the download will use.
      //  - `enginePath` is half the catalog cache key. Omitting it made the key
      //    `"::<version>"`, which never matched the slot built from the engine's
      //    own reported path — the catalog re-spawned the engine on every panel
      //    open instead of being cached.
      //  - `siteSupportNetwork` is read LAZILY so a proxy/cookie change inside
      //    one session is picked up; a startup snapshot would answer for a
      //    network the next download no longer uses.
      enginePath,
      siteSupportNetwork: () => readSiteSupportNetwork(configRef),
      siteSupportLogger: logger,
      jsRuntimePath: join(runtimeDir, 'node.exe'),
      // D-167: L1 fixtures are a development surface (D-31). In a packaged
      // build the directory does not even exist, so the channels are NOT
      // registered instead of being registered and failing on read.
      ...(packaged ? {} : {
        videoFixturePath: join(fixtureDir, 'info-video.json'),
        playlistFixturePath: join(fixtureDir, 'info-flat-playlist.json'),
      }),
      appVersion,
      engineVersion,
      dataDir: dataDir.dataDir,
      dataDirReason: dataDir.reason,
      ...(existsSync(aria2cPath) ? { bundledAria2cPath: aria2cPath } : {}),
      componentUpdate: componentUpdateProxy,
      appUpdate: appUpdateProxy,
      thumbnails,
      // D-166: `planAutostart` was policy with no caller; this is the caller.
      // Windows only — elsewhere the port stays undefined and SETTINGS_SET
      // refuses instead of pretending the toggle worked.
      ...(process.platform === 'win32' ? { systemStartup: createWinStartup({ exePath: process.execPath }) } : {}),
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
      // D-291: a removed record's per-task temp dir (`<work>/<taskId>`) is
      // discarded through the guarded path in `task-temp-cleanup.ts`.
      tempDirIo: createTempDirIo(),
      // Subtitle preview (stage 2): live probe behind an opaque, short-lived,
      // single-use ticket bound to the target URL.
      subtitlePreview,
      // TXT batch import: native .txt picker + bounded read stay in main.
      txtImportFile: createTxtFilePicker(),
      // D-148: the SAME `shell.openExternal` seam the app updater uses below —
      // the Star prompt opens its repo URL inside the main process, never via
      // a renderer-supplied link.
      openExternal: async (url: string) => { await shell.openExternal(url); },
    });
    hostRef = host;
    configRef = host.m4.task.config;

    componentUpdater = createComponentUpdater({
      // D-214: the component chain (version query, SHA2-256SUMS manifest and
      // yt-dlp.exe binary) is entirely on the update-only transport.
      ports: updatePorts,
      updateHttp: updateNetwork.httpPort,
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
      // D-214: `/releases/latest` + `/releases` use the update-only HttpPort;
      // the installer uses the update-only STREAMING downloader, which is the
      // existing `downloadToFile` pipeline with `net.request()` as its transport.
      ports: updatePorts,
      updateHttp: updateNetwork.httpPort,
      downloadInstaller: updateNetwork.downloadInstaller,
      logger,
      config: host.m4.task.config,
      currentVersion: appVersion,
      source: UPDATE_REPO,
      updatesDir: join(dataDir.dataDir, 'updates'),
      openExternal: async (url: string) => { await shell.openExternal(url); },
      openPath: async (path: string) => shell.openPath(path),
      // D-284: quit first, install after — the NSIS guard no longer races us.
      launchAfterExit: (installerPath: string) => scheduleInstallerAfterExit(installerPath),
      trashPartial: async (path: string) => shell.trashItem(path),
      quit: () => { app.quit(); },
    });

    // Covers: one attempt per task, triggered the moment the probe result is
    // known (first progress event) and once at boot for restored tasks.
    // D-103: `ensure()` now hits the local file first, so the boot restore is
    // also what rebuilds the task -> cover references before the first prune.
    const ensureCover = (taskId: string): Promise<string | null> => {
      const record = host.m4.task.queue.get(taskId);
      const url = record?.mediaInfo?.thumbnail ?? null;
      if (url === null) return Promise.resolve(null);
      // external online audit P3: the cover of a private-mode task is
      // PRE-marked purgePending at ensure time, so an abnormal exit (crash /
      // taskkill — private records are never persisted, D-240, and the
      // close-time purge never ran) leaves residue the boot prune can recycle
      // regardless of the auto-clean switch. A still-running task stays safe:
      // the purge-pending channel sits behind the policy's live guard.
      return thumbnails.ensure(taskId, url, { privateCover: record?.privateMode === true });
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
    // D-252: the boot pass runs regardless of the auto-clean switch — with the
    // switch off, `prune()` internally recycles ONLY the `purgePending` entries
    // a private-mode close marked (privacy correctness), never the regular
    // age/budget/lost-reference sweep.
    void Promise.allSettled(bootCoverAttempts).then(async () => {
      await thumbnails.prune();
    }).catch(() => undefined);

    // D-291: empty per-task temp dirs are pure residue (yt-dlp only removes
    // them on a clean success, D-118). The sweep is `rmdir`-only, so a folder
    // holding a resumable `.part` is kept by the filesystem itself. Never
    // awaited: housekeeping must not delay the first frame.
    // D-291: private-mode tasks park their partials under the private tree;
    // those records are never persisted (D-240), so the only way to find their
    // orphaned folders after a crash is to scan that root too.
    const privateRoot = expandEnvVars(PRIVATE_OUTPUT_DIR, process.env);
    const privateWorkRoot = hasUnresolvedEnvToken(privateRoot)
      ? []
      : [`${privateRoot.replace(/[\\/]+$/, '')}/work`];
    void sweepEmptyTempDirs(createTempDirIo(), {
      recordTempDirs: host.m4.task.queue.list().map((record) => tempDirOf(record)),
      workRoots: [join(dataDir.dataDir, 'work'), ...privateWorkRoot],
    }).then(async (removed) => {
      if (removed > 0) await logger.info('task-temp', 'empty temp dirs removed', { removed });
    }).catch(() => undefined);

    // Never awaited: a slow network must not delay the first frame.
    if (appUpdater.shouldAutoCheck()) void appUpdater.check();
    await logger.info('data-dir', 'resolved', {
      mode: dataDir.mode, dataDir: dataDir.dataDir, reason: dataDir.reason,
    });

    return host;
  };

  // Delivery report 五-1: forward the tray-failure log to the real Logger once
  // createHost has built it; console fallback before that (and in unit tests).
  //
  // Post-D-220 review audit: the real Logger's error/warn/info return
  // `Promise<void>` whose rejection (Logger -> logSink.appendJsonl: disk full,
  // locked file, ...) used to escape as an UNHANDLED REJECTION and the record
  // was lost anyway; a partial/fake Logger that throws synchronously would
  // abort the caller outright. Design tradeoff: a log line is never worth a
  // crash — losing this one record and printing a console hint is strictly
  // better than breaking the start-up / tray path the log call is only a
  // bystander to. The console summary carries ONLY scope, message and the
  // sink's own error message: `fields` is deliberately NOT re-printed, since
  // it can hold paths and other sensitive context that is only safe after the
  // Logger's redact pipeline — which, in this failure mode, never ran.
  function forwardLog(
    level: 'error' | 'warn' | 'info',
    scope: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    const target = loggerRef;
    if (target === null) {
      console[level](`[${scope}]`, message, fields ?? '');
      return;
    }
    try {
      void Promise.resolve(target[level](scope, message, fields)).catch((cause: unknown) => {
        console.error('[log] sink failure:', {
          scope, message, reason: cause instanceof Error ? cause.message : String(cause),
        });
      });
    } catch (cause: unknown) {
      // Same minimal summary for a synchronous throw from the logger itself.
      console.error('[log] sink failure:', {
        scope, message, reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const handle = await bootstrap(electronSurface(), {
    pageUrl: options.pageUrl,
    preloadPath: options.preloadPath,
    trayIconPath: options.trayIconPath,
    argv: options.argv ?? process.argv,
    createHost,
    onSystemAppearanceChanged: () => { /* renderer re-reads SETTINGS_GET on focus */ },
    onWindowClose: clearPrivateHistory,
    // Delivery report 五-1: tray-creation failures used to vanish into `catch {}`.
    logger: {
      error: (scope, message, fields) => { forwardLog('error', scope, message, fields); },
      warn: (scope, message, fields) => { forwardLog('warn', scope, message, fields); },
      info: (scope, message, fields) => { forwardLog('info', scope, message, fields); },
    },
    platform: process.platform,
  });
  if (handle !== null && packaged) {
    const cleanupFiles = createUpdateCleanupFiles(async (path) => {
      const { createHash } = await import('node:crypto');
      const { createReadStream } = await import('node:fs');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      return hash.digest('hex');
    });
    // `configRef` is assigned inside `createHost()`, which this closure cannot
    // see, so TS narrows it to `null` here. Re-assert the declared union.
    const cleanupConfig = configRef as IConfigStore | null;
    // D-286: Settings → App update → "自动清理安装包" (default ON). Both
    // housekeeping passes below honor the same switch.
    const cleanupEnabled = cleanupConfig === null
      ? true : cleanupConfig.get('advanced', 'autoCleanUpdateInstaller') !== false;
    // Two cleanups on the SAME updates dir, with a strict boundary:
    //   1. `cleanupCompletedUpdate` — the pending marker names the ONE installer
    //      the running version was just upgraded from; removed only after a
    //      SHA-256 re-verification (its version EQUALS the running one).
    //   2. `sweepLegacyInstallers` — version-based one-shot for the pre-D-289
    //      era (0.3.0–0.3.3 wrote no markers at all, so those installers are
    //      orphans the marker can never name): removes whitelisted names
    //      STRICTLY OLDER than the running version, so it can never
    //      double-handle the file the marker flow owns.
    // Never awaited: housekeeping must not delay start-up (same style as the
    // task-temp sweep in createHost above). A partial sweep failure is WARN,
    // never a crash.
    void cleanupCompletedUpdate(cleanupFiles, join(appDataDir, 'updates'), appVersion, {
      enabled: cleanupEnabled,
    });
    void sweepLegacyInstallers(cleanupFiles, join(appDataDir, 'updates'), appVersion, {
      enabled: cleanupEnabled,
    }).then((report) => {
      if (report.failed.length > 0) {
        forwardLog('warn', 'app-update', 'legacy installer sweep finished with failures', {
          removed: [...report.removed], kept: report.kept.length, failed: [...report.failed],
        });
      } else if (report.removed.length > 0) {
        forwardLog('info', 'app-update', 'legacy installers removed', { removed: [...report.removed] });
      }
    }).catch((cause: unknown) => {
      forwardLog('warn', 'app-update', 'legacy installer sweep skipped', {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }
  return handle;
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
/**
 * D-284 / D-289 / D-291: start the verified installer ONLY after this process
 * is gone. The waiter (PID poll + `--updated` + ACK handshake + retry log)
 * lives in `installer-waiter.ts` so it stays unit-testable without importing
 * Electron; see that file for the full failure chain it closes.
 */
function scheduleInstallerAfterExit(installerPath: string): Promise<boolean> {
  return realInstallerWaiter(installerPath);
}

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
 * `advanced.componentFeedUrl` (user setting).
 *
 * D-161: HTTPS is REQUIRED by default. A plain-HTTP mirror (intranet NAS / LAN)
 * needs the explicit deployment opt-in `YTVDLT_ALLOW_HTTP_COMPONENT_FEED=1`;
 * without it the feed is silently disabled rather than fetched over cleartext.
 * The opt-in is the documented risk confirmation: SHA-256 over the same
 * untrusted link cannot detect a simultaneous manifest+binary substitution.
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
  const allowInsecureHttp = (process.env['YTVDLT_ALLOW_HTTP_COMPONENT_FEED'] ?? '').trim() === '1';
  return allowedComponentFeed(raw, allowInsecureHttp);
}

/**
 * The `electron-updater` path (`app-updater.ts`) is deliberately no longer
 * called from start-up: the public releases ship no `latest.yml`, so the
 * generic feed can only answer 404. `app-update-service.ts` replaces it with a
 * GitHub-Releases check that verifies the installer itself before running it.
 * `app-updater.ts` stays compiled because its coordinator/interval rules are
 * still the reference for a future self-hosted feed (D-93).
 */
