/**
 * Stage 3 · DOWNLOAD_START with a subtitle choice.
 *
 * This is the seam where three things must line up:
 *   1. the renderer can only describe a CHOICE (language codes + switches), never
 *      metadata, a path or an argv token;
 *   2. the main process spends the preview ticket and validates the languages
 *      against the probe it actually ran;
 *   3. the enqueue receives BOTH the merged subtitle patch and the pre-probed
 *      `MediaInfo` (which is what suppresses the second probe).
 */
import { describe, it, expect, vi } from 'vitest';
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { SubtitleDomain, TaskRecord } from '@ytvdlt/shared';
import { CommandTemplateStore, ConfigStore } from '@ytvdlt/core';
import type { TaskDetailAction, TaskDetailResult } from '@ytvdlt/core';
import {
  createM5Handlers,
  type M5ChannelDeps, type SingleEnqueueRequest, type SubtitlePreviewPortLike,
  type SystemAppearancePort,
} from '../../apps/desktop/src/main/m5-channels.js';
import { createSubtitlePreviewService } from '../../apps/desktop/src/main/subtitle-preview-service.js';
import { createInMemoryPorts } from './helpers/in-memory-ports.js';
import { bucketOf, mediaInfo, trackOf } from './helpers/subtitle-media.js';

const WATCH = 'https://example.org/watch?v=abc';
const OTHER = 'https://example.org/watch?v=other';
const appearance: SystemAppearancePort = {
  prefersDark: () => false,
  prefersReducedMotion: () => false,
  accent: () => null,
};

type Dispatch = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Harness {
  dispatch: Dispatch;
  enqueued: SingleEnqueueRequest[];
  service: ReturnType<typeof createSubtitlePreviewService>;
  advance: (ms: number) => void;
  probe: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const { ports } = createInMemoryPorts();
  const config = new ConfigStore({ ports });
  await config.load();
  const templates = new CommandTemplateStore({ ports });
  await templates.init();

  let nowMs = 1_000_000;
  const probe = vi.fn(async () => mediaInfo({
    subtitles: bucketOf(trackOf('en', 'vtt', 'English'), trackOf('zh-Hans', 'srt')),
    automatic_captions: bucketOf(trackOf('en', 'vtt', 'English (auto)'), trackOf('de', 'vtt', 'German (auto)')),
  }));
  let seq = 0;
  const service = createSubtitlePreviewService({
    probe,
    clock: { nowIso: () => new Date(nowMs).toISOString(), nowEpochMs: () => nowMs },
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  });

  const enqueued: SingleEnqueueRequest[] = [];
  const deps: M5ChannelDeps = {
    queue: { list: (): readonly TaskRecord[] => [], get: () => undefined },
    taskDetail: {
      perform: async (_taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> => ({
        action, ok: true, code: 'OK', message: '',
      }),
    },
    templates,
    config,
    systemAppearance: appearance,
    subtitlePreview: service as SubtitlePreviewPortLike,
    enqueueSingle: async (input) => {
      enqueued.push(input);
      return ['single-1'];
    },
  };
  const handlers = createM5Handlers(deps);
  const start = handlers.get(IPC_CHANNELS.DOWNLOAD_START);
  return {
    dispatch: (payload) => start?.(payload) as Promise<Record<string, unknown>>,
    enqueued,
    service,
    advance: (ms: number) => { nowMs += ms; },
    probe,
  };
}

/** Open a preview and return its ticket id (helper for every case below). */
async function ticketFor(h: Harness, url = WATCH): Promise<string> {
  const preview = await h.service.preview(url);
  if (!preview.ok) throw new Error(`preview failed: ${preview.code}`);
  return preview.preview.previewId;
}

describe('download start · subtitle payload validation', () => {
  it('accepts a plain download exactly as before (no subtitle keys)', async () => {
    const h = await harness();
    const result = await h.dispatch({ url: WATCH, kind: 'video' });
    expect(result).toMatchObject({ accepted: true, enqueued: true, taskIds: ['single-1'] });
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]?.subtitlePatch).toBeUndefined();
    expect(h.enqueued[0]?.mediaInfo).toBeUndefined();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('rejects metadata the renderer is not allowed to send', async () => {
    const h = await harness();
    for (const forbidden of [
      { mediaInfo: { title: 'fake' } },
      { subtitlePatch: { enabled: true } },
      { subtitle: { languages: ['en'] } },
      { argv: ['--exec'] },
    ]) {
      await expect(h.dispatch({ url: WATCH, kind: 'video', ...forbidden }))
        .rejects.toThrow(/payload key not allowed/);
    }
    expect(h.enqueued).toHaveLength(0);
  });

  it('requires a ticket before any subtitle choice', async () => {
    const h = await harness();
    const result = await h.dispatch({ url: WATCH, kind: 'video', subtitleLanguages: ['en'] });
    expect(result).toMatchObject({ accepted: false, code: 'PREVIEW_REQUIRED', enqueued: false });
    expect(h.enqueued).toHaveLength(0);
  });

  it('rejects malformed language lists and enums', async () => {
    const h = await harness();
    const cases: Record<string, unknown>[] = [
      { subtitleLanguages: 'en' },
      { subtitleLanguages: [] },
      { subtitleLanguages: Array.from({ length: 13 }, (_, i) => `l${i}`) },
      { subtitleLanguages: ['en.*'] },
      { subtitleLanguages: ['../x'] },
      { subtitleLanguages: ['en'], subtitleConvertTo: 'mkv' },
      { subtitleLanguages: ['en'], subtitleAutoCaptions: 'yes' },
      { subtitleLanguages: ['en'], subtitleEmbed: 1 },
      { subtitleLanguages: ['en'], subtitleKeepFile: 'true' },
    ];
    for (const extra of cases) {
      await expect(h.dispatch({ url: WATCH, kind: 'video', ...extra })).rejects.toThrow(/m5-ipc/);
    }
    await expect(h.dispatch({ url: WATCH, kind: 'video', previewId: 'nope' })).rejects.toThrow(/invalid previewId/);
    expect(h.enqueued).toHaveLength(0);
  });
});

describe('download start · ticket consumption', () => {
  it('consumes the ticket once and forwards the pre-probed MediaInfo', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    const result = await h.dispatch({ url: WATCH, kind: 'video', previewId });

    expect(result).toMatchObject({ accepted: true, enqueued: true });
    expect(h.enqueued[0]?.mediaInfo?.id).toBe('vid001');
    // A ticket alone (no subtitle choice) must NOT invent a subtitle patch.
    expect(h.enqueued[0]?.subtitlePatch).toBeUndefined();
  });

  it('refuses a second use of the same ticket', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    await h.dispatch({ url: WATCH, kind: 'video', previewId, subtitleLanguages: ['en'] });
    const second = await h.dispatch({ url: WATCH, kind: 'video', previewId, subtitleLanguages: ['en'] });

    expect(second).toMatchObject({ accepted: false, code: 'PREVIEW_CONSUMED' });
    expect(h.enqueued).toHaveLength(1);
  });

  it('refuses a ticket opened for another URL', async () => {
    const h = await harness();
    const previewId = await ticketFor(h, WATCH);
    const result = await h.dispatch({ url: OTHER, kind: 'video', previewId, subtitleLanguages: ['en'] });

    expect(result).toMatchObject({ accepted: false, code: 'PREVIEW_URL_MISMATCH' });
    expect(h.enqueued).toHaveLength(0);
  });

  it('refuses an expired ticket', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    h.advance(5 * 60 * 1000);
    const result = await h.dispatch({ url: WATCH, kind: 'video', previewId, subtitleLanguages: ['en'] });

    expect(result).toMatchObject({ accepted: false, code: 'PREVIEW_EXPIRED' });
    expect(h.enqueued).toHaveLength(0);
  });

  it('degrades silently when a ticket is stale but no subtitle was chosen', async () => {
    // Prefill-only: losing the ticket costs one extra probe, not a failed task.
    const h = await harness();
    const previewId = await ticketFor(h);
    h.advance(5 * 60 * 1000);
    const result = await h.dispatch({ url: WATCH, kind: 'video', previewId });

    expect(result).toMatchObject({ accepted: true });
    expect(h.enqueued[0]?.mediaInfo).toBeUndefined();
  });
});

describe('download start · subtitle patch', () => {
  it('manual language → enabled, with the exact code', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    await h.dispatch({ url: WATCH, kind: 'video', previewId, subtitleLanguages: ['zh-Hans'] });

    const patch = h.enqueued[0]?.subtitlePatch as Partial<SubtitleDomain>;
    expect(patch).toMatchObject({
      enabled: true, languages: 'zh-Hans', autoCaptions: false, embed: false, convertTo: 'none',
    });
    expect(h.enqueued[0]?.mediaInfo).toBeDefined();
  });

  it('automatic-only language → no manual writing (R1)', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    await h.dispatch({
      url: WATCH, kind: 'video', previewId,
      subtitleLanguages: ['de'], subtitleAutoCaptions: true,
    });

    const patch = h.enqueued[0]?.subtitlePatch as Partial<SubtitleDomain>;
    expect(patch).toMatchObject({ enabled: false, languages: 'de', autoCaptions: true });
  });

  it.each([['de'], ['en', 'de']])('rejects automatic-only tracks without permission: %j', async (...languages) => {
    const h = await harness();
    const previewId = await ticketFor(h);
    const result = await h.dispatch({
      url: WATCH, kind: 'video', previewId,
      subtitleLanguages: languages, subtitleAutoCaptions: false,
    });
    expect(result).toMatchObject({ accepted: false, enqueued: false, code: 'SUBTITLE_NO_MANUAL_TRACK' });
    expect(h.enqueued).toHaveLength(0);
  });

  it('manual + automatic + conversion + multi-language', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    await h.dispatch({
      url: WATCH, kind: 'video', previewId,
      subtitleLanguages: ['en', 'zh-Hans'],
      subtitleAutoCaptions: true,
      subtitleConvertTo: 'srt',
    });

    const patch = h.enqueued[0]?.subtitlePatch as Partial<SubtitleDomain>;
    expect(patch).toMatchObject({
      enabled: true, languages: 'en,zh-Hans', autoCaptions: true, convertTo: 'srt',
    });
  });

  it('embed is carried for video and refused for audio without burning the ticket', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);

    const audio = await h.dispatch({
      url: WATCH, kind: 'audio', previewId,
      subtitleLanguages: ['en'], subtitleEmbed: true,
    });
    expect(audio).toMatchObject({ accepted: false, code: 'SUBTITLE_EMBED_UNSUPPORTED' });
    expect(h.enqueued).toHaveLength(0);

    // The ticket survived the refusal, so the user can switch to video and retry.
    const video = await h.dispatch({
      url: WATCH, kind: 'video', previewId,
      subtitleLanguages: ['en'], subtitleEmbed: true, subtitleKeepFile: true,
    });
    expect(video).toMatchObject({ accepted: true });
    expect(h.enqueued[0]?.subtitlePatch).toMatchObject({ embed: true, keepSubtitleFile: true });
  });

  it('refuses a language the video does not offer', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    const result = await h.dispatch({ url: WATCH, kind: 'video', previewId, subtitleLanguages: ['ja'] });

    expect(result).toMatchObject({ accepted: false, code: 'SUBTITLE_LANGUAGE_UNKNOWN' });
    expect(h.enqueued).toHaveLength(0);
  });

  it('keeps the config default expression untouched when only some languages match', async () => {
    const h = await harness();
    const previewId = await ticketFor(h);
    await h.dispatch({ url: WATCH, kind: 'video', previewId, subtitleLanguages: ['en', 'ja'] });
    expect(h.enqueued[0]?.subtitlePatch).toMatchObject({ languages: 'en' });
  });
});

describe('download start · no preview service in this build', () => {
  it('accepts a plain download but refuses a subtitle choice', async () => {
    const { ports } = createInMemoryPorts();
    const config = new ConfigStore({ ports });
    await config.load();
    const templates = new CommandTemplateStore({ ports });
    await templates.init();
    const enqueued: SingleEnqueueRequest[] = [];
    const handlers = createM5Handlers({
      queue: { list: (): readonly TaskRecord[] => [], get: () => undefined },
      taskDetail: {
        perform: async (_taskId: string, action: TaskDetailAction): Promise<TaskDetailResult> => ({
          action, ok: true, code: 'OK', message: '',
        }),
      },
      templates,
      config,
      systemAppearance: appearance,
      enqueueSingle: async (input) => { enqueued.push(input); return ['single-1']; },
    });
    const start = handlers.get(IPC_CHANNELS.DOWNLOAD_START);

    expect(await start?.({ url: WATCH, kind: 'video' })).toMatchObject({ accepted: true });
    expect(await start?.({
      url: WATCH, kind: 'video', subtitleLanguages: ['en'], previewId: '00000000-0000-4000-8000-000000000009',
    })).toMatchObject({ accepted: false, code: 'PREVIEW_UNAVAILABLE' });
    expect(enqueued).toHaveLength(1);
  });
});
