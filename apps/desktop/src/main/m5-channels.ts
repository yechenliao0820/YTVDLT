/**
 * M5 IPC surface (M5-0) — the channels the renderer needs beyond M3/M4.
 *
 * Why a separate file: `ipc-gateway.ts` is the M3 fixture-driven gateway
 * (PROBE / dialogs / path preview). M5 adds real services; bolting them into the
 * fixture gateway would couple recorded-JSON parsing with a live task queue.
 * `createM5Host()` composes both.
 *
 * Rules kept from M3:
 *   - every payload is validated against an explicit key whitelist;
 *   - nothing that leaves this layer contains a media/credential URL:
 *     `TASK_LIST` projects a DTO without `url`, `TASK_DETAIL` masks it with
 *     `maskUrlSecrets()` (same rule as the error report, D-32);
 *   - no `electron` / `node:*` import — the services arrive injected.
 */
import { IPC_CHANNELS, MAX_PLAYLIST_ITEMS, blocksEnqueue } from '@ytvdlt/shared';
import type {
  AppUpdateAction, AppUpdateActionResult, AppUpdateState, DownloadKind, FormatDomain, TaskRecord,
  MediaInfo, SubtitleDomain, SubtitlePreviewConsumeResult, SubtitlePreviewResult,
  SubtitleArtifactSource, SubtitleOutcome, PlaylistInfo, PlaylistPreviewCode,
  PlaylistPreviewDto, PlaylistPreviewCancelDto, PlaylistBatchEnqueueDto,
  PlaylistPrecheckReport,
  ExtractorCatalogResult, UrlSupportResult, ExtractorCatalogFailure,
  SupportedSitesDto, UrlSupportCheckDto, SpawnAbortSignal, ISystemStartupPort,
} from '@ytvdlt/shared';
import {
  ACCENT_PRESETS, DEFAULT_PATH_TOKENS, MAX_SUBTITLE_LANGUAGES, STAR_PROMPT_ACTIONS,
  buildTaskListSnapshot, classifyFailure, isPathInsideRoots, maskUrlSecrets, trustedArtifactRoots,
  mergeSubtitleChoice,
  normalizeHexColor, normalizeLanguageCode, normalizeThemeMode, normalizeMotionMode, parseAccent,
  type SubtitleChoice,
} from '@ytvdlt/core';
import type {
  AccentChoice, ClipboardPort, CommandTemplateInput, CommandTemplateStore, IConfigStore,
  FailureKind, MotionMode, TaskDetailAction, TaskDetailResult, TaskTab, ThemeMode,
} from '@ytvdlt/core';
import type { ThumbnailCacheStatus, ThumbnailPruneReport } from './thumbnail-cache.js';
import type {
  LocalFileState, LocalFileStatusPort, LocalFileStatus as FileStatusBucket,
} from './local-file-status.js';
import type {
  TxtImportServicePort, TxtImportEnqueueDto, TxtImportPickDto,
} from './txt-import-service.js';
import {
  failedPlaylistPreview, isPlaylistEntryAvailable,
  type PlaylistPreviewPortLike,
} from './playlist-preview-service.js';
import type { PlaylistBatchReport, PlaylistEnqueueInput } from './m4-host.js';
import { blockedEntriesByUrl, precheckBatch } from './site-precheck-gate.js';
import type { StarPromptPort } from './star-prompt-service.js';

/** Minimal slice of the queue this layer needs (tests inject a fake). */
export interface TaskListPort {
  list(): readonly TaskRecord[];
  get(taskId: string): TaskRecord | undefined;
  /** D-164 (optional): parked in the FIFO waiting for a slot. */
  isPending?(taskId: string): boolean;
}

export interface TaskDetailPort {
  perform(taskId: string, action: TaskDetailAction): Promise<TaskDetailResult>;
}

export interface SystemAppearancePort {
  prefersDark(): boolean;
  prefersReducedMotion(): boolean;
  accent(): string | null;
}

/** D-67: the component-update surface, injected from the main process. */
export interface ComponentUpdatePortLike {
  status(): Promise<unknown>;
  /** 0.2.1 (D-94): network lookup of the latest published version. */
  check(): Promise<unknown>;
  run(): Promise<unknown>;
}

/** 0.2.1 (D-93): the app-update surface, injected from the main process. */
export interface AppUpdatePortLike {
  state(): AppUpdateState;
  perform(action: AppUpdateAction): Promise<AppUpdateActionResult>;
}

/**
 * 0.2.1 (D-96): where the cached cover image for a task lives.
 *
 * The renderer never sees the remote thumbnail URL — only a local absolute
 * path, and only when the bytes were actually cached. `null` means "draw the
 * letter badge", which is also the offline / privacy-safe path.
 */
export interface ThumbnailPort {
  pathOf(taskId: string): string | null;
  /** D-103: optional so older fakes / builds without the cache still compile. */
  forget?(taskId: string): void;
  status?(): Promise<ThumbnailCacheStatus>;
  prune?(options?: { force?: boolean }): Promise<ThumbnailPruneReport>;
  setAutoClean?(enabled: boolean): Promise<Record<string, unknown>>;
  setMaxBytes?(bytes: number): Promise<Record<string, unknown>>;
}

/**
 * Subtitle preview (stage 2): the live, on-demand probe port.
 *
 * Absent means "this build ships no preview service" and the channel answers
 * `PREVIEW_UNAVAILABLE` — it must never fall back to the recorded fixture,
 * because a fixture that pretends to be a real probe is how the old picker
 * looked functional while every choice was fake.
 */
export interface SubtitlePreviewPortLike {
  preview(url: unknown): Promise<SubtitlePreviewResult>;
  cancel(previewId: string): Promise<boolean>;
  /**
   * Stage 3: spend the ticket. The result carries the full `MediaInfo` and must
   * stay inside the main process — it is never an IPC payload.
   */
  consume(previewId: string, url: unknown): SubtitlePreviewConsumeResult;
}

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

/**
 * D-207: verdict of the delete-chain pre-flight (`TrashFilesPort.preflight`).
 *
 * The pre-flight resolves every eligible path to its FINAL real location and
 * re-runs containment on it — the destructive counterpart of D-204's open-face
 * realpath re-check. Its policy is the owner acceptance criterion "无法证明
 * 文件属于当前任务，就绝不允许删除":
 *
 *   - `ok`      — every path is provably this task's own (the real location
 *                 sits inside the trusted roots, or the entry is provably
 *                 gone with a decidable, contained parent context).
 *                 `missingPaths` (exact input strings) are the provably-gone
 *                 entries: they are excluded from the trash call and counted
 *                 as `filesMissing` (D-120 idempotency unchanged);
 *   - `refused` — at least one path cannot be proven to belong to the task
 *                 (real location outside the roots through a symlink /
 *                 junction, an undecidable context such as a dangling
 *                 mid-path junction, or an unresolvable real path). The
 *                 WHOLE batch is refused: the recycle bin is never called,
 *                 the record is kept, `reason` carries the real cause and
 *                 `refusedCount` the honest offender count.
 */
export type TrashPreflightVerdict =
  | { readonly kind: 'ok'; readonly missingPaths: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string; readonly refusedCount: number };

export interface TrashFilesPort {
  trash(paths: readonly string[]): Promise<readonly (string | TrashFileOutcome)[]>;
  /**
   * D-207 (optional, additive): pre-flight the WHOLE batch BEFORE `trash()`.
   *
   * Absent on legacy D-87 / D-120 fakes, which then keep their exact previous
   * behaviour (the adapter's per-entry lstat link guard remains the backstop).
   * The production adapter (createTrashFilesPort) always provides it, so the
   * withFiles removal chain runs it automatically — no extra wiring anywhere.
   */
  preflight?(paths: readonly string[], roots: readonly string[]): Promise<TrashPreflightVerdict>;
}

/** Normalise D-87 string replies and D-120 structured replies into one shape. */
export function normalizeTrashOutcomes(
  results: readonly (string | TrashFileOutcome)[],
): readonly TrashFileOutcome[] {
  return results.map((entry) => (typeof entry === 'string'
    ? { path: entry, status: 'trashed' as const }
    : entry));
}

/**
 * D-134: the supported-site surface this layer needs.
 *
 * `catalog` may resolve to a failure — that is a value, not an exception, so a
 * build without the capability renders "unknown" instead of a fabricated list.
 * `check` is advisory; only `UNSUPPORTED` may block an enqueue (§3.4).
 */
export interface SiteSupportPortLike {
  readonly available: boolean;
  catalog(force?: boolean): Promise<ExtractorCatalogResult>;
  /** T5: the optional signal is the caller's cancellation (see SiteSupportService). */
  check(url: string, force?: boolean, signal?: SpawnAbortSignal): Promise<UrlSupportResult>;
}

/** Windows path equality: case-insensitive, slash-insensitive. */
export function samePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * 0.2.1 (D-98): the download root, user-selectable.
 *
 * `video` and `audio` are separate on purpose — the app already wrote audio to
 * `paths.audioDir`, so one "download folder" would silently move half the user's
 * files. The picker itself lives in the main process (native dialog + writability
 * probe), which is why this port has no `electron` import.
 */
export type PathKind = 'video' | 'audio';

export interface PathPickerPort {
  /**
   * Opens the native folder picker. `path: null` + `error: null` means the user
   * cancelled; `error` non-null means the directory exists but is not writable.
   */
  pick(kind: PathKind, startAt: string): Promise<{ path: string | null; error: string | null }>;
  open(path: string): Promise<void>;
}

export interface PathsDto {
  /** Absolute, `%VAR%`-expanded paths — exactly what the engine will write to. */
  readonly videoDir: string;
  readonly audioDir: string;
}

/** D-83: what the renderer may ask for in a single download. */
export type VideoQualityChoice = FormatDomain['quality'];
export type AudioQualityChoice = FormatDomain['audioQuality'];
export type AudioFormatChoice = 'auto' | 'mp3' | 'm4a';

export interface SingleDownloadInput {
  readonly url: string;
  readonly kind: DownloadKind;
  /** Video only: `-S res:<N>` preset. */
  readonly quality?: VideoQualityChoice;
  /** Audio only: `-S abr~N` preset (or the transcode bitrate). */
  readonly audioQuality?: AudioQualityChoice;
  /** Audio only: `auto` keeps the source codec, mp3/m4a transcode. */
  readonly audioFormat?: AudioFormatChoice;
  /**
   * Stage 3: the subtitle ticket from `SUBTITLE_PREVIEW`.
   *
   * A ticket is REQUIRED before any subtitle choice is accepted — languages are
   * validated against the probe result the main process still holds, never
   * against whatever the page claims. Sending a ticket WITHOUT a subtitle
   * choice is legitimate: it lets enqueue reuse the probe and skip its own.
   */
  readonly previewId?: string;
  /** Exact language codes from the preview (`en`, `zh-Hans`), max 12. */
  readonly subtitleLanguages?: readonly string[];
  readonly subtitleAutoCaptions?: boolean;
  readonly subtitleConvertTo?: SubtitleDomain['convertTo'];
  readonly subtitleEmbed?: boolean;
  readonly subtitleKeepFile?: boolean;
}

/**
 * What this layer hands to `enqueueSingle`: the renderer payload plus two
 * MAIN-PROCESS-ONLY fields. Neither can come from IPC — `mediaInfo` is the
 * consumed probe result and `subtitlePatch` is produced by the pure merge.
 */
export interface SingleEnqueueRequest extends SingleDownloadInput {
  readonly subtitlePatch?: Partial<SubtitleDomain>;
  readonly mediaInfo?: MediaInfo;
}

export interface M5ChannelDeps {
  readonly queue: TaskListPort;
  readonly taskDetail: TaskDetailPort;
  readonly templates: CommandTemplateStore;
  readonly config: IConfigStore;
  readonly systemAppearance: SystemAppearancePort;
  /** D-166: absent on non-Windows / test builds; SETTINGS_SET then refuses. */
  readonly systemStartup?: ISystemStartupPort;
  /** Optional hook: the Electron layer repaints native windows (title bar). */
  readonly onAppearanceChanged?: (snapshot: AppearanceDto) => void;
  /** D-67: absent means the build ships no updater (button stays disabled). */
  readonly componentUpdate?: ComponentUpdatePortLike;
  /** D-69: real single-video enqueue; absent = DOWNLOAD_START reports disabled. */
  readonly enqueueSingle?: (input: SingleEnqueueRequest) => Promise<readonly string[]>;
  /** D-87: absent = "also delete local files" is refused instead of deleting anything. */
  readonly trashFiles?: TrashFilesPort;
  /**
   * D-120: absent = old behaviour (no `fileStatus` on the list DTO, open
   * actions go straight to core). Production always injects this.
   */
  readonly fileStatus?: LocalFileStatusPort;
  /** D-93: absent = the settings page shows "此构建不含更新器". */
  readonly appUpdate?: AppUpdatePortLike;
  /** D-96: absent = every card falls back to the letter badge. */
  readonly thumbnails?: ThumbnailPort;
  /** D-98: `%VAR%` expansion; absent = stored values are shown verbatim (tests). */
  readonly expandPath?: (raw: string) => string;
  /** D-98: native folder picker + reveal; absent = the path rows stay read-only. */
  readonly pathPicker?: PathPickerPort;
  /**
   * D-114: the running build's identity, straight from the main process.
   *
   * Absent means "this build cannot state its own version" — the renderer then
   * shows a placeholder instead of a plausible-looking old number. Never fill
   * this from a package.json literal: that is exactly how 0.2.2 survived four
   * releases in the footer.
   */
  readonly appInfo?: AppInfoDto;
  /**
   * Subtitle preview (stage 2): absent = the picker reports "not available in
   * this build". The port owns the probe, the TTL and the single-use ticket;
   * this layer only validates the wire input and forwards it.
   */
  readonly subtitlePreview?: SubtitlePreviewPortLike;
  /**
   * TXT batch import. Absent = both channels answer TXT_IMPORT_UNAVAILABLE
   * instead of falling back to any renderer-side file access.
   */
  readonly txtImport?: TxtImportServicePort;
  /** Live playlist probe + ticket store; absent = preview reports unavailable. */
  readonly playlistPreview?: PlaylistPreviewPortLike;
  /** The ONE M4Host batch implementation, shared with the frozen M3 channel. */
  readonly playlistBatch?: (input: PlaylistEnqueueInput) => Promise<PlaylistBatchReport>;
  /**
   * D-134: supported sites + URL pre-check. Absent = both channels answer
   * "unavailable" with a stable code, never a fabricated list and never a
   * silent "supported".
   */
  readonly siteSupport?: SiteSupportPortLike;
  /**
   * D-148: the "Star on GitHub" nudge. Absent = CHECK answers `show: false`
   * and ACTION reports `STAR_PROMPT_UNAVAILABLE` — the renderer must never see
   * a fabricated "you may show" from a build without the service.
   */
  readonly starPrompt?: StarPromptPort;
  /**
   * D-173: the real clipboard lives in the main process (A-4.1-02). Absent =
   * CLIPBOARD_WRITE reports `CLIPBOARD_UNAVAILABLE` instead of pretending the
   * text was copied. Same `ClipboardPort` the TASK_ACTION copy actions use.
   */
  readonly clipboard?: ClipboardPort;
}

/** D-114: what `APP_INFO` answers. `version` is `''` when it is unknown. */
export interface AppInfoDto {
  readonly version: string;
  readonly name: string;
  /** True when the process runs from a packaged asar (not `electron .`). */
  readonly packaged: boolean;
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

export interface AppearanceDto {
  readonly theme: ThemeMode;
  readonly accent: AccentChoice;
  readonly motion: MotionMode;
  readonly language: 'zh-CN' | 'en';
  /** D-88: when true the host clears the task history as the window closes. */
  readonly privateMode: boolean;
  /** 0.2.1 (D-93 / D-94): two independent startup-check switches. */
  readonly autoCheckAppUpdate: boolean;
  readonly autoCheckEngineUpdate: boolean;
  /** D-166: the real HKCU Run state; `general.autostart` is only the fallback mirror. */
  readonly autostart: boolean;
  readonly systemAccent: string | null;
  readonly prefersDark: boolean;
  readonly prefersReducedMotion: boolean;
  /** 0.2.1 (D-98): resolved download roots. */
  readonly videoDir: string;
  readonly audioDir: string;
}

const TASK_ACTIONS: readonly TaskDetailAction[] = [
  'open-file', 'open-folder', 'copy-url', 'copy-error-report', 'cancel', 'remove', 'retry',
];

const MAX_TEMPLATE_ARGS = 32;
const MAX_ARG_LENGTH = 400;

/**
 * D-173: how much TEXT the renderer may hand to the clipboard channel.
 * 1,000,000 UTF-16 units is ~10x any realistic task log (thousands of lines of
 * ~100 chars) and ≤ ~3 MB even in the worst all-CJK UTF-8 case — far below what
 * the OS clipboard or the Electron IPC pipe cares about, while still bounding a
 * runaway dump. Counted in code units, not bytes: the string is not decoded or
 * truncated here, the cap only refuses absurd payloads before they reach the OS.
 */
const MAX_CLIPBOARD_TEXT_CHARS = 1_000_000;

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

/** Opaque, main-process-issued import ticket. */
const IMPORT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** `crypto.randomUUID()` ids (36 chars) fit this shape. */
const PLAYLIST_PREVIEW_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** D-103: the only cache actions the renderer may trigger. */
const THUMBNAIL_CACHE_ACTIONS: readonly string[] = [
  'status', 'prune', 'set-auto', 'set-max-bytes',
];

/** D-93: the only actions the renderer may trigger. */
const APP_UPDATE_ACTIONS: readonly AppUpdateAction[] = [
  'check', 'download', 'cancel-download', 'install', 'open-page', 'skip-version', 'dismiss',
];

/** D-98: paths are user input; keep them short and printable. */
const MAX_PATH_LENGTH = 400;
const PATH_ACTIONS: readonly string[] = ['pick', 'reset', 'open'];

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

/**
 * D-98: stored value (`%USERPROFILE%/...`) → the absolute path the engine uses.
 *
 * An empty or non-string value falls back to the shipped default instead of
 * producing `''` — an empty output dir is exactly the "save failed" case the
 * user must never hit.
 */
export function readPaths(deps: Pick<M5ChannelDeps, 'config' | 'expandPath'>): PathsDto {
  const expand = deps.expandPath ?? ((raw: string): string => raw);
  const read = (key: 'videoDir' | 'audioDir'): string => {
    const raw = deps.config.get<string>('paths', key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    return expand(value === '' ? DEFAULT_PATH_TOKENS[key] : value);
  };
  return { videoDir: read('videoDir'), audioDir: read('audioDir') };
}

/**
 * D-166 follow-up: the HKCU Run entry is the operating system's real state, so
 * the settings toggle must show it — `config.json` only mirrors what the app
 * last wrote, and a registry cleaner / manual `reg delete` can remove the
 * entry behind the app's back. Policy: the registry wins whenever it can be
 * read; when the port is absent (non-Windows / test builds) or `read()` throws,
 * the config value is shown so a failed query can never break SETTINGS_GET or
 * the settings page. On a confirmed mismatch the config mirror is reconciled
 * to the registry value (best-effort: a failed write-back only leaves the
 * mirror stale, the registry stays the truth).
 */
async function readAutostart(deps: M5ChannelDeps): Promise<boolean> {
  const configValue = deps.config.get('general', 'autostart') === true;
  const port = deps.systemStartup;
  if (port === undefined) return configValue;
  let registryValue: boolean;
  try {
    registryValue = (await port.read()) === true;
  } catch {
    // Unknown registry state — show the mirror, never reconcile a guess.
    return configValue;
  }
  if (registryValue !== configValue) {
    try {
      await deps.config.setDomain('general', { autostart: registryValue });
    } catch {
      // Display-only hygiene; nothing functional depends on the mirror.
    }
  }
  return registryValue;
}

async function readAppearance(deps: M5ChannelDeps): Promise<AppearanceDto> {
  return {
    theme: normalizeThemeMode(deps.config.get('general', 'theme')),
    accent: parseAccent(deps.config.get('general', 'accent')),
    motion: normalizeMotionMode(deps.config.get('general', 'motion')),
    language: String(deps.config.get('general', 'language')).toLowerCase().startsWith('en') ? 'en' : 'zh-CN',
    privateMode: deps.config.get('general', 'privateMode') === true,
    autostart: await readAutostart(deps),
    autoCheckAppUpdate: deps.config.get('advanced', 'autoCheckAppUpdate') !== false,
    autoCheckEngineUpdate: deps.config.get('advanced', 'autoCheckEngineUpdate') !== false,
    systemAccent: deps.systemAppearance.accent(),
    prefersDark: deps.systemAppearance.prefersDark(),
    prefersReducedMotion: deps.systemAppearance.prefersReducedMotion(),
    ...readPaths(deps),
  };
}

function assertTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('[m5-ipc] taskId must be a non-empty string');
  }
  return value;
}

/** Longest URL the preview endpoint will look at (matches the service). */
const MAX_PREVIEW_URL_LENGTH = 2048;
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
const MAX_URL_CHARS = 4096;
/**
 * Opaque ticket shape. `crypto.randomUUID()` is 36 chars of `[0-9a-f-]`, and
 * the classes stay open enough for a future id scheme while still refusing
 * paths, dots, slashes and anything a caller could mistake for a filename.
 */
const PREVIEW_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Subtitle preview URL: http(s), trimmed, bounded, printable.
 *
 * This is the transport guard only — the service re-validates with the engine's
 * own whitelist (credentials, host, scheme) before anything is spawned.
 */
function assertPreviewUrl(value: unknown): string {
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
function assertPreviewId(value: unknown): string {
  if (typeof value !== 'string' || !PREVIEW_ID_RE.test(value)) {
    throw new Error('[m5-ipc] invalid previewId');
  }
  return value;
}

/** D-120: stable buckets -> stable codes; the renderer owns the sentence. */
const FILE_CODE_OF: Readonly<Record<string, string>> = {
  missing: 'FILE_MISSING',
  inaccessible: 'FILE_INACCESSIBLE',
  unavailable: 'FILE_UNAVAILABLE',
  invalid: 'NO_ARTIFACT',
};
const FOLDER_CODE_OF: Readonly<Record<string, string>> = {
  missing: 'FOLDER_MISSING',
  inaccessible: 'FOLDER_INACCESSIBLE',
  unavailable: 'FOLDER_UNAVAILABLE',
  invalid: 'NO_ARTIFACT',
};
/** Fallback copy for the detail page, which prints `result.message` verbatim. */
const OPEN_MESSAGE_OF: Readonly<Record<string, string>> = {
  FILE_MISSING: '无法打开文件：该视频文件已不存在于原保存位置，可能已被手动删除或移动。',
  FILE_INACCESSIBLE: '无法打开文件：没有访问权限，或文件正被其他程序占用。',
  FILE_UNAVAILABLE: '暂时无法确认文件状态，磁盘或网络位置可能不可用，请稍后重试。',
  FOLDER_MISSING: '原下载文件夹已不存在或无法访问。',
  FOLDER_INACCESSIBLE: '原下载文件夹无法访问。',
  FOLDER_UNAVAILABLE: '暂时无法确认原下载文件夹状态，请稍后重试。',
  NO_ARTIFACT: '任务记录中没有有效的本地文件路径。',
};

function assertTemplateInput(record: Record<string, unknown>): CommandTemplateInput {
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    throw new Error('[m5-ipc] template name must be 1..80 chars');
  }
  const args = record['args'];
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_TEMPLATE_ARGS) {
    throw new Error('[m5-ipc] template args must be a non-empty array');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH) {
      throw new Error('[m5-ipc] template args must be strings');
    }
  }
  return { name, args: args as readonly string[] };
}

export function createM5Handlers(deps: M5ChannelDeps): Map<string, (payload: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();

  // ---- D-160: per-submission pre-check cancellation -------------------------
  // Each user submission mints one opaque `operationId`; EVERY AbortController
  // of that submission (single URL check, DOWNLOAD_START gate re-check, TXT /
  // playlist batch) is registered under it. CANCEL and STATUS are scoped to a
  // single id, so one dialog's stop button can no longer abort another live
  // pre-check — the P2 audit finding against the old global Set. An omitted id
  // is the LEGACY scope: it only reaches registrations made without an id too,
  // never an isolated submission. Controllers are always unregistered in a
  // `finally`, and the scope itself is dropped when its last controller leaves,
  // so neither controllers nor scope keys can leak.
  //
  // The id is NOT a batch id, a URL list, a path or a preview ticket. It carries
  // no authority beyond naming THIS submission's own cancellation scope — the
  // main process still owns every abort decision, and the whitelist below
  // bounds its shape so it can never smuggle a URL into the IPC surface.
  interface PrecheckScope {
    readonly controllers: Set<AbortController>;
    /** BATCH pre-checks only; created lazily on the first progress report. */
    readonly progress: Map<AbortController, { checked: number; total: number }>;
  }
  const LEGACY_SCOPE = '';
  const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  const scopes = new Map<string, PrecheckScope>();

  const scopeOf = (operationId: string | null): string => operationId ?? LEGACY_SCOPE;
  const entryFor = (scope: string): PrecheckScope => {
    let entry = scopes.get(scope);
    if (entry === undefined) {
      entry = { controllers: new Set(), progress: new Map() };
      scopes.set(scope, entry);
    }
    return entry;
  };
  const releaseIfEmpty = (scope: string): void => {
    const entry = scopes.get(scope);
    if (entry !== undefined && entry.controllers.size === 0 && entry.progress.size === 0) {
      scopes.delete(scope);
    }
  };
  /** Read a validated, opaque operation id from a whitelisted IPC payload. */
  const readOperationId = (record: Record<string, unknown>): string | null => {
    const raw = record['operationId'];
    if (raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || !OPERATION_ID_RE.test(raw)) {
      throw new Error('[m5-ipc] invalid operationId');
    }
    return raw;
  };
  const registerPrecheck = (operationId: string | null): AbortController => {
    const controller = new AbortController();
    entryFor(scopeOf(operationId)).controllers.add(controller);
    return controller;
  };
  const finishPrecheck = (operationId: string | null, controller: AbortController): void => {
    const scope = scopeOf(operationId);
    const entry = scopes.get(scope);
    if (entry === undefined) return;
    entry.controllers.delete(controller);
    entry.progress.delete(controller);
    releaseIfEmpty(scope);
  };
  const trackBatchProgress = (
    operationId: string | null,
    controller: AbortController,
  ): (checked: number, total: number) => void => {
    let entry: { checked: number; total: number } | null = null;
    return (checked: number, total: number) => {
      if (entry === null) {
        entry = { checked: 0, total: 0 };
        scopes.get(scopeOf(operationId))?.progress.set(controller, entry);
      }
      entry.checked = checked;
      entry.total = total;
    };
  };

  handlers.set(IPC_CHANNELS.TASK_LIST, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_LIST, payload);
    const tab = record['tab'];
    const query = record['query'];
    if (tab !== undefined && !['all', 'downloading', 'finished', 'canceled'].includes(String(tab))) {
      throw new Error('[m5-ipc] invalid tab');
    }
    if (query !== undefined && typeof query !== 'string') throw new Error('[m5-ipc] query must be a string');
    const refresh = record['refreshFileStatus'];
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new Error('[m5-ipc] refreshFileStatus must be a boolean');
    }
    const records = deps.queue.list();
    const snapshot = buildTaskListSnapshot(records, {
      ...(tab === undefined ? {} : { tab: tab as TaskTab }),
      ...(query === undefined ? {} : { query: query as string }),
    });
    // D-120: one batch probe per list request, short-TTL cached in the port.
    // The renderer asks for a fresh stat only on load / re-entry / user action,
    // never on every repaint. Missing port => no field at all (old contract).
    const states = deps.fileStatus === undefined
      ? {}
      : await deps.fileStatus.probe(records, refresh === true);
    return {
      tab: snapshot.tab,
      counts: snapshot.counts,
      empty: snapshot.empty,
      items: snapshot.visible.map((record) => toTaskListItem(
        record,
        deps.thumbnails === undefined ? null : deps.thumbnails.pathOf(record.id),
        states[record.id],
        deps.queue.isPending?.(record.id) === true,
      )),
    };
  });

  handlers.set(IPC_CHANNELS.TASK_DETAIL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_DETAIL, payload);
    const taskId = assertTaskId(record['taskId']);
    const task = deps.queue.get(taskId);
    if (task === undefined) return { found: false, task: null };
    return { found: true, task: toTaskDetail(task, deps.queue.isPending?.(taskId) === true) };
  });

  handlers.set(IPC_CHANNELS.TASK_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TASK_ACTION, payload);
    const taskId = assertTaskId(record['taskId']);
    const action = record['action'];
    if (typeof action !== 'string' || !TASK_ACTIONS.includes(action as TaskDetailAction)) {
      throw new Error('[m5-ipc] unknown task action');
    }
    const rawWithFiles = record['withFiles'];
    if (rawWithFiles !== undefined && typeof rawWithFiles !== 'boolean') {
      throw new Error('[m5-ipc] withFiles must be a boolean');
    }
    // ---- D-120: a fresh, honest observation before ANY open action ----------
    // The result is a stable code, never a sentence: the renderer resolves it
    // in the active locale. A transient error is never reported as "deleted".
    const isOpenAction = action === 'open-file' || action === 'open-folder';
    let observed: LocalFileState | undefined;
    if (deps.fileStatus !== undefined && isOpenAction) {
      const task = deps.queue.get(taskId);
      if (task === undefined) {
        return { action, ok: false, code: 'TASK_MISSING', message: `unknown task: ${taskId}` };
      }
      observed = await deps.fileStatus.probeTask(task);
      if (observed.status === 'invalid') {
        return { action, ok: false, code: 'NO_ARTIFACT', message: OPEN_MESSAGE_OF['NO_ARTIFACT'] as string };
      }
      if (action === 'open-folder') {
        // A missing FILE must not block the folder: the directory is what the
        // user asked to see. Only a missing/unreadable directory is a failure.
        if (observed.dirStatus !== 'present') {
          const code = FOLDER_CODE_OF[observed.dirStatus] ?? 'ERROR';
          return { action, ok: false, code, message: OPEN_MESSAGE_OF[code] ?? `原下载目录不可打开（${observed.dirStatus}）` };
        }
      } else if (observed.status !== 'present') {
        const code = FILE_CODE_OF[observed.status] ?? 'ERROR';
        return { action, ok: false, code, message: OPEN_MESSAGE_OF[code] ?? `本地文件不可打开（${observed.status}）` };
      }
    }

    // ---- D-120: local cleanup is idempotent and NEVER gates the record -----
    if (rawWithFiles === true) {
      if (action !== 'remove') throw new Error('[m5-ipc] withFiles requires action=remove');
      if (deps.trashFiles === undefined) {
        return { action: 'remove', ok: false, code: 'SHELL_UNAVAILABLE', message: '当前构建未启用回收站端口' };
      }
      // Only the paths the engine itself recorded for THIS task are eligible.
      // The renderer never sends a path, so it cannot aim this at arbitrary files.
      const target = deps.queue.get(taskId);
      const artifacts = target?.artifacts ?? [];
      // D-182: a path outside the record's own output roots never reaches the
      // recycle bin. The intake gate (task-queue) already guarantees this for
      // anything downloaded in this session; the check defends restored /
      // manipulated snapshots. The whole batch is refused (nothing is trashed,
      // the record is kept and the reason is reported) — deleting a foreign
      // file is the one error that cannot be undone.
      // D-203 (breaking change, supersedes the frozen D-120 tolerance): a
      // record without a usable request has NO trustworthy roots, and
      // `isPathInsideRoots` fails OPEN on empty roots by design — so a
      // request-less legacy record used to let ANY recorded path (e.g.
      // `C:/Windows/evil.mp4`) into the recycle bin. The gate is therefore
      // fail-closed for EVERY record: whenever `trustedArtifactRoots` returns
      // null (request === null, a request cleaned by the D-161/D-195 shape
      // guard, an undeterminable output dir, or no specific root) the whole
      // batch is refused and the record plus its history are kept intact.
      const removalRoots = trustedArtifactRoots(target?.request?.paths ?? {});
      // D-193 / D-203: null roots mean the ownership of every artifact is
      // unverifiable — both gates derive their scope from this same record,
      // so an empty scope would make "inside" mean "anywhere".
      if (removalRoots === null) {
        return {
          action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
          reason: '无法验证产物文件归属（任务缺少可用的下载请求信息），为防止误删已拒绝回收本地文件',
          message: '本地文件清理失败：无法验证产物文件归属（任务缺少可用的下载请求信息），为防止误删已拒绝回收本地文件；任务记录已保留',
          failedCount: artifacts.length,
        };
      }
      const refused = artifacts.filter((path) => !isPathInsideRoots(path, removalRoots));
      if (refused.length > 0) {
        return {
          action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
          reason: `检测到 ${refused.length} 个产物路径超出任务输出目录，为防止误删已拒绝回收`,
          message: `本地文件清理失败：检测到 ${refused.length} 个产物路径超出任务输出目录，为防止误删已拒绝回收；任务记录已保留`,
          failedCount: refused.length,
        };
      }
      // A second live record may quote the same physical file. Deleting it for
      // this record would silently destroy the other record's artifact, so the
      // shared paths are skipped (the record is still removed). In a batch the
      // last record of the group then finds no other claim and recycles it.
      const claimedElsewhere = new Set<string>();
      for (const other of deps.queue.list()) {
        if (other.id === taskId) continue;
        for (const artifact of other.artifacts) claimedElsewhere.add(samePathKey(artifact));
      }
      const eligible = artifacts.filter((path) => !claimedElsewhere.has(samePathKey(path)));
      const sharedSkipped = artifacts.length - eligible.length;
      // ---- D-207: pre-flight the WHOLE batch before anything destructive -----
      // The string gate above compares NAMES. On Windows the kernel silently
      // resolves a reparse point placed in a MIDDLE path component, so a
      // recorded `<videoDir>/link/file.mp4` can physically live anywhere while
      // every name-level check passes — the adapter's end-component lstat guard
      // cannot see it, and a dangling mid-path junction even masquerades as
      // "already missing". The pre-flight (carried by the injected trash port,
      // implemented adapter-side against the real filesystem) resolves every
      // eligible path to its FINAL real location and re-runs containment on it.
      // ONE unprovable path refuses the WHOLE batch: the recycle bin is never
      // reached, the record is kept and `taskDetail.perform('remove')` is never
      // called. This also closes the honest-count hole — a legitimate file can
      // no longer be recycled first and then abandoned in the bin behind a
      // refused result that mentions no `filesTrashed`. Provably-gone entries
      // (realpath ENOENT with a decidable, contained parent) keep the D-120
      // idempotent semantics: excluded from the trash call, counted as
      // `filesMissing`. Ports without `preflight` (legacy fakes) keep their
      // exact previous behaviour; the adapter's per-entry lstat guard stays in
      // place behind this gate as the TOCTOU second line.
      const preflight = deps.trashFiles.preflight;
      let trashTargets = eligible;
      let preflightMissing: readonly string[] = [];
      if (preflight !== undefined) {
        const verdict = await preflight(eligible, removalRoots);
        if (verdict.kind === 'refused') {
          return {
            action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
            reason: verdict.reason,
            message: `本地文件清理失败：${verdict.reason}；任务记录已保留`,
            failedCount: verdict.refusedCount,
          };
        }
        preflightMissing = verdict.missingPaths;
        if (verdict.missingPaths.length > 0) {
          const gone = new Set(verdict.missingPaths);
          trashTargets = eligible.filter((path) => !gone.has(path));
        }
      }
      const outcomes = normalizeTrashOutcomes(await deps.trashFiles.trash(trashTargets));
      // A D-87 adapter replies with only the paths it handled. A short reply is
      // a partial failure and must keep the record (existing contract).
      if (outcomes.length < trashTargets.length) {
        return {
          action: 'remove', ok: false, code: 'ERROR', failureKind: 'file-cleanup',
          message: `本地文件未全部移入回收站（${outcomes.length}/${trashTargets.length}），记录已保留`,
        };
      }
      const failed = outcomes.filter((entry) => entry.status === 'error');
      if (failed.length > 0) {
        // Real filesystem failure: keep the record, report the real reason,
        // and never mark the operation as successful.
        return {
          action: 'remove', ok: false, code: 'FILE_DELETE_FAILED', failureKind: 'file-cleanup',
          reason: failed[0]?.reason ?? '未知错误',
          message: `本地文件清理失败：${failed[0]?.reason ?? '未知错误'}；任务记录已保留`,
          failedCount: failed.length,
        };
      }
      // D-207: `filesMissing` is honest about BOTH sources — entries the
      // pre-flight proved gone (never handed to the trash call) and entries
      // the adapter itself reported missing.
      const filesMissing = preflightMissing.length
        + outcomes.filter((entry) => entry.status === 'missing').length;
      const filesTrashed = outcomes.filter((entry) => entry.status === 'trashed').length;
      deps.fileStatus?.forget(taskId);
      const removal = await deps.taskDetail.perform(taskId, 'remove');
      if (removal.ok === true) deps.thumbnails?.forget?.(taskId);
      return { ...removal, filesMissing, filesTrashed, sharedSkipped };
    }

    const result = await deps.taskDetail.perform(taskId, action as TaskDetailAction);
    // D-103: dropping a task record drops its claim on the cover. The file is
    // NOT deleted here — the prune pass checks whether another live task shares
    // it, then moves it to the recycle bin.
    if (action === 'remove') {
      if (result.ok === true) {
        deps.thumbnails?.forget?.(taskId);
        deps.fileStatus?.forget(taskId);
      }
    } else if (isOpenAction && observed !== undefined) {
      // Let the renderer say "文件已不存在，已为你打开原保存文件夹" without
      // another IPC round trip.
      return { ...result, fileStatus: observed.status, dirStatus: observed.dirStatus };
    }
    return result;
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_LIST, async (payload) => {
    validateM5Payload(IPC_CHANNELS.TEMPLATE_LIST, payload);
    await deps.templates.init();
    return { templates: deps.templates.list(), rejectedAtLoad: deps.templates.rejectedAtLoad };
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_SAVE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TEMPLATE_SAVE, payload);
    const input = assertTemplateInput(record);
    const id = record['id'];
    if (id === undefined) {
      return { created: true, template: await deps.templates.create(input) };
    }
    if (typeof id !== 'string' || id.length === 0) throw new Error('[m5-ipc] invalid template id');
    return { created: false, template: await deps.templates.update(id, input) };
  });

  handlers.set(IPC_CHANNELS.TEMPLATE_DELETE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.TEMPLATE_DELETE, payload);
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) throw new Error('[m5-ipc] invalid template id');
    return { removed: await deps.templates.remove(id) };
  });

  handlers.set(IPC_CHANNELS.COMPONENT_STATUS, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_STATUS, payload);
    if (deps.componentUpdate === undefined) {
      return { components: [], source: null, updating: false };
    }
    return deps.componentUpdate.status();
  });

  handlers.set(IPC_CHANNELS.COMPONENT_UPDATE, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_UPDATE, payload);
    if (deps.componentUpdate === undefined) {
      return { ok: false, source: null, reason: '当前构建未启用组件更新', results: [] };
    }
    return deps.componentUpdate.run();
  });

  // 0.2.1 (D-94): the network half of the component surface. Kept separate from
  // COMPONENT_STATUS so the settings page can render versions instantly and only
  // pay for a request when the user (or the startup toggle) asks for one.
  handlers.set(IPC_CHANNELS.COMPONENT_CHECK, async (payload) => {
    validateM5Payload(IPC_CHANNELS.COMPONENT_CHECK, payload);
    if (deps.componentUpdate === undefined) {
      return { checkedAt: '', results: [] };
    }
    return deps.componentUpdate.check();
  });

  // 0.2.1 (D-93): app update. `status` is a pure read of the in-memory state, so
  // the queue page can poll it on the same tick as TASK_LIST without a request.
  handlers.set(IPC_CHANNELS.APP_UPDATE_STATUS, async (payload) => {
    validateM5Payload(IPC_CHANNELS.APP_UPDATE_STATUS, payload);
    if (deps.appUpdate === undefined) {
      return {
        phase: 'idle', currentVersion: '', latest: null,
        releaseNotes: [], omittedReleaseNotes: 0,
        message: '此构建不含更新器', downloadedBytes: 0, totalBytes: null,
        skippedVersion: null, lastCheckedAt: null, canAutoInstall: false,
      };
    }
    return deps.appUpdate.state();
  });

  handlers.set(IPC_CHANNELS.APP_UPDATE_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.APP_UPDATE_ACTION, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !APP_UPDATE_ACTIONS.includes(action as AppUpdateAction)) {
      throw new Error('[m5-ipc] unknown app update action');
    }
    if (deps.appUpdate === undefined) {
      return { ok: false, action, message: '此构建不含更新器', state: null };
    }
    return deps.appUpdate.perform(action as AppUpdateAction);
  });

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

    const taskIds = await deps.enqueueSingle({
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

  // Subtitle preview (stage 2): the real, on-demand probe behind the picker.
  // Two invariants live here rather than in the service:
  //   1. a superseded ticket is released BEFORE the new probe, so a failure
  //      cannot leave the old id alive (the renderer already forgot it);
  //   2. an absent service answers with a code, never with fixture data.
  handlers.set(IPC_CHANNELS.SUBTITLE_PREVIEW, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SUBTITLE_PREVIEW, payload);
    const url = assertPreviewUrl(record['url']);
    const previous = record['previousPreviewId'];
    if (previous !== undefined && previous !== '') {
      await deps.subtitlePreview?.cancel(assertPreviewId(previous));
    }
    if (deps.subtitlePreview === undefined) {
      return { ok: false, code: 'PREVIEW_UNAVAILABLE', message: '当前构建未启用字幕预览' };
    }
    return deps.subtitlePreview.preview(url);
  });

  handlers.set(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL, payload);
    const previewId = assertPreviewId(record['previewId']);
    if (deps.subtitlePreview === undefined) return { ok: false, canceled: false };
    return { ok: true, canceled: await deps.subtitlePreview.cancel(previewId) };
  });

  // 0.2.1 (D-98): the download root. `pick` is the only way to change it — the
  // renderer can never hand us an arbitrary string to write into the config.
  handlers.set(IPC_CHANNELS.PATH_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.PATH_ACTION, payload);
    const action = record['action'];
    const kind = record['kind'];
    if (typeof action !== 'string' || !PATH_ACTIONS.includes(action)) {
      throw new Error('[m5-ipc] unknown path action');
    }
    if (kind !== 'video' && kind !== 'audio') throw new Error('[m5-ipc] path kind must be video|audio');
    const key: 'videoDir' | 'audioDir' = kind === 'audio' ? 'audioDir' : 'videoDir';
    const before = readPaths(deps);

    if (action === 'reset') {
      await deps.config.setDomain('paths', { [key]: DEFAULT_PATH_TOKENS[key] });
      const paths = readPaths(deps);
      return { ok: true, action, kind, canceled: false, error: null, path: paths[key], paths };
    }

    if (deps.pathPicker === undefined) {
      return {
        ok: false, action, kind, canceled: false,
        error: '当前构建不支持选择目录', path: null, paths: before,
      };
    }

    if (action === 'open') {
      try {
        await deps.pathPicker.open(before[key]);
        return { ok: true, action, kind, canceled: false, error: null, path: before[key], paths: before };
      } catch (error) {
        return {
          ok: false, action, kind, canceled: false,
          error: error instanceof Error ? error.message : String(error),
          path: null, paths: before,
        };
      }
    }

    const picked = await deps.pathPicker.pick(kind, before[key]);
    if (picked.path === null) {
      return {
        ok: false, action, kind,
        // No error + no path = the user closed the dialog; not a failure.
        canceled: picked.error === null,
        error: picked.error,
        path: null,
        paths: before,
      };
    }
    const next = picked.path.trim();
    if (next === '' || next.length > MAX_PATH_LENGTH || /[\u0000-\u001f]/.test(next)) {
      return {
        ok: false, action, kind, canceled: false,
        error: '所选路径无效', path: null, paths: before,
      };
    }
    await deps.config.setDomain('paths', { [key]: next });
    const paths = readPaths(deps);
    return { ok: true, action, kind, canceled: false, error: null, path: paths[key], paths };
  });

  // D-103: cover-cache management. Every action is main-process owned; the
  // renderer cannot name a file, a directory or a deletion primitive.
  handlers.set(IPC_CHANNELS.THUMBNAIL_CACHE, async (payload): Promise<Record<string, unknown>> => {
    const record = validateM5Payload(IPC_CHANNELS.THUMBNAIL_CACHE, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !THUMBNAIL_CACHE_ACTIONS.includes(action)) {
      throw new Error('[m5-ipc] unknown thumbnail cache action');
    }
    const cache = deps.thumbnails;
    const unavailable = { ok: false, action, available: false, message: '封面缓存未启用' };
    if (cache === undefined) return unavailable;

    if (action === 'status') {
      if (cache.status === undefined) return unavailable;
      return { ok: true, action, available: true, status: await cache.status() };
    }
    if (action === 'prune') {
      if (cache.prune === undefined) return unavailable;
      // The button is an explicit user action: it works even when automatic
      // cleaning is switched off, but still never touches a live cover.
      return { ok: true, action, available: true, report: await cache.prune({ force: true }) };
    }
    if (action === 'set-auto') {
      const enabled = record['enabled'];
      if (typeof enabled !== 'boolean') throw new Error('[m5-ipc] enabled must be a boolean');
      if (cache.setAutoClean === undefined) return unavailable;
      return { ok: true, action, available: true, policy: await cache.setAutoClean(enabled) };
    }
    const maxBytes = record['maxBytes'];
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes)
      || maxBytes < 8 * 1024 * 1024 || maxBytes > 2 * 1024 * 1024 * 1024) {
      throw new Error('[m5-ipc] invalid maxBytes');
    }
    if (cache.setMaxBytes === undefined) return unavailable;
    return { ok: true, action, available: true, policy: await cache.setMaxBytes(maxBytes) };
  });

  // D-114: read-only build identity. Deliberately NOT derived from the page
  // URL: the value must survive a navigation that drops query parameters, and
  // it must never be a literal shipped inside the renderer bundle.
  handlers.set(IPC_CHANNELS.APP_INFO, async (payload) => {
    validateM5Payload(IPC_CHANNELS.APP_INFO, payload);
    const info = deps.appInfo;
    return {
      version: typeof info?.version === 'string' ? info.version : '',
      name: typeof info?.name === 'string' && info.name !== '' ? info.name : 'YTVDLT',
      packaged: info?.packaged === true,
    };
  });

  // D-134 (A): "which sites can this engine parse?" — a page-level read.
  // The answer is a DTO with counts + rows; `enginePath` is intentionally
  // dropped (absolute local path, not needed by the UI). A failure is a CODE,
  // never a fallback list: §3.1 forbids inventing one, because a stale list is
  // indistinguishable from a correct one.
  handlers.set(IPC_CHANNELS.SUPPORTED_SITES, async (payload): Promise<SupportedSitesDto> => {
    const record = validateM5Payload(IPC_CHANNELS.SUPPORTED_SITES, payload);
    const refresh = record['refresh'];
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new Error('[m5-ipc] refresh must be a boolean');
    }
    const port = deps.siteSupport;
    if (port === undefined) {
      return {
        ok: false, code: 'ENGINE_UNAVAILABLE', engineVersion: '', siteCount: 0,
        subExtractorCount: 0, brokenCount: 0, hasGeneric: false, fetchedAt: '',
        rows: [], cached: false,
      };
    }
    const result = await port.catalog(refresh === true);
    if (!result.ok) {
      return {
        ok: false, code: result.reason, engineVersion: '', siteCount: 0,
        subExtractorCount: 0, brokenCount: 0, hasGeneric: false, fetchedAt: '',
        rows: [], cached: false,
      };
    }
    const catalog = result.catalog;
    return {
      ok: true,
      code: '',
      engineVersion: catalog.engineVersion,
      siteCount: catalog.siteCount,
      subExtractorCount: catalog.subExtractorCount,
      brokenCount: catalog.brokenCount,
      hasGeneric: catalog.extractors.some((entry) => entry.isGeneric),
      fetchedAt: catalog.fetchedAt,
      // The engine's own order is preserved: re-sorting here would hide an
      // engine change from the diff, and the page does its own sorting.
      rows: catalog.extractors,
      // R1-06: the flag comes from the layer that knows — the catalog cache —
      // and is forwarded verbatim. It used to be guessed here from "did the
      // caller pass refresh", which labelled the very first load of a session
      // as cached (and, after the cache-key fix, would have labelled every load
      // that way), telling the user a stale-looking story that was not true.
      cached: result.cached,
    };
  });

  // D-134 (B): the six-state pre-check for ONE url (§3.3/§3.4).
  // Only `UNSUPPORTED` sets `blocks: true`; the renderer must never re-derive
  // that rule, so it is computed here from the single frozen predicate.
  handlers.set(IPC_CHANNELS.URL_SUPPORT_CHECK, async (payload): Promise<UrlSupportCheckDto> => {
    const record = validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK, payload);
    const operationId = readOperationId(record);
    const rawUrl = record['url'];
    if (typeof rawUrl !== 'string' || rawUrl.trim() === ''
      || rawUrl.length > MAX_URL_CHARS || /[\u0000-\u001f\u007f]/.test(rawUrl)) {
      throw new Error('[m5-ipc] URL_SUPPORT_CHECK requires a bounded string url');
    }
    if (!/^https?:\/\//i.test(rawUrl.trim())) {
      throw new Error('[m5-ipc] URL_SUPPORT_CHECK requires an http(s) url');
    }
    const refresh = record['refresh'];
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new Error('[m5-ipc] refresh must be a boolean');
    }
    const url = rawUrl.trim();
    const unavailable: UrlSupportCheckDto = {
      url, state: 'INDETERMINATE', extractor: '', cached: false, blocks: false,
      code: 'PREVIEW_UNAVAILABLE', reason: 'pre-check unavailable in this build',
    };
    const port = deps.siteSupport;
    if (port === undefined) return unavailable;
    // T5: this single check is cancellable — a CANCEL from the page aborts the
    // signal, which kills the engine child and answers the CANCELLED state.
    const controller = registerPrecheck(operationId);
    try {
      const result = await port.check(url, refresh === true, controller.signal);
      return {
        url: result.url,
        state: result.state,
        extractor: result.extractor,
        reason: result.reason,
        cached: result.cached,
        blocks: blocksEnqueue(result.state),
        // Stable code so the renderer resolves the sentence in the active
        // locale; `reason` is the English fallback an old UI can print.
        code: result.state === 'CANCELLED' ? 'PRECHECK_CANCELLED'
          : result.state === 'UNSUPPORTED' && result.extractor === ''
            ? 'SITE_UNSUPPORTED'
            : result.state === 'UNSUPPORTED' ? 'ITEM_UNSUPPORTED'
              : result.state === 'NO_MEDIA' ? 'NO_MEDIA'
                : result.state === 'TIMEOUT' ? 'PRECHECK_TIMEOUT'
                  : result.state === 'INDETERMINATE' ? 'INDETERMINATE' : '',
      };
    } finally {
      finishPrecheck(operationId, controller);
    }
  });

  // D-160: the user-level "stop" for ONE submission. An `operationId` scopes
  // the abort to that submission's controllers; without it only the LEGACY
  // scope is reachable. Two live dialogs with different ids can therefore run
  // and be cancelled independently, which the old global Set could not do.
  // Aborting an already-finished controller is a no-op, so a stale id is
  // harmless; an id nobody registered answers `cancelled: false` honestly.
  handlers.set(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL, payload);
    const operationId = readOperationId(record);
    const controllers = [...(scopes.get(scopeOf(operationId))?.controllers ?? [])];
    for (const controller of controllers) controller.abort();
    return { ok: true, cancelled: controllers.length > 0 };
  });

  // T5 (append-only): read-only progress probe for the batch dialogs. Polling,
  // not pushing, on purpose: this IPC surface is invoke/response, and the
  // project's established progress pattern is a polled read (APP_UPDATE_STATUS,
  // §5 rule 6). `active` turns false the moment the last batch pre-check
  // settles, which is the poll's termination condition.
  handlers.set(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS, payload);
    const operationId = readOperationId(record);
    // D-160: progress is per submission too, so one dialog's readout cannot
    // show another dialog's checked/total counts.
    const progress = scopes.get(scopeOf(operationId))?.progress;
    let checked = 0;
    let total = 0;
    if (progress !== undefined) {
      for (const entry of progress.values()) {
        checked += entry.checked;
        total += entry.total;
      }
    }
    return { active: progress !== undefined && progress.size > 0, checked, total };
  });

  // D-148 (A): "may the Star prompt show now?" — a zero-payload read (same
  // rule as APP_INFO). The whole frequency decision (launch count, per-version
  // cap, 7-day retry gap, permanent silence) lives behind the port; the
  // renderer only receives a boolean and can never inflate its own state.
  handlers.set(IPC_CHANNELS.STAR_PROMPT_CHECK, async (payload): Promise<{ show: boolean }> => {
    validateM5Payload(IPC_CHANNELS.STAR_PROMPT_CHECK, payload);
    const port = deps.starPrompt;
    if (port === undefined) return { show: false };
    return port.check();
  });

  // D-148 (B): the user's answer. One validated enum, nothing else — the
  // repository URL is a main-process constant, so the renderer has no way to
  // point `shell.openExternal` anywhere else (D-98 spirit).
  handlers.set(IPC_CHANNELS.STAR_PROMPT_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.STAR_PROMPT_ACTION, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !STAR_PROMPT_ACTIONS.includes(action as never)) {
      throw new Error('[m5-ipc] unknown star prompt action');
    }
    const port = deps.starPrompt;
    if (port === undefined) return { ok: false, action, code: 'STAR_PROMPT_UNAVAILABLE' };
    return port.applyAction(action);
  });

  // D-173: the main process owns the real clipboard (A-4.1-02). Since D-170 the
  // session denies every renderer permission — including the
  // `clipboard-sanitized-write` check behind `navigator.clipboard.writeText` —
  // so a renderer-side copy silently fails in the packaged app. Here the write
  // goes through the injected `ClipboardPort` (Electron `clipboard.writeText`),
  // which never passes a permission handler. Success/failure is an explicit
  // `{ok}` answer, never a silent void; the codes reuse the TASK_ACTION copy
  // vocabulary (`CLIPBOARD_UNAVAILABLE`, task-detail.ts).
  handlers.set(IPC_CHANNELS.CLIPBOARD_WRITE, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.CLIPBOARD_WRITE, payload);
    const text = record['text'];
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT_CHARS) {
      throw new Error('[m5-ipc] CLIPBOARD_WRITE requires a bounded text string');
    }
    const port = deps.clipboard;
    if (port === undefined) return { ok: false, code: 'CLIPBOARD_UNAVAILABLE' };
    try {
      await port.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false, code: 'CLIPBOARD_WRITE_FAILED' };
    }
  });

  handlers.set(IPC_CHANNELS.SETTINGS_GET, async (payload) => {
    validateM5Payload(IPC_CHANNELS.SETTINGS_GET, payload);
    return readAppearance(deps);
  });
  handlers.set(IPC_CHANNELS.SETTINGS_SET, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SETTINGS_SET, payload);
    const patch: Record<string, unknown> = {};
    if (record['theme'] !== undefined) {
      const theme = normalizeThemeMode(record['theme']);
      if (theme !== record['theme']) throw new Error('[m5-ipc] invalid theme');
      patch['theme'] = theme;
    }
    if (record['accent'] !== undefined) {
      const accent = record['accent'];
      const valid = typeof accent === 'string' && (
        accent === 'system'
        || (ACCENT_PRESETS as readonly string[]).includes(accent)
        || normalizeHexColor(accent) !== null
      );
      if (!valid) throw new Error('[m5-ipc] invalid accent');
      patch['accent'] = accent;
    }
    if (record['motion'] !== undefined) {
      const motion = normalizeMotionMode(record['motion']);
      if (motion !== record['motion']) throw new Error('[m5-ipc] invalid motion');
      patch['motion'] = motion;
    }
    if (record['language'] !== undefined) {
      const language = String(record['language']);
      if (language !== 'zh-CN' && language !== 'en') throw new Error('[m5-ipc] invalid language');
      patch['language'] = language;
    }
    // D-88: private mode lives in `general.privateMode` (already a declared
    // default since M1). The host reads it on window close / before-quit.
    if (record['privateMode'] !== undefined) {
      if (typeof record['privateMode'] !== 'boolean') throw new Error('[m5-ipc] invalid privateMode');
      patch['privateMode'] = record['privateMode'];
    }
    // 0.2.1: the update switches live in `advanced`, not `general`.
    const advancedPatch: Record<string, unknown> = {};
    for (const key of ['autoCheckAppUpdate', 'autoCheckEngineUpdate'] as const) {
      const value = record[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new Error(`[m5-ipc] invalid ${key}`);
      advancedPatch[key] = value;
    }
    // D-166: the registry is written FIRST. If `reg` fails, the config keeps
    // saying what is actually true on disk instead of promising a startup entry
    // that does not exist.
    if (record['autostart'] !== undefined) {
      if (typeof record['autostart'] !== 'boolean') {
        throw new Error('[m5-ipc] autostart must be a boolean');
      }
      const port = deps.systemStartup;
      if (port === undefined) throw new Error('[m5-ipc] autostart is not available in this build');
      const applied = await port.apply(record['autostart']);
      if (!applied.ok) {
        throw new Error(`[m5-ipc] autostart failed: ${applied.reason ?? 'unknown'}`);
      }
      patch['autostart'] = record['autostart'];
    }

    if (Object.keys(patch).length > 0) await deps.config.setDomain('general', patch);
    if (Object.keys(advancedPatch).length > 0) await deps.config.setDomain('advanced', advancedPatch);
    const snapshot = await readAppearance(deps);
    deps.onAppearanceChanged?.(snapshot);
    return snapshot;
  });

  return handlers;
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
