/**
 * Playlist batch · real M5 IPC handlers against the real preview service.
 *
 * Proves the trust boundary: the renderer can name a URL + a ticket + ids, but
 * can NEVER submit a PlaylistInfo, an entry URL, a path or an argv token; the
 * full probe result comes from the main-process cache on consume().
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS, MAX_PLAYLIST_ITEMS, type PlaylistInfo } from '@ytvdlt/shared';
import { ConfigStore, CommandTemplateStore } from '@ytvdlt/core';
import type { TaskDetailResult } from '@ytvdlt/core';
import {
  M5_CHANNELS, createM5Handlers, validateM5Payload, type M5ChannelDeps,
} from '../../apps/desktop/src/main/m5-channels.js';
import type { PlaylistEnqueueInput, PlaylistBatchReport } from '../../apps/desktop/src/main/m4-host.js';
import { PlaylistPreviewService } from '../../apps/desktop/src/main/playlist-preview-service.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';

const URL_A = 'https://www.youtube.com/playlist?list=PL_GTA_65';
const URL_B = 'https://www.youtube.com/playlist?list=PL_OTHER';

function info(count = 65): PlaylistInfo {
  return {
    id: 'PL_GTA_65', title: 'GTA 游戏合集', _type: 'playlist',
    extractor_key: 'youtube:playlist', webpage_url: URL_A,
    playlistCount: 65,
    entries: Array.from({ length: count }, (_v, i) => ({
      id: `ep${i + 1}`, title: `第 ${i + 1} 集`, url: `https://cdn.example.org/v${i + 1}?sig=SECRET`,
      duration: 600, _type: 'url',
    })),
  };
}

interface Harness {
  handlers: ReturnType<typeof createM5Handlers>;
  calls: PlaylistEnqueueInput[];
  service: PlaylistPreviewService;
  setReport: (report: PlaylistBatchReport) => void;
}

async function harness(options: {
  report?: PlaylistBatchReport;
  withoutService?: boolean;
} = {}): Promise<Harness> {
  const mem = createInMemoryPorts();
  const config = new ConfigStore({ ports: mem.ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports: mem.ports });
  await templates.init();
  const calls: PlaylistEnqueueInput[] = [];
  let report: PlaylistBatchReport = options.report ?? {
    requested: 0, enqueued: 0, failed: 0, taskIds: [], failures: [],
  };
  const service = new PlaylistPreviewService({
    probe: async () => info(),
    clock: { nowEpochMs: () => 1_000 },
    newId: () => 'preview-ticket-0001',
  });
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
    ...(options.withoutService === true ? {} : { playlistPreview: service }),
    playlistBatch: async (input) => {
      calls.push(input);
      if (report.requested === 0) {
        return {
          requested: input.selectedIds.length,
          enqueued: input.selectedIds.length,
          failed: 0,
          taskIds: input.selectedIds.map((_id, index) => `task-${index}`),
          failures: [],
        };
      }
      return report;
    },
  };
  return {
    handlers: createM5Handlers(deps),
    calls,
    service,
    setReport: (next) => { report = next; },
  };
}

async function preview(h: Harness, url = URL_A) {
  const handler = h.handlers.get(IPC_CHANNELS.PLAYLIST_PREVIEW);
  return handler?.({ url }) as Promise<{ ok: boolean; previewId: string; entries: unknown[]; fetchedCount: number }>;
}

async function enqueue(h: Harness, payload: Record<string, unknown>) {
  const handler = h.handlers.get(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE);
  return handler?.(payload) as Promise<{
    ok: boolean; code: string; requested: number; enqueued: number; failed: number;
    taskIds: string[]; failures: unknown[];
  }>;
}

describe('Playlist batch IPC · channel inventory and whitelist', () => {
  it('registers the three new channels (M3 PLAYLIST_ENQUEUE stays untouched)', () => {
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.PLAYLIST_PREVIEW);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.PLAYLIST_PREVIEW_CANCEL);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE);
    expect(M5_CHANNELS).not.toContain(IPC_CHANNELS.PLAYLIST_ENQUEUE);
  });

  it('PREVIEW refuses a renderer-supplied PlaylistInfo / path / argv', () => {
    expect(() => validateM5Payload(IPC_CHANNELS.PLAYLIST_PREVIEW, { url: URL_A })).not.toThrow();
    for (const key of ['playlist', 'playlistInfo', 'path', 'argv']) {
      expect(() => validateM5Payload(IPC_CHANNELS.PLAYLIST_PREVIEW, { url: URL_A, [key]: {} }))
        .toThrow(/payload key not allowed/);
    }
  });

  it('BATCH_ENQUEUE refuses a playlist object, a URL list and an argv token', () => {
    const base = { previewId: 'preview-ticket-0001', url: URL_A };
    expect(() => validateM5Payload(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE, base)).not.toThrow();
    for (const key of ['playlist', 'playlistInfo', 'urls', 'argv', 'path']) {
      expect(() => validateM5Payload(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE, { ...base, [key]: {} }))
        .toThrow(/payload key not allowed/);
    }
  });
});

describe('Playlist batch IPC · live probe + default select all', () => {
  it('returns a 65-row safe DTO and a ticket, with no entry URL', async () => {
    const h = await harness();
    const dto = await preview(h);
    expect(dto.ok).toBe(true);
    expect(dto.fetchedCount).toBe(65);
    expect(dto.entries).toHaveLength(65);
    expect(JSON.stringify(dto)).not.toContain('SECRET');
    expect(dto.previewId).toBeTruthy();
  });

  it('without the service the channel reports unavailability, never a fixture', async () => {
    const h = await harness({ withoutService: true });
    const dto = await preview(h);
    expect(dto).toMatchObject({ ok: false });
  });

  it('cancel releases the ticket without creating any task', async () => {
    const h = await harness();
    const dto = await preview(h);
    const cancel = h.handlers.get(IPC_CHANNELS.PLAYLIST_PREVIEW_CANCEL);
    expect(await cancel?.({ previewId: dto.previewId })).toEqual({ ok: true });
    expect((await enqueue(h, { previewId: dto.previewId, url: URL_A })).code).toBe('PREVIEW_UNKNOWN');
    expect(h.calls).toHaveLength(0);
  });

  it('no selectedIds = DOWNLOAD ALL 65 from the CACHED playlist', async () => {
    const h = await harness();
    const dto = await preview(h);
    const result = await enqueue(h, { previewId: dto.previewId, url: URL_A });
    expect(result.requested).toBe(65);
    expect(result.enqueued).toBe(65);
    expect(result.failed).toBe(0);
    expect(result.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.selectedIds).toHaveLength(65);
    expect(h.calls[0]?.playlist?.entries).toHaveLength(65);
    expect(h.calls[0]?.playlist?.id).toBe('PL_GTA_65');
  });

  it('forwards kind / quality / audio enums to the batch', async () => {
    const h = await harness();
    const dto = await preview(h);
    await enqueue(h, {
      previewId: dto.previewId, url: URL_A,
      selectedIds: ['ep1', 'ep2'], kind: 'audio', audioQuality: '192', audioFormat: 'mp3',
    });
    expect(h.calls[0]).toMatchObject({ kind: 'audio', audioQuality: '192', audioFormat: 'mp3' });
  });
});

describe('Playlist batch IPC · edge cases', () => {
  it('an empty selection is refused WITHOUT burning the ticket', async () => {
    const h = await harness();
    const dto = await preview(h);
    const refused = await enqueue(h, { previewId: dto.previewId, url: URL_A, selectedIds: [] });
    expect(refused.code).toBe('EMPTY_SELECTION');
    expect(h.calls).toHaveLength(0);
    expect((await enqueue(h, { previewId: dto.previewId, url: URL_A })).enqueued).toBe(65);
  });

  it('rejects more than the existing 500-item ceiling', async () => {
    const h = await harness();
    const dto = await preview(h);
    await expect(enqueue(h, {
      previewId: dto.previewId, url: URL_A,
      selectedIds: Array.from({ length: MAX_PLAYLIST_ITEMS + 1 }, (_v, i) => `ep${i}`),
    })).rejects.toThrow(/exceeds 500/);
  });

  it('rejects a malformed ticket, URL and out-of-enum quality', async () => {
    const h = await harness();
    await expect(enqueue(h, { previewId: 'x', url: URL_A })).rejects.toThrow(/invalid previewId/);
    await expect(enqueue(h, { previewId: 'preview-ticket-0001', url: 'file:///C:/x' }))
      .rejects.toThrow(/invalid playlist url/);
    await expect(enqueue(h, { previewId: 'preview-ticket-0001', url: URL_A, quality: '8K' }))
      .rejects.toThrow(/invalid quality/);
  });

  it('a ticket cannot be replayed or used across URLs', async () => {
    const h = await harness();
    const dto = await preview(h);
    expect((await enqueue(h, { previewId: dto.previewId, url: URL_B })).code)
      .toBe('PREVIEW_URL_MISMATCH');
    // Mismatch does not burn it, so the correct URL still works once.
    expect((await enqueue(h, { previewId: dto.previewId, url: URL_A })).ok).toBe(true);
    expect((await enqueue(h, { previewId: dto.previewId, url: URL_A })).code)
      .toBe('PREVIEW_CONSUMED');
    expect(h.calls).toHaveLength(1);
  });

  it('partial enqueue failure is reported, never rounded up to success', async () => {
    const h = await harness();
    h.setReport({
      requested: 3, enqueued: 2, failed: 1, taskIds: ['a', 'b'],
      failures: [{ id: 'ep3', reason: 'ENQUEUE_FAILED' }],
    });
    const dto = await preview(h);
    const result = await enqueue(h, {
      previewId: dto.previewId, url: URL_A, selectedIds: ['ep1', 'ep2', 'ep3'],
    });
    expect(result).toMatchObject({
      ok: false, code: 'PARTIAL_SUCCESS', requested: 3, enqueued: 2, failed: 1,
    });
    expect(result.failures).toHaveLength(1);
  });

  it('a total enqueue failure returns ENQUEUE_FAILED', async () => {
    const h = await harness();
    h.setReport({
      requested: 3, enqueued: 0, failed: 3, taskIds: [],
      failures: [{ id: 'ep1', reason: 'queue exploded' }],
    });
    const dto = await preview(h);
    expect(await enqueue(h, { previewId: dto.previewId, url: URL_A }))
      .toMatchObject({ ok: false, code: 'ENQUEUE_FAILED', enqueued: 0, failed: 3 });
  });
});
