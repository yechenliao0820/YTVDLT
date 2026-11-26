/**
 * M5 IPC contracts (task 3, low-risk pure-logic extraction).
 *
 * Extracted VERBATIM from `m5-channels.ts` — the payload whitelist, the M5
 * channel list, the URL-free task DTO projections and the trash-outcome
 * normalisation. Pure logic only: no ports, no `electron`, no `node:*`, no
 * timers, no closure state — every function here maps or validates its
 * arguments and nothing else. `m5-channels.ts` re-exports everything under
 * the ORIGINAL import path, so `m5-host`, `main/index` and the 16 test files
 * that deep-import from `m5-channels.js` keep their exact old surface.
 */
import { IPC_CHANNELS } from '@ytvdlt/shared';
import type { SubtitleArtifactSource, SubtitleOutcome, TaskRecord } from '@ytvdlt/shared';
import { classifyFailure, maskUrlSecrets } from '@ytvdlt/core';
import type { FailureKind } from '@ytvdlt/core';
import type { LocalFileState, LocalFileStatus as FileStatusBucket } from './local-file-status.js';

/**
 * D-120: one answer per requested path, so "already gone" can never be
 * mistaken for "could not be deleted".
 *
 *   trashed — existed and was moved to the OS recycle bin
 *   missing — ENOENT/ENOTDIR: local cleanup is already complete (idempotent)
 *   error   — a real failure (locked, no permission, volume unavailable…)
 *
 * Legacy adapters may still return plain path strings; those count as
 * `trashed`, preserving the D-87 contract and every existing fake port.
 */
export type TrashFileStatus = 'trashed' | 'missing' | 'error';

export interface TrashFileOutcome {
  readonly path: string;
  readonly status: TrashFileStatus;
  /** The real OS reason; only present for `error`, never a guessed cause. */
  readonly reason?: string;
}

/** Normalise D-87 string replies and D-120 structured replies into one shape. */
export function normalizeTrashOutcomes(
  results: readonly (string | TrashFileOutcome)[],
): readonly TrashFileOutcome[] {
  return results.map((entry) => (typeof entry === 'string'
    ? { path: entry, status: 'trashed' as const }
    : entry));
}

/** Windows path equality: case-insensitive, slash-insensitive. */
export function samePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

const PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  // D-120: `refreshFileStatus` only asks for a fresh stat; it grants no path
  // access and cannot widen any deletion.
  [IPC_CHANNELS.TASK_LIST]: ['tab', 'query', 'refreshFileStatus'],
  [IPC_CHANNELS.TASK_DETAIL]: ['taskId'],
  // D-87: `withFiles: true` asks the host to recycle the task's artifacts
  // before removing the record. Only valid together with `action: 'remove'`.
  [IPC_CHANNELS.TASK_ACTION]: ['taskId', 'action', 'withFiles'],
  [IPC_CHANNELS.TEMPLATE_LIST]: [],
  [IPC_CHANNELS.TEMPLATE_SAVE]: ['id', 'name', 'args'],
  [IPC_CHANNELS.TEMPLATE_DELETE]: ['id'],
  [IPC_CHANNELS.SETTINGS_GET]: [],
  [IPC_CHANNELS.SETTINGS_SET]: [
    'theme', 'accent', 'motion', 'language', 'privateMode',
    'autoCheckAppUpdate', 'autoCheckEngineUpdate', 'autostart',
    // D-286: installer cleanup after a successful update.
    'autoCleanUpdateInstaller',
  ],
  [IPC_CHANNELS.COMPONENT_STATUS]: [],
  [IPC_CHANNELS.COMPONENT_UPDATE]: [],
  [IPC_CHANNELS.COMPONENT_CHECK]: [],
  [IPC_CHANNELS.APP_UPDATE_STATUS]: [],
  [IPC_CHANNELS.APP_UPDATE_ACTION]: ['action'],
  [IPC_CHANNELS.PATH_ACTION]: ['action', 'kind'],
  [IPC_CHANNELS.DOWNLOAD_START]: [
    'url', 'kind', 'quality', 'audioQuality', 'audioFormat',
    // D-160: opaque id of THIS user submission; the main process binds every
    // pre-check controller of the submission to it. Not a URL / path / ticket.
    'operationId',
    // Stage 3: the subtitle ticket + the per-task subtitle intent. Flat keys on
    // purpose — `validateM5Payload` only sees the top level, so a nested
    // `subtitle: {...}` object would smuggle unvalidated fields past it.
    'previewId', 'subtitleLanguages', 'subtitleAutoCaptions',
    'subtitleConvertTo', 'subtitleEmbed', 'subtitleKeepFile',
  ],
  // D-103: the renderer may read occupancy, ask for a manual prune, or change
  // two policy values. It can NEVER pass a file path to this channel.
  [IPC_CHANNELS.THUMBNAIL_CACHE]: ['action', 'enabled', 'maxBytes'],
  // D-114: read-only identity; no input at all.
  [IPC_CHANNELS.APP_INFO]: [],
  // Subtitle preview (stage 2): a link, plus the ticket it replaces (optional).
  // Deliberately NOT accepted: mediaInfo, tracks, formats, paths, argv — the
  // renderer proposes a URL, the main process decides what may be known about
  // it. `previousPreviewId` only releases the superseded ticket.
  [IPC_CHANNELS.SUBTITLE_PREVIEW]: ['url', 'previousPreviewId'],
  [IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL]: ['previewId'],
  // TXT import: PICK accepts NOTHING (no path, ever). ENQUEUE accepts an opaque
  // single-use id plus the three download enums — never a URL or a file name.
  [IPC_CHANNELS.TXT_IMPORT_PICK]: [],
  [IPC_CHANNELS.TXT_IMPORT_ENQUEUE]: [
    'importId', 'kind', 'quality', 'audioQuality', 'audioFormat', 'operationId',
  ],
  // Playlist batch import: the renderer may name a URL and a ticket, never a
  // PlaylistInfo, an entry URL, a path or an argv token.
  [IPC_CHANNELS.PLAYLIST_PREVIEW]: ['url', 'previousPreviewId'],
  [IPC_CHANNELS.PLAYLIST_PREVIEW_CANCEL]: ['previewId'],
  [IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE]: [
    'previewId', 'url', 'selectedIds', 'kind', 'quality', 'audioQuality', 'audioFormat',
    'operationId',
  ],
  // D-134: supported-site discovery. LIST takes an optional `refresh` boolean
  // and NOTHING else — the renderer can ask "ask the engine again", never
  // "here is the list". CHECK takes the url being submitted (or, for a batch
  // entry, the one line about to be enqueued) plus an optional `refresh`.
  // Deliberately absent: enginePath, engineVersion, argv, cookies, a format
  // selection, an extractor name — none of them are the renderer's to choose.
  [IPC_CHANNELS.SUPPORTED_SITES]: ['refresh'],
  [IPC_CHANNELS.URL_SUPPORT_CHECK]: ['url', 'refresh', 'operationId'],
  // D-160: CANCEL / STATUS take ONE opaque `operationId` — the id the renderer
  // minted for its own submission. It is NOT a batch id, URL list or preview
  // ticket: the main process only ever cancels / reports the controllers it
  // registered under that exact id, so two live dialogs can no longer stop
  // each other. Omitting the id keeps the LEGACY scope (pre-D-160 callers):
  // such a cancel can only reach controllers that were also registered
  // without an id — never an isolated submission.
  [IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL]: ['operationId'],
  [IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS]: ['operationId'],
  // D-148: CHECK takes NOTHING (same zero-input rule as APP_INFO) so the page
  // cannot forge a frequency decision; ACTION takes ONLY the action enum —
  // never a URL (the repo page is resolved inside the main process).
  [IPC_CHANNELS.STAR_PROMPT_CHECK]: [],
  [IPC_CHANNELS.STAR_PROMPT_ACTION]: ['action'],
  // D-173: exactly ONE key, `text`, and nothing else — no paths, no argv, no
  // html. The value itself is length-capped below.
  [IPC_CHANNELS.CLIPBOARD_WRITE]: ['text'],
};

export function validateM5Payload(channel: string, payload: unknown): Record<string, unknown> {
  const allowed = PAYLOAD_KEYS[channel];
  if (allowed === undefined) throw new Error(`[m5-ipc] unregistered channel: ${channel}`);
  const record = payload ?? {};
  if (typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`[m5-ipc] payload must be an object for ${channel}`);
  }
  for (const key of Object.keys(record as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new Error(`[m5-ipc] payload key not allowed: ${key}`);
  }
  return record as Record<string, unknown>;
}

export interface TaskListItemDto {
  readonly id: string;
  readonly state: string;
  /** D-164: parked in the FIFO; present only when true (old snapshots stay lean). */
  readonly pending?: boolean;
  readonly kind: string;
  readonly title: string;
  readonly uploader: string | null;
  readonly duration: number | null;
  readonly percent: number | null;
  readonly errorCode: string | null;
  /**
   * D-109: stable bucket for the one-line failure brief. `null` when the task
   * holds no error at all; the human sentence is resolved by the renderer from
   * `queue.failure.<kind>`, so switching language needs no new IPC round trip.
   */
  readonly failureKind: FailureKind | null;
  readonly artifactCount: number;
  /** 0.2.1 (D-95): transfer numbers; `null` = unknown, never "zero". */
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly speedBps: number | null;
  readonly etaSec: number | null;
  /**
   * D-115: how far the run has actually got. `null` / absent means "no reliable
   * information" — the renderer then keeps the previous behaviour rather than
   * assuming a merge. Values: `fetching|downloading|merging|postprocess|verifying`.
   */
  readonly stage?: string | null;
  /** 0.2.1 (D-96): absolute local cover path, or null for the letter badge. */
  readonly thumbPath: string | null;
  /**
   * D-120: stable bucket, never a sentence. Absent when the build has no
   * probe or the task is not `Completed` — the renderer then paints nothing.
   * It is a FILE-system observation and must never change the download state.
   */
  readonly fileStatus?: FileStatusBucket | null;
  /** D-120: same buckets for the containing directory (open-folder branch). */
  readonly dirStatus?: FileStatusBucket | null;
  /**
   * Stage 4: how many subtitle files this run produced. Additive; absent on
   * records that predate subtitle artifacts.
   */
  readonly subtitleCount?: number;
  /** Stage 4: requested-vs-produced verdict (`none|ok|partial|missing`). */
  readonly subtitleOutcome?: SubtitleOutcome;
  /** Stage 4: language tags actually produced, in artifact order, de-duplicated. */
  readonly subtitleLanguages?: readonly string[];
}

export interface TaskDetailDto {
  readonly id: string;
  readonly state: string;
  /** D-164: parked in the FIFO; present only when true. */
  readonly pending?: boolean;
  readonly kind: string;
  readonly title: string;
  /** Masked: `token=***REDACTED***`, never the raw signed URL. */
  readonly url: string;
  readonly artifacts: readonly string[];
  readonly percent: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /**
   * Stage 4: subtitle files with their language / format / source. Paths are
   * already exposed through `artifacts`, so this adds no new exposure — it adds
   * the classification the renderer must not try to derive from a file name.
   */
  readonly subtitleFiles?: readonly {
    readonly path: string;
    readonly language: string;
    readonly ext: string;
    readonly source: SubtitleArtifactSource;
  }[];
  readonly subtitleOutcome?: SubtitleOutcome;
}

/** URL-free projection: the list never needs a link to render a card. */
export function toTaskListItem(
  record: TaskRecord,
  thumbnailPath: string | null = null,
  fileState?: LocalFileState,
  pending = false,
): TaskListItemDto {
  return {
    id: record.id,
    state: record.state,
    // D-164: `state` alone cannot express "waiting for a slot" — a parked task
    // is `Idle`, exactly like a restored task that will never start on its own.
    // The UI needs the distinction to offer a cancel that actually works.
    ...(pending ? { pending: true } : {}),
    kind: record.kind,
    title: record.mediaInfo?.title ?? record.id,
    uploader: record.mediaInfo?.uploader ?? null,
    duration: record.mediaInfo?.duration ?? null,
    percent: record.lastPercent,
    errorCode: record.error?.code ?? null,
    // D-109: derived from the stable code only — never from yt-dlp text, and
    // never a localized string (the renderer owns the copy).
    failureKind: record.error === null ? null : classifyFailure(record.error.code),
    artifactCount: record.artifacts.length,
    downloadedBytes: record.lastDownloadedBytes ?? null,
    totalBytes: record.lastTotalBytes ?? null,
    speedBps: record.lastSpeedBps ?? null,
    etaSec: record.lastEtaSec ?? null,
    // D-115: only the queue knows how far the run got; the renderer must not
    // infer a phase from `percent === 100` (two streams each reach 100%).
    stage: record.lastStage ?? null,
    thumbPath: thumbnailPath,
    // D-120: only a real observation is sent. `undefined` keeps old snapshots
    // byte-identical (no invented "all present" state for unprobed builds).
    ...(fileState === undefined ? {} : { fileStatus: fileState.status, dirStatus: fileState.dirStatus }),
    // Stage 4: subtitle bookkeeping is derived from the task's own manifest;
    // absent (not `0`) when the record predates it, so old snapshots keep
    // painting exactly what they painted before.
    ...(record.subtitleFiles === undefined
      ? {}
      : {
        subtitleCount: record.subtitleFiles.length,
        subtitleLanguages: [...new Set(record.subtitleFiles
          .map((file) => file.language)
          .filter((language) => language !== ''))],
        ...(record.subtitleOutcome === undefined ? {} : { subtitleOutcome: record.subtitleOutcome }),
      }),
  };
}

/** Detail view keeps the URL but masked — same rule as the error report. */
export function toTaskDetail(record: TaskRecord, pending = false): TaskDetailDto {
  return {
    id: record.id,
    state: record.state,
    ...(pending ? { pending: true } : {}),
    kind: record.kind,
    title: record.mediaInfo?.title ?? record.id,
    url: maskUrlSecrets(record.url),
    artifacts: [...record.artifacts],
    percent: record.lastPercent,
    errorCode: record.error?.code ?? null,
    errorMessage: record.error?.message ?? null,
    ...(record.subtitleFiles === undefined
      ? {}
      : {
        subtitleFiles: record.subtitleFiles.map((file) => ({
          path: file.path,
          language: file.language,
          ext: file.ext,
          source: file.source,
        })),
      }),
    ...(record.subtitleOutcome === undefined ? {} : { subtitleOutcome: record.subtitleOutcome }),
  };
}

/** Channel list the preload whitelist must expose (asserted by the tests). */
export const M5_CHANNELS: readonly string[] = [
  IPC_CHANNELS.TASK_LIST,
  IPC_CHANNELS.TASK_DETAIL,
  IPC_CHANNELS.TASK_ACTION,
  IPC_CHANNELS.TEMPLATE_LIST,
  IPC_CHANNELS.TEMPLATE_SAVE,
  IPC_CHANNELS.TEMPLATE_DELETE,
  IPC_CHANNELS.SETTINGS_GET,
  IPC_CHANNELS.COMPONENT_STATUS,
  IPC_CHANNELS.COMPONENT_UPDATE,
  IPC_CHANNELS.COMPONENT_CHECK,
  IPC_CHANNELS.APP_UPDATE_STATUS,
  IPC_CHANNELS.APP_UPDATE_ACTION,
  IPC_CHANNELS.PATH_ACTION,
  IPC_CHANNELS.SETTINGS_SET,
  IPC_CHANNELS.DOWNLOAD_START,
  IPC_CHANNELS.THUMBNAIL_CACHE,
  IPC_CHANNELS.APP_INFO,
  // Subtitle preview (stage 2, append-only; the fixture PROBE is untouched).
  IPC_CHANNELS.SUBTITLE_PREVIEW,
  IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL,
  // TXT batch import (append-only).
  IPC_CHANNELS.TXT_IMPORT_PICK,
  IPC_CHANNELS.TXT_IMPORT_ENQUEUE,
  // Playlist batch import (append-only; M3 PLAYLIST_ENQUEUE stays in the
  // fixture gateway and is NOT part of this list).
  IPC_CHANNELS.PLAYLIST_PREVIEW,
  IPC_CHANNELS.PLAYLIST_PREVIEW_CANCEL,
  IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE,
  // D-134 (append-only): supported-site discovery + per-url pre-check.
  IPC_CHANNELS.SUPPORTED_SITES,
  IPC_CHANNELS.URL_SUPPORT_CHECK,
  // T5 (append-only): user-level pre-check cancellation + batch progress.
  IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL,
  IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS,
  // D-148 (append-only): the "Star on GitHub" nudge.
  IPC_CHANNELS.STAR_PROMPT_CHECK,
  IPC_CHANNELS.STAR_PROMPT_ACTION,
  // D-173 (append-only): main-process clipboard write (bounded text only).
  IPC_CHANNELS.CLIPBOARD_WRITE,
];

/** Longest URL the preview endpoint will look at (matches the service). */
export const MAX_PREVIEW_URL_LENGTH = 2048;
/**
 * Longest URL the renderer-submitted download channels accept — ONE shared
 * bound for `DOWNLOAD_START` and `URL_SUPPORT_CHECK`, so the pre-check can
 * never hard-reject a URL the enqueue path would have taken. 4096 UTF-16 code
 * units is ~4x the preview-probe bound and far above any real video or
 * playlist URL (long signed CDN tokens included), yet well below the Windows
 * ~32k-char command-line limit the value later reaches through argv — the cap
 * only bounds what can land in argv, logs and the task snapshot. Counted in
 * code units like `MAX_CLIPBOARD_TEXT_CHARS` (D-173): the string is not
 * decoded or truncated here, and the over-limit rejection never echoes the
 * value back.
 */
export const MAX_URL_CHARS = 4096;
/**
 * Opaque ticket shape. `crypto.randomUUID()` is 36 chars of `[0-9a-f-]`, and
 * the classes stay open enough for a future id scheme while still refusing
 * paths, dots, slashes and anything a caller could mistake for a filename.
 */
export const PREVIEW_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Subtitle preview URL: http(s), trimmed, bounded, printable.
 *
 * This is the transport guard only — the service re-validates with the engine's
 * own whitelist (credentials, host, scheme) before anything is spawned.
 */
export function assertPreviewUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('[m5-ipc] subtitle preview requires a string url');
  const url = value.trim();
  if (url.length === 0 || url.length > MAX_PREVIEW_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new Error('[m5-ipc] invalid subtitle preview url');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('[m5-ipc] subtitle preview requires an http(s) url');
  }
  return url;
}

/** `''` is accepted by the caller as "no previous ticket", never as an id. */
export function assertPreviewId(value: unknown): string {
  if (typeof value !== 'string' || !PREVIEW_ID_RE.test(value)) {
    throw new Error('[m5-ipc] invalid previewId');
  }
  return value;
}
