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
import type { DownloadKind, TaskRecord } from '@ytvdlt/shared';
import {
  ACCENT_PRESETS, buildTaskListSnapshot, maskUrlSecrets,
  normalizeHexColor, normalizeThemeMode, normalizeMotionMode, parseAccent,
} from '@ytvdlt/core';
import type {
  AccentChoice, CommandTemplateInput, CommandTemplateStore, IConfigStore,
  MotionMode, TaskDetailAction, TaskDetailResult, TaskTab, ThemeMode,
} from '@ytvdlt/core';

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
  run(): Promise<unknown>;
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
  readonly enqueueSingle?: (input: { readonly url: string; readonly kind: DownloadKind }) => Promise<readonly string[]>;
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
  readonly artifactCount: number;
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
  readonly systemAccent: string | null;
  readonly prefersDark: boolean;
  readonly prefersReducedMotion: boolean;
}

const TASK_ACTIONS: readonly TaskDetailAction[] = [
  'open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry',
];

const MAX_TEMPLATE_ARGS = 32;
const MAX_ARG_LENGTH = 400;

const PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  [IPC_CHANNELS.TASK_LIST]: ['tab', 'query'],
  [IPC_CHANNELS.TASK_DETAIL]: ['taskId'],
  [IPC_CHANNELS.TASK_ACTION]: ['taskId', 'action'],
  [IPC_CHANNELS.TEMPLATE_LIST]: [],
  [IPC_CHANNELS.TEMPLATE_SAVE]: ['id', 'name', 'args'],
  [IPC_CHANNELS.TEMPLATE_DELETE]: ['id'],
  [IPC_CHANNELS.SETTINGS_GET]: [],
  [IPC_CHANNELS.SETTINGS_SET]: ['theme', 'accent', 'motion', 'language'],
  [IPC_CHANNELS.COMPONENT_STATUS]: [],
  [IPC_CHANNELS.COMPONENT_UPDATE]: [],
  [IPC_CHANNELS.DOWNLOAD_START]: ['url', 'kind'],
};

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
export function toTaskListItem(record: TaskRecord): TaskListItemDto {
  return {
    id: record.id,
    state: record.state,
    kind: record.kind,
    title: record.mediaInfo?.title ?? record.id,
    uploader: record.mediaInfo?.uploader ?? null,
    duration: record.mediaInfo?.duration ?? null,
    percent: record.lastPercent,
    errorCode: record.error?.code ?? null,
    artifactCount: record.artifacts.length,
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

function readAppearance(deps: M5ChannelDeps): AppearanceDto {
  return {
    theme: normalizeThemeMode(deps.config.get('general', 'theme')),
    accent: parseAccent(deps.config.get('general', 'accent')),
    motion: normalizeMotionMode(deps.config.get('general', 'motion')),
    language: String(deps.config.get('general', 'language')).toLowerCase().startsWith('en') ? 'en' : 'zh-CN',
    systemAccent: deps.systemAppearance.accent(),
    prefersDark: deps.systemAppearance.prefersDark(),
    prefersReducedMotion: deps.systemAppearance.prefersReducedMotion(),
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
      items: snapshot.visible.map(toTaskListItem),
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
    return deps.taskDetail.perform(taskId, action as TaskDetailAction);
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

  // D-69: the real single-video download entry. The renderer (or a smoke test)
  // supplies a plain http(s) URL; no playlist, no fixture channel.
  handlers.set(IPC_CHANNELS.DOWNLOAD_START, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.DOWNLOAD_START, payload);
    const url = record['url'];
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('[m5-ipc] DOWNLOAD_START requires an http(s) url');
    }
    const kind: DownloadKind = record['kind'] === 'audio' ? 'audio' : 'video';
    if (deps.enqueueSingle === undefined) {
      return { accepted: false, enqueued: false, taskIds: [], reason: '当前构建未启用单视频下载' };
    }
    const taskIds = await deps.enqueueSingle({ url, kind });
    return { accepted: true, enqueued: taskIds.length > 0, taskIds };
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
    if (Object.keys(patch).length > 0) await deps.config.setDomain('general', patch);
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
  IPC_CHANNELS.SETTINGS_SET,
  IPC_CHANNELS.DOWNLOAD_START,
];
