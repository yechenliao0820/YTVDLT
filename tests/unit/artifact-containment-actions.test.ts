/**
 * D-182 · action-time containment (layer 2, defence in depth).
 *
 * The intake gate (task-queue, layer 1) already keeps foreign paths out of
 * records created in this session; these tests pin what the DESTRUCTIVE
 * actions do when a record nevertheless carries one (restored / manipulated
 * snapshot):
 *   - `withFiles` removal refuses the WHOLE batch before anything is trashed;
 *   - `open-file` / `open-folder` refuse an outside target (core task-detail);
 *   - a record without a request cannot be judged and keeps the frozen D-120
 *     semantics (fail-open, pinned deliberately).
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { DownloadRequest, TaskRecord } from '@ytvdlt/shared';
import {
  CommandTemplateStore, ConfigStore, TaskDetailService, buildErrorReport, formatErrorReport,
} from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import type { IShellPort } from '@ytvdlt/shared';
import {
  createM5Handlers, type M5ChannelDeps, type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const REQUEST: DownloadRequest = {
  taskId: 't1', url: 'https://example.org/v',
  format: { quality: 'best', videoCodecPref: 'auto', formatId: null, sortingFields: null, extractAudio: false, audioQuality: 'best', audioCodecPref: 'auto', audioFormat: null, audioMultistreams: false },
  subtitle: { enabled: false, languages: 'en.*', autoCaptions: false, skipTranslated: true, convertTo: 'none', embed: false, keepSubtitleFile: false },
  paths: { videoDir: 'C:/Videos', audioDir: 'C:/Music', commandDir: 'C:/cmd', privateMode: false, subdirByExtractor: false, subdirByPlaylist: false, outputTemplate: '%(title)s.%(ext)s', tempDir: 'C:/temp/t1' },
  network: { rateLimit: null, proxy: null, cookiesFile: null, userAgent: null, ipv4Only: false, concurrentFragments: null, aria2cPath: null },
  advanced: { sponsorblockRemove: null, downloadSections: null, splitChapters: false, customTitle: null, debug: false, downloadArchive: null, customCommand: null },
};

const record = (artifacts: readonly string[], withRequest: boolean = true): TaskRecord => ({
  id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Completed',
  createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
  mediaInfo: null, request: withRequest ? REQUEST : null, artifacts: [...artifacts],
  lastPercent: 100, error: null, privateMode: false, postprocessed: false,
});

const appearance: SystemAppearancePort = {
  prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
};

interface Harness {
  dispatch(channel: string, payload: unknown): Promise<Record<string, unknown>>;
  trashCalls: string[][];
  shellCalls: Array<{ op: string; path: string }>;
  performCalls: string[];
  recordGone(): boolean;
}

async function harness(initial: TaskRecord): Promise<Harness> {
  const mem = createInMemoryPorts();
  for (const artifact of initial.artifacts) mem.state.files.set(artifact, 'video-bytes');
  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();

  const trashCalls: string[][] = [];
  const shellCalls: Array<{ op: string; path: string }> = [];
  const performCalls: string[] = [];
  let current: TaskRecord | undefined = initial;
  const shell: IShellPort = {
    async openPath(path: string) { shellCalls.push({ op: 'open', path }); },
    async showItemInFolder(path: string) { shellCalls.push({ op: 'reveal', path }); },
  };
  const taskDetail = new TaskDetailService({
    ports: mem.ports,
    queue: {
      async enqueue() {}, async enqueueBatch() { return []; },
      async cancel() { return true; }, async restart() {},
      async remove(id: string) {
        if (current?.id === id) current = undefined;
        return true;
      },
      get: (id) => (current?.id === id ? current : undefined),
      list: () => (current === undefined ? [] : [current]),
      onEvent: () => () => {},
      concurrency: 1, activeTaskIds: [], pendingCount: 0, setConcurrency: () => 1,
    },
    shell,
    buildReport: (task) => buildErrorReport({
      task, appVersion: '0.0.0', engineVersion: 'fake', os: 'win32', stderr: '',
    }, '2026-11-14T00:00:00.000Z'),
    formatReport: formatErrorReport,
  });

  const deps: M5ChannelDeps = {
    queue: {
      list: () => (current === undefined ? [] : [current]),
      get: (id) => (current?.id === id ? current : undefined),
    },
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        performCalls.push(`${taskId}:${action}`);
        return taskDetail.perform(taskId, action);
      },
    },
    templates,
    config,
    systemAppearance: appearance,
    trashFiles: {
      async trash(paths) {
        trashCalls.push([...paths]);
        return paths.map((path) => ({ path, status: 'trashed' as const }));
      },
    },
  };
  const handlers = createM5Handlers(deps);
  return {
    dispatch: async (channel: string, payload: unknown) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`unregistered channel: ${channel}`);
      return (await handler(payload)) as Record<string, unknown>;
    },
    trashCalls,
    shellCalls,
    performCalls,
    recordGone: () => current === undefined,
  };
}

describe('D-182 · withFiles removal refuses paths outside the record roots', () => {
  it('refuses the WHOLE batch before any trash and keeps the record', async () => {
    const h = await harness(record(['C:/Videos/a.mp4', 'C:/Windows/evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(String(result['reason'])).toContain('超出任务输出目录');
    expect(result['failureKind']).toBe('file-cleanup');
    // Nothing was trashed, nothing was removed, the refusal is not silent.
    expect(h.trashCalls).toEqual([]);
    expect(h.performCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });

  it('a `..` traversal recorded in a snapshot cannot be trashed either', async () => {
    const h = await harness(record(['C:/Videos/../../evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(false);
    expect(h.trashCalls).toEqual([]);
    expect(h.recordGone()).toBe(false);
  });

  it('all-contained artifacts still flow through D-120 unchanged', async () => {
    const h = await harness(record([
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Videos/Title [id].en.srt',
      'C:/Music/Title [id].mp3',
    ]));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(true);
    expect(h.trashCalls).toEqual([[
      'C:/Videos/Title [id]_(1).mp4',
      'C:/Videos/Title [id].en.srt',
      'C:/Music/Title [id].mp3',
    ]]);
    expect(h.recordGone()).toBe(true);
  });

  it('a record without a request cannot be judged and keeps D-120 semantics', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4'], false));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, {
      taskId: 't1', action: 'remove', withFiles: true,
    });
    expect(result['ok']).toBe(true);
    expect(h.trashCalls).toEqual([['C:/Windows/evil.mp4']]);
    expect(h.recordGone()).toBe(true);
  });
});

describe('D-182 · open actions refuse an outside target (core task-detail)', () => {
  it('open-file returns REFUSED and never calls the shell', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('REFUSED');
    expect(h.shellCalls).toEqual([]);
    expect(h.performCalls).toEqual(['t1:open-file']);
  });

  it('open-folder refuses the same way (it would reveal the parent dir)', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('REFUSED');
    expect(h.shellCalls).toEqual([]);
  });

  it('an inside target keeps the D-120 open behaviour (file present → shell)', async () => {
    const h = await harness(record(['C:/Videos/a.mp4']));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result['ok']).toBe(true);
    expect(h.shellCalls).toEqual([{ op: 'open', path: 'C:/Videos/a.mp4' }]);
  });

  it('a request-less record keeps the pre-D-182 open behaviour', async () => {
    const h = await harness(record(['C:/Windows/evil.mp4'], false));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    // No roots → no verdict → the gate stays open; the file exists on the fake
    // fs, so the shell is invoked exactly as before D-182.
    expect(result['ok']).toBe(true);
    expect(h.shellCalls).toEqual([{ op: 'open', path: 'C:/Windows/evil.mp4' }]);
  });
});
