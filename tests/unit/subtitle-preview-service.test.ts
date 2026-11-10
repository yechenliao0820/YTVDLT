/**
 * Subtitle preview · service (stage 2).
 *
 * These are the guarantees the renderer and the enqueue path both depend on:
 * one probe per URL, an opaque bounded ticket, a fixed failure sentence that
 * cannot quote a signed URL, and a `consume()` result whose `media` is the very
 * object `TaskRecord.mediaInfo` wants (so the queue does not probe again).
 */
import { describe, it, expect, vi } from 'vitest';
import type { MediaInfo } from '@ytvdlt/shared';
import {
  createSubtitlePreviewService,
  normalizePreviewUrl,
  type SubtitlePreviewServiceOptions,
} from '../../apps/desktop/src/main/subtitle-preview-service.js';
import {
  SIGNED_PAGE_URL, bucketOf, findUrlLeaks, mediaInfo, trackOf,
} from './helpers/subtitle-media.js';

const WATCH = 'https://example.org/watch?v=abc';

interface Harness {
  service: ReturnType<typeof createSubtitlePreviewService>;
  probe: ReturnType<typeof vi.fn>;
  clock: { nowIso: () => string; nowEpochMs: () => number; advance: (ms: number) => void };
  media: MediaInfo;
  ids: string[];
  logs: Array<Record<string, unknown>>;
}

function harness(overrides: Partial<SubtitlePreviewServiceOptions> = {}): Harness {
  const media = mediaInfo({
    subtitles: bucketOf(trackOf('en', 'vtt', 'English'), trackOf('zh-Hans', 'srt')),
    automatic_captions: bucketOf(trackOf('en', 'vtt', 'English (auto)'), trackOf('de', 'vtt', 'German (auto)')),
  });
  let nowMs = 1_000_000;
  const clock = {
    nowIso: () => new Date(nowMs).toISOString(),
    nowEpochMs: () => nowMs,
    advance: (ms: number) => { nowMs += ms; },
  };
  const probe = vi.fn(async () => media);
  const ids: string[] = [];
  let seq = 0;
  const logs: Array<Record<string, unknown>> = [];
  const service = createSubtitlePreviewService({
    probe,
    clock,
    newId: () => {
      // Shaped like `crypto.randomUUID()`: the IPC layer validates this shape.
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      ids.push(id);
      return id;
    },
    logger: {
      info: async (_scope, _message, data) => { logs.push(data ?? {}); },
    },
    ...overrides,
  });
  return { service, probe, clock, media, ids, logs };
}

describe('subtitle preview service · happy path', () => {
  it('returns a whitelisted DTO and a ticket bound to the URL', async () => {
    const { service, probe, ids } = harness();
    const result = await service.preview(WATCH);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(WATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.preview.previewId).toBe(ids[0]);
    expect(result.preview.media).toEqual({
      title: 'Fixture Video',
      uploader: 'Fixture Channel',
      durationSec: 212,
      extractorKey: 'youtube',
    });
    expect(result.preview.manualLanguages).toBe(2);
    expect(result.preview.automaticLanguages).toBe(2);
    expect(result.preview.empty).toBe(false);
    expect(result.preview.tracks.map((track) => track.languageCode)).toEqual(['en', 'zh-Hans', 'de']);
    // 5 minutes on the injected clock, expressed as an ISO instant.
    expect(result.preview.expiresAt).toBe(new Date(1_000_000 + 5 * 60_000).toISOString());
    expect(service.size).toBe(1);
  });

  it('reports "no subtitles" as a SUCCESS with an empty track list', async () => {
    const empty = mediaInfo();
    const { service } = harness({ probe: async () => empty });
    const result = await service.preview(WATCH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.tracks).toEqual([]);
    expect(result.preview.empty).toBe(true);
    expect(result.preview.manualLanguages).toBe(0);
    expect(result.preview.automaticLanguages).toBe(0);
    // An empty preview is still a valid ticket: the enqueue path may need the
    // probed MediaInfo (title/uploader) even when no subtitle is selected.
    expect(service.size).toBe(1);
  });

  it('keeps the probe result for the enqueue path (same object identity)', async () => {
    const { service, media } = harness();
    const result = await service.preview(WATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const consumed = service.consume(result.preview.previewId, WATCH);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    // Identity matters: phase 3 assigns this to `TaskRecord.mediaInfo`, which is
    // the only branch that makes TaskQueue skip its own probe.
    expect(consumed.consumption.media).toBe(media);
    expect(consumed.consumption.tracks).toHaveLength(3);
  });
});

describe('subtitle preview service · URL validation', () => {
  it.each([
    ['file:///C:/secret.txt'],
    ['javascript:alert(1)'],
    ['ftp://example.org/v'],
    ['https://user:pass@example.org/watch'],
    ['/relative/path'],
    ['not a url'],
    [`https://example.org/${'a'.repeat(2100)}`],
  ])('refuses %s without probing', async (url) => {
    const { service, probe } = harness();
    const result = await service.preview(url);
    expect(result).toEqual({
      ok: false, code: 'PREVIEW_INVALID_URL', message: '字幕预览需要合法的 http(s) 链接',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(service.size).toBe(0);
  });

  it('rejects non-strings and whitespace-only input', async () => {
    const { service, probe } = harness();
    for (const value of [undefined, null, 42, {}, [], '   ']) {
      const result = await service.preview(value);
      expect(result.ok).toBe(false);
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('trims the URL before probing and binding', async () => {
    const { service, probe } = harness();
    const result = await service.preview(`  ${WATCH}  `);
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledWith(WATCH);
    if (result.ok) expect(service.consume(result.preview.previewId, WATCH).ok).toBe(true);
  });

  it('normalizePreviewUrl is the single rule', () => {
    expect(normalizePreviewUrl(` ${WATCH} `)).toBe(WATCH);
    expect(normalizePreviewUrl('file:///x')).toBeNull();
    expect(normalizePreviewUrl('')).toBeNull();
  });
});

describe('subtitle preview service · probe failures', () => {
  it('collapses a probe error into a fixed sentence and logs only a code', async () => {
    const failure = Object.assign(new Error(`request failed for ${SIGNED_PAGE_URL}`), { code: 'HTTP_403' });
    const { service, logs } = harness({ probe: async () => { throw failure; } });
    const result = await service.preview(WATCH);

    expect(result).toEqual({
      ok: false, code: 'PREVIEW_FAILED', message: '字幕信息获取失败，请检查链接或网络后重试',
    });
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
    // The log line carries the stable code, never the upstream message (which
    // may quote the URL, which may carry a token).
    expect(logs).toEqual([{ code: 'HTTP_403' }]);
    expect(JSON.stringify(logs)).not.toContain('http');
    expect(service.size).toBe(0);
  });

  it('degrades to UNKNOWN in the log when the failure carries no code', async () => {
    const { service, logs } = harness({ probe: async () => { throw new Error('boom'); } });
    const result = await service.preview(WATCH);
    expect(result.ok).toBe(false);
    expect(logs[0]).toEqual({ code: 'UNKNOWN' });
  });
});

describe('subtitle preview service · one probe per URL', () => {
  it('shares a single in-flight probe but issues a ticket per caller', async () => {
    let release: (media: MediaInfo) => void = () => undefined;
    const pending = new Promise<MediaInfo>((resolve) => { release = resolve; });
    const probe = vi.fn(() => pending);
    const { service, ids } = harness({ probe });

    const first = service.preview(WATCH);
    const second = service.preview(WATCH);
    expect(service.pendingProbes).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);

    release(mediaInfo({ subtitles: bucketOf(trackOf('en', 'vtt', 'English')) }));
    const [a, b] = await Promise.all([first, second]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.preview.previewId).not.toBe(b.preview.previewId);
    expect(ids).toHaveLength(2);
    expect(service.pendingProbes).toBe(0);
    // Both tickets are independently spendable — sharing one would break the
    // second caller for no reason.
    expect(service.consume(a.preview.previewId, WATCH).ok).toBe(true);
    expect(service.consume(b.preview.previewId, WATCH).ok).toBe(true);
  });

  it('does not cache a failed probe as a shareable success', async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first fails');
      return mediaInfo();
    });
    const { service } = harness({ probe });
    expect((await service.preview(WATCH)).ok).toBe(false);
    expect((await service.preview(WATCH)).ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('subtitle preview service · ticket lifecycle', () => {
  it('expires after five minutes', async () => {
    const { service, clock } = harness();
    const result = await service.preview(WATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    clock.advance(5 * 60_000);
    expect(service.consume(result.preview.previewId, WATCH)).toEqual({ ok: false, code: 'PREVIEW_EXPIRED' });
    expect(service.size).toBe(0);
  });

  it('refuses a second consume and a foreign URL', async () => {
    const { service } = harness();
    const result = await service.preview(WATCH);
    if (!result.ok) return;

    expect(service.consume(result.preview.previewId, 'https://example.org/watch?v=other')).toEqual({
      ok: false, code: 'PREVIEW_URL_MISMATCH',
    });
    expect(service.consume(result.preview.previewId, WATCH).ok).toBe(true);
    expect(service.consume(result.preview.previewId, WATCH)).toEqual({ ok: false, code: 'PREVIEW_CONSUMED' });
  });

  it('cancel releases the ticket; a second cancel is a no-op', async () => {
    const { service } = harness();
    const result = await service.preview(WATCH);
    if (!result.ok) return;

    expect(await service.cancel(result.preview.previewId)).toBe(true);
    expect(await service.cancel(result.preview.previewId)).toBe(false);
    expect(service.consume(result.preview.previewId, WATCH)).toEqual({ ok: false, code: 'PREVIEW_UNKNOWN' });
  });

  it('dispose() wipes every ticket (window close / quit)', async () => {
    const { service } = harness();
    const first = await service.preview(WATCH);
    const second = await service.preview('https://example.org/watch?v=second');
    expect(service.size).toBe(2);

    service.dispose();
    expect(service.size).toBe(0);
    if (first.ok) expect(service.consume(first.preview.previewId, WATCH).ok).toBe(false);
    if (second.ok) expect(service.consume(second.preview.previewId, 'https://example.org/watch?v=second').ok).toBe(false);
  });

  it('keeps a consumed id distinguishable from a cancelled one', async () => {
    const { service } = harness();
    const spent = await service.preview(WATCH);
    const dropped = await service.preview('https://example.org/watch?v=drop');
    if (!spent.ok || !dropped.ok) return;

    service.consume(spent.preview.previewId, WATCH);
    await service.cancel(dropped.preview.previewId);
    expect(service.consume(spent.preview.previewId, WATCH)).toEqual({ ok: false, code: 'PREVIEW_CONSUMED' });
    expect(service.consume(dropped.preview.previewId, 'https://example.org/watch?v=drop')).toEqual({
      ok: false, code: 'PREVIEW_UNKNOWN',
    });
  });
});

describe('subtitle preview service · renderer-visible payload is URL-free', () => {
  it('the DTO carries no signed subtitle URL, page URL or thumbnail', async () => {
    const { service } = harness();
    const result = await service.preview(WATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(findUrlLeaks(result.preview)).toEqual([]);
    expect(JSON.stringify(result.preview)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(result.preview)).not.toContain('http');
    // And the raw MediaInfo is not smuggled in under another key.
    for (const forbidden of ['formats', 'webpage_url', 'description', 'subtitles', 'automatic_captions']) {
      expect(JSON.stringify(result.preview)).not.toContain(`"${forbidden}"`);
    }
  });
});
