/**
 * Subtitle preview · IPC boundary (stage 2).
 *
 * The renderer talks to this layer and nothing else, so this file proves the
 * two things a security review would ask for:
 *   1. every input is validated (unknown keys, bad URLs, bad ticket ids);
 *   2. what comes back carries no signed URL — checked on the REAL service, not
 *      on a hand-written fake, because the projection is what could leak.
 *
 * It also proves the renderer has no way to SPEND a ticket: consumption is a
 * main-process-only method used by the enqueue path in phase 3.
 */
import { describe, it, expect, vi } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { TaskRecord } from '@ytvdlt/shared';
import { CommandTemplateStore, ConfigStore } from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import {
  M5_CHANNELS, createM5Handlers,
  type M5ChannelDeps, type SubtitlePreviewPortLike, type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createSubtitlePreviewService } from '../../apps/desktop/src/main/subtitle-preview-service.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import {
  bucketOf, findUrlLeaks, mediaInfo, trackOf,
} from './helpers/subtitle-media.js';

const WATCH = 'https://example.org/watch?v=abc';
const OTHER = 'https://example.org/watch?v=other';
const appearance: SystemAppearancePort = {
  prefersDark: () => false,
  prefersReducedMotion: () => false,
  accent: () => null,
};

interface Harness {
  handlers: Map<string, (payload: unknown) => Promise<unknown>>;
  service: ReturnType<typeof createSubtitlePreviewService>;
  probe: ReturnType<typeof vi.fn>;
}

async function harness(options: { withService?: boolean } = {}): Promise<Harness> {
  const { ports } = createInMemoryPorts();
  const config = new ConfigStore({ ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports });
  await templates.init();

  const probe = vi.fn(async () => mediaInfo({
    subtitles: bucketOf(trackOf('en', 'vtt', 'English'), trackOf('zh-Hans', 'srt')),
    automatic_captions: bucketOf(trackOf('en', 'vtt', 'English (auto)')),
  }));
  let seq = 0;
  const service = createSubtitlePreviewService({
    probe,
    clock: { nowIso: () => '2026-11-10T00:00:00.000Z', nowEpochMs: () => 1_000_000 },
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  });

  const noTasks = {
    queue: { list: (): readonly TaskRecord[] => [], get: () => undefined },
    taskDetail: {
      perform: async (_taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> => ({
        action, ok: true, code: 'OK', message: '',
      }),
    },
  };
  const deps: M5ChannelDeps = {
    queue: noTasks.queue,
    taskDetail: noTasks.taskDetail,
    templates,
    config,
    systemAppearance: appearance,
    ...(options.withService === false ? {} : { subtitlePreview: service as SubtitlePreviewPortLike }),
  };
  return { handlers: createM5Handlers(deps), service, probe };
}

describe('subtitle preview ipc · channel inventory', () => {
  it('exposes both new channels and keeps them in the shared list', () => {
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.SUBTITLE_PREVIEW);
    expect(M5_CHANNELS).toContain(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL);
    expect(IPC_CHANNELS.SUBTITLE_PREVIEW).toBe('ytvdlt:subtitle:preview');
    expect(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL).toBe('ytvdlt:subtitle:previewCancel');
  });

  it('offers no channel that could SPEND a ticket', async () => {
    // Consumption is main-process only; phase 3 wires it into enqueue.
    const spendable = Object.values(IPC_CHANNELS).filter((channel) => /consume/i.test(channel));
    expect(spendable).toEqual([]);
    const { handlers } = await harness();
    expect(handlers.has('ytvdlt:subtitle:consume')).toBe(false);
    // The only subtitle channels are the two above — nothing hidden in the map.
    const subtitleChannels = [...handlers.keys()].filter((channel) => channel.startsWith('ytvdlt:subtitle:'));
    expect(subtitleChannels.sort()).toEqual([
      IPC_CHANNELS.SUBTITLE_PREVIEW,
      IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL,
    ].sort());
  });
});

describe('subtitle preview ipc · input validation', () => {
  it('forwards a valid URL and returns the real DTO', async () => {
    const { handlers, probe } = await harness();
    const result = await handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW)?.({ url: WATCH }) as {
      ok: true; preview: { previewId: string; tracks: unknown[]; empty: boolean };
    };
    expect(probe).toHaveBeenCalledWith(WATCH);
    expect(result.ok).toBe(true);
    expect(result.preview.previewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.preview.tracks).toHaveLength(2);
    expect(result.preview.empty).toBe(false);
  });

  it('rejects any key the renderer is not allowed to send', async () => {
    const { handlers } = await harness();
    const preview = handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW);
    for (const payload of [
      { url: WATCH, mediaInfo: { subtitles: {} } },
      { url: WATCH, tracks: [] },
      { url: WATCH, paths: { videoDir: 'C:/x' } },
      { url: WATCH, argv: ['--exec', 'calc'] },
    ]) {
      await expect(preview?.(payload)).rejects.toThrow(/payload key not allowed/);
    }
  });

  it('rejects non-http(s), non-string, empty and over-long URLs', async () => {
    const { handlers, probe } = await harness();
    const preview = handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW);
    await expect(preview?.({ url: 'file:///C:/x.txt' })).rejects.toThrow(/http\(s\)/);
    await expect(preview?.({ url: 'javascript:alert(1)' })).rejects.toThrow(/http\(s\)/);
    await expect(preview?.({ url: 42 })).rejects.toThrow(/string url/);
    await expect(preview?.({ url: '   ' })).rejects.toThrow(/invalid subtitle preview url/);
    await expect(preview?.({ url: `https://example.org/${'a'.repeat(2100)}` })).rejects.toThrow(/invalid/);
    await expect(preview?.({})).rejects.toThrow(/string url/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects a malformed previousPreviewId before probing', async () => {
    const { handlers, probe } = await harness();
    const preview = handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW);
    for (const previousPreviewId of ['short', '../../etc/passwd', 42, 'a'.repeat(80)]) {
      await expect(preview?.({ url: WATCH, previousPreviewId })).rejects.toThrow(/invalid previewId/);
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('treats an empty previousPreviewId as "none"', async () => {
    const { handlers } = await harness();
    const result = await handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW)?.({ url: WATCH, previousPreviewId: '' });
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it('releases the superseded ticket when a new preview replaces it', async () => {
    const { handlers, service } = await harness();
    const preview = handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW);
    const first = await preview?.({ url: WATCH }) as { preview: { previewId: string } };
    const second = await preview?.({ url: OTHER, previousPreviewId: first.preview.previewId }) as {
      preview: { previewId: string };
    };

    expect(service.consume(first.preview.previewId, WATCH)).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
    expect(service.consume(second.preview.previewId, OTHER).ok).toBe(true);
  });
});

describe('subtitle preview ipc · cancel', () => {
  it('cancels a live ticket and reports a second cancel honestly', async () => {
    const { handlers } = await harness();
    const preview = await handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW)?.({ url: WATCH }) as {
      preview: { previewId: string };
    };
    const cancel = handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL);
    await expect(cancel?.({ previewId: preview.preview.previewId }))
      .resolves.toEqual({ ok: true, canceled: true });
    await expect(cancel?.({ previewId: preview.preview.previewId }))
      .resolves.toEqual({ ok: true, canceled: false });
  });

  it('validates the ticket id', async () => {
    const { handlers } = await harness();
    const cancel = handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL);
    await expect(cancel?.({ previewId: '' })).rejects.toThrow(/invalid previewId/);
    await expect(cancel?.({ previewId: '../x' })).rejects.toThrow(/invalid previewId/);
    await expect(cancel?.({})).rejects.toThrow(/invalid previewId/);
  });
});

describe('subtitle preview ipc · build without the service', () => {
  it('answers PREVIEW_UNAVAILABLE instead of falling back to the fixture', async () => {
    const { handlers, probe } = await harness({ withService: false });
    const result = await handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW)?.({ url: WATCH });
    expect(result).toEqual({ ok: false, code: 'PREVIEW_UNAVAILABLE', message: '当前构建未启用字幕预览' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports "nothing canceled" on the cancel channel', async () => {
    const { handlers } = await harness({ withService: false });
    const result = await handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL)?.({
      previewId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result).toEqual({ ok: false, canceled: false });
  });
});

describe('subtitle preview ipc · nothing sensitive crosses the bridge', () => {
  it('the payload returned to the renderer contains no URL or credential', async () => {
    const { handlers } = await harness();
    const result = await handlers.get(IPC_CHANNELS.SUBTITLE_PREVIEW)?.({ url: WATCH });
    expect(findUrlLeaks(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(result)).not.toContain('http');
    // The full MediaInfo must not arrive under a nested key either.
    expect(JSON.stringify(result)).not.toContain('automatic_captions');
    expect(JSON.stringify(result)).not.toContain('webpage_url');
  });
});
