/**
 * D-120 · acceptance matrix for "delete task" × "also delete local files".
 *
 * The regression: a file the user had ALREADY deleted in Explorer made
 * `shell.trashItem` throw ENOENT; the channel treated that as a partial
 * failure and returned before `taskDetail.perform('remove')` — so the task
 * history survived. File cleanup and record removal must be independent.
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { TaskRecord } from '@ytvdlt/shared';
import { CommandTemplateStore, ConfigStore } from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import {
  createM5Handlers, type M5ChannelDeps, type SystemAppearancePort,
  type TrashFileOutcome,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const SIGNED = 'https://example.org/watch?v=abc&token=SECRET';
const FILE_A = 'C:/Videos/a.mp4';
const FILE_B = 'C:/Videos/b.mp4';
const SHARED = 'C:/Videos/same.mp4';

function record(id: string, artifacts: readonly string[]): TaskRecord {
  return {
    id, url: SIGNED, kind: 'video', state: 'Completed',
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    mediaInfo: null, request: null, artifacts: [...artifacts], lastPercent: 100, error: null,
    privateMode: false, postprocessed: false,
  };
}

const appearance: SystemAppearancePort = {
  prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
};

type Reply = string | TrashFileOutcome;

interface Harness {
  dispatch(channel: string, payload: unknown): Promise<Record<string, unknown>>;
  calls: string[];
  trashedRequests: string[][];
}

async function harness(initial: readonly TaskRecord[], reply: (paths: readonly string[]) => Reply[]): Promise<Harness> {
  const ports = createInMemoryPorts();
  const config = new ConfigStore({ ports: ports.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: ports.ports });
  await templates.init();
  const records = [...initial];
  const byId = new Map(records.map((item) => [item.id, item]));
  const calls: string[] = [];
  const trashedRequests: string[][] = [];
  const deps: M5ChannelDeps = {
    queue: { list: () => records, get: (id) => byId.get(id) },
    taskDetail: {
      async perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> {
        calls.push(`${taskId}:${action}`);
        if (action === 'remove') {
          const index = records.findIndex((item) => item.id === taskId);
          if (index >= 0) records.splice(index, 1);
          byId.delete(taskId);
        }
        return { action, ok: true, code: 'OK', message: '已删除' };
      },
    },
    templates,
    config,
    systemAppearance: appearance,
    trashFiles: {
      async trash(paths) {
        trashedRequests.push([...paths]);
        return reply(paths);
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
    calls,
    trashedRequests,
  };
}

const STATUS = (status: TrashFileOutcome['status'], reason?: string) =>
  (path: string): TrashFileOutcome => reason === undefined
    ? { path, status }
    : { path, status, reason };

describe('D-120 · delete acceptance matrix (8 scenarios)', () => {
  it('1. file exists + history only: records removed, files untouched', async () => {
    const h = await harness([record('t1', [FILE_A])], (paths) => paths.map(() => { throw new Error('must not be called'); }));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove' });
    expect(result['ok']).toBe(true);
    expect(h.calls).toEqual(['t1:remove']);
    expect(h.trashedRequests).toEqual([]);
  });

  it('2. file exists + also delete files: recycled then record removed', async () => {
    const h = await harness([record('t1', [FILE_A])], (paths) => paths.map(STATUS('trashed')));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    expect(result['ok']).toBe(true);
    expect(result['filesTrashed']).toBe(1);
    expect(h.trashedRequests).toEqual([[FILE_A]]);
    expect(h.calls).toEqual(['t1:remove']);
  });

  it('3. file already deleted externally + history only: still succeeds', async () => {
    const h = await harness([record('t1', [FILE_A])], (paths) => paths.map(STATUS('missing')));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove' });
    expect(result['ok']).toBe(true);
    expect(h.calls).toEqual(['t1:remove']);
    expect(h.trashedRequests).toEqual([]);
  });

  it('4. file already deleted externally + also delete files: THE REGRESSION', async () => {
    const h = await harness([record('t1', [FILE_A])], (paths) => paths.map(STATUS('missing')));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    expect(result['ok']).toBe(true);
    expect(result['filesMissing']).toBe(1);
    expect(result['message']).not.toMatch(/未全部移入|失败/);
    expect(h.calls).toEqual(['t1:remove']);
  });

  it('5. file locked by another program: real error, record KEPT, reason reported', async () => {
    const h = await harness([record('t1', [FILE_A])], (paths) => paths.map(STATUS('error', 'EBUSY: resource busy or locked')));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['reason']).toContain('EBUSY');
    expect(h.calls).toEqual([]);
  });

  it('6. permission denied: never misreported as missing', async () => {
    const h = await harness([record('t1', [FILE_A])], (paths) => paths.map(STATUS('error', 'EACCES: permission denied')));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('FILE_DELETE_FAILED');
    expect(result['reason']).toContain('EACCES');
    expect(result['filesMissing']).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('7. batch with partially missing files: every record is removed', async () => {
    const h = await harness(
      [record('t1', [FILE_A]), record('t2', [FILE_B])],
      (paths) => paths.map((path) => STATUS(path === FILE_A ? 'trashed' : 'missing')(path)),
    );
    const first = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    const second = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't2', action: 'remove', withFiles: true });
    expect(first['ok']).toBe(true);
    expect(second['ok']).toBe(true);
    expect(Number(first['filesTrashed']) + Number(second['filesTrashed'])).toBe(1);
    expect(Number(first['filesMissing']) + Number(second['filesMissing'])).toBe(1);
    expect(h.calls).toEqual(['t1:remove', 't2:remove']);
    // Only the two recorded artifact paths were ever eligible — no widening.
    expect(h.trashedRequests).toEqual([[FILE_A], [FILE_B]]);
  });

  it('8. two records quote the SAME physical file: never delete it for one of them', async () => {
    const h = await harness([record('t1', [SHARED]), record('t2', [SHARED])], (paths) => paths.map(STATUS('trashed')));
    const first = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    expect(first['ok']).toBe(true);
    expect(first['sharedSkipped']).toBe(1);
    expect(h.trashedRequests).toEqual([[]]); // t2 still claims the file
    expect(h.calls).toEqual(['t1:remove']);
    // Once the last claimant is removed in the same batch, the file is recycled.
    const second = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't2', action: 'remove', withFiles: true });
    expect(second['ok']).toBe(true);
    expect(second['sharedSkipped']).toBe(0);
    expect(h.trashedRequests[1]).toEqual([SHARED]);
  });
});

describe('D-120 · legacy D-87 adapter contract still holds', () => {
  it('a short string reply means partial failure and keeps the record', async () => {
    const h = await harness([record('t1', [FILE_A, FILE_B])], (paths) => paths.slice(0, 1));
    const result = await h.dispatch(IPC_CHANNELS.TASK_ACTION, { taskId: 't1', action: 'remove', withFiles: true });
    expect(result['ok']).toBe(false);
    expect(result['code']).toBe('ERROR');
    expect(h.calls).toEqual([]);
  });

  it('no recycle port still refuses without removing anything', async () => {
    const ports = createInMemoryPorts();
    const config = new ConfigStore({ ports: ports.ports });
    await config.load();
    const templates = new CommandTemplateStore({ ports: ports.ports });
    await templates.init();
    const records = [record('t1', [FILE_A])];
    const handlers = createM5Handlers({
      queue: { list: () => records, get: () => records[0] },
      taskDetail: { perform: async (_id, action) => ({ action, ok: true, code: 'OK', message: '' }) },
      templates, config, systemAppearance: appearance,
    });
    const result = await handlers.get(IPC_CHANNELS.TASK_ACTION)?.({ taskId: 't1', action: 'remove', withFiles: true }) as Record<string, unknown>;
    expect(result['code']).toBe('SHELL_UNAVAILABLE');
  });
});
