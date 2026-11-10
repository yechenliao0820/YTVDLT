/** Task state machine + serializable snapshots. Pure types only. */
import type { AppError } from './errors.js';
import type { MediaInfo } from './media.js';
import type { DownloadRequest } from './request.js';
import type { EngineEvent, EngineStage } from './events.js';
import type { SubtitleFileLink, SubtitleOutcome } from './subtitle-artifact.js';

/** 7 states, aligned with Seal `Task.kt`. `Completed` is terminal. */
export type TaskState =
  | 'Idle' | 'FetchingInfo' | 'ReadyWithInfo'
  | 'Running' | 'Completed' | 'Error' | 'Canceled';

export type DownloadKind = 'video' | 'audio';

/** Serializable task snapshot (no functions / CancelHandle). */
export interface TaskRecord {
  id: string;
  url: string;
  kind: DownloadKind;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Cached after a successful probe; `restart` can skip re-probing. */
  mediaInfo: MediaInfo | null;
  /** Immutable DownloadRequest snapshot (five domains). */
  request: DownloadRequest | null;
  /** Absolute artifact paths, filled after manifest parsing. */
  artifacts: string[];
  /**
   * Last progress percent; preserved across cancel/failure so a stopped task
   * still shows where it stopped. `restart()` clears it (D-107): a retry is a
   * new run, and the previous attempt's number must not be shown as this one's.
   * `null` = unknown — never coerce it to 0.
   */
  lastPercent: number | null;
  /**
   * 0.2.1 (D-95): the last observed transfer numbers, so the queue card can
   * show "12.3 MB / 48.0 MB · 4.2 MB/s · 剩余 1:32" instead of a bare percent.
   * All optional: an old `tasks.json` simply has none of them, and `null`
   * always means "unknown", never zero.
   */
  lastDownloadedBytes?: number | null;
  lastTotalBytes?: number | null;
  lastSpeedBps?: number | null;
  lastEtaSec?: number | null;
  /**
   * D-115: the furthest real stage this run has reached, so a card that is
   * still `Running` can say "merging / finalizing" instead of pretending the
   * transfer is still going. Optional: an older `tasks.json` has no value and
   * the UI then keeps the previous behaviour.
   */
  lastStage?: EngineStage | null;
  error: AppError | null;
  /** When true, completion does NOT write history. */
  privateMode: boolean;
  /** Whether post-processing happened (decides C2 vs C8). */
  postprocessed: boolean;
  /**
   * Stage 4: subtitle files this run produced, each linked to its media.
   * Optional so every pre-existing `tasks.json` / test fixture stays valid; the
   * queue only fills it after a successful verification. `restart()` clears it
   * — a retry is a NEW run and must not inherit the previous attempt's list.
   */
  subtitleFiles?: readonly SubtitleFileLink[];
  /**
   * Stage 4: requested-vs-produced reconciliation. `none` = no subtitles were
   * asked for; absent = older record that predates this field.
   */
  subtitleOutcome?: SubtitleOutcome;
}

export interface TaskSnapshot {
  schemaVersion: 1;
  savedAt: string;
  tasks: TaskRecord[];
}

/** TaskQueue outward events: state changes + frozen engine events. */
export type TaskEvent =
  | { type: 'state-changed'; taskId: string; from: TaskState; to: TaskState }
  | EngineEvent;
