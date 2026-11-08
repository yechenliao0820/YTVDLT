/**
 * M5-0 · IPC surface (A-M5-00 / A-4.4-16 / A-4.4-20).
 *
 * The channels are tested against REAL services (ConfigStore, CommandTemplateStore)
 * and fake task ports, because the security-relevant properties live here:
 *   - `TASK_LIST` ships a DTO with NO `url` key at all;
 *   - `TASK_DETAIL` masks the URL (`token=***REDACTED***`);
 *   - the payload whitelist rejects unknown keys and bad types;
 *   - settings writes go through ConfigStore, never straight to a file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { TaskRecord } from '@ytvdlt/shared';
import { CommandTemplateStore, ConfigStore, maskUrlSecrets } from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import {
  M5_CHANNELS, createM5Handlers, toTaskDetail, toTaskListItem, validateM5Payload,
  type M5ChannelDeps, type SingleDownloadInput, type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createInMemoryPorts, type InMemoryPorts } from './helpers/in-memory-ports.js';

const SIGNED_URL = 'https://example.org/watch?v=abc&token=SUPERSECRET&sig=deadbeef';

function record(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    url: SIGNED_URL,
    kind: 'video',
    state: 'Running',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    mediaInfo: {
      id: 'v', title: `Video ${id}`, uploader: 'Uploader', uploader_id: null, duration: 120,
      thumbnail: null, webpage_url: SIGNED_URL, extractor_key: 'generic', description: null,
      upload_date: null, ext: 'mp4', formats: [], subtitles: {}, automatic_captions: {},
      chapters: null, _type: 'video',
    },
    request: null,
    artifacts: [],
    lastPercent: 42,
    error: null,
    privateMode: false,
    postprocessed: false,
    ...overrides,
  };
}

interface Harness {
  ports: InMemoryPorts;
  deps: M5ChannelDeps;
  handlers: Map<string, (payload: unknown) => Promise<unknown>>;
  calls: TaskDetailAction[];
}

const appearance: SystemAppearancePort = {
  prefersDark: () => false,
  prefersReducedMotion: () => false,
  accent: () => '#0f6b64',
};

async function harness(
  records: readonly TaskRecord[] = [record('t1'), record('t2', { state: 'Completed' })],
  overrides: Partial<M5ChannelDeps> = {},
): Promise<Harness> {
  const ports = createInMemoryPorts();
  const config = new ConfigStore({ ports: ports.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: ports.ports });
  await templates.init();
  const calls: TaskDetailAction[] = [];
  const byId = new Map(records.map((item) => [item.id, item]));

  const deps: M5ChannelDeps = {
    queue: {
      list: () => records,
      get: (id: string) => byId.get(id),
    },
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        calls.push(action);
        return { action, ok: true, code: 'OK', message: `${taskId}:${action}` };
      },
    },
    templates,
    config,
    systemAppearance: appearance,
    ...overrides,
  };
  return { ports, deps, handlers: createM5Handlers(deps), calls };
}

describe('m5 ipc · channel inventory', () => {
  // 11 (M5) + COMPONENT_CHECK / APP_UPDATE_STATUS / APP_UPDATE_ACTION / PATH_ACTION (0.2.1).
  it('exposes exactly the fifteen M5 channels, all present in IPC_CHANNELS', () => {
    expect(M5_CHANNELS).toHaveLength(15);
    const values = Object.values(IPC_CHANNELS);
    for (const channel of M5_CHANNELS) expect(values).toContain(channel);
    expect(new Set(M5_CHANNELS).size).toBe(M5_CHANNELS.length);
  });

  it('appends channels without renumbering the M3/M4 ones', () => {
    expect(IPC_CHANNELS.PROBE).toBe('ytvdlt:probe');
    expect(IPC_CHANNELS.PLAYLIST_ENQUEUE).toBe('ytvdlt:playlist:enqueue');
    expect(IPC_CHANNELS.TASK_LIST).toBe('ytvdlt:task:list');
  });
});

describe('m5 ipc · payload whitelist', () => {
  it('rejects unknown keys, non-objects and unregistered channels', () => {
    expect(() => validateM5Payload(IPC_CHANNELS.TASK_LIST, { evil: 1 })).toThrow(/key not allowed/);
    expect(() => validateM5Payload(IPC_CHANNELS.TASK_LIST, 'nope')).toThrow(/must be an object/);
    expect(() => validateM5Payload('ytvdlt:nope', {})).toThrow(/unregistered channel/);
    expect(validateM5Payload(IPC_CHANNELS.TASK_LIST, { tab: 'all' })).toEqual({ tab: 'all' });
  });
});

describe('m5 ipc · task list never leaks a URL', () => {
  it('projects a URL-free DTO', () => {
    const dto = toTaskListItem(record('t1'));
    expect(Object.keys(dto)).not.toContain('url');
    expect(JSON.stringify(dto)).not.toContain('SUPERSECRET');
    expect(dto.title).toBe('Video t1');
    expect(dto.percent).toBe(42);
  });

  it('filters by tab and query, and reports counts', async () => {
    const { handlers } = await harness();
    const all = await handlers.get(IPC_CHANNELS.TASK_LIST)?.({}) as {
      counts: Record<string, number>; items: unknown[]; empty: unknown;
    };
    expect(all.counts).toEqual({ all: 2, downloading: 1, finished: 1, canceled: 0 });
    expect(all.items).toHaveLength(2);
    expect(all.empty).toBeNull();

    const finished = await handlers.get(IPC_CHANNELS.TASK_LIST)?.({ tab: 'finished' }) as { items: { id: string }[] };
    expect(finished.items.map((item) => item.id)).toEqual(['t2']);

    const empty = await handlers.get(IPC_CHANNELS.TASK_LIST)?.({ tab: 'canceled' }) as { empty: { variant: string } };
    expect(empty.empty.variant).toBe('filter');

    await expect(handlers.get(IPC_CHANNELS.TASK_LIST)?.({ tab: 'bogus' })).rejects.toThrow(/invalid tab/);
    await expect(handlers.get(IPC_CHANNELS.TASK_LIST)?.({ query: 7 })).rejects.toThrow(/query must be a string/);
  });

  it('reports an empty queue as the "no tasks" state', async () => {
    const { handlers } = await harness([]);
    const result = await handlers.get(IPC_CHANNELS.TASK_LIST)?.({}) as { empty: { variant: string }; counts: { all: number } };
    expect(result.empty.variant).toBe('empty');
    expect(result.counts.all).toBe(0);
  });
});

describe('m5 ipc · task detail masks the link', () => {
  it('masks signed query parameters', () => {
    const detail = toTaskDetail(record('t1'));
    expect(detail.url).toBe(maskUrlSecrets(SIGNED_URL));
    expect(detail.url).not.toContain('SUPERSECRET');
    expect(detail.url).toContain('token=');
  });

  it('returns found=false for an unknown task', async () => {
    const { handlers } = await harness();
    expect(await handlers.get(IPC_CHANNELS.TASK_DETAIL)?.({ taskId: 'nope' })).toEqual({ found: false, task: null });
    await expect(handlers.get(IPC_CHANNELS.TASK_DETAIL)?.({ taskId: '' })).rejects.toThrow(/taskId/);
  });
});

describe('m5 ipc · task actions', () => {
  it('routes the seven documented actions', async () => {
    const { handlers, calls } = await harness();
    for (const action of ['open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry']) {
      const result = await handlers.get(IPC_CHANNELS.TASK_ACTION)?.({ taskId: 't1', action }) as { ok: boolean };
      expect(result.ok).toBe(true);
    }
    expect(calls).toHaveLength(7);
    await expect(handlers.get(IPC_CHANNELS.TASK_ACTION)?.({ taskId: 't1', action: 'exec-shell' }))
      .rejects.toThrow(/unknown task action/);
  });
});

describe('m5 ipc · command template CRUD', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('creates, lists, updates and removes a template', async () => {
    const created = await h.handlers.get(IPC_CHANNELS.TEMPLATE_SAVE)?.({
      name: '1080p mp4', args: ['-f', 'bestvideo[height<=1080]+bestaudio', '--merge-output-format', 'mp4'],
    }) as { created: boolean; template: { id: string; name: string } };
    expect(created.created).toBe(true);
    expect(created.template.name).toBe('1080p mp4');

    const listed = await h.handlers.get(IPC_CHANNELS.TEMPLATE_LIST)?.({}) as { templates: { id: string }[] };
    expect(listed.templates).toHaveLength(1);

    const updated = await h.handlers.get(IPC_CHANNELS.TEMPLATE_SAVE)?.({
      id: created.template.id, name: '720p', args: ['-f', 'best[height<=720]'],
    }) as { created: boolean; template: { name: string } };
    expect(updated.created).toBe(false);
    expect(updated.template.name).toBe('720p');

    const removed = await h.handlers.get(IPC_CHANNELS.TEMPLATE_DELETE)?.({ id: created.template.id }) as { removed: boolean };
    expect(removed.removed).toBe(true);
    const again = await h.handlers.get(IPC_CHANNELS.TEMPLATE_DELETE)?.({ id: created.template.id }) as { removed: boolean };
    expect(again.removed).toBe(false);
  });

  it('rejects malformed template input before it reaches the store', async () => {
    await expect(h.handlers.get(IPC_CHANNELS.TEMPLATE_SAVE)?.({ name: '', args: ['-f'] })).rejects.toThrow(/name/);
    await expect(h.handlers.get(IPC_CHANNELS.TEMPLATE_SAVE)?.({ name: 'x', args: [] })).rejects.toThrow(/args/);
    await expect(h.handlers.get(IPC_CHANNELS.TEMPLATE_SAVE)?.({ name: 'x', args: [1] })).rejects.toThrow(/strings/);
    // A denied option must be refused by the store's argv whitelist, not stored.
    await expect(h.handlers.get(IPC_CHANNELS.TEMPLATE_SAVE)?.({ name: 'bad', args: ['--exec', 'calc.exe'] }))
      .rejects.toThrow();
  });
});

describe('m5 ipc · settings', () => {
  it('reads defaults and persists a partial patch', async () => {
    const { handlers, ports } = await harness();
    const initial = await handlers.get(IPC_CHANNELS.SETTINGS_GET)?.({}) as Record<string, unknown>;
    expect(initial['theme']).toBe('system');
    expect(initial['language']).toBe('zh-CN');
    expect(initial['systemAccent']).toBe('#0f6b64');

    const updated = await handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({
      theme: 'dark', accent: 'teal', motion: 'reduced', language: 'en',
    }) as Record<string, unknown>;
    expect(updated['theme']).toBe('dark');
    expect(updated['accent']).toEqual({ kind: 'preset', value: 'teal' });
    expect(updated['motion']).toBe('reduced');
    expect(updated['language']).toBe('en');

    // Persisted to the injected config file (not just in memory).
    const stored = JSON.parse(ports.state.files.get(`${ports.state.env.configDir}/config.json`) ?? '{}') as {
      domains: { general: Record<string, unknown> };
    };
    expect(stored.domains.general['theme']).toBe('dark');
    expect(stored.domains.general['language']).toBe('en');
  });

  it('rejects invalid enum values instead of silently coercing them', async () => {
    const { handlers } = await harness();
    await expect(handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ theme: 'sepia' })).rejects.toThrow(/invalid theme/);
    await expect(handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ motion: 'fast' })).rejects.toThrow(/invalid motion/);
    await expect(handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ language: 'fr' })).rejects.toThrow(/invalid language/);
    await expect(handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ accent: 42 })).rejects.toThrow(/invalid accent/);
  });

  it('notifies the native layer after a change', async () => {
    const ports = createInMemoryPorts();
    const config = new ConfigStore({ ports: ports.ports });
    await config.load();
    const seen: string[] = [];
    const handlers = createM5Handlers({
      queue: { list: () => [], get: () => undefined },
      taskDetail: { perform: async () => ({ action: 'cancel' as TaskDetailAction, ok: true, code: 'OK' as const, message: '' }) },
      templates: new CommandTemplateStore({ ports: ports.ports }),
      config,
      systemAppearance: appearance,
      onAppearanceChanged: (snapshot) => { seen.push(snapshot.theme); },
    });
    await handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ theme: 'light' });
    expect(seen).toEqual(['light']);
  });
});

describe('D-67 · component update channels', () => {
  const statusPort = {
    status: async () => ({
      components: [{ id: 'yt-dlp', label: 'yt-dlp', fileName: 'yt-dlp.exe', installed: true, version: '2026.10.26' }],
      source: 'https://feed.example.org',
      updating: false,
    }),
    run: async () => ({ ok: true, source: 'https://feed.example.org', reason: 'ok', results: [] }),
  };

  it('routes both channels to the injected updater', async () => {
    const { deps } = await harness();
    const handlers = createM5Handlers({ ...deps, componentUpdate: statusPort });
    const status = await handlers.get(IPC_CHANNELS.COMPONENT_STATUS)?.({}) as { source: string | null };
    expect(status.source).toBe('https://feed.example.org');
    const update = await handlers.get(IPC_CHANNELS.COMPONENT_UPDATE)?.({}) as { ok: boolean };
    expect(update.ok).toBe(true);
  });

  it('degrades to "disabled" when the build ships no updater', async () => {
    const { deps } = await harness();
    const handlers = createM5Handlers(deps);
    expect(await handlers.get(IPC_CHANNELS.COMPONENT_STATUS)?.({}))
      .toEqual({ components: [], source: null, updating: false });
    const update = await handlers.get(IPC_CHANNELS.COMPONENT_UPDATE)?.({}) as { ok: boolean; reason: string };
    expect(update.ok).toBe(false);
    expect(update.reason).toContain('未启用');
  });

  it('rejects an unexpected payload key on both channels', async () => {
    const { deps } = await harness();
    const handlers = createM5Handlers({ ...deps, componentUpdate: statusPort });
    await expect(handlers.get(IPC_CHANNELS.COMPONENT_STATUS)?.({ url: 'x' })).rejects.toThrow(/not allowed/);
    await expect(handlers.get(IPC_CHANNELS.COMPONENT_UPDATE)?.({ force: true })).rejects.toThrow(/not allowed/);
  });
});

describe('m5 ipc · DOWNLOAD_START carries the user choice (D-83)', () => {
  it('forwards the audio branch as kind + bitrate + container, nothing else', async () => {
    const seen: SingleDownloadInput[] = [];
    const { handlers } = await harness(undefined, {
      enqueueSingle: async (input) => { seen.push(input); return ['single-1']; },
    });
    const result = await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({
      url: 'https://example.org/v',
      kind: 'audio',
      audioQuality: '192',
      audioFormat: 'mp3',
    }) as { accepted: boolean; enqueued: boolean; taskIds: string[] };
    expect(result).toMatchObject({ accepted: true, enqueued: true, taskIds: ['single-1'] });
    expect(seen[0]).toEqual({
      url: 'https://example.org/v', kind: 'audio', audioQuality: '192', audioFormat: 'mp3',
    });
  });

  it('forwards the video branch as a resolution preset only', async () => {
    const seen: SingleDownloadInput[] = [];
    const { handlers } = await harness(undefined, {
      enqueueSingle: async (input) => { seen.push(input); return ['single-2']; },
    });
    // An audio field sent with kind=video must not leak into the request.
    await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({
      url: 'https://example.org/v', kind: 'video', quality: '1080p', audioQuality: '192',
    });
    expect(seen[0]).toEqual({ url: 'https://example.org/v', kind: 'video', quality: '1080p' });
  });

  it('rejects values outside the three enums instead of silently defaulting', async () => {
    const seen: SingleDownloadInput[] = [];
    const { handlers } = await harness(undefined, {
      enqueueSingle: async (input) => { seen.push(input); return ['single-3']; },
    });
    const channel = handlers.get(IPC_CHANNELS.DOWNLOAD_START);
    await expect(channel?.({ url: 'https://example.org/v', quality: '4320p' })).rejects.toThrow(/invalid quality/);
    await expect(channel?.({ url: 'https://example.org/v', kind: 'audio', audioQuality: '999' }))
      .rejects.toThrow(/invalid audioQuality/);
    await expect(channel?.({ url: 'https://example.org/v', kind: 'audio', audioFormat: 'flac' }))
      .rejects.toThrow(/invalid audioFormat/);
    expect(seen).toHaveLength(0);
  });

  it('still reports "disabled" when the build has no enqueue port', async () => {
    const { handlers } = await harness();
    const result = await handlers.get(IPC_CHANNELS.DOWNLOAD_START)?.({
      url: 'https://example.org/v', kind: 'audio',
    }) as { accepted: boolean; enqueued: boolean; reason: string };
    expect(result).toMatchObject({ accepted: false, enqueued: false });
    expect(result.reason).toContain('未启用');
  });
});

describe('m5 ipc · removing a task together with its local files (D-87)', () => {
  it('recycles exactly this task artifacts, then removes the record', async () => {
    const seen: string[][] = [];
    const records = [
      record('t1', { state: 'Completed', artifacts: ['C:/V/a.mp4', 'C:/V/a.vtt'] }),
      record('t2', { state: 'Completed' }),
    ];
    const { handlers, calls } = await harness(records, {
      trashFiles: { trash: async (paths) => { seen.push([...paths]); return [...paths]; } },
    });
    const result = await handlers.get(IPC_CHANNELS.TASK_ACTION)?.({
      taskId: 't1', action: 'remove', withFiles: true,
    }) as TaskDetailResult;
    expect(seen).toEqual([['C:/V/a.mp4', 'C:/V/a.vtt']]);
    expect(calls).toEqual(['remove']);
    expect(result.ok).toBe(true);
  });

  it('keeps the record when the recycle bin handled only part of the files', async () => {
    const records = [record('t1', { state: 'Completed', artifacts: ['a.mp4', 'b.vtt'] })];
    const { handlers, calls } = await harness(records, {
      trashFiles: { trash: async (paths) => paths.slice(0, 1) },
    });
    const result = await handlers.get(IPC_CHANNELS.TASK_ACTION)?.({
      taskId: 't1', action: 'remove', withFiles: true,
    }) as { ok: boolean; code: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERROR');
    expect(calls).toHaveLength(0);
  });

  it('refuses withFiles for other actions and rejects non-boolean values', async () => {
    const { handlers } = await harness(undefined, {
      trashFiles: { trash: async (paths) => paths },
    });
    const channel = handlers.get(IPC_CHANNELS.TASK_ACTION);
    await expect(channel?.({ taskId: 't1', action: 'cancel', withFiles: true }))
      .rejects.toThrow(/withFiles requires action=remove/);
    await expect(channel?.({ taskId: 't1', action: 'remove', withFiles: 'yes' }))
      .rejects.toThrow(/withFiles must be a boolean/);
  });

  it('deletes nothing when no recycle port is wired into the build', async () => {
    const { handlers, calls } = await harness();
    const result = await handlers.get(IPC_CHANNELS.TASK_ACTION)?.({
      taskId: 't1', action: 'remove', withFiles: true,
    }) as { ok: boolean; code: string };
    expect(result).toMatchObject({ ok: false, code: 'SHELL_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });
});

describe('m5 ipc · private mode setting (D-88)', () => {
  it('persists privateMode and reads it back through SETTINGS_GET', async () => {
    const { handlers, deps } = await harness();
    const before = await handlers.get(IPC_CHANNELS.SETTINGS_GET)?.({}) as { privateMode: boolean };
    expect(before.privateMode).toBe(false);
    const updated = await handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ privateMode: true }) as { privateMode: boolean };
    expect(updated.privateMode).toBe(true);
    expect(deps.config.get('general', 'privateMode')).toBe(true);
  });

  it('rejects a non-boolean privateMode', async () => {
    const { handlers } = await harness();
    await expect(handlers.get(IPC_CHANNELS.SETTINGS_SET)?.({ privateMode: 'yes' }))
      .rejects.toThrow(/invalid privateMode/);
  });
});

describe('m5 ipc · download location (D-98)', () => {
  const expand = (raw: string): string => raw.split('%USERPROFILE%').join('C:/Users/leo');

  function withPicker(result: { path: string | null; error: string | null }) {
    const picked: Array<{ kind: string; startAt: string }> = [];
    const opened: string[] = [];
    return {
      picked,
      opened,
      port: {
        pick: async (kind: 'video' | 'audio', startAt: string) => {
          picked.push({ kind, startAt });
          return result;
        },
        open: async (path: string) => { opened.push(path); },
      },
    };
  }

  it('returns the expanded defaults through SETTINGS_GET, never an empty string', async () => {
    const { handlers } = await harness(undefined, { expandPath: expand });
    const settings = await handlers.get(IPC_CHANNELS.SETTINGS_GET)?.({}) as { videoDir: string; audioDir: string };
    expect(settings.videoDir).toBe('C:/Users/leo/Downloads/YTVDLT');
    expect(settings.audioDir).toBe('C:/Users/leo/Downloads/YTVDLT/Audio');
  });

  it('persists a picked folder and echoes the new resolved path', async () => {
    const picker = withPicker({ path: 'D:/Video', error: null });
    const { handlers, deps } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    const result = await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'video' }) as {
      ok: boolean; path: string; paths: { videoDir: string };
    };
    expect(result.ok).toBe(true);
    expect(result.path).toBe('D:/Video');
    expect(result.paths.videoDir).toBe('D:/Video');
    expect(deps.config.get('paths', 'videoDir')).toBe('D:/Video');
    expect(picker.picked[0]?.startAt).toBe('C:/Users/leo/Downloads/YTVDLT');
  });

  it('keeps audio and video independent', async () => {
    const picker = withPicker({ path: 'D:/Music', error: null });
    const { handlers, deps } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'audio' });
    expect(deps.config.get('paths', 'audioDir')).toBe('D:/Music');
    expect(deps.config.get('paths', 'videoDir')).toBe('%USERPROFILE%/Downloads/YTVDLT');
  });

  it('treats a cancelled dialog as "no change", not as an error', async () => {
    const picker = withPicker({ path: null, error: null });
    const { handlers, deps } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    const result = await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'video' }) as {
      ok: boolean; canceled: boolean; error: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(true);
    expect(result.error).toBeNull();
    expect(deps.config.get('paths', 'videoDir')).toBe('%USERPROFILE%/Downloads/YTVDLT');
  });

  it('refuses to save a folder that is not writable', async () => {
    const picker = withPicker({ path: null, error: '该文件夹不可写：C:/Windows/System32' });
    const { handlers, deps } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    const result = await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'video' }) as {
      ok: boolean; canceled: boolean; error: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(false);
    expect(result.error).toContain('不可写');
    expect(deps.config.get('paths', 'videoDir')).toBe('%USERPROFILE%/Downloads/YTVDLT');
  });

  it('resets to the shipped default token', async () => {
    const picker = withPicker({ path: 'D:/Video', error: null });
    const { handlers, deps } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'video' });
    const result = await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'reset', kind: 'video' }) as {
      ok: boolean; path: string;
    };
    expect(result.ok).toBe(true);
    expect(deps.config.get('paths', 'videoDir')).toBe('%USERPROFILE%/Downloads/YTVDLT');
    expect(result.path).toBe('C:/Users/leo/Downloads/YTVDLT');
  });

  it('opens the resolved folder through the picker port', async () => {
    const picker = withPicker({ path: null, error: null });
    const { handlers } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'open', kind: 'audio' });
    expect(picker.opened).toEqual(['C:/Users/leo/Downloads/YTVDLT/Audio']);
  });

  it('rejects an unknown action or kind', async () => {
    const picker = withPicker({ path: 'D:/x', error: null });
    const { handlers } = await harness(undefined, { expandPath: expand, pathPicker: picker.port });
    await expect(handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'rm -rf', kind: 'video' }))
      .rejects.toThrow(/unknown path action/);
    await expect(handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'music' }))
      .rejects.toThrow(/video\|audio/);
  });

  it('reports a disabled picker instead of pretending to save', async () => {
    const { handlers } = await harness(undefined, { expandPath: expand });
    const result = await handlers.get(IPC_CHANNELS.PATH_ACTION)?.({ action: 'pick', kind: 'video' }) as {
      ok: boolean; error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不支持');
  });
});
