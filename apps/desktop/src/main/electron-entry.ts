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
import { ArtifactVerifier, ErrorMapper, Logger } from '@ytvdlt/core';
import { createEngine } from '@ytvdlt/engine-ytdlp';
import { createNodePorts } from './adapters/node-ports.js';
import { createElectronShellPort } from './adapters/electron-shell-port.js';
import { resolveFixtureDir, resolveRuntimeDir } from './runtime-paths.js';
import { createNodeProbePort, resolveDataDir } from './data-dir.js';
import { createQueueIntakeGate } from './adapters/queue-intake-gate.js';
import { LocalDirUpdateSource } from './adapters/local-dir-update-source.js';
import { AppUpdateCoordinator, UPDATE_CONFIG } from './app-updater.js';
import {
  createComponentUpdater, type ComponentUpdatePort,
} from './component-updater.js';
import { createM5Host, type M5Host } from './m5-host.js';
import { bootstrap, type BootstrapHandle, type ElectronLike } from './bootstrap.js';

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
    let hostRef: M5Host | null = null;
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
      run: async () => componentUpdater === null
        ? { ok: false, source: null, reason: '组件更新尚未就绪', results: [] }
        : componentUpdater.run(),
    };

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
      clipboard: { writeText: async (text: string) => { clipboard.writeText(text); } },
      systemAppearance: {
        prefersDark: () => nativeTheme.shouldUseDarkColors,
        // Reduced motion is a CSS media query; the renderer owns it (theme.js).
        prefersReducedMotion: () => false,
        accent: () => null,
      },
    });
    hostRef = host;

    componentUpdater = createComponentUpdater({
      ports,
      logger,
      components: [
        { id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', path: enginePath },
        { id: 'aria2c', label: 'aria2c', fileName: 'aria2c.exe', path: aria2cPath },
      ],
      baseUrl: resolveComponentFeed(host.m4.task.config),
      intakeGate,
    });

    // Background app update: never awaited, never blocks the window.
    void checkAppUpdateOnce(host, logger, appVersion);
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
 */
function resolveComponentFeed(config: M5Host['m4']['task']['config']): string | null {
  const fromEnv = (process.env['YTVDLT_COMPONENT_FEED'] ?? '').trim();
  const raw = fromEnv !== ''
    ? fromEnv
    : String(config.get<string>('advanced', 'componentFeedUrl') ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : null;
}

async function checkAppUpdateOnce(host: M5Host, logger: Logger, appVersion: string): Promise<void> {
  const feed = host.m4.task.config.get<string>(UPDATE_CONFIG.domain, UPDATE_CONFIG.feedKey);
  if (typeof feed !== 'string' || feed.trim() === '') return;
  try {
    const { createElectronUpdaterPort } = await import('./adapters/electron-updater-adapter.js');
    const updater = await createElectronUpdaterPort({ currentVersion: () => appVersion });
    const coordinator = new AppUpdateCoordinator({
      updater,
      config: host.m4.task.config,
      logger,
      notifyOnce: (message: string) => {
        // Non-blocking by construction: a log line plus the renderer's own hint.
        void logger.info('app-update', 'user-notified', { message });
      },
    });
    await coordinator.checkAndApply();
  } catch (error) {
    await logger.warn('app-update', 'updater module unavailable; skipped', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
