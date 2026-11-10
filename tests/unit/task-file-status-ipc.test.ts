/**
 * D-120 · TASK_LIST file-state projection + open-file / open-folder feedback.
 *
 * Verifies the "existing IPC channel" contract: no new channel, no path sent
 * by the renderer, stable codes (not sentences), and no filesystem work from
 * every repaint.
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { TaskRecord } from '@ytvdlt/shared';
import { CommandTemplateStore, ConfigStore } from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import { createM5Handlers, type M5ChannelDeps, type SystemAppearancePort } from '../../apps/desktop/src/main/m5-channels.js';
import { createLocalFileStatusProbe, type StatOutcome } from '../../apps/desktop/src/main/local-file-status.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const FILE = 'C:/Videos/clip.mp4';
const DIR = 'C:/Videos';
const appearance: SystemAppearancePort = {
  prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
};

function record(id: string, state: string, artifacts: readonly string[]): TaskRecord {
  return {
    id, url: 'https://example.org/watch?v=abc&token=SECRET', kind: 'video', state,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    mediaInfo: null, request: null, artifacts: [...artifacts], lastPercent: 100, error: null,
    privateMode: false, postprocessed: false,
  };
}

interface Harness {
  dispatch(channel: string, payload: unknown): Promise<any>;
  calls: string[];
  table: Record<string, StatOutcome>;
  statCalls(): number;
}

async function harness(initial: readonly TaskRecord[], withProbe = true): Promise<Harness> {
  const ports = createInMemoryPorts();
  const config = new ConfigStore({ ports: ports.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: ports.ports });
  await templates.init();
  const records = [...initial];
  const byId = new Map(records.map((item) => [item.id, item]));
  const calls: string[] = [];
  const table: Record<string, StatOutcome> = { [FILE]: { kind: 'file' }, [DIR]: { kind: 'dir' } };
  let statCalls = 0;
  const fileStatus = createLocalFileStatusProbe({
    stat: async (path) => {
      statCalls += 1;
      return table[path] ?? { kind: 'error', code: 'ENOENT' };
    },
    now: () => 1_000,
    cacheTtlMs: 10_000,
  });
  const deps: M5ChannelDeps = {
    queue: { list: () => records, get: (id) => byId.get(id) },
    taskDetail: {
      async perform(_id: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        calls.push(action);
        return { action, ok: true, code: 'OK', message: FILE };
      },
    },
    templates, config, systemAppearance: appearance,
    ...(withProbe ? { fileStatus } : {}),
  };
  const handlers = createM5Handlers(deps);
  return {
    dispatch: async (channel: string, payload: unknown) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`unregistered channel: ${channel}`);
      return handler(payload);
    },
    calls,
    table,
    statCalls: () => statCalls,
  };
}

describe('D-120 · TASK_LIST projection', () => {
  it('adds the observation only for completed tasks; no URL, no path', async () => {
    const h = await harness([record('done', 'Completed', [FILE]), record('run', 'Running', [FILE])]);
    const list = await h.dispatch(IPC_CHANNELS.TASK_LIST, { tab: 'all' });
    const done = list.items.find((item: any) => item.id === 'done');
    const running = list.items.find((item: any) => item.id === 'run');
    expect(done.fileStatus).toBe('present');
    expect(done.dirStatus).toBe('present');
    expect(Object.keys(done)).not.toContain('url');
    expect(Object.keys(done)).not.toContain('artifacts');
    expect(running.fileStatus).toBeUndefined();
  });

  it('without a probe port the DTO keeps its old shape', async () => {
    const h = await harness([record('done', 'Completed', [FILE])], false);
    const list = await h.dispatch(IPC_CHANNELS.TASK_LIST, {});
    expect(list.items[0].fileStatus).toBeUndefined();
  });

  it('normal polls reuse the cache; refreshFileStatus forces a fresh stat', async () => {
    const h = await harness([record('done', 'Completed', [FILE])]);
    await h.dispatch(IPC_CHANNELS.TASK_LIST, { tab: 'all' });
    expect(h.statCalls()).toBe(2); // file + dir, once
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    await h.dispatch(IPC_CHANNELS.TASK_LIST, { tab: 'all' });
    expect(h.statCalls()).toBe(2); // no per-render filesystem work
    const fresh = await h.dispatch(IPC_CHANNELS.TASK_LIST, { tab: 'all', refreshFileStatus: true });
    expect(fresh.items[0].fileStatus).toBe('missing');
    expect(h.statCalls()).toBe(4);
  });

  it('rejects a non-boolean refresh flag', async () => {
    const h = await harness([record('done', 'Completed', [FILE])]);
    await expect(h.dispatch(IPC_CHANNELS.TASK_LIST, { refreshFileStatus: 'yes' }))
      .rejects.toThrow(/refreshFileStatus must be a boolean/);
  });

  it('a restored file returns to present on the next forced check', async () => {
    const h = await harness([record('done', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    expect((await h.dispatch(IPC_CHANNELS.TASK_LIST, { refreshFileStatus: true })).items[0].fileStatus).toBe('missing');
    h.table[FILE] = { kind: 'file' };
    expect((await h.dispatch(IPC_CHANNELS.TASK_LIST, { refreshFileStatus: true })).items[0].fileStatus).toBe('present');
  });
});

describe('D-120 · open file / open folder feedback', () => {
  it('1. file present: open-file goes to core and succeeds', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result.ok).toBe(true);
    expect(h.calls).toEqual(['open-file']);
  });

  it('2. file present: open-folder reveals it', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' });
    expect(result.ok).toBe(true);
    expect(h.calls).toEqual(['open-folder']);
  });

  it('3. file missing: open-file refuses with FILE_MISSING, no shell call', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FILE_MISSING');
    expect(result.message).toContain('已不存在');
    expect(h.calls).toEqual([]);
  });

  it('4. file missing but folder present: open-folder STILL opens the folder', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' });
    expect(result.ok).toBe(true);
    expect(result.fileStatus).toBe('missing');
    expect(h.calls).toEqual(['open-folder']);
  });

  it('5. file AND folder missing: FOLDER_MISSING, no shell call', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    h.table[DIR] = { kind: 'error', code: 'ENOENT' };
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FOLDER_MISSING');
    expect(h.calls).toEqual([]);
  });

  it('6. permission denied is NEVER reported as file missing', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'EACCES' };
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result.code).toBe('FILE_INACCESSIBLE');
  });

  it('7. a temporarily unavailable volume is NEVER reported as deleted', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'EIO' };
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result.code).toBe('FILE_UNAVAILABLE');
  });

  it('8. moved / renamed file = missing at the recorded path', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    expect((await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' })).code).toBe('FILE_MISSING');
  });

  it('9. no recorded artifact = NO_ARTIFACT, not "file gone"', async () => {
    const h = await harness([record('t1', 'Completed', [])]);
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-file' });
    expect(result.code).toBe('NO_ARTIFACT');
    expect(h.calls).toEqual([]);
  });

  it('10. unreadable folder is distinct from a missing folder', async () => {
    const h = await harness([record('t1', 'Completed', [FILE])]);
    h.table[FILE] = { kind: 'error', code: 'ENOENT' };
    h.table[DIR] = { kind: 'error', code: 'EPERM' };
    expect((await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'open-folder' })).code)
      .toBe('FOLDER_INACCESSIBLE');
  });
});
