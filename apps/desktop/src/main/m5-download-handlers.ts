/**
 * M5 download/import-domain IPC handlers (task 4, mechanical extraction from
 * `m5-channels.ts`): DOWNLOAD_START (the D-69/D-83 entry with the D-134 §3.4
 * site gate and the stage-3 subtitle ticket spend), the D-129 TXT batch
 * import pair and the D-130 playlist preview/batch trio.
 *
 * The handler bodies are VERBATIM. The pre-check cancellation scope is NOT
 * rebuilt here: register/finish/progress come from the shared `ctx.precheck`
 * closure created once by `createM5Handlers` (D-160 invariant — one scope
 * registry per host, shared with the site domain and its CANCEL/STATUS).
 */
import { IPC_CHANNELS, MAX_PLAYLIST_ITEMS, blocksEnqueue } from '@ytvdlt/shared';
import type {
  DownloadKind, PlaylistBatchEnqueueDto, PlaylistInfo, PlaylistPrecheckReport,
  PlaylistPreviewCancelDto, PlaylistPreviewCode, PlaylistPreviewDto,
  SubtitleDomain,
} from '@ytvdlt/shared';
import { MAX_SUBTITLE_LANGUAGES, mergeSubtitleChoice, normalizeLanguageCode } from '@ytvdlt/core';
import type { SubtitleChoice } from '@ytvdlt/core';
import { assertPreviewId, MAX_URL_CHARS, validateM5Payload } from './m5-contracts.js';
import type { M5HandlerContext, M5Handler, M5HandlerMap } from './m5-channels.js';
import type { AudioFormatChoice, AudioQualityChoice, M5ChannelDeps, VideoQualityChoice } from './m5-channels.js';
import type { TxtImportEnqueueDto, TxtImportPickDto } from './txt-import-service.js';
import { isPrivateDirUnresolvableError, PRIVATE_DIR_UNRESOLVABLE } from './m4-host.js';
import { failedPlaylistPreview, isPlaylistEntryAvailable } from './playlist-preview-service.js';
import { blockedEntriesByUrl, precheckBatch } from './site-precheck-gate.js';

/** D-83: the renderer may only pick values the plan layer already understands. */
const VIDEO_QUALITY_VALUES: readonly string[] = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p', 'lowest'];
const AUDIO_QUALITY_VALUES: readonly string[] = ['best', '192', '128', '64', '32', 'lowest'];
const AUDIO_FORMAT_VALUES: readonly string[] = ['auto', 'mp3', 'm4a'];

/** Stage 3: the only conversion targets the bundled yt-dlp accepts. */
const SUBTITLE_CONVERT_VALUES: readonly string[] = ['none', 'ass', 'srt', 'vtt', 'lrc'];

/**
 * Stage 3: why an enqueue was refused. Stable codes only — the renderer owns
 * the sentence (same rule as D-109); `reason` is a fallback for old UIs.
 */
const SUBTITLE_REJECT_REASONS: Readonly<Record<string, string>> = {
  PREVIEW_REQUIRED: '选择字幕前需要先获取字幕列表',
  PREVIEW_UNAVAILABLE: '当前构建未启用字幕预览',
  PREVIEW_EXPIRED: '字幕预览已过期，请重新获取',
  PREVIEW_CONSUMED: '字幕预览已被使用，请重新获取',
  PREVIEW_URL_MISMATCH: '字幕预览与当前链接不匹配',
  PREVIEW_UNKNOWN: '字幕预览不存在或已取消',
  SUBTITLE_NO_MANUAL_TRACK: '所选语言含仅自动字幕，请启用自动字幕或移除这些语言',
  SUBTITLE_LANGUAGE_UNKNOWN: '所选字幕语言不在该视频的字幕列表中',
  SUBTITLE_EMBED_UNSUPPORTED: '音频任务不能内嵌字幕',
};

/** Config defaults for the subtitle domain (partial: missing keys stay default). */
function readSubtitleDefaults(deps: Pick<M5ChannelDeps, 'config'>): Partial<SubtitleDomain> {
  return deps.config.getDomain('subtitle') as unknown as Partial<SubtitleDomain>;
}

/**
 * Stage 3: read the per-task subtitle intent from the validated payload.
 *
 * Shape errors (a string where an array belongs, an unknown conversion target,
 * 13 languages) are protocol failures and throw, exactly like the existing
 * quality enums. Cross-field rules that a user can actually hit (embedding in
 * audio mode, unknown language) are handled by the caller as business refusals.
 */
function readSubtitleChoice(record: Record<string, unknown>): SubtitleChoice | null {
  const keys = [
    'subtitleLanguages', 'subtitleAutoCaptions', 'subtitleConvertTo',
    'subtitleEmbed', 'subtitleKeepFile',
  ];
  if (!keys.some((key) => record[key] !== undefined)) return null;

  const raw = record['subtitleLanguages'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('[m5-ipc] subtitleLanguages must be a non-empty array');
  }
  if (raw.length > MAX_SUBTITLE_LANGUAGES) {
    throw new Error(`[m5-ipc] subtitleLanguages exceeds ${MAX_SUBTITLE_LANGUAGES} entries`);
  }
  const languages: string[] = [];
  for (const item of raw) {
    // Same rule as the projection: a real yt-dlp code, not a glob and not junk.
    const code = normalizeLanguageCode(item);
    if (code === null) throw new Error('[m5-ipc] invalid subtitle language code');
    languages.push(code);
  }
  const convertTo = record['subtitleConvertTo'] ?? 'none';
  if (!SUBTITLE_CONVERT_VALUES.includes(String(convertTo))) {
    throw new Error('[m5-ipc] invalid subtitleConvertTo');
  }
  const flag = (key: string): boolean => {
    const value = record[key];
    if (value === undefined) return false;
    if (typeof value !== 'boolean') throw new Error(`[m5-ipc] ${key} must be a boolean`);
    return value;
  };
  return {
    languages,
    includeAutomatic: flag('subtitleAutoCaptions'),
    convertTo: convertTo as SubtitleDomain['convertTo'],
    embed: flag('subtitleEmbed'),
    keepSubtitleFile: flag('subtitleKeepFile'),
  };
}

/** Opaque, main-process-issued import ticket. */
const IMPORT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** `crypto.randomUUID()` ids (36 chars) fit this shape. */
const PLAYLIST_PREVIEW_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function createDownloadHandlers(ctx: M5HandlerContext): M5HandlerMap {
  const handlers = new Map<string, M5Handler>();
  const deps = ctx.deps;
  const { readOperationId, registerPrecheck, finishPrecheck, trackBatchProgress } = ctx.precheck;


    // D-69: the real single-video download entry. The renderer (or a smoke test)
  // supplies a plain http(s) URL; no playlist, no fixture channel.
  // D-83: it may also say what to fetch — video resolution preset, audio
  // bitrate, audio container — but only from the three enums above; anything
  // else is rejected instead of silently falling back.
  handlers.set(IPC_CHANNELS.DOWNLOAD_START, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.DOWNLOAD_START, payload);
    const operationId = readOperationId(record);
    const url = record['url'];
    // Same bound as URL_SUPPORT_CHECK: the renderer may not dump an unbounded
    // string into the pre-check, argv, logs or the task snapshot. The error
    // does not echo the value.
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) {
      throw new Error('[m5-ipc] DOWNLOAD_START requires a bounded string url');
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('[m5-ipc] DOWNLOAD_START requires an http(s) url');
    }
    // D-190 / §5 rule 1: an out-of-range enum is a protocol failure, not a
    // silent downgrade to `video`. Same guard TXT_IMPORT_ENQUEUE already had.
    const rawKind = record['kind'];
    if (rawKind !== undefined && rawKind !== 'video' && rawKind !== 'audio') {
      throw new Error('[m5-ipc] invalid kind');
    }
    const kind: DownloadKind = rawKind === 'audio' ? 'audio' : 'video';
    const rawQuality = record['quality'];
    const rawAudioQuality = record['audioQuality'];
    const rawAudioFormat = record['audioFormat'];
    if (rawQuality !== undefined && !VIDEO_QUALITY_VALUES.includes(String(rawQuality))) {
      throw new Error('[m5-ipc] invalid quality');
    }
    if (rawAudioQuality !== undefined && !AUDIO_QUALITY_VALUES.includes(String(rawAudioQuality))) {
      throw new Error('[m5-ipc] invalid audioQuality');
    }
    if (rawAudioFormat !== undefined && !AUDIO_FORMAT_VALUES.includes(String(rawAudioFormat))) {
      throw new Error('[m5-ipc] invalid audioFormat');
    }
    const rawPreviewId = record['previewId'];
    const previewId = rawPreviewId === undefined ? null : assertPreviewId(rawPreviewId);
    const choice = readSubtitleChoice(record);

    const reject = (code: string): Record<string, unknown> => ({
      accepted: false,
      enqueued: false,
      taskIds: [],
      code,
      reason: SUBTITLE_REJECT_REASONS[code] ?? '字幕选择未被接受',
    });

    // R3: audio mode can never embed — refuse before spending the ticket so the
    // user can fix the choice and retry with the same preview.
    if (choice !== null && choice.embed && kind === 'audio') return reject('SUBTITLE_EMBED_UNSUPPORTED');
    if (deps.enqueueSingle === undefined) {
      return { accepted: false, enqueued: false, taskIds: [], reason: '当前构建未启用单视频下载' };
    }

    // ---- D-134 §3.4: the ONE gate that may refuse an enqueue ----------------
    // Runs BEFORE a subtitle ticket is spent, so a refused URL does not burn the
    // user's preview. Only a settled UNSUPPORTED blocks; anything else — a
    // timeout, a network blip, an absent port, our own exception — passes
    // through and lets the download be the authority. The asymmetry is
    // deliberate: a wrong block is unfixable by the user, a wrong pass costs
    // one failed download that the engine then explains accurately.
    // D-137 (F-06/F-07): keep the verdict so a NON-blocking outcome can also
    // be explained to the user. `blocks` is still computed HERE from the frozen
    // predicate — the renderer never decides what counts as unsupported.
    let supportVerdict: { readonly state: string; readonly extractor: string } | null = null;
    // T5: the gate check is cancellable. A cancellation is the user saying
    // "stop", NOT the gate misjudging the link, so the run answers
    // `PRECHECK_CANCELLED` BEFORE any ticket is spent and BEFORE any task is
    // created — enqueue must not happen behind the user's back.
    if (deps.siteSupport !== undefined && deps.siteSupport.available) {
      // T5: register ONLY when a check actually runs. Registering outside this
      // branch left a controller in the cancel set for every DOWNLOAD_START on
      // a build without the capability — the set grew without bound and a
      // later CANCEL falsely claimed it had stopped something.
      const precheckController = registerPrecheck(operationId);
      try {
        const verdict = await deps.siteSupport.check(url, false, precheckController.signal)
          .catch(() => null);
        if (verdict !== null) {
          supportVerdict = { state: verdict.state, extractor: verdict.extractor };
          if (precheckController.signal.aborted) {
            return {
              accepted: false,
              enqueued: false,
              taskIds: [],
              code: 'PRECHECK_CANCELLED',
              cancelled: true,
              // No sentence from the main process: the renderer resolves
              // `code` in the active locale (same rule as the blocks below).
              reason: 'The pre-check was cancelled',
              support: {
                state: verdict.state,
                extractor: verdict.extractor,
                blocks: false,
              },
            };
          }
          if (blocksEnqueue(verdict.state)) {
            return {
              accepted: false,
              enqueued: false,
              taskIds: [],
              code: verdict.extractor === '' ? 'SITE_UNSUPPORTED' : 'ITEM_UNSUPPORTED',
              // No stderr, no argv, no cookie. English is only a FALLBACK for an
              // older UI: the current renderer resolves `code` in the active
              // locale, so an English page no longer shows a Chinese sentence.
              reason: 'This link or site is not supported by the download engine',
              support: {
                state: verdict.state,
                extractor: verdict.extractor,
                blocks: true,
              },
            };
          }
        }
      } finally {
        finishPrecheck(operationId, precheckController);
      }
    }

    // ---- Stage 3: spend the preview ticket exactly once ---------------------
    // The ticket is OPTIONAL for a plain download (it only saves the queue's own
    // probe). It is MANDATORY for a subtitle choice: the languages must be
    // checked against a probe the main process actually ran, never against what
    // the page claims. `consume()` is single-use and URL-bound, so a stale or
    // borrowed id cannot describe another video.
    const consumed = previewId !== null && deps.subtitlePreview !== undefined
      ? deps.subtitlePreview.consume(previewId, url)
      : null;
    if (choice !== null) {
      if (deps.subtitlePreview === undefined) return reject('PREVIEW_UNAVAILABLE');
      if (consumed === null || !consumed.ok) {
        return reject(consumed === null ? 'PREVIEW_REQUIRED' : consumed.code);
      }
    }
    const consumption = consumed !== null && consumed.ok ? consumed.consumption : null;
    let subtitlePatch: Partial<SubtitleDomain> | undefined;
    if (choice !== null && consumption !== null) {
      const merged = mergeSubtitleChoice({
        choice,
        available: consumption.tracks,
        current: readSubtitleDefaults(deps),
        mode: kind === 'audio' ? 'audio' : 'video',
      });
      if (!merged.usable) return reject(merged.warnings.some((warning) => warning.code === 'SUBTITLE_NO_MANUAL_TRACK')
        ? 'SUBTITLE_NO_MANUAL_TRACK' : 'SUBTITLE_LANGUAGE_UNKNOWN');
      subtitlePatch = merged.patch;
    }

    // D-254: an unresolvable private-output directory is a REFUSAL, not a crash.
    // The intake (m4 readDefaults) throws the tagged error before any request
    // exists; answer here in the SAME normalized shape as the pre-check
    // refusals above, so the renderer shows the Chinese reason instead of a
    // raw `IPC_ERROR` rejection with an Electron-prefixed sentence.
    let taskIds: readonly string[];
    try {
      taskIds = await deps.enqueueSingle({
        url,
        kind,
        // A video resolution says nothing about an audio task (and vice versa),
        // so each field is only forwarded to the mode that consumes it.
        ...(kind === 'video' && rawQuality !== undefined
          ? { quality: rawQuality as VideoQualityChoice } : {}),
        ...(kind === 'audio' && rawAudioQuality !== undefined
          ? { audioQuality: rawAudioQuality as AudioQualityChoice } : {}),
        ...(kind === 'audio' && rawAudioFormat !== undefined
          ? { audioFormat: rawAudioFormat as AudioFormatChoice } : {}),
        ...(subtitlePatch === undefined ? {} : { subtitlePatch }),
        // Requirement 13 (phase 2): the already-probed MediaInfo travels with the
        // enqueue, so TaskQueue does NOT probe a second time.
        ...(consumption === null ? {} : { mediaInfo: consumption.media }),
      });
    } catch (error) {
      if (!isPrivateDirUnresolvableError(error)) throw error;
      return {
        accepted: false, enqueued: false, taskIds: [],
        code: PRIVATE_DIR_UNRESOLVABLE, reason: error.message,
      };
    }
    return {
      accepted: true, enqueued: taskIds.length > 0, taskIds,
      // D-137: fail-open outcomes are NOT silent any more. The page can say
      // "未确认，仍已加入队列" in its own language instead of implying that a
      // pre-check blessed the link. Absent when no pre-check ran.
      ...(supportVerdict === null ? {} : { support: {
        state: supportVerdict.state,
        extractor: supportVerdict.extractor,
        blocks: false,
      } }),
    };
  });

  // ---- TXT batch import ----------------------------------------------------
  // The service owns the native picker, the file read, the parse, the ticket
  // store and the real enqueue. This layer only validates the wire shape and
  // refuses unknown keys, so no renderer can name a local path or inject a URL.
  const txtUnavailablePick = (): TxtImportPickDto => ({
    ok: false, canceled: false, code: 'TXT_IMPORT_UNAVAILABLE',
    fileName: '', importId: '', totalLines: 0, blankCount: 0,
    validCount: 0, invalidCount: 0, duplicateCount: 0, playlistCount: 0,
    items: [], maxUrls: 0,
  });
  const txtUnavailableEnqueue = (): TxtImportEnqueueDto => ({
    ok: false, code: 'TXT_IMPORT_UNAVAILABLE', requested: 0, enqueued: 0,
    failed: 0, taskIds: [], failures: [],
  });

  handlers.set(IPC_CHANNELS.TXT_IMPORT_PICK, async (payload): Promise<TxtImportPickDto> => {
    validateM5Payload(IPC_CHANNELS.TXT_IMPORT_PICK, payload);
    return deps.txtImport === undefined
      ? txtUnavailablePick()
      : deps.txtImport.pick();
  });

  handlers.set(IPC_CHANNELS.TXT_IMPORT_ENQUEUE, async (payload): Promise<TxtImportEnqueueDto> => {
    const record = validateM5Payload(IPC_CHANNELS.TXT_IMPORT_ENQUEUE, payload);
    const operationId = readOperationId(record);
    const importId = record['importId'];
    if (typeof importId !== 'string' || !IMPORT_ID_RE.test(importId)) {
      throw new Error('[m5-ipc] invalid importId');
    }
    const rawKind = record['kind'];
    // §5 rule 1: an out-of-range enum is a protocol failure, not a silent
    // downgrade to `video`. The other three enums already followed this rule;
    // `kind` was the one gap in the new D-129 channel.
    if (rawKind !== undefined && rawKind !== 'video' && rawKind !== 'audio') {
      throw new Error('[m5-ipc] invalid kind');
    }
    const rawQuality = record['quality'];
    const rawAudioQuality = record['audioQuality'];
    const rawAudioFormat = record['audioFormat'];
    if (rawQuality !== undefined && !VIDEO_QUALITY_VALUES.includes(String(rawQuality))) {
      throw new Error('[m5-ipc] invalid quality');
    }
    if (rawAudioQuality !== undefined && !AUDIO_QUALITY_VALUES.includes(String(rawAudioQuality))) {
      throw new Error('[m5-ipc] invalid audioQuality');
    }
    if (rawAudioFormat !== undefined && !AUDIO_FORMAT_VALUES.includes(String(rawAudioFormat))) {
      throw new Error('[m5-ipc] invalid audioFormat');
    }
    if (deps.txtImport === undefined) return txtUnavailableEnqueue();
    // T5: the batch pre-check runs inside the service (the renderer never sees
    // these URLs, D-129), so the cancellation and the progress plumbing are
    // handed THROUGH the service into `precheckBatch`.
    const controller = registerPrecheck(operationId);
    try {
      return await deps.txtImport.enqueue({
        importId,
        kind: rawKind === 'audio' ? 'audio' : 'video',
        ...(rawQuality === undefined ? {} : { quality: rawQuality as VideoQualityChoice }),
        ...(rawAudioQuality === undefined ? {} : { audioQuality: rawAudioQuality as AudioQualityChoice }),
        ...(rawAudioFormat === undefined ? {} : { audioFormat: rawAudioFormat as AudioFormatChoice }),
        precheckSignal: controller.signal,
        onPrecheckProgress: trackBatchProgress(operationId, controller),
      });
    } finally {
      finishPrecheck(operationId, controller);
    }
  });

  // ---- Playlist batch import (live probe + single-use ticket) -------------
  const playlistEnqueueUnavailable = (code: PlaylistPreviewCode): PlaylistBatchEnqueueDto => ({
    ok: false, code, requested: 0, enqueued: 0, failed: 0, taskIds: [], failures: [],
  });

  /**
   * T5: the reply for a batch the user cancelled mid-pre-check. `code` +
   * `cancelled` let the dialog say "cancelled, nothing was queued" instead of
   * counting the run as a gate refusal (a CANCELLED verdict never blocks — the
   * user simply said stop). `failed` counts only REAL pre-check refusals that
   * happened before the cancel; the rest were never examined.
   */
  const cancelledPlaylistEnqueue = (
    requested: number,
    extra: {
      readonly failures?: readonly { readonly id: string; readonly reason: string }[];
      readonly precheck?: PlaylistPrecheckReport;
    } = {},
  ): PlaylistBatchEnqueueDto => ({
    ok: false,
    code: 'PRECHECK_CANCELLED',
    cancelled: true,
    requested,
    enqueued: 0,
    failed: extra.failures?.length ?? 0,
    taskIds: [],
    failures: extra.failures === undefined ? [] : [...extra.failures],
    ...(extra.precheck === undefined ? {} : { precheck: extra.precheck }),
  });

  handlers.set(IPC_CHANNELS.PLAYLIST_PREVIEW, async (payload): Promise<PlaylistPreviewDto> => {
    const record = validateM5Payload(IPC_CHANNELS.PLAYLIST_PREVIEW, payload);
    const previous = record['previousPreviewId'];
    if (previous !== undefined && typeof previous !== 'string') {
      throw new Error('[m5-ipc] previousPreviewId must be a string');
    }
    if (typeof previous === 'string' && previous !== '' && !PLAYLIST_PREVIEW_ID_RE.test(previous)) {
      throw new Error('[m5-ipc] invalid previousPreviewId');
    }
    if (deps.playlistPreview === undefined) return failedPlaylistPreview('PREVIEW_UNAVAILABLE');
    return deps.playlistPreview.preview(
      record['url'], typeof previous === 'string' ? previous : undefined,
    );
  });

  handlers.set(IPC_CHANNELS.PLAYLIST_PREVIEW_CANCEL, async (payload): Promise<PlaylistPreviewCancelDto> => {
    const record = validateM5Payload(IPC_CHANNELS.PLAYLIST_PREVIEW_CANCEL, payload);
    const previewId = record['previewId'];
    if (typeof previewId !== 'string' || !PLAYLIST_PREVIEW_ID_RE.test(previewId)) {
      throw new Error('[m5-ipc] invalid previewId');
    }
    if (deps.playlistPreview === undefined) return { ok: false };
    return { ok: await deps.playlistPreview.cancel(previewId) };
  });

  handlers.set(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE, async (payload): Promise<PlaylistBatchEnqueueDto> => {
    const record = validateM5Payload(IPC_CHANNELS.PLAYLIST_BATCH_ENQUEUE, payload);
    const operationId = readOperationId(record);
    const previewId = record['previewId'];
    if (typeof previewId !== 'string' || !PLAYLIST_PREVIEW_ID_RE.test(previewId)) {
      throw new Error('[m5-ipc] invalid previewId');
    }
    const url = record['url'];
    if (typeof url !== 'string' || url.length > 2000 || !/^https?:\/\//i.test(url)) {
      throw new Error('[m5-ipc] invalid playlist url');
    }
    const rawIds = record['selectedIds'];
    if (rawIds !== undefined) {
      if (!Array.isArray(rawIds)) throw new Error('[m5-ipc] selectedIds must be an array');
      if (rawIds.length > MAX_PLAYLIST_ITEMS) {
        throw new Error(`[m5-ipc] selectedIds exceeds ${MAX_PLAYLIST_ITEMS} items`);
      }
      for (const id of rawIds) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
          throw new Error('[m5-ipc] invalid selectedIds entry');
        }
      }
    }
    // D-190 / §5 rule 1: same strict `kind` enum guard as DOWNLOAD_START and
    // TXT_IMPORT_ENQUEUE; an invalid value must not silently become `video`.
    const rawKind = record['kind'];
    if (rawKind !== undefined && rawKind !== 'video' && rawKind !== 'audio') {
      throw new Error('[m5-ipc] invalid kind');
    }
    const rawQuality = record['quality'];
    const rawAudioQuality = record['audioQuality'];
    const rawAudioFormat = record['audioFormat'];
    if (rawQuality !== undefined && !VIDEO_QUALITY_VALUES.includes(String(rawQuality))) {
      throw new Error('[m5-ipc] invalid quality');
    }
    if (rawAudioQuality !== undefined && !AUDIO_QUALITY_VALUES.includes(String(rawAudioQuality))) {
      throw new Error('[m5-ipc] invalid audioQuality');
    }
    if (rawAudioFormat !== undefined && !AUDIO_FORMAT_VALUES.includes(String(rawAudioFormat))) {
      throw new Error('[m5-ipc] invalid audioFormat');
    }
    if (deps.playlistPreview === undefined || deps.playlistBatch === undefined) {
      return playlistEnqueueUnavailable('PREVIEW_UNAVAILABLE');
    }
    // T5: the batch pre-check below is cancellable; every exit from here on
    // unregisters the controller. Read through a lambda: the flag flips while
    // the pre-check awaits, and a fresh call per check avoids stale narrowing.
    const precheckController = registerPrecheck(operationId);
    const precheckCancelled = (): boolean => precheckController.signal.aborted;
    try {
    // An explicit empty selection is refused BEFORE spending the ticket.
    if (Array.isArray(rawIds) && rawIds.length === 0) {
      return playlistEnqueueUnavailable('EMPTY_SELECTION');
    }
    // T5: a cancel that arrived before the ticket was spent means "stop" — the
    // ticket is NOT consumed, so the user can confirm the same preview again.
    // `requested` counts only what the request named explicitly (the "download
    // all" default is resolved from the ticket below, which this path never
    // touched) — the `cancelled` flag is what the dialog actually reports.
    if (precheckCancelled()) {
      return cancelledPlaylistEnqueue(Array.isArray(rawIds) ? rawIds.length : 0);
    }
    const consumed = deps.playlistPreview.consume(previewId, url);
    if (!consumed.ok || consumed.playlist === undefined) {
      return playlistEnqueueUnavailable(consumed.code === '' ? 'PREVIEW_UNKNOWN' : consumed.code);
    }
    const playlist: PlaylistInfo = consumed.playlist;
    // No ids = "download all", resolved in the MAIN process from the cached
    // probe. The renderer can never submit a PlaylistInfo of its own.
    const selected: readonly string[] = rawIds === undefined
      ? playlist.entries.filter(isPlaylistEntryAvailable).map((entry) => entry.id).slice(0, MAX_PLAYLIST_ITEMS)
      : rawIds as readonly string[];
    if (selected.length === 0) return playlistEnqueueUnavailable('EMPTY_SELECTION');

    // ---- D-134 §3.4: pre-check the SELECTED entries -------------------------
    // Per ENTRY, not per playlist: §3.1's rule is that one dead item must never
    // condemn the whole collection. Entry URLs exist only in this
    // main-process-private `PlaylistInfo`, which is why this runs here rather
    // than in the page. Only a settled UNSUPPORTED removes an entry, and it is
    // reported as an ordinary per-item failure so the batch still runs for the
    // rest — with the counts staying honest.
    const entryUrlOf = new Map<string, string>();
    for (const entry of playlist.entries) {
      if (typeof entry.url === 'string' && entry.url !== '') entryUrlOf.set(entry.id, entry.url);
    }
    let enqueueIds: readonly string[] = selected;
    const precheckFailures: { id: string; reason: string }[] = [];
    // R1-03: the tally the dialog reports back. Undefined when this build has no
    // pre-check port, so an absent tally can never be read as "all supported".
    let playlistPrecheck: PlaylistPrecheckReport | undefined;
    if (deps.siteSupport !== undefined && deps.siteSupport.available) {
      const withUrl = selected.filter((id) => entryUrlOf.has(id));
      const outcome = await precheckBatch(
        withUrl.map((id) => entryUrlOf.get(id) as string),
        deps.siteSupport,
        // T5: the batch is cancellable and reports line-wise progress to the
        // STATUS probe the dialogs poll.
        { signal: precheckController.signal, onProgress: trackBatchProgress(operationId, precheckController) },
      );
      // T5: the user cancelled the pre-check — nothing may be enqueued. The
      // preview ticket has already been consumed above (the pre-check needs the
      // entry URLs only the cached PlaylistInfo holds), so a retry needs a
      // fresh preview; the `cancelled` flag makes the dialog say so instead of
      // counting this as a gate refusal.
      if (precheckCancelled()) {
        return cancelledPlaylistEnqueue(selected.length, {
          failures: precheckFailures,
          ...(playlistPrecheck === undefined ? {} : { precheck: playlistPrecheck }),
        });
      }
      const stillAllowed = new Set(outcome.allowed);
      // D-137: ONE url can appear on SEVERAL entries. The old `find()` reported
      // a single id while the filter below removes EVERY id with that url, so
      // the batch silently lost entries and under-reported `failed`.
      for (const item of blockedEntriesByUrl(
        withUrl, (id) => entryUrlOf.get(id), outcome.blocked,
      )) {
        precheckFailures.push({ id: item.entry, reason: item.code });
      }
      // Ids, never URLs: the DTO is display-safe by contract (playlist-preview.ts).
      const idsForUrls = (urls: readonly string[]): string[] =>
        withUrl.filter((id) => urls.includes(entryUrlOf.get(id) as string));
      const summary = outcome.summary;
      playlistPrecheck = {
        examined: summary.examined,
        supported: summary.supported,
        unsupported: summary.unsupported,
        noMedia: summary.noMedia,
        indeterminate: summary.indeterminate,
        // Entries with no URL of their own are not checkable at all, so they are
        // reported as NOT CHECKED next to the budget-skipped ones: folding them
        // into any other bucket would inflate a number the user is reconciling
        // against `requested`.
        skipped: summary.skipped + (selected.length - withUrl.length),
        unsupportedIds: idsForUrls(summary.unsupportedUrls),
        noMediaIds: idsForUrls(summary.noMediaUrls),
        indeterminateIds: idsForUrls(summary.indeterminateUrls),
      };
      enqueueIds = selected.filter((id) => {
        const url = entryUrlOf.get(id);
        // An entry with no URL of its own is already handled downstream as
        // unavailable; it is not this gate's business.
        return url === undefined ? true : stillAllowed.has(url);
      });
    }
    if (enqueueIds.length === 0) {
      // Every selected entry was refused by the pre-check. Reported as a real
      // batch outcome WITH the per-entry reasons — collapsing this into
      // `EMPTY_SELECTION` would tell the user they picked nothing, which is the
      // opposite of what happened.
      return {
        ok: false,
        code: 'ENQUEUE_FAILED',
        requested: precheckFailures.length,
        enqueued: 0,
        failed: precheckFailures.length,
        taskIds: [],
        failures: precheckFailures,
        ...(playlistPrecheck === undefined ? {} : { precheck: playlistPrecheck }),
      };
    }

    const report = await deps.playlistBatch({
      selectedIds: enqueueIds,
      playlistUrl: url,
      kind: rawKind === 'audio' ? 'audio' : 'video',
      playlist,
      ...(rawQuality === undefined ? {} : { quality: rawQuality as VideoQualityChoice }),
      ...(rawAudioQuality === undefined ? {} : { audioQuality: rawAudioQuality as AudioQualityChoice }),
      ...(rawAudioFormat === undefined ? {} : { audioFormat: rawAudioFormat as AudioFormatChoice }),
    });
    const failures = [...precheckFailures, ...report.failures];
    return {
      ok: failures.length === 0 && report.enqueued > 0,
      code: failures.length === 0 ? '' : (report.enqueued > 0 ? 'PARTIAL_SUCCESS' : 'ENQUEUE_FAILED'),
      requested: report.requested + precheckFailures.length,
      enqueued: report.enqueued,
      failed: report.failed + precheckFailures.length,
      taskIds: report.taskIds,
      failures,
      ...(playlistPrecheck === undefined ? {} : { precheck: playlistPrecheck }),
    };
    } finally {
      // T5: the controller is unregistered on EVERY exit, including the cancel
      // returns above, so the cancel set never holds a finished check.
      finishPrecheck(operationId, precheckController);
    }
  });

  return handlers;
}
