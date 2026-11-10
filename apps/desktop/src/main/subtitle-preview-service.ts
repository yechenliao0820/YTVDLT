/**
 * SubtitlePreviewService (stage 2) — live subtitle metadata + ticket handling.
 *
 * This is the ONLY place that probes for subtitles, and it probes **on demand**:
 * nothing runs at start-up, so a user who never opens the subtitle picker still
 * pays zero extra network cost (phase-1 R7). When the picker does open, the
 * probe result is not thrown away — it is stored in `SubtitlePreviewCache` and
 * handed back on `consume()`, which is how the enqueue path avoids the queue's
 * own second probe (`task-queue.ts` only probes when `mediaInfo === null`).
 *
 * Security boundaries enforced here, not in the renderer:
 *   - the returned DTO is built by whitelist (title / uploader / duration /
 *     language rows); no `MediaInfo`, no signed `SubtitleTrack.url`;
 *   - probe errors are collapsed into a fixed sentence — an upstream message
 *     can quote the URL, and that URL may carry a token;
 *   - every id is opaque (`crypto.randomUUID` in production), bound to the
 *     normalised URL, short-lived and single-use.
 */
import type {
  ClockPort, MediaInfo, SubtitlePreviewConsumeResult, SubtitlePreviewDto, SubtitlePreviewResult,
  SubtitleTrackPreview,
} from '@ytvdlt/shared';
import { assertHttpUrl } from '@ytvdlt/engine-ytdlp';
import {
  SubtitlePreviewCache, collectSubtitleTracks, sanitizeDisplayText, summarizeSubtitleTracks,
  toConsumption, type SubtitlePreviewEntry,
} from '@ytvdlt/core';

/** Longest URL worth probing; also a cheap guard against IPC abuse. */
const MAX_PREVIEW_URL_LENGTH = 2048;
/** A title is display text, not a document. */
const MAX_TITLE_LENGTH = 300;
const MAX_UPLOADER_LENGTH = 120;

/** Structural port the IPC layer talks to (keeps `m5-channels` import-free). */
export interface SubtitlePreviewPort {
  preview(url: unknown): Promise<SubtitlePreviewResult>;
  cancel(previewId: string): Promise<boolean>;
}

export interface SubtitlePreviewLogger {
  info(scope: string, message: string, data?: Record<string, unknown>): Promise<void>;
}

export interface SubtitlePreviewServiceOptions {
  /** Live probe, already bound to the bundled yt-dlp + JS runtime paths. */
  readonly probe: (url: string) => Promise<MediaInfo>;
  /** Injected clock (`CorePorts.clock`) so TTL is testable and timezone-free. */
  readonly clock: Pick<ClockPort, 'nowIso' | 'nowEpochMs'>;
  /** Opaque id source; production passes `crypto.randomUUID`. */
  readonly newId: () => string;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly logger?: SubtitlePreviewLogger;
}

/**
 * http(s) only, trimmed, bounded.
 *
 * Reuses the engine's whitelist rather than a second regex: that one already
 * rejects `file://`, UNC paths, drive letters, embedded credentials, control
 * characters and schemeless input — the exact set a probe must never receive.
 */
export function normalizePreviewUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > MAX_PREVIEW_URL_LENGTH) return null;
  try {
    assertHttpUrl(value);
  } catch {
    return null;
  }
  return value;
}

function toPreviewDto(entry: SubtitlePreviewEntry, tracks: readonly SubtitleTrackPreview[]): SubtitlePreviewDto {
  const media = entry.media;
  const summary = summarizeSubtitleTracks(tracks);
  return {
    previewId: entry.id,
    media: {
      title: sanitizeDisplayText(media.title, MAX_TITLE_LENGTH) ?? '',
      uploader: sanitizeDisplayText(media.uploader, MAX_UPLOADER_LENGTH),
      durationSec: Number.isFinite(media.duration) ? media.duration : null,
      extractorKey: sanitizeDisplayText(media.extractor_key, 40) ?? '',
    },
    tracks: [...tracks],
    manualLanguages: summary.manualLanguages,
    automaticLanguages: summary.automaticLanguages,
    empty: summary.empty,
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
  };
}

export class SubtitlePreviewService implements SubtitlePreviewPort {
  private readonly options: SubtitlePreviewServiceOptions;
  private readonly cache: SubtitlePreviewCache;
  /**
   * In-flight probes keyed by URL. Two rapid clicks on the same link share ONE
   * yt-dlp process; each caller still receives its own ticket, because sharing
   * a single-use id would break the second caller for no reason.
   */
  private readonly inflight = new Map<string, Promise<MediaInfo>>();

  constructor(options: SubtitlePreviewServiceOptions) {
    this.options = options;
    this.cache = new SubtitlePreviewCache({
      now: () => options.clock.nowEpochMs(),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
  }

  get ttlMs(): number {
    return this.cache.ttlMs;
  }

  /** Live ticket count (diagnostics / tests). */
  get size(): number {
    return this.cache.size;
  }

  /** Probes currently in flight (diagnostics / tests). */
  get pendingProbes(): number {
    return this.inflight.size;
  }

  /** Probe once, project, and hand the renderer an opaque ticket. */
  async preview(rawUrl: unknown): Promise<SubtitlePreviewResult> {
    const url = normalizePreviewUrl(rawUrl);
    if (url === null) {
      return { ok: false, code: 'PREVIEW_INVALID_URL', message: '字幕预览需要合法的 http(s) 链接' };
    }
    let media: MediaInfo;
    try {
      media = await this.probeOnce(url);
    } catch (error) {
      this.reportFailure(error);
      return { ok: false, code: 'PREVIEW_FAILED', message: '字幕信息获取失败，请检查链接或网络后重试' };
    }
    const tracks = collectSubtitleTracks(media);
    const entry = this.cache.put({
      id: this.options.newId(),
      urlKey: url,
      media,
      tracks,
    });
    return { ok: true, preview: toPreviewDto(entry, tracks) };
  }

  /** Release a ticket the user abandoned (URL changed, dialog closed). */
  async cancel(previewId: string): Promise<boolean> {
    return this.cache.cancel(previewId);
  }

  /**
   * Spend a ticket. MAIN PROCESS ONLY — the result carries the full `MediaInfo`
   * (signed URLs included) and must never be returned over IPC.
   *
   * Phase 3 calls this from the enqueue path and writes `consumption.media`
   * into `TaskRecord.mediaInfo`, which is exactly the field the queue checks
   * before its own probe.
   */
  consume(previewId: string, rawUrl: unknown): SubtitlePreviewConsumeResult {
    const url = normalizePreviewUrl(rawUrl);
    if (url === null) return { ok: false, code: 'PREVIEW_INVALID_URL' };
    return toConsumption(this.cache.consume(previewId, url));
  }

  /** Window close / app quit: drop tickets and forget in-flight probes. */
  dispose(): void {
    this.inflight.clear();
    this.cache.clear();
  }

  private probeOnce(url: string): Promise<MediaInfo> {
    const existing = this.inflight.get(url);
    if (existing !== undefined) return existing;
    let pending: Promise<MediaInfo> | null = null;
    pending = (async (): Promise<MediaInfo> => {
      try {
        return await this.options.probe(url);
      } finally {
        if (this.inflight.get(url) === pending) this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, pending);
    return pending;
  }

  /**
   * Log the failure WITHOUT the message: yt-dlp error text frequently quotes the
   * URL, and the URL may carry a token. Only a stable code is recorded.
   */
  private reportFailure(error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    const bucket = typeof code === 'string' ? code : 'UNKNOWN';
    const logger = this.options.logger;
    if (logger === undefined) return;
    void logger.info('subtitle-preview', 'preview failed', { code: bucket }).catch(() => undefined);
  }
}

export function createSubtitlePreviewService(
  options: SubtitlePreviewServiceOptions,
): SubtitlePreviewService {
  return new SubtitlePreviewService(options);
}
