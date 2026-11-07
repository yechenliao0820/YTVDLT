/**
 * M4-6 · task detail — the seven operations + the error-report redaction.
 */
import { describe, it, expect } from 'vitest';
import {
  TaskDetailService, TASK_DETAIL_ACTIONS, buildErrorReport, formatErrorReport, maskUrlSecrets,
} from '@ytvdlt/core';
import type { IShellPort, TaskRecord } from '@ytvdlt/shared';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const record = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 't1', url: 'https://example.org/v?token=SECRET&sig=ABC&x=1', kind: 'video', state: 'Error',
  createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
  mediaInfo: null, request: null, artifacts: ['C:/V/fixture.mp4'], lastPercent: 42,
  error: { code: 'HTTP_403', message: 'Forbidden: Cookie: SID=abc', detail: '', retryable: false, report: 'x' },
  privateMode: false, postprocessed: false,
  ...overrides,
});

interface Recorded { shell: Array<{ op: string; path: string }>; clipboard: string[] }

function harness(task: TaskRecord | null = record()) {
  const mem = createInMemoryPorts();
  if (task !== null && task.artifacts[0] !== undefined) mem.state.files.set(task.artifacts[0], 'bytes');
  const recorded: Recorded = { shell: [], clipboard: [] };
  const calls: string[] = [];
  const tasks = new Map<string, TaskRecord>();
  if (task !== null) tasks.set(task.id, task);

  const queue = {
    async enqueue() {},
    async enqueueBatch() { return []; },
    async cancel(id: string) { calls.push(`cancel:${id}`); return true; },
    async restart(id: string) { calls.push(`restart:${id}`); },
    async remove(id: string) { calls.push(`remove:${id}`); return true; },
    get(id: string) { return tasks.get(id); },
    list() { return [...tasks.values()]; },
    onEvent() { return () => {}; },
    concurrency: 3,
    activeTaskIds: [] as readonly string[],
    pendingCount: 0,
    setConcurrency() { return 3; },
  };

  const shell: IShellPort = {
    async openPath(path: string) { recorded.shell.push({ op: 'open', path }); },
    async showItemInFolder(path: string) { recorded.shell.push({ op: 'reveal', path }); },
  };
  const clipboard = { async writeText(text: string) { recorded.clipboard.push(text); } };

  const service = new TaskDetailService({
    ports: mem.ports,
    queue,
    shell,
    clipboard,
    buildReport: (t) => buildErrorReport({
      task: t,
      appVersion: '0.1.0',
      engineVersion: '2026.10.26',
      os: 'win32 10.0.22631',
      stderr: 'ERROR: Cookie: SID=abc\nAuthorization: Bearer xyz\nHTTP 403',
    }, '2026-11-06T00:00:00.000Z'),
    formatReport: formatErrorReport,
  });

  return { service, mem, recorded, calls };
}

describe('M4-6 · seven task-detail operations', () => {
  it('exposes exactly the seven required actions', () => {
    expect([...TASK_DETAIL_ACTIONS]).toEqual([
      'open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry',
    ]);
    expect(TASK_DETAIL_ACTIONS).toHaveLength(7);
  });

  it('open-file / open-folder call the shell with the primary artifact', async () => {
    const { service, recorded } = harness();
    expect((await service.perform('t1', 'open-file')).ok).toBe(true);
    expect((await service.perform('t1', 'open-folder')).ok).toBe(true);
    expect(recorded.shell).toEqual([
      { op: 'open', path: 'C:/V/fixture.mp4' },
      { op: 'reveal', path: 'C:/V/fixture.mp4' },
    ]);
  });

  it('open-file refuses a missing artifact instead of calling the shell', async () => {
    const { service, mem, recorded } = harness();
    mem.state.files.delete('C:/V/fixture.mp4');
    const result = await service.perform('t1', 'open-file');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FILE_MISSING');
    expect(recorded.shell).toHaveLength(0);
  });

  it('open-file refuses when the task has no artifact at all', async () => {
    const { service } = harness(record({ artifacts: [] }));
    expect((await service.perform('t1', 'open-file')).code).toBe('NO_ARTIFACT');
  });

  it('copy-url copies a redacted URL', async () => {
    const { service, recorded } = harness();
    const result = await service.perform('t1', 'copy-url');
    expect(result.ok).toBe(true);
    expect(result.clipboardText).toBe('https://example.org/v?token=***REDACTED***&sig=***REDACTED***&x=1');
    expect(recorded.clipboard[0]).not.toContain('SECRET');
  });

  it('copy-error-report writes a redacted report with versions and stderr', async () => {
    const { service, recorded } = harness();
    const result = await service.perform('t1', 'copy-error-report');
    expect(result.ok).toBe(true);
    const text = recorded.clipboard[0] ?? '';
    expect(text).toContain('OS: win32 10.0.22631');
    expect(text).toContain('App: 0.1.0');
    expect(text).toContain('Engine: 2026.10.26');
    expect(text).toContain('Code: HTTP_403');
    expect(text).toContain('--- stderr ---');
    expect(text).not.toContain('SID=abc');
    expect(text).not.toContain('Bearer xyz');
    expect(text).not.toContain('SECRET');
  });

  it('copy-error-report refuses a task without an error', async () => {
    const { service } = harness(record({ error: null, state: 'Completed' }));
    expect((await service.perform('t1', 'copy-error-report')).code).toBe('NO_ERROR');
  });

  it('cancel / remove / retry delegate to the queue', async () => {
    const { service, calls } = harness();
    expect((await service.perform('t1', 'cancel')).ok).toBe(true);
    expect((await service.perform('t1', 'remove')).ok).toBe(true);
    expect((await service.perform('t1', 'retry')).ok).toBe(true);
    expect(calls).toEqual(['cancel:t1', 'remove:t1', 'restart:t1']);
  });

  it('an unknown task is refused by every action', async () => {
    const { service } = harness(null);
    for (const action of TASK_DETAIL_ACTIONS) {
      const result = await service.perform('missing', action);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TASK_MISSING');
    }
  });
});

describe('M4-6 · error report redaction', () => {
  it('masks signed query parameters but keeps the parameter names', () => {
    expect(maskUrlSecrets('https://x/y?token=abc&sig=def&expire=123&normal=1'))
      .toBe('https://x/y?token=***REDACTED***&sig=***REDACTED***&expire=***REDACTED***&normal=1');
    expect(maskUrlSecrets('https://x/y')).toBe('https://x/y');
    expect(maskUrlSecrets('https://user:pw@x/y?po_token=abc')).toBe('https://***:***@x/y?po_token=***REDACTED***');
  });

  it('caps stderr at 400 lines and never includes MediaFormat.url', () => {
    const task = record({
      artifacts: [],
      mediaInfo: {
        id: 'm', title: 't', uploader: null, uploader_id: null, duration: 1, thumbnail: null,
        webpage_url: 'https://x/y', extractor_key: 'generic', description: null, upload_date: null,
        ext: 'mp4', chapters: null, subtitles: {}, automatic_captions: [], _type: 'video',
        formats: [{
          format_id: '1', ext: 'mp4', width: 1, height: 1, vcodec: 'h264', acodec: 'aac',
          filesize: 1, filesize_approx: null, tbr: 1, fps: 1, format_note: null,
          url: 'https://cdn.example/secret-signature',
        }],
      } as never,
    });
    const report = buildErrorReport({
      task, appVersion: '1', engineVersion: '2', os: 'win32',
      stderr: Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'),
    }, 'now');
    expect(report.stderr.split('\n')).toHaveLength(400);
    expect(JSON.stringify(report)).not.toContain('secret-signature');
    expect(formatErrorReport(report)).toContain('Task: t1');
  });
});
