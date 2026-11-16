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
import type {
  AppUpdateAction, AppUpdateActionResult, AppUpdateState, DownloadKind, FormatDomain, TaskRecord,
  MediaInfo, SubtitleDomain, SubtitlePreviewConsumeResult, SubtitlePreviewResult,
  ExtractorCatalogResult, UrlSupportResult,
  SpawnAbortSignal, ISystemStartupPort,
} from '@ytvdlt/shared';
import type {
  AccentChoice, ClipboardPort, CommandTemplateStore, IConfigStore,
  MotionMode, TaskDetailAction, TaskDetailResult, ThemeMode,
} from '@ytvdlt/core';
import type { ThumbnailCacheStatus, ThumbnailPruneReport } from './thumbnail-cache.js';
import type { LocalFileStatusPort } from './local-file-status.js';
import type { TxtImportServicePort } from './txt-import-service.js';
import type { PlaylistPreviewPortLike } from './playlist-preview-service.js';
import type { PlaylistBatchReport, PlaylistEnqueueInput } from './m4-host.js';
import type { StarPromptPort } from './star-prompt-service.js';
// Task-3 pure-logic extraction (2026-11-15): the payload whitelist, the M5
// channel list, the URL-free task DTO projections and the trash-outcome
// normalisation moved VERBATIM to `./m5-contracts.js`. Everything below
// re-exports the ORIGINAL surface — m5-host, main/index and the 16 test
// files import these symbols from HERE, and that contract must survive.
import type { TrashFileOutcome } from './m5-contracts.js';
export {
  M5_CHANNELS, normalizeTrashOutcomes, samePathKey, toTaskDetail, toTaskListItem, validateM5Payload,
} from './m5-contracts.js';
export type {
  TaskDetailDto, TaskListItemDto, TrashFileOutcome, TrashFileStatus,
} from './m5-contracts.js';
// Task 4: the four domain registrars (verbatim handler bodies) + the
// re-export that keeps readPaths importable from THIS path (its original
// home; the implementation now lives in m5-settings-handlers.ts).
import { createDownloadHandlers } from './m5-download-handlers.js';
import { createSettingsHandlers } from './m5-settings-handlers.js';
import { createSiteHandlers } from './m5-site-handlers.js';
import { createTaskHandlers } from './m5-task-handlers.js';
export { readPaths } from './m5-settings-handlers.js';

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
 *
 * `verificationRoots` (optional, append-only, carried on `ok` only): the
 * EXACT canonical roots (`canonicalContainmentRoots` output) this verdict was
 * judged against. The caller passes them back to `trash()` as its third
 * argument so the executor binds to the roots the pre-flight CONFIRMED
 * instead of re-deriving them at execution time — if an output root itself is
 * swapped between the two calls (e.g. replaced by a junction pointing
 * elsewhere), re-deriving would silently judge against the NEW identity
 * (trust-baseline drift); binding turns that into a whole-batch refusal.
 * Absent on `refused` (nothing may execute anyway) and on legacy fakes that
 * predate the field; `trash()` keeps its previous behaviour when it is
 * omitted.
 */
export type TrashPreflightVerdict =
  | {
    readonly kind: 'ok';
    readonly missingPaths: readonly string[];
    readonly verificationRoots?: readonly string[];
  }
  | { readonly kind: 'refused'; readonly reason: string; readonly refusedCount: number };

export interface TrashFilesPort {
  /**
   * `roots` (optional, append-only): the record's trusted output roots for the
   * executor-side realpath re-validation (the D-207 "TOCTOU backstop" second
   * line). When provided, the adapter re-resolves EVERY entry through
   * `realpath` immediately before `trashItem` and refuses any resolution that
   * lands outside these roots — closing the pre-flight→trash gap where a local
   * attacker with write access to an output directory can swap a path (or a
   * middle component) for a junction pointing elsewhere. Omitted (undefined)
   * by legacy callers, which keep their exact previous behaviour.
   *
   * `expectedCanonicalRoots` (optional third parameter, append-only — D-221
   * re-audit): the `verificationRoots` carried by the pre-flight's `ok`
   * verdict, passed back verbatim. When provided, the adapter FIRST re-resolves
   * every bound root through `realpath` and refuses the WHOLE batch (every
   * entry `error`, zero `trashItem` calls) when a root's resolution no longer
   * matches the recorded identity (root swapped for a junction pointing
   * elsewhere), the root is gone/dangling (ENOENT/ENOTDIR), or the resolution
   * fails for any other reason (EACCES/ELOOP → fail-closed). The per-entry
   * re-validation then judges against these pre-flight-confirmed roots, NOT
   * against roots re-derived at execution time. Omitted → previous behaviour
   * (canonical roots re-derived from `roots` at execution time).
   */
  trash(
    paths: readonly string[],
    roots?: readonly string[],
    expectedCanonicalRoots?: readonly string[],
  ): Promise<readonly (string | TrashFileOutcome)[]>;
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

/** One IPC handler: validated payload in, DTO promise out (the gateway shape). */
export type M5Handler = (payload: unknown) => Promise<unknown>;
/** The handler map `createM5Handlers` composes (one entry per M5 channel). */
export type M5HandlerMap = Map<string, M5Handler>;

/**
 * Task 4: the D-160 precheck-cancellation scope, created ONCE per
 * `createM5Handlers` call and shared by every domain that runs a cancellable
 * pre-check (DOWNLOAD_START, TXT / playlist batches, URL_SUPPORT_CHECK) and
 * read back by its CANCEL / STATUS handlers. One scope registry per host —
 * one submission's stop button can never touch another's controllers.
 */
export interface M5PrecheckScope {
  readonly readOperationId: (record: Record<string, unknown>) => string | null;
  readonly registerPrecheck: (operationId: string | null) => AbortController;
  readonly finishPrecheck: (operationId: string | null, controller: AbortController) => void;
  readonly trackBatchProgress: (
    operationId: string | null,
    controller: AbortController,
  ) => (checked: number, total: number) => void;
  /** Read-only: the submission's registered controllers (URL_SUPPORT_CHECK_CANCEL). */
  readonly peekControllers: (operationId: string | null) => readonly AbortController[];
  /** Read-only: the submission's batch progress entries (URL_SUPPORT_CHECK_STATUS). */
  readonly peekProgress: (
    operationId: string | null,
  ) => ReadonlyMap<AbortController, { checked: number; total: number }> | undefined;
}

/**
 * Task 4: what every domain registrar receives — the validated deps plus the
 * shared precheck scope. Domains each build their own handler map; the
 * composition root merges them, so `ipcMain.handle` registration stays in
 * the gateway path (bootstrap registerAll) and no domain can bypass it.
 */
export interface M5HandlerContext {
  readonly deps: M5ChannelDeps;
  readonly precheck: M5PrecheckScope;
}

export function createM5Handlers(deps: M5ChannelDeps): M5HandlerMap {
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
  // Task-4 seam: the CANCEL / STATUS handlers read the registry directly.
  // Expose the two read-only peeks so the site domain answers from the SAME
  // scopes map — a second registry must never exist.
  const peekControllers = (operationId: string | null): readonly AbortController[] =>
    [...(scopes.get(scopeOf(operationId))?.controllers ?? [])];
  const peekProgress = (
    operationId: string | null,
  ): ReadonlyMap<AbortController, { checked: number; total: number }> | undefined =>
    scopes.get(scopeOf(operationId))?.progress;

  // Task 4: the four domain modules each build their own handler map against
  // the SHARED context above (deps + the one precheck scope closure). The
  // composition root merges them in a fixed order; every channel is unique and
  // the m5-host duplicate-channel guard plus the 31-channel M5_CHANNELS
  // assertion are the net against a missed or double registration.
  const ctx: M5HandlerContext = { deps, precheck: {
    readOperationId, registerPrecheck, finishPrecheck, trackBatchProgress,
    peekControllers, peekProgress,
  } };
  for (const [channel, handler] of createTaskHandlers(ctx)) handlers.set(channel, handler);
  for (const [channel, handler] of createDownloadHandlers(ctx)) handlers.set(channel, handler);
  for (const [channel, handler] of createSiteHandlers(ctx)) handlers.set(channel, handler);
  for (const [channel, handler] of createSettingsHandlers(ctx)) handlers.set(channel, handler);

  return handlers;
}
