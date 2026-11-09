/** Task state machine + serializable snapshots. Pure types only. */
import type { AppError } from './errors.js';
import type { MediaInfo } from './media.js';
import type { DownloadRequest } from './request.js';
import type { EngineEvent } from './events.js';

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
  error: AppError | null;
  /** When true, completion does NOT write history. */
  privateMode: boolean;
  /** Whether post-processing happened (decides C2 vs C8). */
  postprocessed: boolean;
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
