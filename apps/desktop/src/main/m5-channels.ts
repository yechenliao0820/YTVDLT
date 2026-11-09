/**
 * M5 IPC surface (M5-0) — the channels the renderer needs beyond M3/M4.
 *
 * Why a separate file: `ipc-gateway.ts` is the M3 fixture-driven gateway
 * (PROBE / dialogs / path preview). M5 adds real services; bolting them into the
 * fixture gateway would couple recorded-JSON parsing with a live task queue.
 * `createM5Host()` composes both.
 *
 * Rules kept from M3:
 *   - every payload is validated against an explicit key whitelist;
 *   - nothing that leaves this layer contains a media/credential URL:
 *     `TASK_LIST` projects a DTO without `url`, `TASK_DETAIL` masks it with
 *     `maskUrlSecrets()` (same rule as the error report, D-32);
 *   - no `electron` / `node:*` import — the services arrive injected.
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type {
  AppUpdateAction, AppUpdateActionResult, AppUpdateState, DownloadKind, FormatDomain, TaskRecord,
} from '@ytvdlt/shared';
import {
  ACCENT_PRESETS, DEFAULT_PATH_TOKENS, buildTaskListSnapshot, classifyFailure, maskUrlSecrets,
  normalizeHexColor, normalizeThemeMode, normalizeMotionMode, parseAccent,
} from '@ytvdlt/core';
import type {
  AccentChoice, CommandTemplateInput, CommandTemplateStore, IConfigStore,
  FailureKind, MotionMode, TaskDetailAction, TaskDetailResult, TaskTab, ThemeMode,
} from '@ytvdlt/core';
import type { ThumbnailCacheStatus, ThumbnailPruneReport } from './thumbnail-cache.js';

/** Minimal slice of the queue this layer needs (tests inject a fake). */
export interface TaskListPort {
  list(): readonly TaskRecord[];
  get(taskId: string): TaskRecord | undefined;
}

export interface TaskDetailPort {
  perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult>;
}

export interface SystemAppearancePort {
  prefersDark(): boolean;
  prefersReducedMotion(): boolean;
  accent(): string | null;
}

/** D-67: the component-update surface, injected from the main process. */
export interface ComponentUpdatePortLike {
  status(): Promise<unknown>;
  /** 0.2.1 (D-94): network lookup of the latest published version. */
  check(): Promise<unknown>;
  run(): Promise<unknown>;
}

/** 0.2.1 (D-93): the app-update surface, injected from the main process. */
export interface AppUpdatePortLike {
  state(): AppUpdateState;
  perform(action: AppUpdateAction): Promise<AppUpdateActionResult>;
}

/**
 * 0.2.1 (D-96): where the cached cover image for a task lives.
 *
 * The renderer never sees the remote thumbnail URL — only a local absolute
 * path, and only when the bytes were actually cached. `null` means "draw the
 * letter badge", which is also the offline / privacy-safe path.
 */
export interface ThumbnailPort {
  pathOf(taskId: string): string | null;
  /** D-103: optional so older fakes / builds without the cache still compile. */
  forget?(taskId: string): void;
  status?(): Promise<ThumbnailCacheStatus>;
  prune?(options?: { force?: boolean }): Promise<ThumbnailPruneReport>;
  setAutoClean?(enabled: boolean): Promise<Record<string, unknown>>;
  setMaxBytes?(bytes: number): Promise<Record<string, unknown>>;
}

/**
 * D-87: moving a task's artifacts to the OS recycle bin is a main-process job.
 * Injected (never imported from `electron`) so the channel layer stays L0-testable.
 * Returns the paths that were actually trashed; a short list means a partial
 * failure and the record is deliberately kept so the user can retry.
 */
export interface TrashFilesPort {
  trash(paths: readonly string[]): Promise<readonly string[]>;
}

/**
 * 0.2.1 (D-98): the download root, user-selectable.
 *
 * `video` and `audio` are separate on purpose — the app already wrote audio to
 * `paths.audioDir`, so one "download folder" would silently move half the user's
 * files. The picker itself lives in the main process (native dialog + writability
 * probe), which is why this port has no `electron` import.
 */
export type PathKind = 'video' | 'audio';

export interface PathPickerPort {
  /**
   * Opens the native folder picker. `path: null` + `error: null` means the user
   * cancelled; `error` non-null means the directory exists but is not writable.
   */
  pick(kind: PathKind, startAt: string): Promise<{ path: string | null; error: string | null }>;
  open(path: string): Promise<void>;
}

export interface PathsDto {
  /** Absolute, `%VAR%`-expanded paths — exactly what the engine will write to. */
  readonly videoDir: string;
  readonly audioDir: string;
}

/** D-83: what the renderer may ask for in a single download. */
export type VideoQualityChoice = FormatDomain['quality'];
export type AudioQualityChoice = FormatDomain['audioQuality'];
export type AudioFormatChoice = 'auto' | 'mp3' | 'm4a';

export interface SingleDownloadInput {
  readonly url: string;
  readonly kind: DownloadKind;
  /** Video only: `-S res:<N>` preset. */
  readonly quality?: VideoQualityChoice;
  /** Audio only: `-S abr~N` preset (or the transcode bitrate). */
  readonly audioQuality?: AudioQualityChoice;
  /** Audio only: `auto` keeps the source codec, mp3/m4a transcode. */
  readonly audioFormat?: AudioFormatChoice;
}

export interface M5ChannelDeps {
  readonly queue: TaskListPort;
  readonly taskDetail: TaskDetailPort;
  readonly templates: CommandTemplateStore;
  readonly config: IConfigStore;
  readonly systemAppearance: SystemAppearancePort;
  /** Optional hook: the Electron layer repaints native windows (title bar). */
  readonly onAppearanceChanged?: (snapshot: AppearanceDto) => void;
  /** D-67: absent means the build ships no updater (button stays disabled). */
  readonly componentUpdate?: ComponentUpdatePortLike;
  /** D-69: real single-video enqueue; absent = DOWNLOAD_START reports disabled. */
  readonly enqueueSingle?: (input: SingleDownloadInput) => Promise<readonly string[]>;
  /** D-87: absent = "also delete local files" is refused instead of deleting anything. */
  readonly trashFiles?: TrashFilesPort;
  /** D-93: absent = the settings page shows "此构建不含更新器". */
  readonly appUpdate?: AppUpdatePortLike;
  /** D-96: absent = every card falls back to the letter badge. */
  readonly thumbnails?: ThumbnailPort;
  /** D-98: `%VAR%` expansion; absent = stored values are shown verbatim (tests). */
  readonly expandPath?: (raw: string) => string;
  /** D-98: native folder picker + reveal; absent = the path rows stay read-only. */
  readonly pathPicker?: PathPickerPort;
  /**
   * D-114: the running build's identity, straight from the main process.
   *
   * Absent means "this build cannot state its own version" — the renderer then
   * shows a placeholder instead of a plausible-looking old number. Never fill
   * this from a package.json literal: that is exactly how 0.2.2 survived four
   * releases in the footer.
   */
  readonly appInfo?: AppInfoDto;
}

/** D-114: what `APP_INFO` answers. `version` is `''` when it is unknown. */
export interface AppInfoDto {
  readonly version: string;
  readonly name: string;
  /** True when the process runs from a packaged asar (not `electron .`). */
  readonly packaged: boolean;
}

export interface TaskListItemDto {
  readonly id: string;
  readonly state: string;
  readonly kind: string;
  readonly title: string;
  readonly uploader: string | null;
  readonly duration: number | null;
  readonly percent: number | null;
  readonly errorCode: string | null;
  /**
   * D-109: stable bucket for the one-line failure brief. `null` when the task
   * holds no error at all; the human sentence is resolved by the renderer from
   * `queue.failure.<kind>`, so switching language needs no new IPC round trip.
   */
  readonly failureKind: FailureKind | null;
  readonly artifactCount: number;
  /** 0.2.1 (D-95): transfer numbers; `null` = unknown, never "zero". */
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly speedBps: number | null;
  readonly etaSec: number | null;
  /**
   * D-115: how far the run has actually got. `null` / absent means "no reliable
   * information" — the renderer then keeps the previous behaviour rather than
   * assuming a merge. Values: `fetching|downloading|merging|postprocess|verifying`.
   */
  readonly stage?: string | null;
  /** 0.2.1 (D-96): absolute local cover path, or null for the letter badge. */
  readonly thumbPath: string | null;
}

export interface TaskDetailDto {
  readonly id: string;
  readonly state: string;
  readonly kind: string;
  readonly title: string;
  /** Masked: `token=***REDACTED***`, never the raw signed URL. */
  readonly url: string;
  readonly artifacts: readonly string[];
  readonly percent: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface AppearanceDto {
  readonly theme: ThemeMode;
  readonly accent: AccentChoice;
  readonly motion: MotionMode;
  readonly language: 'zh-CN' | 'en';
  /** D-88: when true the host clears the task history as the window closes. */
  readonly privateMode: boolean;
  /** 0.2.1 (D-93 / D-94): two independent startup-check switches. */
  readonly autoCheckAppUpdate: boolean;
  readonly autoCheckEngineUpdate: boolean;
  readonly systemAccent: string | null;
  readonly prefersDark: boolean;
  readonly prefersReducedMotion: boolean;
  /** 0.2.1 (D-98): resolved download roots. */
  readonly videoDir: string;
  readonly audioDir: string;
}

const TASK_ACTIONS: readonly TaskDetailAction[] = [
  'open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry',
];

const MAX_TEMPLATE_ARGS = 32;
const MAX_ARG_LENGTH = 400;

const PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  [IPC_CHANNELS.TASK_LIST]: ['tab', 'query'],
  [IPC_CHANNELS.TASK_DETAIL]: ['taskId'],
  // D-87: `withFiles: true` asks the host to recycle the task's artifacts
  // before removing the record. Only valid together with `action: 'remove'`.
  [IPC_CHANNELS.TASK_ACTION]: ['taskId', 'action', 'withFiles'],
  [IPC_CHANNELS.TEMPLATE_LIST]: [],
  [IPC_CHANNELS.TEMPLATE_SAVE]: ['id', 'name', 'args'],
  [IPC_CHANNELS.TEMPLATE_DELETE]: ['id'],
  [IPC_CHANNELS.SETTINGS_GET]: [],
  [IPC_CHANNELS.SETTINGS_SET]: [
    'theme', 'accent', 'motion', 'language', 'privateMode',
    'autoCheckAppUpdate', 'autoCheckEngineUpdate',
  ],
  [IPC_CHANNELS.COMPONENT_STATUS]: [],
  [IPC_CHANNELS.COMPONENT_UPDATE]: [],
  [IPC_CHANNELS.COMPONENT_CHECK]: [],
  [IPC_CHANNELS.APP_UPDATE_STATUS]: [],
  [IPC_CHANNELS.APP_UPDATE_ACTION]: ['action'],
  [IPC_CHANNELS.PATH_ACTION]: ['action', 'kind'],
  [IPC_CHANNELS.DOWNLOAD_START]: ['url', 'kind', 'quality', 'audioQuality', 'audioFormat'],
  // D-103: the renderer may read occupancy, ask for a manual prune, or change
  // two policy values. It can NEVER pass a file path to this channel.
  [IPC_CHANNELS.THUMBNAIL_CACHE]: ['action', 'enabled', 'maxBytes'],
  // D-114: read-only identity; no input at all.
  [IPC_CHANNELS.APP_INFO]: [],
};

/** D-103: the only cache actions the renderer may trigger. */
const THUMBNAIL_CACHE_ACTIONS: readonly string[] = [
  'status', 'prune', 'set-auto', 'set-max-bytes',
];

/** D-93: the only actions the renderer may trigger. */
const APP_UPDATE_ACTIONS: readonly AppUpdateAction[] = [
  'check', 'download', 'install', 'open-page', 'skip-version', 'dismiss',
];

/** D-98: paths are user input; keep them short and printable. */
const MAX_PATH_LENGTH = 400;
const PATH_ACTIONS: readonly string[] = ['pick', 'reset', 'open'];

/** D-83: the renderer may only pick values the plan layer already understands. */
const VIDEO_QUALITY_VALUES: readonly string[] = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p', 'lowest'];
const AUDIO_QUALITY_VALUES: readonly string[] = ['best', '192', '128', '64', '32', 'lowest'];
const AUDIO_FORMAT_VALUES: readonly string[] = ['auto', 'mp3', 'm4a'];

export function validateM5Payload(channel: string, payload: unknown): Record<string, unknown> {
  const allowed = PAYLOAD_KEYS[channel];
  if (allowed === undefined) throw new Error(`[m5-ipc] unregistered channel: ${channel}`);
  const record = payload ?? {};
  if (typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`[m5-ipc] payload must be an object for ${channel}`);
  }
  for (const key of Object.keys(record as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new Error(`[m5-ipc] payload key not allowed: ${key}`);
  }
  return record as Record<string, unknown>;
}

/** URL-free projection: the list never needs a link to render a card. */
export function toTaskListItem(record: TaskRecord, thumbnailPath: string | null = null): TaskListItemDto {
  return {
    id: record.id,
    state: record.state,
    kind: record.kind,
    title: record.mediaInfo?.title ?? record.id,
    uploader: record.mediaInfo?.uploader ?? null,
    duration: record.mediaInfo?.duration ?? null,
    percent: record.lastPercent,
    errorCode: record.error?.code ?? null,
    // D-109: derived from the stable code only — never from yt-dlp text, and
    // never a localized string (the renderer owns the copy).
    failureKind: record.error === null ? null : classifyFailure(record.error.code),
    artifactCount: record.artifacts.length,
    downloadedBytes: record.lastDownloadedBytes ?? null,
    totalBytes: record.lastTotalBytes ?? null,
    speedBps: record.lastSpeedBps ?? null,
    etaSec: record.lastEtaSec ?? null,
    // D-115: only the queue knows how far the run got; the renderer must not
    // infer a phase from `percent === 100` (two streams each reach 100%).
    stage: record.lastStage ?? null,
    thumbPath: thumbnailPath,
  };
}

/** Detail view keeps the URL but masked — same rule as the error report. */
export function toTaskDetail(record: TaskRecord): TaskDetailDto {
  return {
    id: record.id,
    state: record.state,
    kind: record.kind,
    title: record.mediaInfo?.title ?? record.id,
    url: maskUrlSecrets(record.url),
    artifacts: [...record.artifacts],
    percent: record.lastPercent,
    errorCode: record.error?.code ?? null,
    errorMessage: record.error?.message ?? null,
  };
}

/**
 * D-98: stored value (`%USERPROFILE%/...`) → the absolute path the engine uses.
 *
 * An empty or non-string value falls back to the shipped default instead of
 * producing `''` — an empty output dir is exactly the "save failed" case the
 * user must never hit.
 */
export function readPaths(deps: Pick<M5ChannelDeps, 'config' | 'expandPath'>): PathsDto {
  const expand = deps.expandPath ?? ((raw: string): string => raw);
  const read = (key: 'videoDir' | 'audioDir'): string => {
    const raw = deps.config.get<string>('paths', key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    return expand(value === '' ? DEFAULT_PATH_TOKENS[key] : value);
  };
  return { videoDir: read('videoDir'), audioDir: read('audioDir') };
}

function readAppearance(deps: M5ChannelDeps): AppearanceDto {
  return {
    theme: normalizeThemeMode(deps.config.get('general', 'theme')),
    accent: parseAccent(deps.config.get('general', 'accent')),
    motion: normalizeMotionMode(deps.config.get('general', 'motion')),
    language: String(deps.config.get('general', 'language')).toLowerCase().startsWith('en') ? 'en' : 'zh-CN',
    privateMode: deps.config.get('general', 'privateMode') === true,
    autoCheckAppUpdate: deps.config.get('advanced', 'autoCheckAppUpdate') !== false,
    autoCheckEngineUpdate: deps.config.get('advanced', 'autoCheckEngineUpdate') !== false,
    systemAccent: deps.systemAppearance.accent(),
    prefersDark: deps.systemAppearance.prefersDark(),
    prefersReducedMotion: deps.systemAppearance.prefersReducedMotion(),
    ...readPaths(deps),
  };
}

function assertTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('[m5-ipc] taskId must be a non-empty string');
  }
  return value;
}

function assertTemplateInput(record: Record<string, unknown>): CommandTemplateInput {
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    throw new Error('[m5-ipc] template name must be 1..80 chars');
  }
  const args = record['args'];
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_TEMPLATE_ARGS) {
    throw new Error('[m5-ipc] template args must be a non-empty array');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH) {
      throw new Error('[m5-ipc] template args must be strings');
    }
  }
  return { name, args: args as readonly string[] };
}

export function createM5Handlers(deps: M5ChannelDeps): Map<string, (payload: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();

  handlers.set(IPC_CHANNELS.TASK_LIST, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_LIST, payload);
    const tab = record['tab'];
    const query = record['query'];
    if (tab !== undefined && !['all', 'downloading', 'finished', 'canceled'].includes(String(tab))) {
      throw new Error('[m5-ipc] invalid tab');
    }
    if (query !== undefined && typeof query !== 'string') throw new Error('[m5-ipc] query must be a string');
    const snapshot = buildTaskListSnapshot(deps.queue.list(), {
      ...(tab === undefined ? {} : { tab: tab as TaskTab }),
      ...(query === undefined ? {} : { query: query as string }),
    });
    return {
      tab: snapshot.tab,
      counts: snapshot.counts,
      empty: snapshot.empty,
      items: snapshot.visible.map((record) => toTaskListItem(
        record,
        deps.thumbnails === undefined ? null : deps.thumbnails.pathOf(record.id),
      )),
    };
  });

  handlers.set(IPC_CHANNELS.TASK_DETAIL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_DETAIL, payload);
    const taskId = assertTaskId(record['taskId']);
    const task = deps.queue.get(taskId);
    if (task === undefined) return { found: false, task: null };
    return { found: true, task: toTaskDetail(task) };
  });

  handlers.set(IPC_CHANNELS.TASK_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_ACTION, payload);
    const taskId = assertTaskId(record['taskId']);
    const action = record['action'];
    if (typeof action !== 'string' || !TASK_ACTIONS.includes(action as TaskDetailAction)) {
      throw new Error('[m5-ipc] unknown task action');
    }
    const rawWithFiles = record['withFiles'];
    if (rawWithFiles !== undefined && typeof rawWithFiles !== 'boolean') {
      throw new Error('[m5-ipc] withFiles must be a boolean');
    }
    if (rawWithFiles === true) {
      if (action !== 'remove') throw new Error('[m5-ipc] withFiles requires action=remove');
      if (deps.trashFiles === undefined) {
        return { action: 'remove', ok: false, code: 'SHELL_UNAVAILABLE', message: '当前构建未启用回收站端口' };
      }
      // Only the paths the engine itself recorded for THIS task are eligible.
      // The renderer never sends a path, so it cannot aim this at arbitrary files.
      const artifacts = deps.queue.get(taskId)?.artifacts ?? [];
      const trashed = await deps.trashFiles.trash(artifacts);
      if (trashed.length !== artifacts.length) {
        return {
          action: 'remove', ok: false, code: 'ERROR',
          message: `本地文件未全部移入回收站（${trashed.length}/${artifacts.length}），记录已保留`,
        };
      }
    }
    const result = await deps.taskDetail.perform(taskId, action as TaskDetailAction);
    // D-103: dropping a task record drops its claim on the cover. The file is
    // NOT deleted here — the prune pass checks whether another live task shares
    // it, then moves it to the recycle bin.
    if (action === 'remove' && result.ok === true) deps.thumbnails?.forget?.(taskId);
    return result;
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_LIST, async (payload) => {
    validateM5Payload(IPC_CHANNELS.TEMPLATE_LIST, payload);
    await deps.templates.init();
    return { templates: deps.templates.list(), rejectedAtLoad: deps.templates.rejectedAtLoad };
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_SAVE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TEMPLATE_SAVE, payload);
    const input = assertTemplateInput(record);
    const id = record['id'];
    if (id === undefined) {
      return { created: true, template: await deps.templates.create(input) };
    }
    if (typeof id !== 'string' || id.length === 0) throw new Error('[m5-ipc] invalid template id');
    return { created: false, template: await deps.templates.update(id, input) };
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_DELETE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TEMPLATE_DELETE, payload);
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) throw new Error('[m5-ipc] invalid template id');
    return { removed: await deps.templates.remove(id) };
  });

  handlers.set(IPC_CHANNELS.COMPONENT_STATUS, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_STATUS, payload);
    if (deps.componentUpdate === undefined) {
      return { components: [], source: null, updating: false };
    }
    return deps.componentUpdate.status();
  });

  handlers.set(IPC_CHANNELS.COMPONENT_UPDATE, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_UPDATE, payload);
    if (deps.componentUpdate === undefined) {
      return { ok: false, source: null, reason: '当前构建未启用组件更新', results: [] };
    }
    return deps.componentUpdate.run();
  });

  // 0.2.1 (D-94): the network half of the component surface. Kept separate from
  // COMPONENT_STATUS so the settings page can render versions instantly and only
  // pay for a request when the user (or the startup toggle) asks for one.
  handlers.set(IPC_CHANNELS.COMPONENT_CHECK, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_CHECK, payload);
    if (deps.componentUpdate === undefined) {
      return { checkedAt: '', results: [] };
    }
    return deps.componentUpdate.check();
  });

  // 0.2.1 (D-93): app update. `status` is a pure read of the in-memory state, so
  // the queue page can poll it on the same tick as TASK_LIST without a request.
  handlers.set(IPC_CHANNELS.APP_UPDATE_STATUS, async (payload) => {
    validateM5Payload(IPC_CHANNELS.APP_UPDATE_STATUS, payload);
    if (deps.appUpdate === undefined) {
      return {
        phase: 'idle', currentVersion: '', latest: null,
        message: '此构建不含更新器', downloadedBytes: 0, totalBytes: null,
        skippedVersion: null, lastCheckedAt: null, canAutoInstall: false,
      };
    }
    return deps.appUpdate.state();
  });

  handlers.set(IPC_CHANNELS.APP_UPDATE_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.APP_UPDATE_ACTION, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !APP_UPDATE_ACTIONS.includes(action as AppUpdateAction)) {
      throw new Error('[m5-ipc] unknown app update action');
    }
    if (deps.appUpdate === undefined) {
      return { ok: false, action, message: '此构建不含更新器', state: null };
    }
    return deps.appUpdate.perform(action as AppUpdateAction);
  });

  // D-69: the real single-video download entry. The renderer (or a smoke test)
  // supplies a plain http(s) URL; no playlist, no fixture channel.
  // D-83: it may also say what to fetch — video resolution preset, audio
  // bitrate, audio container — but only from the three enums above; anything
  // else is rejected instead of silently falling back.
  handlers.set(IPC_CHANNELS.DOWNLOAD_START, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.DOWNLOAD_START, payload);
    const url = record['url'];
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('[m5-ipc] DOWNLOAD_START requires an http(s) url');
    }
    const kind: DownloadKind = record['kind'] === 'audio' ? 'audio' : 'video';
    const rawQuality = record['quality'];
    const rawAudioQuality = record['audioQuality'];
    const rawAudioFormat = record['audioFormat'];
    if (rawQuality !== undefined && !VIDEO_QUALITY_VALUES.includes(String(rawQuality))) {
      throw new Error('[m5-ipc] invalid quality');
    }
    if (rawAudioQuality !== undefined && !AUDIO_QUALITY_VALUES.includes(String(rawAudioQuality))) {
      throw new Error('[m5-ipc] invalid audioQuality');
    }
    if (rawAudioFormat !== undefined && !AUDIO_FORMAT_VALUES.includes(String(rawAudioFormat))) {
      throw new Error('[m5-ipc] invalid audioFormat');
    }
    if (deps.enqueueSingle === undefined) {
      return { accepted: false, enqueued: false, taskIds: [], reason: '当前构建未启用单视频下载' };
    }
    const taskIds = await deps.enqueueSingle({
      url,
      kind,
      // A video resolution says nothing about an audio task (and vice versa),
      // so each field is only forwarded to the mode that consumes it.
      ...(kind === 'video' && rawQuality !== undefined
        ? { quality: rawQuality as VideoQualityChoice } : {}),
      ...(kind === 'audio' && rawAudioQuality !== undefined
        ? { audioQuality: rawAudioQuality as AudioQualityChoice } : {}),
      ...(kind === 'audio' && rawAudioFormat !== undefined
        ? { audioFormat: rawAudioFormat as AudioFormatChoice } : {}),
    });
    return { accepted: true, enqueued: taskIds.length > 0, taskIds };
  });

  // 0.2.1 (D-98): the download root. `pick` is the only way to change it — the
  // renderer can never hand us an arbitrary string to write into the config.
  handlers.set(IPC_CHANNELS.PATH_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.PATH_ACTION, payload);
    const action = record['action'];
    const kind = record['kind'];
    if (typeof action !== 'string' || !PATH_ACTIONS.includes(action)) {
      throw new Error('[m5-ipc] unknown path action');
    }
    if (kind !== 'video' && kind !== 'audio') throw new Error('[m5-ipc] path kind must be video|audio');
    const key: 'videoDir' | 'audioDir' = kind === 'audio' ? 'audioDir' : 'videoDir';
    const before = readPaths(deps);

    if (action === 'reset') {
      await deps.config.setDomain('paths', { [key]: DEFAULT_PATH_TOKENS[key] });
      const paths = readPaths(deps);
      return { ok: true, action, kind, canceled: false, error: null, path: paths[key], paths };
    }

    if (deps.pathPicker === undefined) {
      return {
        ok: false, action, kind, canceled: false,
        error: '当前构建不支持选择目录', path: null, paths: before,
      };
    }

    if (action === 'open') {
      try {
        await deps.pathPicker.open(before[key]);
        return { ok: true, action, kind, canceled: false, error: null, path: before[key], paths: before };
      } catch (error) {
        return {
          ok: false, action, kind, canceled: false,
          error: error instanceof Error ? error.message : String(error),
          path: null, paths: before,
        };
      }
    }

    const picked = await deps.pathPicker.pick(kind, before[key]);
    if (picked.path === null) {
      return {
        ok: false, action, kind,
        // No error + no path = the user closed the dialog; not a failure.
        canceled: picked.error === null,
        error: picked.error,
        path: null,
        paths: before,
      };
    }
    const next = picked.path.trim();
    if (next === '' || next.length > MAX_PATH_LENGTH || /[\u0000-\u001f]/.test(next)) {
      return {
        ok: false, action, kind, canceled: false,
        error: '所选路径无效', path: null, paths: before,
      };
    }
    await deps.config.setDomain('paths', { [key]: next });
    const paths = readPaths(deps);
    return { ok: true, action, kind, canceled: false, error: null, path: paths[key], paths };
  });

  // D-103: cover-cache management. Every action is main-process owned; the
  // renderer cannot name a file, a directory or a deletion primitive.
  handlers.set(IPC_CHANNELS.THUMBNAIL_CACHE, async (payload): Promise<Record<string, unknown>> => {
    const record = validateM5Payload(IPC_CHANNELS.THUMBNAIL_CACHE, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !THUMBNAIL_CACHE_ACTIONS.includes(action)) {
      throw new Error('[m5-ipc] unknown thumbnail cache action');
    }
    const cache = deps.thumbnails;
    const unavailable = { ok: false, action, available: false, message: '封面缓存未启用' };
    if (cache === undefined) return unavailable;

    if (action === 'status') {
      if (cache.status === undefined) return unavailable;
      return { ok: true, action, available: true, status: await cache.status() };
    }
    if (action === 'prune') {
      if (cache.prune === undefined) return unavailable;
      // The button is an explicit user action: it works even when automatic
      // cleaning is switched off, but still never touches a live cover.
      return { ok: true, action, available: true, report: await cache.prune({ force: true }) };
    }
    if (action === 'set-auto') {
      const enabled = record['enabled'];
      if (typeof enabled !== 'boolean') throw new Error('[m5-ipc] enabled must be a boolean');
      if (cache.setAutoClean === undefined) return unavailable;
      return { ok: true, action, available: true, policy: await cache.setAutoClean(enabled) };
    }
    const maxBytes = record['maxBytes'];
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes)
      || maxBytes < 8 * 1024 * 1024 || maxBytes > 2 * 1024 * 1024 * 1024) {
      throw new Error('[m5-ipc] invalid maxBytes');
    }
    if (cache.setMaxBytes === undefined) return unavailable;
    return { ok: true, action, available: true, policy: await cache.setMaxBytes(maxBytes) };
  });

  // D-114: read-only build identity. Deliberately NOT derived from the page
  // URL: the value must survive a navigation that drops query parameters, and
  // it must never be a literal shipped inside the renderer bundle.
  handlers.set(IPC_CHANNELS.APP_INFO, async (payload) => {
    validateM5Payload(IPC_CHANNELS.APP_INFO, payload);
    const info = deps.appInfo;
    return {
      version: typeof info?.version === 'string' ? info.version : '',
      name: typeof info?.name === 'string' && info.name !== '' ? info.name : 'YTVDLT',
      packaged: info?.packaged === true,
    };
  });

  handlers.set(IPC_CHANNELS.SETTINGS_GET, async (payload) => {
    validateM5Payload(IPC_CHANNELS.SETTINGS_GET, payload);
    return readAppearance(deps);
  });
  handlers.set(IPC_CHANNELS.SETTINGS_SET, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SETTINGS_SET, payload);
    const patch: Record<string, unknown> = {};
    if (record['theme'] !== undefined) {
      const theme = normalizeThemeMode(record['theme']);
      if (theme !== record['theme']) throw new Error('[m5-ipc] invalid theme');
      patch['theme'] = theme;
    }
    if (record['accent'] !== undefined) {
      const accent = record['accent'];
      const valid = typeof accent === 'string' && (
        accent === 'system'
        || (ACCENT_PRESETS as readonly string[]).includes(accent)
        || normalizeHexColor(accent) !== null
      );
      if (!valid) throw new Error('[m5-ipc] invalid accent');
      patch['accent'] = accent;
    }
    if (record['motion'] !== undefined) {
      const motion = normalizeMotionMode(record['motion']);
      if (motion !== record['motion']) throw new Error('[m5-ipc] invalid motion');
      patch['motion'] = motion;
    }
    if (record['language'] !== undefined) {
      const language = String(record['language']);
      if (language !== 'zh-CN' && language !== 'en') throw new Error('[m5-ipc] invalid language');
      patch['language'] = language;
    }
    // D-88: private mode lives in `general.privateMode` (already a declared
    // default since M1). The host reads it on window close / before-quit.
    if (record['privateMode'] !== undefined) {
      if (typeof record['privateMode'] !== 'boolean') throw new Error('[m5-ipc] invalid privateMode');
      patch['privateMode'] = record['privateMode'];
    }
    // 0.2.1: the update switches live in `advanced`, not `general`.
    const advancedPatch: Record<string, unknown> = {};
    for (const key of ['autoCheckAppUpdate', 'autoCheckEngineUpdate'] as const) {
      const value = record[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new Error(`[m5-ipc] invalid ${key}`);
      advancedPatch[key] = value;
    }
    if (Object.keys(patch).length > 0) await deps.config.setDomain('general', patch);
    if (Object.keys(advancedPatch).length > 0) await deps.config.setDomain('advanced', advancedPatch);
    const snapshot = readAppearance(deps);
    deps.onAppearanceChanged?.(snapshot);
    return snapshot;
  });

  return handlers;
}

/** Channel list the preload whitelist must expose (asserted by the tests). */
export const M5_CHANNELS: readonly string[] = [
  IPC_CHANNELS.TASK_LIST,
  IPC_CHANNELS.TASK_DETAIL,
  IPC_CHANNELS.TASK_ACTION,
  IPC_CHANNELS.TEMPLATE_LIST,
  IPC_CHANNELS.TEMPLATE_SAVE,
  IPC_CHANNELS.TEMPLATE_DELETE,
  IPC_CHANNELS.SETTINGS_GET,
  IPC_CHANNELS.COMPONENT_STATUS,
  IPC_CHANNELS.COMPONENT_UPDATE,
  IPC_CHANNELS.COMPONENT_CHECK,
  IPC_CHANNELS.APP_UPDATE_STATUS,
  IPC_CHANNELS.APP_UPDATE_ACTION,
  IPC_CHANNELS.PATH_ACTION,
  IPC_CHANNELS.SETTINGS_SET,
  IPC_CHANNELS.DOWNLOAD_START,
  IPC_CHANNELS.THUMBNAIL_CACHE,
  IPC_CHANNELS.APP_INFO,
];
