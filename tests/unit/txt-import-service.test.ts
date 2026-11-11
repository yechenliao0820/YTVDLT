/**
 * TXT import · main-process service + IPC trust boundary.
 *
 * The important assertions here are about what the renderer CANNOT do: it
 * cannot name a local path, cannot inject a URL list, and cannot replay an
 * import ticket. Partial enqueue failures must stay visible.
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import { assertHttpUrl } from '@ytvdlt/engine-ytdlp';
import { ConfigStore, CommandTemplateStore } from '@ytvdlt/core';
import type { TaskDetailResult } from '@ytvdlt/core';
import {
  M5_CHANNELS, createM5Handlers, validateM5Payload, type M5ChannelDeps,
} from '../../apps/desktop/src/main/m5-channels.js';
import {
  createTxtImportService, TxtImportSessionStore,
  type TxtBatchRequest, type TxtBatchResult, type TxtImportFileResult,
} from '../../apps/desktop/src/main/txt-import-service.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const V = (n: number): string => `https://www.youtube.com/watch?v=video${String(n).padStart(3, '0')}`;
const TEXT4 = [V(1), V(2), V(3), V(4)].join('\n');

interface ServiceHarness {
  service: ReturnType<typeof createTxtImportService>;
  batches: TxtBatchRequest[];
}

function service(options: {
  file?: Partial<TxtImportFileResult>;
  batch?: (input: TxtBatchRequest) => Promise<TxtBatchResult>;
  clock?: () => number;
  makeId?: () => string;
  validateUrl?: (raw: string) => void;
  ttlMs?: number;
  maxSessions?: number;
} = {}): ServiceHarness {
  const batches: TxtBatchRequest[] = [];
  const svc = createTxtImportService({
    pickFile: {
      async pick(): Promise<TxtImportFileResult> {
        return {
          canceled: false, fileName: 'links.txt', text: TEXT4, code: '',
          ...options.file,
        };
      },
    },
    validateUrl: options.validateUrl ?? assertHttpUrl,
    enqueueBatch: options.batch ?? (async (input) => {
      batches.push(input);
      return {
        enqueued: input.urls.length,
        taskIds: input.urls.map((_url, index) => `task-${index}`),
        failures: [],
      };
    }),
    ...(options.clock === undefined ? {} : { now: options.clock }),
    ...(options.makeId === undefined ? {} : { makeId: options.makeId }),
    ...(options.ttlMs === undefined ? {} : { sessionTtlMs: options.ttlMs }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
  });
  return { service: svc, batches };
}

describe('TXT import service · pick', () => {
  it('returns a preview with real counts and an opaque import id', async () => {
    const { service: svc } = service();
    const result = await svc.pick();
    expect(result.ok).toBe(true);
    expect(result.code).toBe('');
    expect(result.fileName).toBe('links.txt');
    expect(result.totalLines).toBe(4);
    expect(result.validCount).toBe(4);
    expect(result.invalidCount).toBe(0);
    expect(result.duplicateCount).toBe(0);
    expect(result.playlistCount).toBe(0);
    expect(result.items).toHaveLength(4);
    expect(result.importId).not.toBe('');
    expect(result.maxUrls).toBeGreaterThan(0);
  });

  it('a cancelled native dialog creates nothing', async () => {
    const result = await service({ file: { canceled: true, text: '' } }).service.pick();
    expect(result.canceled).toBe(true);
    expect(result.importId).toBe('');
    expect(result.ok).toBe(true);
  });

  it.each(['FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'ENCODING_ERROR', 'NOT_TXT'])(
    'passes the real file error %s through instead of faking a preview',
    async (code) => {
      const result = await service({ file: { code, text: '' } }).service.pick();
      expect(result.ok).toBe(false);
      expect(result.code).toBe(code);
      expect(result.importId).toBe('');
      expect(result.validCount).toBe(0);
    },
  );

  it.each([
    ['empty file', '', 'EMPTY_FILE'],
    ['all blank', '\n \n\r\n', 'EMPTY_FILE'],
    ['no valid URL', 'nope\nnope again', 'NO_VALID_URL'],
  ])('refuses to confirm %s but still reports counts', async (_label, text, code) => {
    const result = await service({ file: { text } }).service.pick();
    expect(result.code).toBe(code);
    expect(result.importId).toBe('');
    expect(result.totalLines).toBeGreaterThanOrEqual(0);
  });

  it('refuses an over-limit file while showing the full preview', async () => {
    const lines = Array.from({ length: 201 }, (_v, i) => V(i)).join('\n');
    const result = await service({ file: { text: lines } }).service.pick();
    expect(result.code).toBe('TOO_MANY_URLS');
    expect(result.validCount).toBe(201);
    expect(result.items).toHaveLength(201);
    expect(result.importId).toBe('');
  });
});

describe('TXT import service · enqueue', () => {
  it('enqueues exactly the previewed URLs and reports the real result', async () => {
    const h = service();
    const picked = await h.service.pick();
    const result = await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(result.ok).toBe(true);
    expect(result.requested).toBe(4);
    expect(result.enqueued).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.taskIds).toHaveLength(4);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]?.urls).toEqual([V(1), V(2), V(3), V(4)]);
    expect(h.batches[0]?.kind).toBe('video');
  });

  it('forwards the existing kind/quality enums to the batch', async () => {
    const h = service();
    const picked = await h.service.pick();
    await h.service.enqueue({
      importId: picked.importId, kind: 'audio', audioQuality: '192', audioFormat: 'mp3',
    });
    expect(h.batches[0]).toMatchObject({
      kind: 'audio', audioQuality: '192', audioFormat: 'mp3',
    });
  });

  it('a ticket is single-use: replaying it creates no second batch', async () => {
    const h = service();
    const picked = await h.service.pick();
    await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    const replay = await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(replay.code).toBe('IMPORT_EXPIRED');
    expect(replay.enqueued).toBe(0);
    expect(h.batches).toHaveLength(1);
  });

  it('an expired ticket is refused', async () => {
    let clock = 1000;
    const h = service({ clock: () => clock, ttlMs: 50, makeId: () => 'import-ticket-0001' });
    const picked = await h.service.pick();
    clock = 2000;
    const result = await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(result.code).toBe('IMPORT_EXPIRED');
    expect(result.enqueued).toBe(0);
  });

  it('reports partial success instead of rounding up to "all succeeded"', async () => {
    const h = service({
      batch: async (input) => ({
        enqueued: 2,
        taskIds: ['a', 'b'],
        failures: [
          { url: input.urls[2] ?? '', reason: 'ENQUEUE_FAILED' },
          { url: input.urls[3] ?? '', reason: 'ENQUEUE_FAILED' },
        ],
      }),
    });
    const picked = await h.service.pick();
    const result = await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(result.requested).toBe(4);
    expect(result.enqueued).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PARTIAL_SUCCESS');
    expect(result.failures).toHaveLength(2);
  });

  it('a thrown batch reports every un-enqueued URL as a failure', async () => {
    const h = service({ batch: async () => { throw new Error('queue exploded'); } });
    const picked = await h.service.pick();
    const result = await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(result.requested).toBe(4);
    expect(result.enqueued).toBe(0);
    expect(result.failed).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ENQUEUE_FAILED');
    expect(result.failures.every((f) => f.reason === 'queue exploded')).toBe(true);
  });

  it('re-validates every URL before enqueue (defence in depth)', async () => {
    let phase = 'pick';
    const h = service({
      validateUrl: (raw) => {
        if (phase === 'enqueue' && raw === V(2)) throw new Error('INVALID_URL');
        assertHttpUrl(raw);
      },
    });
    const picked = await h.service.pick();
    phase = 'enqueue';
    const result = await h.service.enqueue({ importId: picked.importId, kind: 'video' });
    expect(result.failed).toBe(1);
    expect(result.enqueued).toBe(3);
    expect(result.failures[0]).toMatchObject({ url: V(2), reason: 'INVALID_URL' });
    expect(h.batches[0]?.urls).toEqual([V(1), V(3), V(4)]);
  });
});

describe('TXT import session store', () => {
  it('evicts expired and oldest sessions', () => {
    let clock = 0;
    const store = new TxtImportSessionStore({ now: () => clock, ttlMs: 10, maxSessions: 2 });
    store.save([V(1)], 'ticket-0001');
    store.save([V(2)], 'ticket-0002');
    store.save([V(3)], 'ticket-0003');
    expect(store.size).toBeLessThanOrEqual(2);
    expect(store.consume('ticket-0001')).toBeNull();
    clock = 100;
    expect(store.consume('ticket-0003')).toBeNull();
  });
});

async function channelHandlers(overrides: Partial<M5ChannelDeps> = {}) {
  const mem = createInMemoryPorts();
  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();
  const deps: M5ChannelDeps = {
    queue: { list: () => [], get: () => undefined },
    taskDetail: {
      async perform(_id, action): Promise<TaskDetailResult> {
        return { action, ok: true, code: 'OK', message: 'ok' };
      },
    },
    templates,
    config,
    systemAppearance: {
      prefersDark: () => false, prefersReducedMotion: () => false, accent: () => null,
    },
    ...overrides,
  };
  return createM5Handlers(deps);
}

describe('TXT import · IPC whitelist', () => {
  it('registers both channels in M5_CHANNELS (preload whitelist is derived from it)', () => {
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.TXT_IMPORT_PICK);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.TXT_IMPORT_ENQUEUE);
  });

  it('PICK accepts NO payload key — a renderer path is refused', () => {
    expect(() => validateM5Payload(IPC_CHANNELS.TXT_IMPORT_PICK, {})).not.toThrow();
    expect(() => validateM5Payload(IPC_CHANNELS.TXT_IMPORT_PICK, { path: 'C:/secret.txt' })).toThrow();
  });

  it('ENQUEUE refuses a renderer-supplied URL list', () => {
    expect(() => validateM5Payload(IPC_CHANNELS.TXT_IMPORT_ENQUEUE, {
      importId: 'import-ticket-0001', urls: ['https://evil.example/a'],
    })).toThrow();
  });

  it('without the service both channels report unavailability, never a fallback', async () => {
    const handlers = await channelHandlers();
    const pick = handlers.get(IPC_CHANNELS.TXT_IMPORT_PICK);
    const enqueue = handlers.get(IPC_CHANNELS.TXT_IMPORT_ENQUEUE);
    const picked = await pick?.({}) as { code: string };
    const enqueued = await enqueue?.({ importId: 'import-ticket-0001' }) as { code: string };
    expect(picked.code).toBe('TXT_IMPORT_UNAVAILABLE');
    expect(enqueued.code).toBe('TXT_IMPORT_UNAVAILABLE');
  });

  it('ENQUEUE rejects a malformed importId and an out-of-enum quality', async () => {
    const handlers = await channelHandlers({
      txtImport: service().service,
    });
    const enqueue = handlers.get(IPC_CHANNELS.TXT_IMPORT_ENQUEUE);
    await expect(enqueue?.({ importId: 'x' })).rejects.toThrow(/invalid importId/);
    await expect(enqueue?.({ importId: 'import-ticket-0001', quality: '8K' })).rejects.toThrow(/invalid quality/);
    // §5 rule 1: an out-of-range enum must be REFUSED, not silently downgraded
    // to `video` (D-131 audit finding on the new channel).
    await expect(enqueue?.({ importId: 'import-ticket-0001', kind: 'subtitle-only' })).rejects.toThrow(/invalid kind/);
  });

  it('PICK through the real handler returns the service preview', async () => {
    const handlers = await channelHandlers({ txtImport: service().service });
    const pick = handlers.get(IPC_CHANNELS.TXT_IMPORT_PICK);
    const result = await pick?.({}) as { ok: boolean; validCount: number; importId: string };
    expect(result.ok).toBe(true);
    expect(result.validCount).toBe(4);
    expect(result.importId).not.toBe('');
  });

  it('ENQUEUE through the real handler forwards only validated enums', async () => {
    const h = service();
    const handlers = await channelHandlers({ txtImport: h.service });
    const pick = handlers.get(IPC_CHANNELS.TXT_IMPORT_PICK);
    const enqueue = handlers.get(IPC_CHANNELS.TXT_IMPORT_ENQUEUE);
    const picked = await pick?.({}) as { importId: string };
    const result = await enqueue?.({
      importId: picked.importId, kind: 'video', quality: '1080p',
    }) as { enqueued: number };
    expect(result.enqueued).toBe(4);
    expect(h.batches[0]).toMatchObject({ kind: 'video', quality: '1080p' });
  });
});
