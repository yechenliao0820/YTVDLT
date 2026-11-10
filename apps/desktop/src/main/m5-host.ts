/**
 * M5Host — composes the M4 host with the M5 IPC surface (M5-0).
 *
 * `createM4Host()` already assembles queue/restore/batch/notifications/templates/
 * task-detail; this file adds the channels the renderer needs to actually DRIVE
 * those services (task list, task detail, the seven actions, template CRUD,
 * settings), and exposes one gateway so `registerAll()` registers everything.
 *
 * Still no `electron` import: the window, tray and nativeTheme live in
 * `bootstrap.ts`, which takes them injected. That keeps this composition
 * L0-testable — which is the only honest way to verify it in an environment
 * without an Electron binary (D-39).
 */
import type { TaskDetailAction } from '@ytvdlt/core';
import { createM4Host, type M4Host, type M4HostOptions } from './m4-host.js';
import {
  createM5Handlers, M5_CHANNELS,
  type AppUpdatePortLike, type AppearanceDto, type ComponentUpdatePortLike,
  type PathPickerPort, type SubtitlePreviewPortLike, type SystemAppearancePort,
  type TaskDetailPort, type TaskListPort, type ThumbnailPort, type TrashFilesPort,
} from './m5-channels.js';
import type { IpcGateway, IpcHandler } from './ipc-gateway.js';
import type { LocalFileStatusPort } from './local-file-status.js';
import { IPC_CHANNELS } from '@ytvdlt/shared';

export interface M5HostOptions extends M4HostOptions {
  /** OS probe (nativeTheme + registry accent); injected so tests stay offline. */
  readonly systemAppearance: SystemAppearancePort;
  /** Called after SETTINGS_SET so the Electron layer can repaint native chrome. */
  readonly onAppearanceChanged?: (snapshot: AppearanceDto) => void;
  /** Resolved data directory (portable vs %APPDATA%%) — shown in the About box. */
  readonly dataDir?: string;
  /** Why that directory won; surfaced so support can see it without a debugger. */
  readonly dataDirReason?: string;
  /** D-67: component (yt-dlp / aria2c) updater; absent = button disabled. */
  readonly componentUpdate?: ComponentUpdatePortLike;
  /** D-93: app updater (GitHub Releases); absent = "此构建不含更新器". */
  readonly appUpdate?: AppUpdatePortLike;
  /** D-96: cached cover images; absent = letter badges. */
  readonly thumbnails?: ThumbnailPort;
  /** D-98: `%VAR%` expansion for the download roots. */
  readonly expandPath?: (raw: string) => string;
  /** D-98: native folder picker; absent = path rows stay read-only. */
  readonly pathPicker?: PathPickerPort;
  /** D-87: recycle-bin adapter for "also delete local files". */
  readonly trashFiles?: TrashFilesPort;
  /** D-120: local artifact state probe; absent keeps the old (no field) DTO. */
  readonly fileStatus?: LocalFileStatusPort;
  /** Subtitle preview (stage 2): live probe + ticket store; absent = disabled. */
  readonly subtitlePreview?: SubtitlePreviewPortLike;
}

/**
 * Pure data for the About box (M5-4). No `electron` import, no timestamp —
 * it is a snapshot the renderer can render and a test can compare verbatim.
 */
export interface AboutInfo {
  readonly appVersion: string;
  readonly runtimeDir: string;
  readonly dataDir: string;
  readonly dataDirReason: string;
  readonly runtime: readonly ['yt-dlp', 'node', 'ffmpeg'];
  readonly license: 'LGPL-3.0';
}

export interface M5Host {
  readonly m4: M4Host;
  /** Merged gateway: M3 fixture channels + M5 service channels. */
  readonly gateway: IpcGateway;
  /** Channels added by M5 (for the preload whitelist assertion). */
  readonly channels: readonly string[];
  readonly appearance: () => Promise<AppearanceDto>;
  /** Static About-box payload (M5-4). */
  readonly aboutInfo: () => AboutInfo;
  /** Delegates to the M4 host; kept here so callers depend on one object. */
  readonly taskDetail: M4Host['taskDetail'];
  readonly dispose: () => void;
}

/** Compose several handler maps into one gateway (first registration wins). */
export function mergeGateways(...gateways: readonly IpcGateway[]): IpcGateway {
  const handlers = new Map<string, IpcHandler>();
  for (const gateway of gateways) {
    for (const [channel, handler] of gateway.handlers) {
      if (handlers.has(channel)) throw new Error(`[m5-host] duplicate channel: ${channel}`);
      handlers.set(channel, handler);
    }
  }
  return {
    handlers,
    async dispatch(channel: string, payload: unknown): Promise<unknown> {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`[ipc] unregistered channel: ${channel}`);
      return handler(payload ?? {});
    },
    registerAll(registrar): void {
      for (const [channel, handler] of handlers) {
        registrar.register(channel, (payload: unknown) => handler(payload ?? {}));
      }
    },
  };
}

/** Adapt the M4 task detail service to the narrow port M5 channels need. */
function detailPort(host: M4Host): TaskDetailPort {
  return {
    perform: (taskId: string, action: TaskDetailAction) => host.taskDetail.perform(taskId, action),
  };
}

export async function createM5Host(options: M5HostOptions): Promise<M5Host> {
  const m4 = await createM4Host(options);

  const queue: TaskListPort = {
    list: () => m4.task.queue.list(),
    get: (taskId: string) => m4.task.queue.get(taskId),
  };

  const handlers = createM5Handlers({
    queue,
    taskDetail: detailPort(m4),
    templates: m4.commandTemplates,
    config: m4.task.config,
    systemAppearance: options.systemAppearance,
    ...(options.onAppearanceChanged === undefined ? {} : { onAppearanceChanged: options.onAppearanceChanged }),
    ...(options.componentUpdate === undefined ? {} : { componentUpdate: options.componentUpdate }),
    ...(options.appUpdate === undefined ? {} : { appUpdate: options.appUpdate }),
    ...(options.thumbnails === undefined ? {} : { thumbnails: options.thumbnails }),
    ...(options.expandPath === undefined ? {} : { expandPath: options.expandPath }),
    ...(options.pathPicker === undefined ? {} : { pathPicker: options.pathPicker }),
    ...(options.trashFiles === undefined ? {} : { trashFiles: options.trashFiles }),
    ...(options.fileStatus === undefined ? {} : { fileStatus: options.fileStatus }),
    ...(options.subtitlePreview === undefined ? {} : { subtitlePreview: options.subtitlePreview }),
    // D-114: the authoritative build identity. Sourced from the same
    // `app.getVersion()` the package metadata carries, never from a literal.
    appInfo: {
      version: options.appVersion,
      name: 'YTVDLT',
      packaged: options.ports.env.isPackaged(),
    },
    enqueueSingle: (input) => m4.enqueueSingle(input),
  });

  const m5Gateway: IpcGateway = {
    handlers,
    async dispatch(channel: string, payload: unknown): Promise<unknown> {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`[ipc] unregistered channel: ${channel}`);
      return handler(payload ?? {});
    },
    registerAll(registrar): void {
      for (const [channel, handler] of handlers) {
        registrar.register(channel, (payload: unknown) => handler(payload ?? {}));
      }
    },
  };

  const gateway = mergeGateways(m4.gateway, m5Gateway);

  const aboutInfo = (): AboutInfo => ({
    appVersion: options.appVersion,
    runtimeDir: options.ports.env.runtimeDir(),
    dataDir: options.dataDir ?? options.ports.env.appDataDir(),
    dataDirReason: options.dataDirReason ?? '',
    runtime: ['yt-dlp', 'node', 'ffmpeg'],
    license: 'LGPL-3.0',
  });

  return {
    m4,
    gateway,
    channels: M5_CHANNELS,
    appearance: async () => gateway.dispatch(IPC_CHANNELS.SETTINGS_GET, {}) as Promise<AppearanceDto>,
    aboutInfo,
    taskDetail: m4.taskDetail,
    dispose: () => m4.dispose(),
  };
}
