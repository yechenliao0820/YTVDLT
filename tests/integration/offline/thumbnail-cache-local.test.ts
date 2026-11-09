/**
 * D-103 · offline integration: UI IPC channel -> M5 handlers -> real cache
 * adapter -> real filesystem, with the real ConfigStore for policy values.
 *
 * This is the seam where the settings page talks to the cache. It proves that
 * the renderer can read occupancy, flip the switch, change capacity and ask
 * for a manual prune WITHOUT ever supplying a path, and that removing a task
 * through TASK_ACTION releases its cover claim.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { ConfigStore, CommandTemplateStore, type ILogger, type TaskDetailAction, type TaskDetailResult } from '@ytvdlt/core';
import type { TaskRecord } from '@ytvdlt/shared';
import { createInMemoryPorts } from '../../unit/helpers/in-memory-ports.js';
import { createM5Handlers, type M5ChannelDeps } from '../../../apps/desktop/src/main/m5-channels.js';
import { createThumbnailCache } from '../../../apps/desktop/src/main/thumbnail-cache.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);

function logger(): ILogger {
  const noop = async (): Promise<void> => undefined;
  return {
    log: noop, info: noop, warn: noop, error: noop, logArgv: noop,
    writeCrashReport: async () => '', exportLogs: async () => '',
  };
}

interface Harness {
  readonly handlers: Map<string, (payload: unknown) => Promise<unknown>>;
  readonly config: ConfigStore;
  readonly dir: string;
  readonly trashed: string[];
  readonly templates: CommandTemplateStore;
  live: string[];
  cache: ReturnType<typeof createThumbnailCache>;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ytvdlt-cache-ipc-'));
  const ports = createInMemoryPorts();
  const config = new ConfigStore({ ports: ports.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: ports.ports });
  await templates.init();
  const trashed: string[] = [];
  const state = {
    dir, config, trashed, templates, live: [] as string[], handlers: new Map() as Harness['handlers'],
    cache: undefined as unknown as Harness['cache'],
  } as Harness;

  const cache = createThumbnailCache({
    dir,
    logger: logger(),
    liveTaskIds: () => state.live,
    policy: () => {
      const saved = config.get('advanced', 'thumbnailCacheMaxBytes');
      return {
        enabled: config.get('advanced', 'autoCleanThumbnailCache') !== false,
        maxBytes: typeof saved === 'number' ? saved : 8 * 1024 * 1024,
        maxFiles: 50,
        maxAgeDays: 30,
      };
    },
    setPolicy: async (patch) => {
      const next: Record<string, unknown> = {};
      if (patch['enabled'] !== undefined) next['autoCleanThumbnailCache'] = patch['enabled'];
      if (patch['maxBytes'] !== undefined) next['thumbnailCacheMaxBytes'] = patch['maxBytes'];
      if (Object.keys(next).length > 0) await config.setDomain('advanced', next);
    },
    trash: async (path) => {
      trashed.push(path);
      renameSync(path, `${path}.trashed`);
      return true;
    },
    http: {
      getText: async () => '',
      getBytes: async () => PNG,
    },
  });
  state.cache = cache;

  const records: TaskRecord[] = [];
  const deps: M5ChannelDeps = {
    queue: { list: () => records, get: (id) => records.find((item) => item.id === id) },
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        return { action, ok: true, code: 'OK', message: `${taskId}:${action}` };
      },
    },
    templates,
    config,
    systemAppearance: { prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null },
    thumbnails: cache,
  };
  state.handlers = createM5Handlers(deps);
  return state;
}

function invoke(h: Harness, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = h.handlers.get(IPC_CHANNELS.THUMBNAIL_CACHE);
  if (handler === undefined) throw new Error('channel not registered');
  return handler(payload) as Promise<Record<string, unknown>>;
}

describe('thumbnail cache IPC · renderer contract', () => {
  it('reports occupancy and never accepts a path from the renderer', async () => {
    const h = await harness();
    await h.cache.ensure('t1', 'https://cdn.example/a.png');
    const before = await invoke(h, { action: 'status' });
    expect(before['ok']).toBe(true);
    expect((before['status'] as Record<string, unknown>)['files']).toBe(1);
    expect((before['status'] as Record<string, unknown>)['recycleBinAvailable']).toBe(true);

    await expect(invoke(h, { action: 'status', path: 'C:/Users/x/video.mp4' }))
      .rejects.toThrow(/key not allowed/);
    await expect(invoke(h, { action: 'delete-everything' }))
      .rejects.toThrow(/unknown thumbnail cache action/);
    await expect(invoke(h, { action: 'set-max-bytes', maxBytes: 1 }))
      .rejects.toThrow(/invalid maxBytes/);
    await expect(invoke(h, { action: 'set-auto', enabled: 'yes' }))
      .rejects.toThrow(/enabled must be a boolean/);
  });

  it('persists the auto-clean switch and capacity into the real ConfigStore', async () => {
    const h = await harness();
    const off = await invoke(h, { action: 'set-auto', enabled: false });
    expect((off['policy'] as Record<string, unknown>)['enabled']).toBe(false);
    expect(h.config.get('advanced', 'autoCleanThumbnailCache')).toBe(false);

    const sized = await invoke(h, { action: 'set-max-bytes', maxBytes: 64 * 1024 * 1024 });
    expect((sized['policy'] as Record<string, unknown>)['maxBytes']).toBe(64 * 1024 * 1024);
    expect(h.config.get('advanced', 'thumbnailCacheMaxBytes')).toBe(64 * 1024 * 1024);
  });

  it('prunes through the IPC channel after TASK_ACTION removes the task', async () => {
    const h = await harness();
    h.live = ['t1'];
    const path = await h.cache.ensure('t1', 'https://cdn.example/cover.png');
    expect(path).not.toBeNull();
    expect(existsSync(String(path))).toBe(true);

    // Still live: the manual button must not recycle the cover in use.
    const protectedRun = await invoke(h, { action: 'prune' });
    const protectedReport = protectedRun['report'] as Record<string, unknown>;
    expect(protectedReport['removed']).toBe(0);
    expect(existsSync(String(path))).toBe(true);

    // Removing the task through the real channel releases the reference.
    const taskAction = h.handlers.get(IPC_CHANNELS.TASK_ACTION);
    expect(taskAction).toBeDefined();
    await taskAction?.({ taskId: 't1', action: 'remove' });
    h.live = [];

    const cleaned = await invoke(h, { action: 'prune' });
    const report = cleaned['report'] as Record<string, unknown>;
    expect(report['removed']).toBe(1);
    expect(report['bytesAfter']).toBe((report['bytesBefore'] as number) - (report['freedBytes'] as number));
    expect(existsSync(`${path}.trashed`)).toBe(true);
    expect(h.trashed).toHaveLength(1);
    expect(h.trashed[0]?.startsWith(h.dir)).toBe(true);
  });

  it('degrades cleanly when no cache port is wired', async () => {
    const h = await harness();
    h.handlers = createM5Handlers({
      queue: { list: () => [], get: () => undefined },
      taskDetail: {
        async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
          return { action, ok: true, code: 'OK', message: '' };
        },
      },
      templates: h.templates,
      config: h.config,
      systemAppearance: { prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null },
    });
    const result = await invoke(h, { action: 'status' });
    expect(result['ok']).toBe(false);
    expect(result['available']).toBe(false);
  });
});
