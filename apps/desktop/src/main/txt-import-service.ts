/**
 * TXT import service — main-process composition, NO `electron` / NO `node:*`.
 *
 * Two channels, one deliberate trust boundary:
 *   PICK    renderer sends NO payload at all (and therefore no path). The
 *           native picker + file read happen in the injected adapter;
 *   ENQUEUE renderer sends ONLY the opaque `importId` plus the existing
 *           download enums. It can never inject an arbitrary URL, so a
 *           compromised page cannot turn this feature into "download anything".
 *
 * The id resolves to a short-lived, single-use, in-memory session holding the
 * validated URLs from THAT pick. Enqueue re-validates every one of them with
 * the same engine whitelist before handing them to `TaskQueue.enqueueBatch()`.
 */
import type { DownloadKind, FormatDomain } from '@ytvdlt/shared';
import {
  parseTxtUrlList, TXT_IMPORT_LIMITS,
  type TxtImportItem, type TxtImportParseResult,
} from '@ytvdlt/core';

/** What the injected native adapter returns; `text` is already decoded UTF-8. */
export interface TxtImportFilePort {
  pick(): Promise<TxtImportFileResult>;
}

export interface TxtImportFileResult {
  readonly canceled: boolean;
  readonly fileName: string;
  readonly text: string;
  /** `''` on success; otherwise a stable machine code (no localized text). */
  readonly code: string;
}

export interface TxtBatchRequest {
  readonly urls: readonly string[];
  readonly kind: DownloadKind;
  readonly quality?: FormatDomain['quality'];
  readonly audioQuality?: FormatDomain['audioQuality'];
  readonly audioFormat?: 'auto' | 'mp3' | 'm4a';
}

/** A failure is identified by URL, so the caller need not track array indices. */
export interface TxtBatchFailure {
  readonly url: string;
  readonly reason: string;
}

export interface TxtBatchResult {
  readonly enqueued: number;
  readonly taskIds: readonly string[];
  readonly failures: readonly TxtBatchFailure[];
}

export interface TxtImportPickDto {
  readonly ok: boolean;
  readonly canceled: boolean;
  /** `''` on success; stable code otherwise. */
  readonly code: string;
  readonly fileName: string;
  /** `''` when the preview is not confirmable (error / no valid URL / limit). */
  readonly importId: string;
  readonly totalLines: number;
  readonly blankCount: number;
  readonly validCount: number;
  readonly invalidCount: number;
  readonly duplicateCount: number;
  readonly playlistCount: number;
  readonly items: readonly TxtImportItem[];
  readonly maxUrls: number;
}

export interface TxtImportEnqueueOptions {
  readonly importId: string;
  readonly kind: DownloadKind;
  readonly quality?: FormatDomain['quality'];
  readonly audioQuality?: FormatDomain['audioQuality'];
  readonly audioFormat?: 'auto' | 'mp3' | 'm4a';
}

export interface TxtImportEnqueueDto {
  readonly ok: boolean;
  readonly code: string;
  /** How many URLs the preview said it would enqueue. */
  readonly requested: number;
  /** How many TaskRecords really reached the queue. */
  readonly enqueued: number;
  /** requested - enqueued. Never rounded up to "all succeeded". */
  readonly failed: number;
  readonly taskIds: readonly string[];
  readonly failures: readonly TxtBatchFailure[];
}

export interface TxtImportServicePort {
  pick(): Promise<TxtImportPickDto>;
  enqueue(options: TxtImportEnqueueOptions): Promise<TxtImportEnqueueDto>;
}

export interface TxtImportServiceOptions {
  readonly pickFile: TxtImportFilePort;
  /** Production: `assertHttpUrl` from `@ytvdlt/engine-ytdlp`. Throws on reject. */
  readonly validateUrl: (raw: string) => void;
  /** Production: `m4.enqueueTxtBatch()` → `TaskQueue.enqueueBatch()`. */
  readonly enqueueBatch: (input: TxtBatchRequest) => Promise<TxtBatchResult>;
  /** Injectable clock/id so the ticket store is deterministic under test. */
  readonly now?: () => number;
  readonly makeId?: () => string;
  readonly sessionTtlMs?: number;
  readonly maxSessions?: number;
}

interface Session {
  readonly urls: readonly string[];
  readonly createdAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 8;
/** Module-level so ids stay unique across independently built services. */
let serviceSeq = 0;

/**
 * Single-use, bounded ticket store. It is NOT a security secret — the
 * renderer cannot supply URLs — but it keeps an old preview from creating a
 * second batch and bounds memory when the user cancels repeatedly.
 */
export class TxtImportSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private seq = 0;

  constructor(options: {
    now?: () => number;
    ttlMs?: number;
    maxSessions?: number;
  } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  }

  private prune(now: number): void {
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs) this.sessions.delete(id);
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
  }

  save(urls: readonly string[], id: string): string {
    const now = this.now();
    this.prune(now);
    this.sessions.set(id, { urls: [...urls], createdAt: now });
    return id;
  }

  /** Returns null for unknown, expired or already-consumed ids. */
  consume(id: string): readonly string[] | null {
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    this.sessions.delete(id);
    if (this.now() - session.createdAt > this.ttlMs) return null;
    return session.urls;
  }

  get size(): number { return this.sessions.size; }
}

export function createTxtImportService(options: TxtImportServiceOptions): TxtImportServicePort {
  const now = options.now ?? (() => Date.now());
  const store = new TxtImportSessionStore({
    now,
    ...(options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
  });
  const defaultMakeId = (): string =>
    `txt-${now().toString(36)}-${(++serviceSeq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const makeId = options.makeId ?? defaultMakeId;

  return {
    async pick(): Promise<TxtImportPickDto> {
      const file = await options.pickFile.pick();
      const base = {
        fileName: file.fileName,
        totalLines: 0, blankCount: 0, validCount: 0, invalidCount: 0,
        duplicateCount: 0, playlistCount: 0,
        items: [] as readonly TxtImportItem[],
        maxUrls: TXT_IMPORT_LIMITS.maxUrls,
      };
      if (file.canceled) {
        return { ok: true, canceled: true, code: '', importId: '', ...base };
      }
      if (file.code !== '') {
        return { ok: false, canceled: false, code: file.code, importId: '', ...base };
      }
      let parsed: TxtImportParseResult;
      try {
        parsed = parseTxtUrlList({ text: file.text, validateUrl: options.validateUrl });
      } catch {
        return { ok: false, canceled: false, code: 'PARSE_FAILED', importId: '', ...base };
      }
      const preview = {
        ...base,
        totalLines: parsed.totalLines,
        blankCount: parsed.blankCount,
        validCount: parsed.validCount,
        invalidCount: parsed.invalidCount,
        duplicateCount: parsed.duplicateCount,
        playlistCount: parsed.playlistCount,
        items: parsed.items,
      };
      // A non-OK parse still ships the REAL counts and URL list. It simply
      // cannot be confirmed: no ticket is issued.
      if (parsed.code !== 'OK' || parsed.urls.length === 0) {
        return {
          ok: parsed.code === 'OK', canceled: false, code: parsed.code,
          importId: '', ...preview,
        };
      }
      const importId = store.save(parsed.urls, makeId());
      return { ok: true, canceled: false, code: '', importId, ...preview };
    },

    async enqueue(input: TxtImportEnqueueOptions): Promise<TxtImportEnqueueDto> {
      const urls = store.consume(input.importId);
      if (urls === null) {
        return {
          ok: false, code: 'IMPORT_EXPIRED', requested: 0, enqueued: 0,
          failed: 0, taskIds: [], failures: [],
        };
      }
      const accepted: string[] = [];
      const failures: TxtBatchFailure[] = [];
      for (const url of urls) {
        try {
          options.validateUrl(url);
          accepted.push(url);
        } catch {
          failures.push({ url, reason: 'INVALID_URL' });
        }
      }
      let result: TxtBatchResult = { enqueued: 0, taskIds: [], failures: [] };
      try {
        result = await options.enqueueBatch({
          urls: accepted,
          kind: input.kind,
          ...(input.quality === undefined ? {} : { quality: input.quality }),
          ...(input.audioQuality === undefined ? {} : { audioQuality: input.audioQuality }),
          ...(input.audioFormat === undefined ? {} : { audioFormat: input.audioFormat }),
        });
      } catch (error) {
        // A thrown batch may still have enqueued some records. Report every
        // un-enqueued URL as a failure instead of claiming a clean total loss.
        failures.push(...accepted.map((url) => ({
          url,
          reason: error instanceof Error ? error.message : String(error),
        })));
      }
      const allFailures = [...failures, ...result.failures];
      const enqueued = result.enqueued;
      return {
        ok: enqueued > 0 && allFailures.length === 0,
        code: enqueued === 0 ? 'ENQUEUE_FAILED' : (allFailures.length === 0 ? '' : 'PARTIAL_SUCCESS'),
        requested: urls.length,
        enqueued,
        failed: Math.max(0, urls.length - enqueued),
        taskIds: result.taskIds,
        failures: allFailures,
      };
    },
  };
}
