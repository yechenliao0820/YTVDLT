/**
 * D-120 · core's `open-folder` must not depend on the FILE still existing.
 *
 * The download succeeded in the past; an external delete/move does not erase
 * the history, and the user is still entitled to see the original folder.
 */
import { describe, it, expect } from 'vitest';
import {
  TaskDetailService, buildErrorReport, formatErrorReport,
} from '@ytvdlt/core';
import type { IShellPort, TaskRecord } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const FILE = 'C:/Videos/clip.mp4';
const DIR = 'C:/Videos';

function record(artifacts: readonly string[]): TaskRecord {
  return {
    id: 't1', url: 'https://example.org/v', kind: 'video', state: 'Completed',
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    mediaInfo: null, request: null, artifacts: [...artifacts], lastPercent: 100,
    error: null, privateMode: false, postprocessed: false,
  };
}

function harness(task: TaskRecord, shellError?: unknown) {
  const mem = createInMemoryPorts();
  const recorded: Array<{ op: string; path: string }> = [];
  const shell: IShellPort = {
    async openPath(path: string) {
      if (shellError !== undefined) throw shellError;
      recorded.push({ op: 'open', path });
    },
    async showItemInFolder(path: string) { recorded.push({ op: 'reveal', path }); },
  };
  const tasks = new Map([[task.id, task]]);
  const queue = {
    async enqueue() {}, async enqueueBatch() { return []; },
    async cancel() { return true; }, async restart() {}, async remove() { return true; },
    get(id: string) { return tasks.get(id); },
    list() { return [...tasks.values()]; },
    onEvent() { return () => {}; },
    concurrency: 3, activeTaskIds: [] as readonly string[], pendingCount: 0,
    setConcurrency() { return 3; },
  };
  const service = new TaskDetailService({
    ports: mem.ports,
    queue,
    shell,
    clipboard: { async writeText() {} },
    buildReport: (t) => buildErrorReport({
      task: t, appVersion: '0.2.7', engineVersion: 'unknown', os: 'win32',
      stderr: '',
    }, '2026-11-10T00:00:00.000Z'),
    formatReport: formatErrorReport,
  });
  return { mem, recorded, service };
}

describe('D-120 · core open-folder is folder-driven', () => {
  it('file present -> reveal the file (unchanged behaviour)', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(FILE, 'bytes');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(h.recorded).toEqual([{ op: 'reveal', path: FILE }]);
  });

  it('file gone, folder present -> open the folder and say the file is missing', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(DIR, 'directory');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(true);
    expect(result.fileMissing).toBe(true);
    expect(h.recorded).toEqual([{ op: 'open', path: DIR }]);
  });

  it('file AND folder gone -> FOLDER_MISSING, no shell call', async () => {
    const h = harness(record([FILE]));
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FOLDER_MISSING');
    expect(h.recorded).toEqual([]);
  });

  it('opening the folder itself failing is an ERROR, not a silent success', async () => {
    const h = harness(record([FILE]), new Error('EACCES'));
    h.mem.state.files.set(DIR, 'directory');
    const result = await h.service.perform('t1', 'open-folder');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERROR');
  });

  it('open-file still refuses a missing file (nothing to open)', async () => {
    const h = harness(record([FILE]));
    h.mem.state.files.set(DIR, 'directory');
    const result = await h.service.perform('t1', 'open-file');
    expect(result.code).toBe('FILE_MISSING');
    expect(h.recorded).toEqual([]);
  });

  it('no recorded path -> NO_ARTIFACT, never "file deleted"', async () => {
    const h = harness(record([]));
    expect((await h.service.perform('t1', 'open-folder')).code).toBe('NO_ARTIFACT');
    expect((await h.service.perform('t1', 'open-file')).code).toBe('NO_ARTIFACT');
  });
});
